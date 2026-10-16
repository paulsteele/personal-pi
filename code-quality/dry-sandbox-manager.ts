import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProjectLocation } from "@paulsteele/pi-project-locations";
import { CoverageError, type SnapshotFile } from "./capture.js";
import type { QualityConfig } from "./config.js";
import { parseCorpusError } from "./dry-corpus.mjs";
import { corpusErrorMessage, suspectWarning } from "./dry-messages.js";
import {
	DEFAULT_DRY_PROFILE,
	dryProfilePath,
	loadDryProfile,
	resolveDryProject,
	type DryProfile,
} from "./dry-profile.js";
import { buildDryEvidence, retrieveDryCandidates, rangesOverlap } from "./dry-retrieval.js";
import {
	emptyDryStatus,
	type DryClone,
	type DryCoverage,
	type DryEvidence,
	type DryIndexedFile,
	type DryManifest,
	type DryReport,
	type DryStatus,
} from "./dry-types.js";
import { isIndexedFile, isManifest, isReport } from "./dry-worker-schema.js";
import { digest } from "./proposal.js";
import { qualitySandbox, readGuestSnapshot, type QualitySandbox } from "./sandbox.js";

const MAX_REPORT_BYTES = 128 * 1024 * 1024;
const AST_FORMATS = [
	"javascript",
	"typescript",
	"python",
	"java",
	"kotlin",
	"scala",
	"csharp",
	"go",
	"rust",
	"c",
	"cpp",
	"php",
	"ruby",
	"swift",
	"clojure",
];
function sourceContentHash(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}
type SnippetResult =
	| { excluded: { path: string; reason: string } }
	| {
			file: DryIndexedFile;
			clones: DryClone[];
			retrieved: number;
			note?: string;
			unavailable?: Record<string, string>;
	  };

