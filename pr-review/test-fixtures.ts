import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { BUDGETS } from "./config.js";
import { resolveRepo } from "./git.js";
import type { Config, Draft, Repo, Scope } from "./types.js";
import { capture as captureSource } from "./snapshot.js";
import { runWorker as executeWorker } from "./worker.js";
import { review as executeReview } from "./runner.js";
export const runWorker: typeof executeWorker = (options) =>
	executeWorker({ ...options, permissions: options.permissions ?? testAccess() });
export const review: typeof executeReview = (options) =>
	executeReview({ ...options, permissions: options.permissions ?? testPermissions() });
import {
	PermissionScope,
	ReviewPermissions,
	REVIEW_SERVICE_CHANNEL,
	type PermissionAction,
	type PermissionResult,
} from "./permissions.js";

/** Explicit synthetic policy; never reads the operator's real config. */
export function testAccess(
	check: (action: PermissionAction) => Promise<PermissionResult> = async () => ({
		kind: "allowed",
		revision: "fixture",
	}),
) {
	return new PermissionScope({ check, revision: () => "fixture", nextTurn() {}, endTurn() {}, close() {} });
}
const testOperationPort = () => ({
	task: () => ({
		check: async () => ({ kind: "allowed" as const, revision: "fixture" }),
		revision: () => "fixture",
		nextTurn() {},
		endTurn() {},
		close() {},
	}),
	close() {},
});
export function testPermissions() {
	return new ReviewPermissions("fixture", testOperationPort());
}
export function testPermissionEvents() {
	return {
		on: (_name: string, _handler: (data: unknown) => void) => () => {},
		emit(name: string, data: unknown) {
			if (name === REVIEW_SERVICE_CHANNEL)
				(data as { accept(value: unknown): void }).accept({ version: 1, open: testOperationPort });
		},
	};
}
export function capture(
	repo: Repo,
	scope: Scope,
	config: Config,
	exclusions: Array<{ glob: string; reason: string }> = [],
	signal?: AbortSignal,
) {
	return captureSource(repo, scope, config, testAccess(), exclusions, signal);
}
const exec = promisify(execFile);
export const testConfig = {
	schemaVersion: 1,
	provider: "fake",
	model: "test",
	thinking: "off",
	...BUDGETS,
} satisfies Config;
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
