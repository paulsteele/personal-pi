import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SandboxLspManager } from "./lsp-sandbox-manager.js";
import type { QualitySandbox } from "./sandbox.js";
import {
	approveLspDraft,
	loadLspDraft,
	resolveLspProject,
	saveLspDraft,
	type LspRoute,
} from "./lsp-profile.js";
import { presetById, presetRoute } from "./lsp-presets.js";

const observed = vi.hoisted(() => ({ routes: [] as LspRoute[], checks: vi.fn(async () => []) }));
vi.mock("./lsp-sandbox-client.js", () => ({
	SandboxLspClient: class {
		constructor(_sandbox: unknown, route: LspRoute) {
			observed.routes.push(route);
		}
		async start() {}
		async stop() {}
		async refreshWorkspace() {}
		check = observed.checks;
	},
}));
const directories: string[] = [];
beforeEach(() => {
	observed.routes.length = 0;
	observed.checks.mockClear();
});
afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function automaticFixture(
	options: {
		provisionedTools?: boolean;
		discoveryFiles?: string[];
		tools?: { id: string; version: string; executable: string }[];
	} = {},
) {
	const directory = await mkdtemp(join(tmpdir(), "automatic-lsp-"));
	directories.push(directory);
	const root = join(directory, "project");
	await mkdir(root);
	const text = "value: int = 1\n";
	const sandbox: QualitySandbox = {
		sessionId: "session",
		revision: () => "revision",
		session: {
			generation: 1,
			processSupervisor: "supervisor",
			environment: {
				container: "container",
				user: "root",
				workspace: "/workspace",
				configuration: {},
				toolInventory: {
					version: 1,
					revision: "tools",
					tools: options.tools ?? [{ id: "pyright", version: "1.1.414", executable: "/opt/pyright" }],
				},
			},
			filesystem: {
				canonical: async (path) => path,
				read: async () => Buffer.from(text),
				write: async () => {},
				mkdir: async () => {},
				stat: async () => ({ file: true, directory: false, size: text.length }),
				list: async () => [],
			},
			execute: vi.fn(async () => ({
				output: Buffer.from(
					JSON.stringify({
						files: options.discoveryFiles ?? ["app.py", "pyproject.toml"],
						manifestRevision: "manifests",
						truncated: false,
					}),
				),
				stderr: "",
				code: 0,
			})),
		},
	};
	if (options.provisionedTools === false) {
		sandbox.session.environment.toolInventory = undefined;
	}
	const pi = {
		events: {
			emit: (_channel: string, request: { accept(value: QualitySandbox): void }) => request.accept(sandbox),
		},
	} as unknown as ExtensionAPI;
	const agentDir = join(directory, "agent");
	const manager = new SandboxLspManager(pi, agentDir, vi.fn());
	return { manager, sandbox, root, text, agentDir };
}

it("checks a new project's Python file with no setup or saved profile", async () => {
	const fixture = await automaticFixture();
	await fixture.manager.start(fixture.root, true);
	expect(observed.routes).toHaveLength(0);
	const result = await fixture.manager.check(
		[{ path: "/workspace/app.py", after: fixture.text }],
		new AbortController().signal,
	);
	expect(result).toMatchObject({ kind: "checked", findings: [] });
	expect(observed.routes).toMatchObject([{ preset: "pyright", command: "/opt/pyright", root: "/workspace" }]);
	expect(observed.checks).toHaveBeenCalledTimes(1);
});

it("does not start unrelated servers when only Markdown is edited", async () => {
	const fixture = await automaticFixture();
	await fixture.manager.start(fixture.root, true);
	expect(
		await fixture.manager.check(
			[{ path: "/workspace/README.md", after: fixture.text }],
			new AbortController().signal,
		),
	).toBeUndefined();
	expect(observed.routes).toHaveLength(0);
});

it("does not start automatic analysis while quality is disabled", async () => {
	const fixture = await automaticFixture();
	await fixture.manager.start(fixture.root, true, false);
	expect(
		await fixture.manager.check(
			[{ path: "/workspace/app.py", after: fixture.text }],
			new AbortController().signal,
		),
	).toBeUndefined();
	expect(fixture.sandbox.session.execute).not.toHaveBeenCalled();
	expect(observed.routes).toHaveLength(0);
});

it("checks an explicit custom route in automatic mode without provisioning or discovery", async () => {
	const fixture = await automaticFixture({ provisionedTools: false });
	const project = await resolveLspProject(fixture.root, fixture.agentDir);
	const route: LspRoute = {
		...presetRoute(presetById("pyright"), "/usr/local/bin/custom-server"),
		id: "custom-python",
		preset: "custom",
	};
	await saveLspDraft(fixture.agentDir, project, {
		version: 1,
		projectId: project.id,
		enabled: true,
		mode: "auto",
		routes: [route],
	});
	const savedDraft = await loadLspDraft(fixture.agentDir, project);
	expect(savedDraft).toBeDefined();
	await approveLspDraft(fixture.agentDir, project, savedDraft!.revision);
	try {
		await fixture.manager.start(fixture.root, true);
		const result = await fixture.manager.check(
			[{ path: "/workspace/app.py", after: fixture.text }],
			new AbortController().signal,
		);
		expect(result).toMatchObject({ kind: "checked", findings: [] });
		expect(observed.routes).toMatchObject([{ id: "custom-python", command: "/usr/local/bin/custom-server" }]);
		expect(fixture.sandbox.session.execute).not.toHaveBeenCalled();
	} finally {
		await fixture.manager.stop();
	}
});