export class SandboxDryManager {
	status: DryStatus = emptyDryStatus();
	profile: DryProfile = structuredClone(DEFAULT_DRY_PROFILE);
	project?: ProjectLocation;
	manifest?: DryManifest;
	report?: DryReport;
	files: DryIndexedFile[] = [];
	private sandbox?: QualitySandbox;
	private directory = "";
	private guestRoot = "";
	private node = "";
	private executable = "";
	private formats: string[] = [];
	private lifetime = new AbortController();
	private startupEpoch = 0;
	private releaseRetirement?: () => void;
	private generation = "";
	private baselineOperation?: Promise<void>;
	private turnBaselineVersion = 0;
	private serverOperation?: Promise<unknown>;
	private serverAbort?: AbortController;
	private serverExited = false;
	private serverConfigRevision = "";
	private config?: QualityConfig;
	private authorizedPaths: string[] = [];
	constructor(
		readonly pi: Pick<ExtensionAPI, "events">,
		readonly agentDir: string,
		private readonly changed: () => void = () => {},
	) {}
	get revision(): string {
		return this.manifest?.revision ?? digest("unavailable");
	}
	get configRevision(): string {
		return digest(
			JSON.stringify([this.profile, this.config?.maxFileBytes, this.executable, "turn-baseline-v1"]),
		);
	}
	get generationId(): string {
		return `${this.generation}:${this.turnBaselineVersion}`;
	}
	updateLatest(latest: NonNullable<DryStatus["latest"]>): void {
		this.publish({ latest });
	}
	private publish(update: Partial<DryStatus>): void {
		this.status = { ...this.status, ...update };
		this.changed();
	}
	async start(cwd: string, trusted: boolean, config: QualityConfig): Promise<void> {
		await this.stop();
		const startupEpoch = ++this.startupEpoch;
		const assertStartupOwner = () => {
			if (startupEpoch !== this.startupEpoch || this.lifetime.signal.aborted) {
				throw new Error("DRY startup belongs to a retired session");
			}
		};
		this.status = emptyDryStatus();
		this.config = config;
		this.lifetime = new AbortController();
		if (!config.enabled || !config.dryEnabled) {
			this.publish({ toolPhase: "off", scanPhase: "off" });
			return;
		}
		this.publish({ toolPhase: "validating", scanPhase: "idle", reason: undefined });
		try {
			if (!trusted) {
				throw new Error("Trust this project before DRY analysis");
			}
			this.project = await resolveDryProject(cwd, this.agentDir);
			assertStartupOwner();
			this.profile = (await loadDryProfile(this.agentDir, this.project)).profile;
			assertStartupOwner();
			const sandbox = qualitySandbox(this.pi);
			this.sandbox = sandbox;
			const root = await sandbox.guestPath?.(this.project.root);
			if (!root) {
				throw new Error(
					`DRY project root is not fully mapped: ${this.project.root}. Approve its mapping or explicitly waive DRY.`,
				);
			}
			this.guestRoot = root;
			await sandbox.authorizeHostSource?.(this.project.root, this.lifetime.signal);
			assertStartupOwner();
			this.generation = `${sandbox.sessionId}:${sandbox.session.generation}`;
			this.directory = `/tmp/pi-quality-dry-${randomUUID()}`;
			const inventory = sandbox.session.environment.toolInventory?.tools ?? [];
			const tool = inventory.find((entry) => entry.id === "jscpd" && entry.version === "5.4.1");
			const node = inventory.find((entry) => entry.id === "node-runtime");
			if (!tool || !node) {
				throw new Error(
					`DRY requires managed jscpd 5.4.1 and node-runtime. Add {"jscpd":{"kind":"catalog","version":"5.4.1"}} to ${join(this.agentDir, "extensions", "pi-permission-system", "global", "tools.json")} using Sandbox Tools or /sandbox setup global tools, then reload and approve rebuild.`,
				);
			}
			this.executable = tool.executable;
			this.node = node.executable;
			await sandbox.session.filesystem.mkdir(this.directory, this.lifetime.signal);
			const guestModules = [
				"dry-worker.mjs",
				"dry-mcp.mjs",
				"dry-corpus.mjs",
				"dry-suspects.mjs",
				"source-disclosure.mjs",
				"dry-lexical.mjs",
			];
			for (const name of guestModules) {
				await sandbox.session.filesystem.write(
					join(this.directory, name),
					await readFile(new URL(name, import.meta.url)),
					this.lifetime.signal,
				);
			}
			this.releaseRetirement = sandbox.session.beforeContainerRetirement?.(() => this.stop());
			this.publish({ scope: this.project.root, executable: tool.executable });
			const probe = await this.request<{ version: string; formats: string[] }>(
				"probe",
				{},
				this.lifetime.signal,
			);
			assertStartupOwner();
			this.formats = probe.formats;
			this.publish({
				toolPhase: "ready",
				version: probe.version,
				formatCount: this.formats.length,
				astFormatCount: AST_FORMATS.filter((format) => this.formats.includes(format)).length,
			});
		} catch (error) {
			if (startupEpoch !== this.startupEpoch || this.lifetime.signal.aborted) {
				return;
			}
			this.publish({ toolPhase: "unavailable", scanPhase: "unavailable", reason: String(error) });
			throw error;
		}
	}
	private async request<T>(
		operation: string,
		parameters: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<T> {
		const sandbox = this.sandbox;
		const generation = this.generation;
		if (!sandbox || !this.project || !this.config) {
			throw new Error("DRY sandbox is unavailable");
		}
		const root = await sandbox.guestPath?.(this.project.root);
		await sandbox.authorizeHostSource?.(this.project.root, signal);
		if (
			!root ||
			root !== this.guestRoot ||
			`${sandbox.sessionId}:${sandbox.session.generation}` !== generation
		) {
			throw new Error("DRY sandbox mapping/generation changed");
		}
		const { EXCLUDED_FILENAMES, GENERATED_SUFFIXES } = await import("./exclusions.js");
		const result = await sandbox.session.execute({
			command: [this.node, join(this.directory, "dry-worker.mjs")],
			cwd: root,
			input: Buffer.from(
				JSON.stringify({
					version: 1,
					operation,
					directory: this.directory,
					root,
					executable: this.executable,
					profile: this.profile,
					supported: this.formats,
					maxFileBytes: this.config.maxFileBytes,
					timeoutMs: this.config.dryScanTimeoutMs,
					excludedNames: [...EXCLUDED_FILENAMES],
					generatedSuffixes: GENERATED_SUFFIXES,
					authorized: this.authorizedPaths,
					...parameters,
				}),
			),
			signal: AbortSignal.any([signal, this.lifetime.signal]),
			timeoutMs: operation === "serve" ? undefined : this.config.dryScanTimeoutMs,
		});
		if (result.code !== 0) {
			throw new Error(`DRY worker failed: ${result.stderr}`);
		}
		if (this.sandbox !== sandbox || generation !== this.generation || this.lifetime.signal.aborted) {
			throw new Error("DRY result belongs to a retired sandbox");
		}
		return JSON.parse(result.output.toString("utf8")) as T;
	}
	/** Brings the session baseline up to date, updating the running server in place when possible. */
	beginTurn(signal: AbortSignal): Promise<void> {
		return this.scheduleBaseline(signal, "incremental");
	}
	/** Discards the session baseline and rebuilds it from scratch. */
	async refresh(signal: AbortSignal): Promise<void> {
		await this.scheduleBaseline(signal, "rebuild");
	}
	private scheduleBaseline(signal: AbortSignal, mode: "incremental" | "rebuild"): Promise<void> {
		this.turnBaselineVersion++;
		const previous = this.baselineOperation;
		const operation = (async () => {
			await previous?.catch(() => {});
			this.lifetime.signal.throwIfAborted();
			signal.throwIfAborted();
			if (mode === "incremental" && (await this.serverReusable(signal))) {
				try {
					await this.updateBaseline(signal);
					return;
				} catch (error) {
					if (signal.aborted || this.lifetime.signal.aborted) {
						throw error;
					}
				}
			}
			await this.retireServer();
			await this.buildBaseline(signal);
		})();
		this.baselineOperation = operation;
		operation.catch(() => {});
		return operation;
	}
	private async serverReusable(signal: AbortSignal): Promise<boolean> {
		const serverRunning = this.serverOperation !== undefined && !this.serverExited;
		return (
			serverRunning &&
			this.manifest !== undefined &&
			this.serverConfigRevision === this.configRevision &&
			(await this.current(signal))
		);
	}
	private async updateBaseline(signal: AbortSignal): Promise<void> {
		const update = await this.request<{ revision: string; changed: string[]; removed: string[] }>(
			"update",
			{},
			signal,
		);
		if (update.revision === this.manifest?.revision) {
			this.publish({ lastScanAt: Date.now() });
			return;
		}
		const manifest = await this.exportManifest(signal);
		const report = await this.exportReport(signal);
		if (report.manifestRevision !== manifest.revision || manifest.revision !== update.revision) {
			throw new Error("DRY report does not match the updated manifest");
		}
		const restaged = await this.exportIndex(signal, update.changed);
		const filesByPath = new Map(this.files.map((file) => [file.path, file]));
		for (const path of update.removed) {
			filesByPath.delete(path);
		}
		for (const file of restaged) {
			filesByPath.set(file.path, file);
		}
		const files = manifest.files.map((entry) => filesByPath.get(entry.path));
		if (files.some((file, index) => file?.hash !== manifest.files[index]!.hash)) {
			throw new Error("DRY lexical index does not match the updated manifest");
		}
		signal.throwIfAborted();
		this.acceptBaseline(manifest, report, files as DryIndexedFile[]);
	}
	private async exportManifest(signal: AbortSignal): Promise<DryManifest> {
		const manifest = await this.request<DryManifest>("manifest", {}, signal);
		if (!isManifest(manifest)) {
			throw new Error("Invalid DRY manifest");
		}
		return manifest;
	}
	/** Pages lexical index files out of the guest, limited to `paths` when given. */
	private async exportIndex(signal: AbortSignal, paths?: string[]): Promise<DryIndexedFile[]> {
		const files: DryIndexedFile[] = [];
		if (paths?.length === 0) {
			return files;
		}
		let offset: number | null = 0;
		while (offset !== null) {
			const page: { files: DryIndexedFile[]; next: number | null } = await this.request(
				"index",
				{ offset, ...(paths ? { paths } : {}) },
				signal,
			);
			for (const file of page.files) {
				if (!isIndexedFile(file)) {
					throw new Error("Invalid DRY lexical file");
				}
				files.push(file);
			}
			offset = page.next;
		}
		return files;
	}
	private acceptBaseline(manifest: DryManifest, report: DryReport, files: DryIndexedFile[]): void {
		this.manifest = manifest;
		this.report = report;
		this.files = files;
		this.publish({
			scanPhase: "ready",
			warning: this.project && suspectWarning(manifest.suspects, dryProfilePath(this.agentDir, this.project)),
			revision: manifest.revision,
			files: files.length,
			windows: files.reduce((count, file) => count + file.windows.length, 0),
			bytes: manifest.bytes,
			excluded: manifest.excluded.length,
			cloneCounts: report.cloneCounts,
			formats: report.formats.slice(0, 32),
			scanDurationMs: report.scanDurationMs,
			lastScanAt: Date.now(),
		});
	}
	private async buildBaseline(signal: AbortSignal): Promise<void> {
		if (!this.sandbox || this.status.toolPhase !== "ready") {
			throw new Error(this.status.reason ?? "DRY is not initialized");
		}
		this.manifest = undefined;
		this.report = undefined;
		this.files = [];
		this.authorizedPaths = [];
		this.publish({ scanPhase: "scanning", reason: undefined, warning: undefined });
		const serverAbort = new AbortController();
		this.serverAbort = serverAbort;
		this.serverExited = false;
		this.serverConfigRevision = this.configRevision;
		const serverOperation = this.request("serve", {}, serverAbort.signal);
		this.serverOperation = serverOperation;
		void serverOperation
			.catch(() => {})
			.finally(() => {
				if (this.serverOperation === serverOperation) {
					this.serverExited = true;
				}
			});
		try {
			await Promise.race([
				this.request("baseline", {}, signal),
				this.serverOperation.then(() => {
					throw new Error("DRY baseline server exited before readiness");
				}),
			]);
			const manifest = await this.exportManifest(signal);
			const report = await this.exportReport(signal);
			if (report.manifestRevision !== manifest.revision) {
				throw new Error("DRY report does not match the baseline manifest");
			}
			const files = await this.exportIndex(signal);
			signal.throwIfAborted();
			this.acceptBaseline(manifest, report, files);
		} catch (error) {
			serverAbort.abort();
			const failure = this.describeBaselineFailure(error);
			if (!this.lifetime.signal.aborted) {
				this.publish({ scanPhase: "unavailable", reason: failure.message });
			}
			throw failure;
		}
	}
	private describeBaselineFailure(error: unknown): Error {
		const corpusError = parseCorpusError(String(error));
		if (!corpusError || !this.project) {
			return error instanceof Error ? error : new Error(String(error));
		}
		return new Error(corpusErrorMessage(corpusError, dryProfilePath(this.agentDir, this.project)));
	}
	private async exportReport(signal: AbortSignal): Promise<DryReport> {
		const chunks: Buffer[] = [];
		let offset = 0;
		for (;;) {
			const page = await this.request<{ content: string; totalBytes: number }>("report", { offset }, signal);
			if (!Number.isInteger(page.totalBytes) || page.totalBytes < 0 || page.totalBytes > MAX_REPORT_BYTES) {
				throw new Error("DRY report export declares an invalid size");
			}
			const bytes = Buffer.from(page.content, "base64");
			chunks.push(bytes);
			offset += bytes.length;
			if (offset > page.totalBytes) {
				throw new Error("DRY report export exceeds declared size");
			}
			if (offset === page.totalBytes) {
				break;
			}
			if (!bytes.length) {
				throw new Error("DRY report export made no progress");
			}
		}
		const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (!isReport(value)) {
			throw new Error("Invalid normalized DRY report");
		}
		return value;
	}
	async prepare(
		changed: SnapshotFile[],
		authorized: string[],
		signal: AbortSignal,
	): Promise<{ evidence: DryEvidence[]; coverage: DryCoverage[]; manifestRevision: string }> {
		if (!this.baselineOperation) {
			this.beginTurn(signal);
		}
		await this.baselineOperation;
		signal.throwIfAborted();
		if (!this.manifest || !this.sandbox || !this.config) {
			throw new Error(this.status.reason ?? "DRY baseline is unavailable");
		}
		if (this.manifest.truncated) {
			throw new Error("DRY corpus discovery was truncated; increase the scan limit or explicitly waive DRY");
		}
		this.authorizedPaths = authorized.map((path) => relative(this.guestRoot, path));
		const queryFiles: DryIndexedFile[] = [];
		const clones: DryClone[] = [];
		const exclusions = [...this.manifest.excluded];
		const limitations = new Map<string, string>();
		for (const source of changed) {
			if (source.after === null || !source.path.startsWith(`${this.guestRoot}/`)) {
				continue;
			}
			const result = await this.request<SnippetResult>(
				"query",
				{ path: relative(this.guestRoot, source.path), code: source.after },
				signal,
			);
			if ("excluded" in result) {
				exclusions.push(result.excluded);
				continue;
			}
			if (!isIndexedFile(result.file) || !Array.isArray(result.clones)) {
				throw new Error("Invalid DRY snippet response");
			}
			queryFiles.push(result.file);
			clones.push(...result.clones);
			const totalRetrievedMatches = result.retrieved;
			const returnedMatchCount = result.clones.length;
			const hasLimitedMatches = totalRetrievedMatches > returnedMatchCount;
			const limitationReasons = Object.entries(result.unavailable ?? {}).map(
				([kind, reason]) => `${kind}: ${reason}`,
			);
			if (hasLimitedMatches) {
				limitationReasons.unshift("Detector matches limited to 1000");
			}
			if (limitationReasons.length) {
				limitations.set(source.path, limitationReasons.join("; "));
			}
		}
		const result = retrieveDryCandidates(
			this.guestRoot,
			changed,
			{ ...this.manifest, excluded: exclusions },
			this.files,
			clones,
			queryFiles,
		);
		const evidence = await buildDryEvidence(
			this.guestRoot,
			result.candidates,
			changed,
			this.files,
			(path, range, hash) => this.excerpt(path, range, hash, signal),
			queryFiles,
		);
		const currentEvidence = await this.retainCurrentCounterparts(evidence, authorized, signal);
		const coverage = result.coverage.map((entry) => {
			const selected = currentEvidence.filter(
				(pair) => pair.changed.file === entry.file && rangesOverlap(pair.changed.range, entry.ranges[0]!),
			).length;
			const discarded = entry.selected > selected;
			const outcome =
				entry.outcome === "reviewed" && selected === 0 ? ("no_candidates" as const) : entry.outcome;
			const reasonParts = [entry.reason, limitations.get(entry.file)];
			if (discarded) {
				reasonParts.push("Changed or deleted baseline counterparts discarded");
			}
			const reason = reasonParts.filter(Boolean).join("; ") || undefined;
			return { ...entry, selected, outcome, reason };
		});
		return { evidence: currentEvidence, coverage, manifestRevision: this.revision };
	}
	async retainCurrentCounterparts(
		evidence: DryEvidence[],
		authorized: string[],
		signal: AbortSignal,
	): Promise<DryEvidence[]> {
		if (!this.sandbox || !this.config) {
			throw new Error("DRY sandbox is unavailable");
		}
		const paths = [...new Set(evidence.map((pair) => pair.counterpart.file))];
		const hostPaths = await Promise.all(
			paths.map(async (path) => {
				const hostPath = await this.sandbox!.hostPath?.(path);
				if (this.sandbox!.hostPath && !hostPath) {
					throw new Error("DRY evidence is outside approved host mappings");
				}
				return hostPath ?? path;
			}),
		);
		await this.sandbox.authorizeHostSources?.(hostPaths, signal);
		const hashes = new Map<string, string>();
		for (const path of paths) {
			try {
				const text = await readGuestSnapshot(
					this.sandbox,
					path,
					this.config,
					authorized.includes(path),
					signal,
				);
				if (text !== null) {
					hashes.set(path, sourceContentHash(text));
				}
			} catch (error) {
				signal.throwIfAborted();
				const unavailableSource =
					String(error).includes("FileNotFoundError") || error instanceof CoverageError;
				if (!unavailableSource) {
					throw error;
				}
			}
		}
		return evidence.filter((pair) => hashes.get(pair.counterpart.file) === pair.counterpart.hash);
	}
	async current(signal: AbortSignal): Promise<boolean> {
		signal.throwIfAborted();
		if (!this.manifest || !this.sandbox || !this.project || this.lifetime.signal.aborted) {
			return false;
		}
		const mappedRoot = await this.sandbox.guestPath?.(this.project.root);
		return (
			mappedRoot === this.guestRoot &&
			this.generation === `${this.sandbox.sessionId}:${this.sandbox.session.generation}`
		);
	}
	async excerpt(path: string, range: [number, number], hash: string, signal: AbortSignal): Promise<string> {
		return (await this.request<{ text: string }>("evidence", { path, range, hash }, signal)).text;
	}
	private async retireServer(): Promise<void> {
		this.serverAbort?.abort();
		await this.serverOperation?.catch(() => {});
		this.serverAbort = undefined;
		this.serverOperation = undefined;
	}
	async stop(): Promise<void> {
		this.startupEpoch++;
		this.lifetime.abort();
		await this.retireServer();
		await this.baselineOperation?.catch(() => {});
		if (this.sandbox && this.directory.startsWith("/tmp/pi-quality-dry-") && this.node) {
			const removeDirectoryScript =
				"require('node:fs').rmSync(process.argv[1], { recursive: true, force: true })";
			await this.sandbox.session
				.execute({ command: [this.node, "-e", removeDirectoryScript, this.directory], timeoutMs: 5000 })
				.catch(() => {});
		}
		this.baselineOperation = undefined;
		this.releaseRetirement?.();
		this.releaseRetirement = undefined;
		this.sandbox = undefined;
		this.manifest = undefined;
		this.report = undefined;
		this.files = [];
		this.authorizedPaths = [];
		this.generation = "";
		this.executable = "";
		this.publish({ toolPhase: "off", scanPhase: "off" });
	}
}
