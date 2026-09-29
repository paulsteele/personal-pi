import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { canonicalPath, inside } from "./capture.js";
import { digest } from "./proposal.js";

export type LspPreset = "roslyn" | "typescript" | "pyright" | "rust-analyzer" | "gopls" | "custom";
export interface LspRoute {
	id: string;
	root: string;
	preset: LspPreset;
	command: string;
	args: string[];
	version: string;
	extensions: Record<string, string>;
	env: Record<string, string>;
	initializationOptions: Record<string, unknown>;
	settings: Record<string, unknown>;
	project?: string;
	startupTimeoutMs: number;
	diagnosticTimeoutMs: number;
}
export interface LspProfile {
	version: 1;
	projectId: string;
	enabled: boolean;
	routes: LspRoute[];
}
export interface LspProject {
	id: string;
	kind: "repos" | "projects";
	root: string;
}
export interface StoredLspProfile {
	profile: LspProfile;
	revision: string;
}
export interface LspDraft {
	version: 1;
	profile: LspProfile;
	baseRevision: string | null;
}

const Text = Type.String({ minLength: 1, maxLength: 4096 });
const Options = Type.Record(Type.String(), Type.Unknown());
const RouteSchema = Type.Object(
	{
		id: Type.String({ pattern: "^[a-zA-Z0-9_-]{1,80}$" }),
		root: Text,
		preset: Type.Union(
			["roslyn", "typescript", "pyright", "rust-analyzer", "gopls", "custom"].map((value) =>
				Type.Literal(value),
			),
		),
		command: Text,
		args: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 64 }),
		version: Text,
		extensions: Type.Record(
			Type.String({ pattern: "^\\.[a-zA-Z0-9]+$" }),
			Type.String({ minLength: 1, maxLength: 80 }),
		),
		env: Type.Record(Type.String({ pattern: "^[a-zA-Z_][a-zA-Z0-9_]*$" }), Type.String({ maxLength: 16000 })),
		initializationOptions: Options,
		settings: Options,
		project: Type.Optional(Text),
		startupTimeoutMs: Type.Integer({ minimum: 1000, maximum: 300000 }),
		diagnosticTimeoutMs: Type.Integer({ minimum: 100, maximum: 300000 }),
	},
	{ additionalProperties: false },
);
const ProfileSchema = Type.Object(
	{
		version: Type.Literal(1),
		projectId: Type.String({ pattern: "^[a-f0-9]{64}$" }),
		enabled: Type.Boolean(),
		routes: Type.Array(RouteSchema, { maxItems: 32 }),
	},
	{ additionalProperties: false },
);

function validateRelativeRoot(path: string): void {
	if (
		!path ||
		isAbsolute(path) ||
		path.includes("\\") ||
		path.includes("\0") ||
		path.split("/").includes("..")
	) {
		throw new Error(`Expected a project-relative path without traversal: ${JSON.stringify(path)}`);
	}
}

export function parseLspProfile(value: unknown, projectId: string): LspProfile {
	if (!Check(ProfileSchema, value)) throw new Error("Invalid LSP profile schema");
	const profile = value as LspProfile;
	if (profile.projectId !== projectId) throw new Error("LSP profile belongs to another project");
	const ids = new Set<string>();
	for (const route of profile.routes) {
		if (ids.has(route.id)) throw new Error(`Duplicate LSP route: ${route.id}`);
		ids.add(route.id);
		validateRelativeRoot(route.root);
		if (route.project) validateRelativeRoot(route.project);
		if (route.preset === "rust-analyzer") {
			const rustSettings = route.settings["rust-analyzer"] as { checkOnSave?: unknown } | undefined;
			const initializationDisablesCheckOnSave = route.initializationOptions.checkOnSave === false;
			const settingsDisableCheckOnSave = rustSettings?.checkOnSave === false;
			if (!initializationDisablesCheckOnSave || !settingsDisableCheckOnSave)
				throw new Error(
					"rust-analyzer requires broker-owned checks with checkOnSave disabled in settings and initialization",
				);
		}
		if (route.preset === "gopls" && route.initializationOptions.pullDiagnostics !== true)
			throw new Error("gopls requires pullDiagnostics for complete file checks");
		if (!Object.keys(route.extensions).length) throw new Error(`No file extensions for ${route.id}`);
		const processConfiguration = [route.command, ...route.args, ...Object.values(route.env)];
		const containsNullByte = processConfiguration.some((value) => value.includes("\0"));
		if (containsNullByte) throw new Error("LSP process configuration contains a null byte");
		const isDaemonModeArgument = (argument: string) =>
			argument === "--daemon-mode" || argument.startsWith("--daemon-mode=");
		const requestsRoslynDaemon = route.preset === "roslyn" && route.args.some(isDaemonModeArgument);
		if (requestsRoslynDaemon)
			throw new Error("The quality broker owns sharing; Roslyn daemon mode is not supported");
	}
	return structuredClone(profile);
}

