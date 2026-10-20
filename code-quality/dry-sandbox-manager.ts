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
import { isIndexedFile } from "./dry-worker-schema.js";
import { readBaselineExport, type DryExportResult } from "./dry-export-reader.js";
import { DryBaselineDeadline } from "./dry-baseline-deadline.js";
import type { DryBaselineExport } from "./dry-export.mjs";
import { digest } from "./proposal.js";
import { qualitySandbox, readGuestSnapshot, type QualitySandbox } from "./sandbox.js";

interface GuestBaselineTimings {
	captureMs: number;
	detectorMs: number;
	exportPreparationMs: number;
}
interface BaselineReady {
	export: DryBaselineExport;
	timings: GuestBaselineTimings;
}
interface BaselineUpdate {
	revision: string;
	changed: string[];
	removed: string[];
	export?: DryBaselineExport;
	timings: GuestBaselineTimings;
}
const GUEST_BASELINE_PHASES = ["capture", "detector", "export preparation"] as const;
function isGuestBaselinePhase(value: unknown): value is (typeof GUEST_BASELINE_PHASES)[number] {
	return GUEST_BASELINE_PHASES.some((phase) => phase === value);
}
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
			JSON.stringify([this.profile, this.config?.maxFileBytes, this.executable, "sharded-baseline-v2"]),
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
					`DRY requires managed jscpd 5.4.1 and node-runtime. Add {"jscpd":{"kind":"catalog","version":"5.4.1"}} to ${join(this.agentDir, "extensions", "pi-devcontainer-sandbox", "global", "tools.json")} using Sandbox Tools or /sandbox setup global tools, then reload and approve rebuild.`,
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
				"dry-export.mjs",
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
		timeoutMs = this.config?.dryScanTimeoutMs,
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
					timeoutMs,
					excludedNames: [...EXCLUDED_FILENAMES],
					generatedSuffixes: GENERATED_SUFFIXES,
					authorized: this.authorizedPaths,
					...parameters,
				}),
			),
			signal: AbortSignal.any([signal, this.lifetime.signal]),
			timeoutMs: operation === "serve" ? undefined : timeoutMs,
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
			const deadline = new DryBaselineDeadline(
				this.config!.dryScanTimeoutMs,
				AbortSignal.any([signal, this.lifetime.signal]),
			);
			try {
				if (mode === "incremental" && (await deadline.wait(this.serverReusable(deadline.signal)))) {
					try {
						await this.updateBaseline(deadline);
						return;
					} catch (error) {
						if (deadline.signal.aborted) {
							throw error;
						}
					}
				}
				deadline.phase = "server retirement";
				await deadline.wait(this.retireServer());
				await this.buildBaseline(deadline);
			} catch (error) {
				this.serverAbort?.abort();
				const failure = this.describeBaselineFailure(
					deadline.signal.aborted ? deadline.signal.reason : error,
				);
				if (!this.lifetime.signal.aborted) {
					this.publish({ scanPhase: "unavailable", reason: failure.message, baselinePhase: deadline.phase });
				}
				throw failure;
			} finally {
				deadline.close();
			}
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
	private async updateBaseline(deadline: DryBaselineDeadline): Promise<void> {
		const signal = deadline.signal;
		const update = await this.awaitGuestBaseline<BaselineUpdate>("update", deadline);
		this.assertArtifactOwner(this.sandbox!, signal);
		if (update.revision === this.manifest?.revision) {
			const baselineDurationMs = performance.now() - deadline.startedAt;
			const baselineTimings = { ...update.timings, transferValidationMs: 0 };
			this.publish({
				scanPhase: "ready",
				baselinePhase: undefined,
				lastScanAt: Date.now(),
				baselineDurationMs,
				baselineTimings,
				indexBytes: 0,
				indexShards: 0,
			});
			return;
		}
		const exported = await this.loadBaselineExport(update.export, deadline);
		const { manifest, report, files: restaged } = exported;
		if (
			manifest.revision !== update.revision ||
			restaged.length !== update.changed.length ||
			restaged.some((file) => !update.changed.includes(file.path))
		) {
			throw new Error("DRY export does not match the updated paths/revision");
		}
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
		this.publishBaselineMetrics(exported, update.timings, deadline);
	}
	private assertArtifactOwner(sandbox: QualitySandbox, signal: AbortSignal): void {
		signal.throwIfAborted();
		if (
			this.sandbox !== sandbox ||
			this.generation !== `${sandbox.sessionId}:${sandbox.session.generation}` ||
			this.lifetime.signal.aborted ||
			this.serverExited
		) {
			throw new Error("DRY artifact belongs to a retired sandbox/worker");
		}
	}
	private async readPrivateArtifact(path: string, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
		const sandbox = this.sandbox!;
		this.assertArtifactOwner(sandbox, signal);
		const stat = await sandbox.session.filesystem.stat(path, signal);
		if (!stat.file || stat.size > maxBytes) {
			throw new Error(`DRY artifact exceeds its bounded read: ${path}`);
		}
		const bytes = await sandbox.session.filesystem.read(path, signal);
		this.assertArtifactOwner(sandbox, signal);
		if (bytes.length > maxBytes) {
			throw new Error(`DRY artifact exceeds its bounded read: ${path}`);
		}
		return bytes;
	}
	private async awaitGuestBaseline<T>(
		operation: "baseline" | "update",
		deadline: DryBaselineDeadline,
	): Promise<T> {
		deadline.phase = "capture";
		this.publish({ scanPhase: "scanning", baselinePhase: deadline.phase });
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const pollPhase = async () => {
			try {
				const bytes = await this.readPrivateArtifact(
					join(this.directory, "phase.json"),
					1024,
					deadline.signal,
				);
				const value = JSON.parse(bytes.toString("utf8")) as { phase?: string };
				if (!stopped && isGuestBaselinePhase(value.phase)) {
					deadline.phase = value.phase;
					this.publish({ baselinePhase: deadline.phase });
				}
			} catch {
				if (deadline.signal.aborted) {
					return;
				}
			}
			if (!stopped && !deadline.signal.aborted) {
				timer = setTimeout(() => void pollPhase(), 250);
			}
		};
		void pollPhase();
		try {
			return await deadline.wait(
				Promise.race([
					this.request<T>(operation, {}, deadline.signal, deadline.remainingMs),
					this.serverOperation!.then(() => {
						throw new Error("DRY baseline server exited before readiness");
					}),
				]),
			);
		} finally {
			stopped = true;
			clearTimeout(timer);
		}
	}
	private async loadBaselineExport(
		value: unknown,
		deadline: DryBaselineDeadline,
	): Promise<DryExportResult & { transferValidationMs: number }> {
		const started = performance.now();
		const result = await deadline.wait(
			readBaselineExport(
				this.directory,
				value,
				{
					read: (path, maxBytes, signal) => deadline.wait(this.readPrivateArtifact(path, maxBytes, signal)),
					phase: (name) => {
						deadline.phase = name;
						this.publish({ baselinePhase: name });
					},
				},
				deadline.signal,
			),
		);
		this.assertArtifactOwner(this.sandbox!, deadline.signal);
		return { ...result, transferValidationMs: performance.now() - started };
	}
	private publishBaselineMetrics(
		exported: DryExportResult & { transferValidationMs: number },
		timings: GuestBaselineTimings,
		deadline: DryBaselineDeadline,
	): void {
		const baselineDurationMs = performance.now() - deadline.startedAt;
		const transferValidationMs = exported.transferValidationMs;
		const baselineTimings = { ...timings, transferValidationMs };
		this.publish({
			baselinePhase: undefined,
			baselineDurationMs,
			baselineTimings,
			indexBytes: exported.indexBytes,
			indexShards: exported.indexShards,
		});
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
			analyzedFiles: report.analyzedFiles,
			lastScanAt: Date.now(),
		});
	}
	private async buildBaseline(deadline: DryBaselineDeadline): Promise<void> {
		const signal = deadline.signal;
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
			const ready = await this.awaitGuestBaseline<BaselineReady>("baseline", deadline);
			const exported = await this.loadBaselineExport(ready.export, deadline);
			if (exported.files.length !== exported.manifest.files.length) {
				throw new Error("DRY initial lexical export does not cover the manifest");
			}
			signal.throwIfAborted();
			this.acceptBaseline(exported.manifest, exported.report, exported.files);
			this.publishBaselineMetrics(exported, ready.timings, deadline);
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
