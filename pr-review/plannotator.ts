import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { representatives } from "./findings.js";
import { assertSupportedPlannotatorVersion, supportedPlannotatorVersions } from "./plannotator-version.js";
import { redact, renderAdvisory } from "./report.js";
import { ensurePrivateDirectory, inside } from "./storage.js";
import type { Snapshot } from "./snapshot.js";
import type { Report } from "./types.js";

export interface Annotation {
	id?: string;
	source: string;
	author?: string;
	type: string;
	scope: string;
	filePath: string;
	lineStart: number;
	lineEnd: number;
	side: string;
	text: string;
	reasoning?: string;
	severity?: string;
	inReplyTo?: string;
}
export interface Seed {
	annotation: Annotation;
	findingIds: string[];
}
export interface BrowserDecision {
	approved: boolean;
	feedback: string;
	annotations: unknown[];
	exit?: boolean;
}
const instructions =
	"Send Feedback requests fixes for the verified finding comments you submit. Remove unwanted findings; hiding/filtering is not selection. Questions, objections, edited findings and replies return to the main agent for discussion. Approve/LGTM and Close request no automatic fixes. This is a captured diff, not a live repository browser.";
export function viewerDiffType(report: Pick<Report, "scope" | "baseline" | "head">): string {
	if (report.scope.kind === "local") return report.baseline === report.head ? "uncommitted" : "last-commit";
	return report.scope.committedOnly ? "branch" : "since-base";
}
export function seeds(report: Report, snapshot: Snapshot): Seed[] {
	const source = `pr-review:${report.id}`;
	const result: Seed[] = [
		{
			findingIds: [],
			annotation: {
				source,
				type: "comment",
				scope: "general",
				filePath: "",
				lineStart: 0,
				lineEnd: 0,
				side: "new",
				text: redact(
					`Review status: ${report.status}. ${report.changedFiles} changed files in scope, ${report.omitted.length} excluded/unavailable.\nScope: ${JSON.stringify(report.scope)}. Baseline: ${report.baseline ?? "empty tree"}; HEAD: ${report.head ?? "unborn"}; captured target: ${report.fingerprint.slice(0, 12)}.\n${report.issues.join("\n")}\n\n${instructions}`,
				),
			},
		},
	];
	for (const { primary, members } of representatives(report.findings, report.groups)) {
		const metadataOnly = snapshot.changes.find(
			(change) => change.file === primary.file || change.oldPath === primary.file,
		)?.metadataOnly;
		result.push({
			findingIds: members.map((finding) => finding.id),
			annotation: {
				source,
				author: [...new Set(members.map((finding) => finding.reviewer))].join(", "),
				type: "concern",
				scope: metadataOnly ? "file" : "line",
				filePath: primary.file,
				lineStart: metadataOnly ? 0 : primary.startLine,
				lineEnd: metadataOnly ? 0 : primary.endLine,
				side: primary.side,
				text: redact(
					`[${primary.severity}] ${primary.id}: ${primary.title}\n\n${primary.problem}\n\nSuggested change:\n${primary.suggestion}\n\n${primary.rationale}`,
				),
				reasoning: redact(
					members
						.flatMap((finding) =>
							finding.evidence.map(
								(evidence) => `${evidence.file}:${evidence.line} (${evidence.side}) — ${evidence.quote}`,
							),
						)
						.join("\n"),
				),
				severity: primary.severity === "low" ? "nit" : "important",
			},
		});
	}
	for (const advisory of report.advisories ?? [])
		result.push({
			findingIds: [],
			annotation: {
				source,
				author: "Architecture advisory (unverified)",
				type: "comment",
				scope: "general",
				filePath: "",
				lineStart: 0,
				lineEnd: 0,
				side: "new",
				text: renderAdvisory(advisory),
			},
		});
	return result;
}
const signatureFields = [
	"source",
	"type",
	"scope",
	"filePath",
	"lineStart",
	"lineEnd",
	"side",
	"text",
	"reasoning",
	"severity",
	"suggestedCode",
	"conventionalLabel",
	"inReplyTo",
];
function signature(value: Record<string, unknown>): string {
	return JSON.stringify(signatureFields.map((key) => value[key] ?? null));
}
function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
export function interpretDecision(
	raw: unknown,
	seeds: Seed[],
	ids: string[],
): NonNullable<Report["browser"]> {
	const value = record(raw);
	if (
		!value ||
		typeof value.approved !== "boolean" ||
		typeof value.feedback !== "string" ||
		value.feedback.length > 500000 ||
		(value.exit !== undefined && typeof value.exit !== "boolean") ||
		!Array.isArray(value.annotations) ||
		value.annotations.length > 2000 ||
		ids.length !== seeds.length ||
		new Set(ids).size !== ids.length
	)
		throw new Error("Incompatible browser decision; no fixes authorized");
	const discussion: unknown[] = [];
	const requested = new Set<string>();
	const blocked = new Set<string>();
	const known = new Map(ids.map((id, index) => [id, seeds[index]!]));
	const items = value.annotations.map(record);
	const byId = new Map(
		items
			.filter((item): item is Record<string, unknown> => Boolean(item && typeof item.id === "string"))
			.map((item) => [item.id as string, item]),
	);
	if (byId.size !== items.length)
		throw new Error("Duplicate or invalid browser annotation IDs; no fixes authorized");
	for (const item of items) {
		if (!item) continue;
		const seed = known.get(item.id as string);
		if (seed) {
			if (signature(item) === signature(seed.annotation as unknown as Record<string, unknown>))
				for (const id of seed.findingIds) requested.add(id);
			else {
				discussion.push(item);
				for (const id of seed.findingIds) blocked.add(id);
			}
		} else discussion.push(item);
		const seen = new Set<string>();
		let parent = item.inReplyTo;
		while (typeof parent === "string" && !seen.has(parent)) {
			seen.add(parent);
			for (const id of known.get(parent)?.findingIds ?? []) blocked.add(id);
			parent = byId.get(parent)?.inReplyTo;
		}
	}
	for (const id of blocked) requested.delete(id);
	const decision = value.exit === true ? "dismissed" : value.approved ? "lgtm" : "feedback";
	return {
		decision,
		requestedIds: decision === "feedback" ? [...requested] : [],
		discussion,
		feedback: redact(value.feedback),
	};
}
export async function installedPlannotator(pi: Pick<ExtensionAPI, "getCommands">): Promise<string> {
	for (const command of pi.getCommands()) {
		if (command.source !== "extension" || !/^plannotator-review(?::\d+)?$/.test(command.name)) continue;
		let directory = command.sourceInfo.path;
		if (!(await stat(directory)).isDirectory()) directory = dirname(directory);
		for (let depth = 0; depth < 5; depth++) {
			try {
				const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
				if (manifest.name === "@plannotator/pi-extension") {
					assertSupportedPlannotatorVersion(manifest.version);
					await stat(join(directory, "server.ts"));
					await stat(join(directory, "review-editor.html"));
					return directory;
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			directory = dirname(directory);
		}
	}
	throw new Error(
		`PR review requires the already-loaded supported Plannotator extension (${supportedPlannotatorVersions.join(", ")}). No packages will be installed automatically.`,
	);
}
async function cleanupAbandoned(directory: string): Promise<void> {
	for (const name of await readdir(directory)) {
		if (!name.startsWith("viewer-")) continue;
		const path = join(directory, name);
		try {
			const owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
			if (owner.kind !== "pr-review-viewer" || !Number.isSafeInteger(owner.pid) || owner.pid < 1) continue;
			try {
				process.kill(owner.pid, 0);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH")
					await rm(path, { recursive: true, force: true });
			}
		} catch {
			/* Unknown directories are not ours to remove. */
		}
	}
}
/** Export with backpressure. The helper, not Pi's TUI process, loads the final aggregate. */
export async function prepareViewerPatch(
	snapshot: Snapshot,
	directory: string,
	signal: AbortSignal,
): Promise<string> {
	const name = "diff.patch",
		destination = join(directory, name);
	signal.throwIfAborted();
	if (snapshot.writePatch) await snapshot.writePatch(destination, signal);
	else {
		async function* chunks() {
			for (const change of snapshot.changes) {
				const descriptor = Object.getOwnPropertyDescriptor(change, "patch");
				if (!descriptor || typeof descriptor.value !== "string")
					throw new Error("Lazy snapshots must provide a streamed patch export");
				const text = descriptor.value as string;
				for (let offset = 0; offset < text.length; ) {
					signal.throwIfAborted();
					let end = Math.min(text.length, offset + 16000);
					if (
						end < text.length &&
						/[\uD800-\uDBFF]/.test(text[end - 1]!) &&
						/[\uDC00-\uDFFF]/.test(text[end]!)
					)
						end--;
					yield text.slice(offset, end);
					offset = end;
				}
			}
		}
		await pipeline(
			Readable.from(chunks(), { objectMode: false }),
			createWriteStream(destination, { flags: "wx", mode: 0o600 }),
			{ signal },
		);
	}
	signal.throwIfAborted();
	return name;
}
export async function present(options: {
	root: string;
	piPackageDir: string;
	plannotatorDir: string;
	report: Report;
	snapshot: Snapshot;
	signal: AbortSignal;
	progress: (message: string) => void;
	openBrowser?: boolean;
}): Promise<NonNullable<Report["browser"]>> {
	const annotations = seeds(options.report, options.snapshot);
	const parent = join(options.root, "viewer-sessions");
	await ensurePrivateDirectory(parent);
	await cleanupAbandoned(parent);
	const directory = await mkdtemp(join(parent, "viewer-"));
	await writeFile(
		join(directory, "owner.json"),
		JSON.stringify({ kind: "pr-review-viewer", pid: process.pid }),
		{ mode: 0o600 },
	);
	let patchFile: string;
	try {
		patchFile = await prepareViewerPatch(options.snapshot, directory, options.signal);
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
	const executable = /^(node|bun)(\.exe)?$/.test(basename(process.execPath)) ? process.execPath : "node";
	const child = spawn(
		executable,
		[
			fileURLToPath(new URL("./plannotator-host.mjs", import.meta.url)),
			options.piPackageDir,
			options.plannotatorDir,
		],
		{
			cwd: directory,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				PLANNOTATOR_AI: "disabled",
				PLANNOTATOR_SHARE: "disabled",
				PLANNOTATOR_REMOTE: "0",
				PLANNOTATOR_PORT: "",
				PLANNOTATOR_GLIMPSE: "0",
				PLANNOTATOR_DATA_DIR: join(directory, "data"),
				TMPDIR: directory,
				TMP: directory,
				TEMP: directory,
				PI_CODING_AGENT_DIR: join(directory, "agent"),
				PI_OFFLINE: "1",
				PI_SKIP_VERSION_CHECK: "1",
			},
		},
	);
	let exited = false;
	const closed = new Promise<void>((resolve) =>
		child.once("close", () => {
			exited = true;
			resolve();
		}),
	);
	const lines = createInterface({ input: child.stdout });
	let ids: string[] | undefined;
	let decision: unknown;
	let outputBytes = 0;
	let rejectPending: (error: Error) => void = () => {};
	const abort = () => {
		child.stdin.write('{"type":"cancel"}\n');
		rejectPending(new Error("Browser review cancelled; no fixes authorized"));
	};
	let startupTimer: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = new Promise<void>((resolve, reject) => {
			rejectPending = reject;
			startupTimer = setTimeout(() => reject(new Error("Plannotator viewer startup timed out")), 30000);
			child.on("error", () => reject(new Error("Cannot start the local viewer runtime")));
			child.stdin.on("error", () => reject(new Error("Viewer input closed")));
			child.stderr.on("data", () => {}); // Drain without exposing provider/environment diagnostics.
			lines.on("line", (line) => {
				outputBytes += Buffer.byteLength(line);
				if (outputBytes > 4 * 1024 * 1024) {
					reject(new Error("Viewer response exceeded budget"));
					return;
				}
				if (!line.startsWith("PR_REVIEW_UI ")) return;
				try {
					const event = JSON.parse(line.slice("PR_REVIEW_UI ".length));
					if (event.type === "ready") {
						if (
							ids ||
							!Array.isArray(event.ids) ||
							event.ids.length !== annotations.length ||
							!event.ids.every((id: unknown) => typeof id === "string")
						)
							throw new Error("Invalid annotation seeding acknowledgement");
						ids = event.ids;
						clearTimeout(startupTimer);
						options.progress(`Review findings in Plannotator: ${event.url}`);
					} else if (event.type === "decision") {
						if (!ids || decision !== undefined) throw new Error("Unbound or duplicate viewer decision");
						decision = event.decision;
					} else if (event.type === "error")
						reject(new Error("Plannotator viewer failed; no fixes authorized"));
				} catch (error) {
					reject(error instanceof Error ? error : new Error("Invalid viewer protocol"));
				}
			});
			child.once("close", (code) => {
				if (code !== 0 || decision === undefined || !ids)
					reject(new Error("Viewer closed without a valid submitted decision"));
				else resolve();
			});
		});
		options.signal.addEventListener("abort", abort, { once: true });
		if (options.signal.aborted) abort();
		else
			child.stdin.write(
				`${JSON.stringify({ type: "start", diffType: viewerDiffType(options.report), base: options.report.baseline, patchFile, label: `${options.report.project}: ${options.report.baseline ?? "empty"} → captured ${options.report.fingerprint.slice(0, 12)}`, annotations: annotations.map((seed) => seed.annotation), openBrowser: options.openBrowser ?? true })}\n`,
			);
		await result;
		options.signal.throwIfAborted();
		return interpretDecision(decision, annotations, ids!);
	} finally {
		clearTimeout(startupTimer);
		options.signal.removeEventListener("abort", abort);
		if (!exited) child.kill("SIGTERM");
		const force = setTimeout(() => {
			if (!exited) child.kill("SIGKILL");
		}, 3000);
		await closed;
		clearTimeout(force);
		lines.close();
		if (inside(parent, directory)) await rm(directory, { recursive: true, force: true });
	}
}