export function lspStorageRoot(agentDir: string): string {
	return join(canonicalPath(agentDir), "extensions", "code-quality");
}
export function lspProfilePath(agentDir: string, project: LspProject, draft = false): string {
	if (!/^[a-f0-9]{64}$/.test(project.id)) throw new Error("Invalid LSP project identity");
	return join(
		lspStorageRoot(agentDir),
		project.kind,
		project.id,
		draft ? "lsp-profile-draft.json" : "lsp-profile.json",
	);
}

async function rejectSymlinks(path: string): Promise<void> {
	for (let current = path; ; current = dirname(current)) {
		try {
			if ((await lstat(current)).isSymbolicLink())
				throw new Error(`Refusing symlink in LSP storage: ${current}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (dirname(current) === current) return;
	}
}

async function readJson(path: string): Promise<{ value: unknown; revision: string } | undefined> {
	await rejectSymlinks(path);
	try {
		const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const stat = await handle.stat();
			if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Invalid or oversized LSP profile");
			const text = await handle.readFile("utf8");
			return { value: JSON.parse(text), revision: digest(text) };
		} finally {
			await handle.close();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export async function publishLspJson(
	path: string,
	value: unknown,
	expected: string | undefined,
): Promise<void> {
	await rejectSymlinks(path);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await chmod(dirname(path), 0o700);
	const lock = await open(`${path}.lock`, "wx", 0o600).catch(() => {
		throw new Error(
			"Another LSP configuration operation owns the lock; retry after it finishes. Stale locks require inspection.",
		);
	});
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await lock.writeFile(JSON.stringify({ pid: process.pid }));
		if ((await readJson(path))?.revision !== expected)
			throw new Error("LSP configuration changed since preview; reopen setup");
		const text = JSON.stringify(value, null, 2) + "\n";
		if (Buffer.byteLength(text) > 1024 * 1024)
			throw new Error("LSP configuration exceeds its storage budget");
		const file = await open(temporary, "wx", 0o600);
		try {
			await file.writeFile(text);
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, path);
	} finally {
		await lock.close();
		await unlink(temporary).catch(() => {});
		await unlink(`${path}.lock`);
	}
}

function projectIdentity(path: string): string {
	return createHash("sha256").update(path).digest("hex");
}

export async function resolveLspProject(cwd: string, agentDir: string): Promise<LspProject> {
	const canonical = await realpath(cwd);
	try {
		const execute = promisify(execFile);
		const options = { cwd: canonical, timeout: 10000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } };
		const { stdout: root } = await execute("git", ["rev-parse", "--show-toplevel"], options);
		const { stdout: common } = await execute(
			"git",
			["rev-parse", "--path-format=absolute", "--git-common-dir"],
			options,
		);
		return {
			kind: "repos",
			root: await realpath(root.trim()),
			id: projectIdentity(await realpath(common.trim())),
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as { code?: number }).code !== 128)
			throw error;
	}
	for (let root = canonical; ; root = dirname(root)) {
		const project: LspProject = { kind: "projects", root, id: projectIdentity(root) };
		if (await readJson(lspProfilePath(agentDir, project))) return project;
		if (dirname(root) === root) break;
	}
	return { kind: "projects", root: canonical, id: projectIdentity(canonical) };
}

function assertOutsideProject(agentDir: string, project: LspProject): void {
	if (inside(project.root, lspStorageRoot(agentDir)))
		throw new Error("Private LSP storage must be outside the project");
}

export async function loadLspProfile(
	agentDir: string,
	project: LspProject,
): Promise<StoredLspProfile | undefined> {
	assertOutsideProject(agentDir, project);
	const stored = await readJson(lspProfilePath(agentDir, project));
	if (!stored) return undefined;
	const record = stored.value as { profile?: unknown; approvedDigest?: unknown };
	const profile = parseLspProfile(record?.profile, project.id);
	if (record.approvedDigest !== digest(JSON.stringify(profile)))
		throw new Error("LSP profile changed outside approval; use setup edit/approve");
	return { profile, revision: stored.revision };
}

export async function saveLspDraft(
	agentDir: string,
	project: LspProject,
	profile: LspProfile,
	baseRevision?: string | null,
	expectedDraftRevision?: string | null,
): Promise<string> {
	assertOutsideProject(agentDir, project);
	const active = await loadLspProfile(agentDir, project);
	const path = lspProfilePath(agentDir, project, true);
	const prior = await readJson(path);
	const draftBaseRevision = baseRevision === undefined ? (active?.revision ?? null) : baseRevision;
	const expectedPublicationRevision =
		expectedDraftRevision === undefined ? prior?.revision : (expectedDraftRevision ?? undefined);
	await publishLspJson(
		path,
		{
			version: 1,
			profile: parseLspProfile(profile, project.id),
			baseRevision: draftBaseRevision,
		} satisfies LspDraft,
		expectedPublicationRevision,
	);
	return path;
}

export async function loadLspDraft(
	agentDir: string,
	project: LspProject,
): Promise<{ draft: LspDraft; revision: string } | undefined> {
	const stored = await readJson(lspProfilePath(agentDir, project, true));
	if (!stored) return undefined;
	const value = stored.value as Partial<LspDraft>;
	if (value?.version !== 1 || (value.baseRevision !== null && typeof value.baseRevision !== "string"))
		throw new Error("Invalid LSP draft metadata");
	return {
		draft: {
			version: 1,
			profile: parseLspProfile(value.profile, project.id),
			baseRevision: value.baseRevision,
		},
		revision: stored.revision,
	};
}

export async function approveLspDraft(
	agentDir: string,
	project: LspProject,
	expectedDraft: string,
): Promise<StoredLspProfile> {
	assertOutsideProject(agentDir, project);
	const pending = await loadLspDraft(agentDir, project);
	if (!pending || pending.revision !== expectedDraft) throw new Error("LSP draft changed during approval");
	const profile = pending.draft.profile;
	await publishLspJson(
		lspProfilePath(agentDir, project),
		{ profile, approvedDigest: digest(JSON.stringify(profile)) },
		pending.draft.baseRevision ?? undefined,
	);
	return (await loadLspProfile(agentDir, project))!;
}

export function matchingLspRoutes(profile: LspProfile, project: LspProject, file: string): LspRoute[] {
	if (!profile.enabled) return [];
	const candidates = profile.routes.filter((route) => {
		const root = canonicalPath(resolve(project.root, route.root));
		const rootInProject = inside(project.root, root);
		const fileInWorkspace = inside(root, file);
		const supportedExtension = Object.keys(route.extensions).some((extension) => file.endsWith(extension));
		return rootInProject && fileInWorkspace && supportedExtension;
	});
	const depth = (route: LspRoute) =>
		relative(project.root, resolve(project.root, route.root)).split(/[\\/]/).filter(Boolean).length;
	const deepest = Math.max(-1, ...candidates.map(depth));
	return candidates.filter((route) => depth(route) === deepest);
}
