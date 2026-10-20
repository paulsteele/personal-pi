import { spawn } from "node:child_process";
import { createServer, createConnection } from "node:net";
import { createInterface } from "node:readline";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { prepareBaselineExport } from "./dry-export.mjs";

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
function isFormatWithoutAstSupport(format) {
	return [
		"json",
		"json5",
		"yaml",
		"toml",
		"ini",
		"bash",
		"powershell",
		"sql",
		"css",
		"scss",
		"less",
		"sass",
		"graphql",
		"protobuf",
		"hcl",
		"nix",
		"makefile",
		"cmake",
		"docker",
		"nginx",
		"bicep",
	].includes(format);
}
export function detectorKinds(profile) {
	const kinds = ["exact"];
	if (profile.ignoreIdentifiers || profile.ignoreLiterals) {
		kinds.push("renamed");
	}
	if (profile.maxGapLines > 0) {
		kinds.push("gap");
	}
	if (profile.similarity > 0) {
		kinds.push("ast");
	}
	return kinds;
}

export class JscpdClient {
	pending = new Map();
	sequence = 0;
	stderr = "";
	constructor(command, args, cwd, timeoutMs) {
		this.timeoutMs = timeoutMs;
		this.child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
		this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
		let bufferedBytes = 0;
		this.child.stdout.on("data", (bytes) => {
			bufferedBytes += bytes.length;
			if (bufferedBytes > MAX_MESSAGE_BYTES) {
				this.fail(new Error("jscpd protocol output exceeds budget"));
				this.child.kill("SIGKILL");
			}
			const newline = bytes.lastIndexOf(10);
			if (newline >= 0) {
				bufferedBytes = bytes.length - newline - 1;
			}
		});
		this.lines.on("line", (line) => {
			try {
				if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) {
					throw new Error("jscpd protocol message exceeds budget");
				}
				const reply = JSON.parse(line);
				const waiter = this.pending.get(reply.id);
				if (!waiter) {
					return;
				}
				this.pending.delete(reply.id);
				clearTimeout(waiter.timer);
				if (reply.error) {
					waiter.reject(new Error(`jscpd protocol error: ${reply.error.message}`));
				} else {
					waiter.resolve(reply.result);
				}
			} catch (error) {
				this.fail(error);
				this.child.kill("SIGKILL");
			}
		});
		this.child.stderr.on("data", (bytes) => {
			this.stderr = (this.stderr + bytes).slice(-16000);
		});
		this.child.stdin.on("error", (error) => this.fail(error));
		this.child.on("error", (error) => this.fail(error));
		this.closed = new Promise((resolve) => {
			this.child.once("close", (code) => {
				this.failure = new Error(`jscpd baseline exited (${code}): ${this.stderr}`);
				this.fail(this.failure);
				resolve();
			});
		});
	}
	fail(error) {
		this.failure = error;
		for (const waiter of this.pending.values()) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
		this.pending.clear();
	}
	request(method, params) {
		if (this.failure) {
			return Promise.reject(this.failure);
		}
		const id = ++this.sequence;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`jscpd ${method} timed out`));
				this.child.kill("SIGKILL");
			}, this.timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	}
	async initialize() {
		const result = await this.request("initialize", {
			protocolVersion: "2025-11-25",
			capabilities: {},
			clientInfo: { name: "pi-code-quality", version: "1" },
		});
		if (result?.serverInfo?.version !== "5.4.1") {
			throw new Error("Unexpected jscpd baseline version");
		}
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	}
	async call(name, args) {
		const result = await this.request("tools/call", { name, arguments: args });
		if (result?.isError) {
			throw new Error(`jscpd ${name} failed: ${JSON.stringify(result.content)}`);
		}
		const value = result?.structuredContent ?? JSON.parse(result?.content?.[0]?.text ?? "null");
		if (!value || typeof value !== "object") {
			throw new Error(`Invalid jscpd ${name} response`);
		}
		return value;
	}
	async stop() {
		this.fail(new Error("jscpd baseline retired"));
		this.child.kill("SIGKILL");
		await this.closed;
		this.lines.close();
	}
}

