import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as brokers from "./lsp-broker-registry.js";
import { LspManager } from "./lsp-manager.js";
import { presetById, presetRoute } from "./lsp-presets.js";
import { resolveLspProject } from "./lsp-profile.js";
import { digest } from "./proposal.js";
import * as discovery from "./lsp-setup.js";

const directories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

async function validationFixture() {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "lsp-validation-")));
	directories.push(directory);
	const root = join(directory, "project");
	await mkdir(root);
	const agentDir = join(directory, "agent");
	const project = await resolveLspProject(root, agentDir);
	const route = presetRoute(presetById("roslyn"), "/unused/roslyn");
	const manager = new LspManager(agentDir, () => {});
	const attach = vi.spyOn(brokers, "attachBroker").mockRejectedValue(new Error("Unexpected broker startup"));
	return { root, project, route, manager, attach, signal: new AbortController().signal };
}

it("reports a scan limit rather than claiming a truncated workspace contains no source", async () => {
	const fixture = await validationFixture();
	vi.spyOn(discovery, "discoverLspFiles").mockResolvedValue({ files: ["App.sln"], truncated: true });
	expect(await fixture.manager.validate(fixture.route, fixture.project, fixture.signal)).toEqual({
		ready: false,
		summary: `Source discovery reached its scan limit in ${fixture.root} before finding a file matching .cs; narrow the workspace root in /quality lsp setup edit, then retry approval`,
	});
	expect(fixture.attach).not.toHaveBeenCalled();
});

it("identifies the workspace and expected extensions when a complete scan finds no source", async () => {
	const fixture = await validationFixture();
	await writeFile(join(fixture.root, "App.sln"), "");
	expect(await fixture.manager.validate(fixture.route, fixture.project, fixture.signal)).toEqual({
		ready: false,
		summary: `No representative source file matching .cs found in ${fixture.root}; select a workspace containing source`,
	});
	expect(fixture.attach).not.toHaveBeenCalled();
});

it("validates discovered C# source even when the remaining scan was truncated", async () => {
	const fixture = await validationFixture();
	const source = "class App {}";
	const path = join(fixture.root, "App.cs");
	await writeFile(path, source);
	vi.spyOn(discovery, "discoverLspFiles").mockResolvedValue({ files: ["App.cs"], truncated: true });
	const check = vi.fn().mockResolvedValue({ kind: "checked", findings: [] });
	const close = vi.fn().mockResolvedValue(undefined);
	fixture.attach.mockResolvedValue({ check, close } as unknown as brokers.BrokerConnection);
	expect(await fixture.manager.validate(fixture.route, fixture.project, fixture.signal)).toEqual({
		ready: true,
		summary: "Operational; 0 diagnostics in App.cs",
	});
	expect(check).toHaveBeenCalledExactlyOnceWith(
		[{ path, hash: digest(source), languageId: "csharp" }],
		expect.any(AbortSignal),
	);
	expect(close).toHaveBeenCalledOnce();
});
