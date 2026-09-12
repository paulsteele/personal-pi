import { execFile } from "node:child_process";
import { copyFile, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const exec = promisify(execFile);
it.each([false, true])("resolves development tools with workspace-local installation=%s", async (local) => {
	const root = await mkdtemp(join(tmpdir(), "pr-tool-layout-"));
	try {
		const workspace = join(root, "workspace");
		await mkdir(workspace);
		await copyFile(new URL("./run-tool.mjs", import.meta.url), join(workspace, "run-tool.mjs"));
		const packageRoot = join(local ? workspace : root, "node_modules", "typescript");
		await mkdir(join(packageRoot, "bin"), { recursive: true });
		await writeFile(
			join(packageRoot, "package.json"),
			JSON.stringify({ name: "typescript", bin: { tsc: "bin/tsc.cjs" } }),
		);
		await writeFile(
			join(packageRoot, "bin/tsc.cjs"),
			"console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));",
		);
		const result = await exec(process.execPath, [join(workspace, "run-tool.mjs"), "tsc", "--noEmit"], {
			cwd: workspace,
		});
		expect(JSON.parse(result.stdout)).toEqual({ cwd: await realpath(workspace), args: ["--noEmit"] });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