it("checks both workspaces when their punctuation would collide in display-oriented route IDs", async () => {
	const fixture = await automaticFixture({
		discoveryFiles: ["a/b/package.json", "a-b/package.json", "a/b/app.ts", "a-b/app.ts"],
		tools: [{ id: "typescript", version: "6.0.1", executable: "/opt/typescript" }],
	});
	await fixture.manager.start(fixture.root, true);
	try {
		const result = await fixture.manager.check(
			[
				{ path: "/workspace/a/b/app.ts", after: fixture.text },
				{ path: "/workspace/a-b/app.ts", after: fixture.text },
			],
			new AbortController().signal,
		);
		expect(result).toMatchObject({
			kind: "checked",
			hashes: {
				"/workspace/a/b/app.ts": expect.any(String),
				"/workspace/a-b/app.ts": expect.any(String),
			},
		});
		expect(observed.routes.map((route) => route.root)).toEqual(["/workspace/a/b", "/workspace/a-b"]);
		expect(observed.checks).toHaveBeenCalledTimes(2);
	} finally {
		await fixture.manager.stop();
	}
});

it.each(["explicit", "auto"] as const)(
	"selects only the deepest approved routes in %s mode",
	async (mode) => {
		const fixture = await automaticFixture();
		const project = await resolveLspProject(fixture.root, fixture.agentDir);
		const parent = { ...presetRoute(presetById("pyright"), "/tools/parent"), id: "parent" };
		const nested = { ...presetRoute(presetById("pyright"), "/tools/nested", "pyright", "app"), id: "nested" };
		const nestedAdditional = { ...nested, id: "nested-additional", command: "/tools/additional" };
		await saveLspDraft(fixture.agentDir, project, {
			version: 1,
			projectId: project.id,
			enabled: true,
			mode,
			routes: [parent, nested, nestedAdditional],
		});
		const draft = (await loadLspDraft(fixture.agentDir, project))!;
		await approveLspDraft(fixture.agentDir, project, draft.revision);
		await fixture.manager.start(fixture.root, true);
		try {
			const result = await fixture.manager.check(
				[{ path: "/workspace/app/main.py", after: fixture.text }],
				new AbortController().signal,
			);
			expect(result).toMatchObject({ kind: "checked" });
			expect(observed.checks).toHaveBeenCalledTimes(2);
			expect(fixture.sandbox.session.execute).not.toHaveBeenCalled();
		} finally {
			await fixture.manager.stop();
		}
	},
);

it("keeps a warm automatic client when an ordinary source file is added under its root", async () => {
	const discoveryFiles = ["app.py", "pyproject.toml"];
	const fixture = await automaticFixture({ discoveryFiles });
	await fixture.manager.start(fixture.root, true);
	try {
		await fixture.manager.check(
			[{ path: "/workspace/app.py", after: fixture.text }],
			new AbortController().signal,
		);
		discoveryFiles.push("another.py");
		await fixture.manager.check(
			[{ path: "/workspace/another.py", after: fixture.text }],
			new AbortController().signal,
		);
		expect(observed.routes).toHaveLength(1);
		expect(observed.checks).toHaveBeenCalledTimes(2);
	} finally {
		await fixture.manager.stop();
	}
});

it("does not infer a diagnostic route for a language deselected in the automatic profile", async () => {
	const fixture = await automaticFixture();
	const project = await resolveLspProject(fixture.root, fixture.agentDir);
	await saveLspDraft(fixture.agentDir, project, {
		version: 1,
		projectId: project.id,
		enabled: true,
		mode: "auto",
		routes: [],
		disabledLanguages: ["pyright"],
	});
	const draft = (await loadLspDraft(fixture.agentDir, project))!;
	await approveLspDraft(fixture.agentDir, project, draft.revision);
	await fixture.manager.start(fixture.root, true);
	try {
		expect(
			await fixture.manager.check(
				[{ path: "/workspace/app.py", after: fixture.text }],
				new AbortController().signal,
			),
		).toBeUndefined();
		expect(observed.checks).not.toHaveBeenCalled();
		expect(observed.routes).toEqual([]);
	} finally {
		await fixture.manager.stop();
	}
});

it("reports missing provisioning rather than claiming a clean check", async () => {
	const fixture = await automaticFixture();
	fixture.sandbox.session.environment.toolInventory!.tools = [];
	await fixture.manager.start(fixture.root, true);
	expect(
		await fixture.manager.check(
			[{ path: "/workspace/app.py", after: fixture.text }],
			new AbortController().signal,
		),
	).toMatchObject({ kind: "unavailable" });
	expect(observed.checks).not.toHaveBeenCalled();
});