function lineRange(start, end, lines) {
	if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines) {
		throw new Error("Invalid jscpd snippet location");
	}
	return [start, end];
}
export function snippetClones(value, query, manifest) {
	if (
		!Array.isArray(value.duplications) ||
		!Number.isInteger(value.count) ||
		value.count < value.duplications.length
	) {
		throw new Error("Invalid jscpd snippet matches");
	}
	const clones = value.duplications.map((match) => {
		const counterpart = manifest.files.find((file) => file.path === match.file);
		if (
			!counterpart ||
			!["exact", "renamed", "similar"].includes(match.kind) ||
			!Number.isInteger(match.tokens) ||
			match.tokens < 0
		) {
			throw new Error("Invalid jscpd snippet counterpart");
		}
		if (match.method !== undefined && !["gap", "ast"].includes(match.method)) {
			throw new Error("Invalid jscpd snippet method");
		}
		if (
			match.similarity !== undefined &&
			(!Number.isFinite(match.similarity) || match.similarity < 0 || match.similarity > 1)
		) {
			throw new Error("Invalid jscpd snippet similarity");
		}
		return {
			snippet: {
				path: query.path,
				range: lineRange(match.snippetStartLine, match.snippetEndLine, query.code.split("\n").length),
			},
			counterpart: {
				path: match.file,
				range: lineRange(match.fileStartLine, match.fileEndLine, counterpart.lines),
			},
			kind: match.kind,
			tokens: match.tokens,
			...(match.method ? { method: match.method } : {}),
			...(match.similarity === undefined ? {} : { similarity: match.similarity }),
		};
	});
	return { clones, retrieved: value.count, note: value.note, unavailable: value.unavailable };
}

async function writeReport(options, client, manifest, scanStarted) {
	const stats = await client.call("get_statistics", { kinds: detectorKinds(options.profile) });
	if (!Number.isInteger(stats.files) || stats.files < 0 || !stats.statistics?.total || !stats.byKind) {
		throw new Error("Invalid jscpd baseline statistics");
	}
	if (
		stats.unavailable ||
		/unknown (?:key|field)|invalid (?:value|config)|configuration.*error/i.test(client.stderr)
	) {
		throw new Error(
			`jscpd baseline configuration unavailable: ${JSON.stringify(stats.unavailable ?? client.stderr)}`,
		);
	}
	const cloneCounts = Object.fromEntries(
		["exact", "renamed", "gap", "ast"].map((kind) => [kind, stats.byKind[kind] ?? 0]),
	);
	const formats = Object.entries(stats.statistics.formats ?? {}).map(([name, entry]) => ({
		name,
		files: entry.sources,
	}));
	const report = {
		version: 1,
		manifestRevision: manifest.revision,
		cloneCounts,
		analyzedFiles: stats.files,
		formats,
		scanDurationMs: performance.now() - scanStarted,
	};
	await writeFile(join(options.directory, "report.json"), JSON.stringify(report), { mode: 0o600 });
	return report;
}
/**
 * Serves one session baseline. `update` requests restage changed sources and rescan in the same
 * jscpd process instead of rebuilding the baseline.
 */
