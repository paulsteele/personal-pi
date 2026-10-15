#!/usr/bin/env bash
set -uo pipefail
OUT=/tmp/pi-mount-diag3.txt
exec > >(tee "$OUT") 2>&1
IMG=docker.io/library/alpine:3.20
NAME=pi-mount-diag3
podman rm -f "$NAME" >/dev/null 2>&1
podman pull -q "$IMG" >/dev/null
IMG_ID=$(podman image inspect "$IMG" --format '{{.Id}}')

podman run --detach --pull=never --name "$NAME" --network=none --cap-drop=ALL \
  --security-opt=no-new-privileges --user 0 --entrypoint /bin/sh \
  --mount "type=image,source=$IMG_ID,subpath=/etc,destination=/opt/pi-mount-probe/destination,rw=false" \
  "$IMG_ID" -c 'exec sleep 2147483647' >/dev/null || { echo "run FAILED"; exit 1; }

echo "== image id: $IMG_ID"
echo "== container Id / StaticDir"
podman inspect --type container "$NAME" --format '{{.Id}}  {{.StaticDir}}'
echo "== Mounts"
podman inspect --type container "$NAME" | python3 -c '
import json,sys; print(json.dumps(json.load(sys.stdin)[0]["Mounts"], indent=2))'
echo "== store paths"
podman info --format 'graphRoot={{.Store.GraphRoot}} runRoot={{.Store.RunRoot}}'
echo "== mountinfo inside container"
podman exec "$NAME" grep pi-mount-probe /proc/self/mountinfo
podman rm -f --time=0 "$NAME" >/dev/null
echo; echo "Saved to $OUT"
