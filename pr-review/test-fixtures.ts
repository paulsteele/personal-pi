import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { BUDGETS } from "./config.js";
import { resolveRepo } from "./git.js";
import type { Config, Draft } from "./types.js";
const exec = promisify(execFile);
export const testConfig: Config = {
	schemaVersion: 1,
	provider: "fake",
	model: "test",
	thinking: "off",
	...BUDGETS,
};
export const testDraft: Draft = {
	name: "Fixture",
	summary: "Synthetic repository",
	requiredReading: [],
	freshnessSources: [],
	baselineFocus: [],
	specialists: [],
	exclusions: [],
};
export async function testGit(root: string, ...args: string[]): Promise<string> {
	return (
		await exec(
			"git",
			[
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.invalid",
				...args,
			],
			{ cwd: root },
		)
	).stdout;
}
export async function put(root: string, path: string, content: string | Buffer): Promise<void> {
	await mkdir(dirname(join(root, path)), { recursive: true });
	await writeFile(join(root, path), content);
}
export async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pr-review-git-"));
	await testGit(root, "init", "--quiet", "--initial-branch=main");
	return resolveRepo(root);
}
export async function commit(root: string) {
	await testGit(root, "add", ".");
	await testGit(root, "commit", "--quiet", "--no-gpg-sign", "-m", "fixture");
}