export async function serveBaseline(options, capture, configure, updateCapture) {
	const socketPath = join(options.directory, "baseline.sock");
	let client;
	let manifest;
	let queue = Promise.resolve();
	let baselineExport;
	const writeBaselinePhase = async (phaseName) => {
		await writeFile(join(options.directory, "phase.json"), JSON.stringify({ phase: phaseName }), {
			mode: 0o600,
		});
	};
	const createBaselineTimings = (captureMs) => ({ captureMs, detectorMs: 0, exportPreparationMs: 0 });
	const publishBaselineExport = async (report, changedPaths, timings) => {
		await writeBaselinePhase("export preparation");
		const started = performance.now();
		baselineExport = await prepareBaselineExport(options, manifest, report, changedPaths);
		timings.exportPreparationMs = performance.now() - started;
		await writeBaselinePhase("idle");
		return { export: baselineExport, timings };
	};
	const update = async () => {
		await writeBaselinePhase("capture");
		const started = performance.now();
		const updated = await updateCapture(options);
		const timings = createBaselineTimings(performance.now() - started);
		const revisionChanged = updated.manifest.revision !== manifest.revision;
		manifest = updated.manifest;
		const result = {
			revision: manifest.revision,
			changed: updated.changed,
			removed: updated.removed,
			timings,
		};
		if (!revisionChanged) {
			await writeBaselinePhase("idle");
			return result;
		}
		await writeBaselinePhase("detector");
		const detectorStarted = performance.now();
		if (updated.changed.length || updated.removed.length) {
			await client.call("check_current_directory", { kinds: detectorKinds(options.profile), limit: 0 });
		}
		const report = await writeReport(options, client, manifest, detectorStarted);
		timings.detectorMs = report.scanDurationMs;
		return { ...result, ...(await publishBaselineExport(report, updated.changed, timings)) };
	};
	const baseline = (async () => {
		await writeBaselinePhase("capture");
		const captureStarted = performance.now();
		manifest = await capture(options);
		const timings = createBaselineTimings(performance.now() - captureStarted);
		await mkdir(join(options.directory, "sources"), { recursive: true, mode: 0o700 });
		const configPath = await configure(options);
		await writeBaselinePhase("detector");
		const started = performance.now();
		client = new JscpdClient(
			options.executable,
			[
				"--mcp",
				"--config",
				configPath,
				"--workers",
				String(options.profile.workers),
				"--cross-formats",
				"js-ts",
				join(options.directory, "sources"),
			],
			options.directory,
			options.timeoutMs,
		);
		await client.initialize();
		const report = await writeReport(options, client, manifest, started);
		timings.detectorMs = report.scanDurationMs;
		return { ready: true, ...(await publishBaselineExport(report, undefined, timings)) };
	})();
	let resolveBaselineFailureReported;
	const baselineFailureReported = new Promise((resolve) => {
		resolveBaselineFailureReported = resolve;
	});
	const reportBaselineFailure = () => resolveBaselineFailureReported();
	const sockets = new Set();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("error", () => {});
		socket.once("close", () => sockets.delete(socket));
		let input = "";
		let submitted = false;
		socket.on("data", (bytes) => {
			if (submitted) {
				return;
			}
			input += bytes;
			if (Buffer.byteLength(input) > MAX_MESSAGE_BYTES) {
				socket.destroy();
				return;
			}
			if (!input.includes("\n")) {
				return;
			}
			const message = input;
			submitted = true;
			input = "";
			const operation = queue.then(async () => {
				const request = JSON.parse(message);
				const ready = await baseline;
				if (request.operation === "baseline") {
					return { ...ready, export: baselineExport };
				}
				if (request.operation === "update") {
					return update();
				}
				if (request.operation !== "query" || typeof request.code !== "string") {
					throw new Error("Invalid DRY baseline query");
				}
				const codeExceedsFileLimit = Buffer.byteLength(request.code) > options.maxFileBytes;
				if (codeExceedsFileLimit) {
					throw new Error("DRY baseline query exceeds maxFileBytes");
				}
				let kinds = detectorKinds(options.profile);
				if (isFormatWithoutAstSupport(request.format)) {
					kinds = kinds.filter((kind) => kind !== "ast");
				}
				const result = await client.call("check_duplication", {
					code: request.code,
					format: request.format,
					kinds,
					limit: 1000,
				});
				return snippetClones(result, request, manifest);
			});
			queue = operation.catch(() => {});
			void operation.then(
				(value) => socket.end(`${JSON.stringify({ value })}\n`),
				(error) =>
					socket.end(`${JSON.stringify({ error: String(error) })}\n`, () => {
						reportBaselineFailure();
					}),
			);
		});
	});
	let retire;
	const retired = new Promise((resolve) => {
		retire = resolve;
	});
	process.once("SIGTERM", retire);
	process.once("SIGINT", retire);
	let failureDeliveryTimer;
	const baselineLifetime = baseline.then(
		() => client.closed,
		async (error) => {
			const failureDeliveryDeadline = new Promise((resolve) => {
				failureDeliveryTimer = setTimeout(resolve, options.timeoutMs);
			});
			await Promise.race([baselineFailureReported, retired, failureDeliveryDeadline]);
			throw error;
		},
	);
	try {
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, resolve);
		});
		await Promise.race([retired, baselineLifetime]);
	} finally {
		clearTimeout(failureDeliveryTimer);
		process.removeListener("SIGTERM", retire);
		process.removeListener("SIGINT", retire);
		for (const socket of sockets) {
			socket.destroy();
		}
		server.close();
		await client?.stop();
		await baseline.catch(() => {});
		await unlink(socketPath).catch(() => {});
	}
}

export async function queryBaseline(options) {
	const deadline = Date.now() + options.timeoutMs;
	for (;;) {
		try {
			return await new Promise((resolve, reject) => {
				const socket = createConnection(join(options.directory, "baseline.sock"));
				let reply = "";
				socket.setTimeout(Math.max(1, deadline - Date.now()), () =>
					socket.destroy(new Error("DRY baseline request timed out")),
				);
				socket.once("error", reject);
				socket.once("connect", () => socket.write(`${JSON.stringify(options)}\n`));
				socket.on("data", (bytes) => {
					reply += bytes;
					if (Buffer.byteLength(reply) > MAX_MESSAGE_BYTES) {
						socket.destroy(new Error("DRY baseline reply exceeds budget"));
					}
				});
				socket.once("end", () => {
					try {
						const result = JSON.parse(reply);
						if (result.error) {
							throw new Error(result.error);
						}
						resolve(result.value);
					} catch (error) {
						reject(error);
					}
				});
			});
		} catch (error) {
			if (!["ENOENT", "ECONNREFUSED"].includes(error.code) || Date.now() >= deadline) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
}
