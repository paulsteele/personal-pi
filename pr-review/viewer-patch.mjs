import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

/** Only fixed-name regular files owned by the launching viewer session may be loaded. */
export async function readOwnedViewerPatch(directory, parentPid) {
	const readRegular = async (name) => {
		const handle = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const stat = await handle.stat();
			if (!stat.isFile() || stat.nlink !== 1) throw new Error("Invalid viewer-owned file");
			return await handle.readFile("utf8");
		} finally {
			await handle.close();
		}
	};
	const owner = JSON.parse(await readRegular("owner.json"));
	if (owner.kind !== "pr-review-viewer" || owner.pid !== parentPid) throw new Error("Viewer owner mismatch");
	return readRegular("diff.patch");
}
