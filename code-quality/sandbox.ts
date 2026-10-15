import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { QualityConfig } from "./config.js";
import { containsSecrets, CoverageError, sensitivePath } from "./capture.js";

export interface QualitySandboxEnvironment {
	container: string;
	user: string;
	workspace: string;
	configuration: Record<string, unknown>;
	remoteEnvironment?: Record<string, string>;
	toolInventory?: {
		version: 1;
		revision: string;
		tools: { id: string; version: string; executable: string }[];
	};
}

export interface QualitySandboxExecuteOptions {
	command: string[];
	cwd?: string;
	environment?: Record<string, string>;
	signal?: AbortSignal;
	timeoutMs?: number;
	input?: Buffer;
}

export interface QualitySandboxExecutionResult {
	output: Buffer;
	stderr: string;
	code: number;
}

export interface QualityImageToolInstallation {
	id: string;
	version: string;
	command: string[];
	environment: Record<string, string>;
	executable: string;
	prerequisites: string[];
}
export interface QualityImageToolsProposal {
	preview: string;
	apply(signal: AbortSignal): Promise<void>;
}

export interface QualitySandbox {
	sessionId: string;
	revision(): string;
	guestPath?(hostPath: string): Promise<string | undefined>;
	hostPath?(guestPath: string): Promise<string | undefined>;
	authorizeHostSource?(hostPath: string, signal?: AbortSignal): Promise<void>;
	authorizeHostSources?(hostPaths: readonly string[], signal?: AbortSignal): Promise<string[]>;
	planImageTools?(
		tools: QualityImageToolInstallation[],
		signal: AbortSignal,
	): Promise<QualityImageToolsProposal | undefined>;
	session: {
		generation: number;
		processSupervisor: string;
		beforeContainerRetirement?(listener: () => Promise<void>): () => void;
		terminateProcessGroup?(processRecordPath: string): Promise<void>;
		environment: QualitySandboxEnvironment;
		filesystem: {
			canonical(path: string, signal?: AbortSignal): Promise<string>;
			read(path: string, signal?: AbortSignal): Promise<Buffer>;
			write(path: string, content: Buffer | string, signal?: AbortSignal): Promise<void>;
			mkdir(path: string, signal?: AbortSignal): Promise<void>;
			stat(path: string, signal?: AbortSignal): Promise<{ file: boolean; directory: boolean; size: number }>;
			list(path: string, signal?: AbortSignal): Promise<string[]>;
		};
		execute(options: QualitySandboxExecuteOptions): Promise<QualitySandboxExecutionResult>;
	};
}

export function qualitySandbox(pi: Pick<ExtensionAPI, "events">): QualitySandbox {
	let sandbox: QualitySandbox | undefined;
	pi.events.emit("sandbox:service:v1", {
		version: 1,
		accept(value: QualitySandbox) {
			sandbox = value;
		},
	});
	if (!sandbox) {
		throw new Error("Quality requires the mandatory sandbox service");
	}
	return sandbox;
}

export async function guestLspProjectRoot(sandbox: QualitySandbox, hostProjectRoot: string): Promise<string> {
	if (!sandbox.guestPath) {
		return sandbox.session.environment.workspace;
	}
	const guestProjectRoot = await sandbox.guestPath(hostProjectRoot);
	if (!guestProjectRoot) {
		throw new Error("Configured LSP project root is outside approved sandbox mappings");
	}
	return guestProjectRoot;
}

export async function readGuestSnapshot(
	sandbox: QualitySandbox,
	path: string,
	config: QualityConfig,
	authorized: boolean,
	signal?: AbortSignal,
): Promise<string | null> {
	if (!authorized && sensitivePath(path)) {
		throw new CoverageError(
			path,
			"sensitive",
			"Potentially sensitive file; authorize reviewer disclosure first",
		);
	}
	const canonical = await sandbox.session.filesystem.canonical(path, signal);
	let stat;
	try {
		stat = await sandbox.session.filesystem.stat(canonical, signal);
	} catch (error) {
		if (String(error).includes("FileNotFoundError")) {
			return null;
		}
		throw error;
	}
	if (!stat.file) {
		throw new CoverageError(path, "unsupported", "Not a regular guest file");
	}
	if (stat.size > config.maxFileBytes) {
		throw new CoverageError(path, "size", "File exceeds maxFileBytes");
	}
	const bytes = await sandbox.session.filesystem.read(canonical, signal);
	const text = bytes.toString("utf8");
	if (bytes.includes(0) || !Buffer.from(text).equals(bytes)) {
		throw new CoverageError(path, "binary", "Binary or non-UTF-8 content is outside text review");
	}
	if (!authorized && containsSecrets(text)) {
		throw new CoverageError(
			path,
			"sensitive",
			"Possible secret detected; authorize reviewer disclosure first",
		);
	}
	return text;
}
