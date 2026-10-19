import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolBuildPorts } from "../src/sandbox/tool-build-runtime.ts";
import { requireToolImageMountCapability } from "../src/sandbox/tool-mount-capability.ts";
import { podmanOutput } from "../src/sandbox/driver.ts";

const imageReference = process.argv[2];
if (!imageReference) {
  throw new Error(
    "Usage: node scripts/verify-mounted-tools.mjs <local-image-with-sh-sleep-awk>. Pull the desired Linux probe image explicitly first.",
  );
}
const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-mounted-tools-verification-")));
try {
  const run = (args, signal) => podmanOutput(args, signal);
  const version = JSON.parse(await run(["version", "--format", "json"]));
  const info = JSON.parse(await run(["info", "--format", "json"]));
  console.log(JSON.stringify({ version, storage: info.store }, null, 2));
  const inspectedImages = JSON.parse(await run(["inspect", "--type", "image", imageReference]));
  const imageId = inspectedImages[0]?.Id;
  if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(imageId ?? "")) {
    throw new Error("Probe image inspection omitted its immutable ID");
  }
  const ports = createToolBuildPorts({ directory, run, approvedMountArguments: [] });
  await requireToolImageMountCapability({
    directory,
    builderImageId: imageId,
    ports,
    run,
    report: console.log,
  });
  console.log(
    "PASS: immutable image subpath mount, effective read-only enforcement, inspect provenance, and checkpoint exclusion",
  );
  console.log(
    "This probe does not certify language-server diagnostics or the native-library/platform matrix.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
