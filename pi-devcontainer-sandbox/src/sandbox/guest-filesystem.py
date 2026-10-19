import base64
import glob
import json
import mimetypes
import os
import pathlib
import stat
import sys

MAX_MESSAGE_BYTES = 24 * 1024 * 1024


def canonicalize_path(requested_path, cwd):
    candidate = pathlib.Path(os.path.expanduser(requested_path))
    if not candidate.is_absolute():
        candidate = pathlib.Path(cwd) / candidate
    return candidate.resolve(strict=False)


def handle_request(request):
    operation = request["operation"]
    path = canonicalize_path(request["path"], request["cwd"])
    if operation == "canonical":
        return str(path)
    if operation == "canonical_paths":
        return [str(canonicalize_path(requested_path, request["cwd"])) for requested_path in request["paths"]]
    if operation == "entries_exist":
        return [os.path.lexists(os.path.join(request["cwd"], requested_path)) for requested_path in request["paths"]]
    if operation == "read":
        return base64.b64encode(path.read_bytes()).decode("ascii")
    if operation == "write":
        path.write_bytes(base64.b64decode(request["content"]))
        return None
    if operation == "mkdir":
        path.mkdir(parents=True, exist_ok=True)
        return None
    if operation == "stat":
        metadata = path.stat()
        return {
            "directory": stat.S_ISDIR(metadata.st_mode),
            "file": stat.S_ISREG(metadata.st_mode),
            "size": metadata.st_size,
            "identity": str(metadata.st_dev) + ":" + str(metadata.st_ino),
        }
    if operation == "list":
        return sorted(os.listdir(path))
    if operation == "glob":
        return sorted(glob.glob(request["pattern"], root_dir=str(path), recursive=True))[:request["limit"]]
    if operation == "access":
        return {
            "path": str(path),
            "exists": os.path.exists(path),
            "readable": os.access(path, os.R_OK),
        }
    if operation == "mime":
        return mimetypes.guess_type(str(path))[0]
    raise ValueError("Unsupported filesystem operation")


def serve_requests():
    while True:
        line = sys.stdin.buffer.readline(MAX_MESSAGE_BYTES + 1)
        if not line:
            return
        request = json.loads(line)
        request_id = request.get("id")
        try:
            response = {"id": request_id, "result": handle_request(request)}
        except Exception as error:
            response = {"id": request_id, "error": f"{type(error).__name__}: {error}"}
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


if len(sys.argv) > 1 and sys.argv[1] == "--serve":
    serve_requests()
else:
    json.dump(handle_request(json.load(sys.stdin)), sys.stdout)
