import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { containsSecrets, sensitivePath } from "./source-disclosure.mjs";
import { lexicalWindows } from "./dry-lexical.mjs";
import { serveBaseline, queryBaseline } from "./dry-mcp.mjs";
import { corpusError, largestDirectories } from "./dry-corpus.mjs";
import { suspectDirectories } from "./dry-suspects.mjs";

export const WORKER_VERSION = 1;
export const hash = (value) => createHash("sha256").update(value).digest("hex");
const FORMAT_EXTENSIONS = {
	javascript: ["js", "mjs", "cjs"],
	jsx: ["jsx"],
	typescript: ["ts", "mts", "cts"],
	tsx: ["tsx"],
	python: ["py", "pyi"],
	go: ["go"],
	rust: ["rs"],
	csharp: ["cs"],
	java: ["java"],
	kotlin: ["kt", "kts"],
	cpp: ["cpp", "cc", "cxx", "hpp", "hh", "hxx"],
	c: ["c", "h"],
	ruby: ["rb"],
	php: ["php"],
	swift: ["swift"],
	scala: ["scala", "sc"],
	clojure: ["clj", "cljs", "cljc"],
	dart: ["dart"],
	elixir: ["ex", "exs"],
	erlang: ["erl", "hrl"],
	haskell: ["hs", "lhs"],
	lua: ["lua"],
	perl: ["pl", "pm"],
	r: ["r", "R"],
	julia: ["jl"],
	ocaml: ["ml", "mli"],
	fsharp: ["fs", "fsx", "fsi"],
	bash: ["sh", "bash", "zsh"],
	powershell: ["ps1", "psm1"],
	sql: ["sql"],
	json: ["json"],
	json5: ["json5"],
	yaml: ["yaml", "yml"],
	toml: ["toml"],
	ini: ["ini", "cfg"],
	vue: ["vue"],
	svelte: ["svelte"],
	astro: ["astro"],
	markup: ["html", "xml", "xhtml"],
	css: ["css"],
	scss: ["scss"],
	less: ["less"],
	sass: ["sass"],
	graphql: ["graphql", "gql"],
	protobuf: ["proto"],
	hcl: ["hcl", "tf"],
	nix: ["nix"],
	zig: ["zig"],
	solidity: ["sol"],
	groovy: ["groovy", "gradle"],
	objectivec: ["m", "mm"],
	matlab: ["mat"],
	fortran: ["f", "f90", "f95"],
	pascal: ["pas", "pp"],
	cobol: ["cob", "cbl"],
	vbnet: ["vb"],
	elm: ["elm"],
	purescript: ["purs"],
	lisp: ["lisp", "lsp"],
	scheme: ["scm", "ss"],
	racket: ["rkt"],
	cmake: ["cmake"],
	makefile: ["mk"],
	docker: ["dockerfile"],
	nginx: ["conf"],
	bicep: ["bicep"],
};
const DEPENDENCY_DIRECTORIES = new Set([
	".git",
	"node_modules",
	"vendor",
	"target",
	"obj",
	"bin",
	"dist",
	"build",
	".venv",
	"venv",
	".next",
	"coverage",
]);
const DOCUMENT_EXTENSIONS = new Set([".md", ".mdx", ".rst", ".txt", ".adoc"]);
const SHARD_BYTES = 1024 * 1024;
export function inside(root, path) {
	const offset = relative(root, path);
	return (
		offset === "" ||
		(!isAbsolute(offset) &&
			offset !== ".." &&
			!offset.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
	);
}
function safeRelative(path) {
	return (
		typeof path === "string" &&
		path.length > 0 &&
		!isAbsolute(path) &&
		!path.includes("\0") &&
		!path.includes("\\") &&
		!path.split("/").some((part) => part === ".." || part === "")
	);
}
export async function run(command, args, cwd, timeoutMs = 60000, input = undefined) {
	return new Promise((resolveResult, reject) => {
		const child = spawn(command, args, {
			cwd,
			stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		if (input !== undefined) {
			child.stdin.on("error", () => {});
			child.stdin.end(input);
		}
		let output = "";
		let stderr = "";
		let exceeded = false;
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.stdout.on("data", (bytes) => {
			output += bytes;
			if (Buffer.byteLength(output) > 8 * SHARD_BYTES) {
				exceeded = true;
				child.kill("SIGKILL");
			}
		});
		child.stderr.on("data", (bytes) => {
			stderr = (stderr + bytes).slice(-16000);
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			if (signal || exceeded) {
				reject(new Error(`DRY subprocess interrupted${exceeded ? ": output limit" : ""}`));
				return;
			}
			resolveResult({ code, output, stderr });
		});
	});
}
function formatOf(path, overrides, supported) {
	if (basename(path) === "Dockerfile") {
		return supported.includes("docker") ? "docker" : undefined;
	}
	if (["Makefile", "GNUmakefile"].includes(basename(path))) {
		return supported.includes("makefile") ? "makefile" : undefined;
	}
	if (basename(path) === "CMakeLists.txt") {
		return supported.includes("cmake") ? "cmake" : undefined;
	}
	const extension = extname(path).slice(1);
	for (const [format, extensions] of Object.entries(overrides)) {
		if (extensions.includes(`.${extension}`)) {
			return format;
		}
	}
	return Object.entries(FORMAT_EXTENSIONS).find(
		([format, extensions]) => supported.includes(format) && extensions.includes(extension),
	)?.[0];
}
async function readSource(root, path) {
	if (!safeRelative(path)) {
		throw new Error("Unsafe DRY source path");
	}
	const full = join(root, path);
	if (!inside(root, full) || (await realpath(full)) !== full) {
		throw new Error("DRY source escapes its mapped root");
	}
	const file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const metadata = await file.stat();
		if (!metadata.isFile()) {
			throw new Error("DRY source is not a regular file");
		}
		return { bytes: await file.readFile(), metadata };
	} finally {
		await file.close();
	}
}
function isAuthorizedPath(path, options) {
	return options.authorized?.includes(path) ?? false;
}
function pathExcluded(path, options) {
	if (path.split("/").some((part) => DEPENDENCY_DIRECTORIES.has(part))) {
		return "dependency/build directory";
	}
	if (
		options.excludedNames.includes(basename(path)) ||
		options.generatedSuffixes.some((suffix) => path.endsWith(suffix))
	) {
		return "generated/lock file";
	}
	if (
		options.profile.exclude.some(
			(pattern) => path === pattern || path.startsWith(`${pattern.replace(/\/$/, "")}/`),
		)
	) {
		return "project exclusion";
	}
	if (sensitivePath(path) && !isAuthorizedPath(path, options)) {
		return "sensitive path";
	}
	return undefined;
}
function normalizedExcludes(profile) {
	return profile.exclude.map((pattern) => pattern.replace(/\/+$/, "")).filter(Boolean);
}
/**
 * Lists the paths that cover everything outside the excluded prefixes, so Git never walks
 * excluded trees while collecting untracked files. `:(exclude)` pathspecs do not prune that walk.
 */
export async function walkPathspecs(root, excludes, directory = "") {
	const pathspecs = [];
	for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
		const path = directory ? `${directory}/${entry.name}` : entry.name;
		if (path === ".git" || excludes.includes(path)) {
			continue;
		}
		const containsExcludedPath = excludes.some((exclude) => exclude.startsWith(`${path}/`));
		if (containsExcludedPath && entry.isDirectory()) {
			pathspecs.push(...(await walkPathspecs(root, excludes, path)));
		} else {
			pathspecs.push(`:(literal)${path}`);
		}
	}
	return pathspecs;
}
async function discover(root, limit, profile, timeoutMs) {
	const excludes = normalizedExcludes(profile);
	const pathspecs = excludes.length ? await walkPathspecs(root, excludes) : [];
	if (excludes.length && !pathspecs.length) {
		return { paths: [], truncated: false };
	}
	let git;
	try {
		git = await run(
			"git",
			[
				"--no-optional-locks",
				"-c",
				"core.fsmonitor=false",
				"ls-files",
				"--cached",
				"--others",
				"--exclude-standard",
				"-z",
				"--",
				...pathspecs,
			],
			root,
			timeoutMs,
		);
	} catch (error) {
		if (error.code !== "ENOENT") {
			throw error;
		}
		git = { code: 128, output: "" };
	}
	if (git.code === 0) {
		const paths = [...new Set(git.output.split("\0").filter(Boolean))].sort();
		return { paths, truncated: paths.length > limit };
	}
	const paths = [];
	const directories = [root];
	let entries = 0;
	while (directories.length) {
		const directory = directories.shift();
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			entries++;
			if (entries > limit) {
				return { paths: paths.sort(), truncated: true };
			}
			if (entry.isSymbolicLink()) {
				continue;
			}
			const full = join(directory, entry.name);
			const excluded = excludes.includes(relative(root, full));
			if (entry.isDirectory() && !DEPENDENCY_DIRECTORIES.has(entry.name) && !excluded) {
				directories.push(full);
			} else if (entry.isFile()) {
				paths.push(relative(root, full));
			}
		}
	}
	return { paths: paths.sort(), truncated: false };
}
const LINGUIST_ATTRIBUTES = ["linguist-vendored", "linguist-generated"];
function isAttributeSet(value) {
	return value === "set" || value === "true";
}
/** Reads `.gitattributes` linguist markings; repositories without Git report none. */
async function linguistAttributes(root, paths, timeoutMs) {
	const linguistAttributeByPath = new Map();
	if (!paths.length) {
		return linguistAttributeByPath;
	}
	let git;
	try {
		git = await run(
			"git",
			["--no-optional-locks", "check-attr", "-z", "--stdin", ...LINGUIST_ATTRIBUTES],
			root,
			timeoutMs,
			`${paths.join("\0")}\0`,
		);
	} catch (error) {
		if (error.code === "ENOENT") {
			return linguistAttributeByPath;
		}
		throw error;
	}
	if (git.code !== 0) {
		return linguistAttributeByPath;
	}
	const fields = git.output.split("\0");
	for (let index = 0; index + 2 < fields.length; index += 3) {
		const [path, attribute, value] = fields.slice(index, index + 3);
		if (isAttributeSet(value)) {
			linguistAttributeByPath.set(path, attribute.replace(/^linguist-/, ""));
		}
	}
	return linguistAttributeByPath;
}
async function privateJson(path, value) {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(path, JSON.stringify(value), { mode: 0o600 });
}
async function stageSource(options, indexed, bytes, windows) {
	const staged = join(options.directory, "sources", indexed.path);
	await mkdir(dirname(staged), { recursive: true, mode: 0o700 });
	await writeFile(staged, bytes, { mode: 0o600 });
	await privateJson(join(options.directory, "index", `${indexed.path}.json`), { ...indexed, windows });
}
const STAGED_ARTIFACTS = ["sources", "index", "manifest.json", "capture-state.json", "report.json"];
function fileStat(metadata) {
	return { size: metadata.size, mtimeMs: metadata.mtimeMs };
}
function unchangedSince(recordedStat, metadata) {
	return (
		recordedStat !== undefined &&
		metadata.isFile() &&
		recordedStat.size === metadata.size &&
		recordedStat.mtimeMs === metadata.mtimeMs
	);
}
function sameMembers(left, right) {
	return left.length === right.length && left.every((value) => right.includes(value));
}
async function previousCapture(directory) {
	const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
	const state = JSON.parse(await readFile(join(directory, "capture-state.json"), "utf8"));
	return {
		manifest,
		filesByPath: new Map(manifest.files.map((file) => [file.path, file])),
		fileStats: state.fileStats,
		linguistAttributeByPath: new Map(Object.entries(state.linguistAttributes)),
	};
}
/** Rebuilds the staged corpus from scratch. */
export async function capture(options, extractWindows = lexicalWindows) {
	for (const name of STAGED_ARTIFACTS) {
		await rm(join(options.directory, name), { recursive: true, force: true });
	}
	return (await stageCorpus(options, extractWindows, undefined)).manifest;
}
/**
 * Restages only files whose size or modification time changed since the previous capture and
 * removes staged files that left the corpus.
 */
export async function updateCapture(options, extractWindows = lexicalWindows) {
	return stageCorpus(options, extractWindows, await previousCapture(options.directory));
}
async function stageCorpus(options, extractWindows, previous) {
	const root = await realpath(options.root);
	const discovered = await discover(root, options.profile.entryLimit, options.profile, options.timeoutMs);
	if (discovered.truncated) {
		const discoveredFilesByPath = new Map(discovered.paths.map((path) => [path, 1]));
		throw corpusError({
			kind: "discovery_truncated",
			limit: options.profile.entryLimit,
			...largestDirectories(discoveredFilesByPath, options.profile.entryLimit),
		});
	}
	const manifest = {
		version: 1,
		revision: "",
		files: [],
		excluded: [],
		truncated: discovered.truncated,
		bytes: 0,
		suspects: [],
	};
	const corpusBytesByPath = new Map();
	const fileStats = {};
	const changed = [];
	let corpusOverflowed = false;
	for (const path of discovered.paths) {
		const exclusion = pathExcluded(path, options);
		if (exclusion) {
			manifest.excluded.push({ path, reason: exclusion });
			continue;
		}
		const format = formatOf(path, options.profile.formats, options.supported);
		if (!format || (DOCUMENT_EXTENSIONS.has(extname(path)) && basename(path) !== "CMakeLists.txt")) {
			manifest.excluded.push({ path, reason: "unsupported/document" });
			continue;
		}
		let source;
		try {
			if (!safeRelative(path)) {
				throw new Error("Unsafe DRY discovery path");
			}
			const metadata = await lstat(join(root, path));
			if (metadata.size > options.maxFileBytes) {
				manifest.excluded.push({ path, reason: "size limit" });
				continue;
			}
			corpusOverflowed ||= manifest.bytes + metadata.size > options.profile.maxSourceBytes;
			if (corpusOverflowed) {
				corpusBytesByPath.set(path, metadata.size);
				continue;
			}
			const stagedFile = previous?.filesByPath.get(path);
			if (stagedFile && unchangedSince(previous.fileStats[path], metadata)) {
				manifest.files.push(stagedFile);
				manifest.bytes += stagedFile.bytes;
				corpusBytesByPath.set(path, stagedFile.bytes);
				fileStats[path] = fileStat(metadata);
				continue;
			}
			source = await readSource(root, path);
		} catch (error) {
			if (error.code === "ENOENT") {
				continue;
			}
			manifest.excluded.push({ path, reason: "unreadable/symlink" });
			continue;
		}
		const { bytes } = source;
		fileStats[path] = fileStat(source.metadata);
		const text = bytes.toString("utf8");
		const binary = bytes.includes(0) || !Buffer.from(text).equals(bytes);
		const oversized =
			bytes.length > options.maxFileBytes || manifest.bytes + bytes.length > options.profile.maxSourceBytes;
		if (binary || oversized || (containsSecrets(text) && !isAuthorizedPath(path, options))) {
			manifest.excluded.push({
				path,
				reason: binary ? "binary" : oversized ? "size limit" : "sensitive content",
			});
			continue;
		}
		const sourceHash = hash(bytes);
		const indexed = {
			path,
			hash: sourceHash,
			format,
			bytes: bytes.length,
			lines: text.split("\n").length,
			suppressed: /jscpd:ignore-(?:start|end)/.test(text),
		};
		manifest.files.push(indexed);
		manifest.bytes += bytes.length;
		corpusBytesByPath.set(path, bytes.length);
		if (previous?.filesByPath.get(path)?.hash !== sourceHash) {
			changed.push(path);
		}
		await stageSource(options, indexed, bytes, extractWindows(text));
	}
	if (corpusOverflowed) {
		throw corpusError({
			kind: "corpus_too_large",
			limit: options.profile.maxSourceBytes,
			...largestDirectories(corpusBytesByPath, options.profile.maxSourceBytes),
		});
	}
	const stagedPaths = manifest.files.map((file) => file.path);
	const removed = [...(previous?.filesByPath.keys() ?? [])].filter((path) => !stagedPaths.includes(path));
	for (const path of removed) {
		await rm(join(options.directory, "sources", path), { force: true });
		await rm(join(options.directory, "index", `${path}.json`), { force: true });
	}
	const stagedPathsUnchanged = previous && sameMembers(stagedPaths, [...previous.filesByPath.keys()]);
	const linguistAttributeByPath = stagedPathsUnchanged
		? previous.linguistAttributeByPath
		: await linguistAttributes(root, stagedPaths, options.timeoutMs);
	manifest.suspects = suspectDirectories(
		discovered.paths,
		corpusBytesByPath,
		linguistAttributeByPath,
		options.profile,
	);
	manifest.revision = hash(
		JSON.stringify([manifest.files, manifest.excluded, manifest.truncated, options.profile, WORKER_VERSION]),
	);
	await privateJson(join(options.directory, "manifest.json"), manifest);
	await privateJson(join(options.directory, "capture-state.json"), {
		fileStats,
		linguistAttributes: Object.fromEntries(linguistAttributeByPath),
	});
	return { manifest, changed, removed };
}
export async function configureDetector(options) {
	const configPath = join(options.directory, "jscpd-config.json");
	const profile = options.profile;
	await privateJson(configPath, {
		minTokens: profile.minTokens,
		minLines: profile.minLines,
		ignoreIdentifiers: profile.ignoreIdentifiers,
		ignoreLiterals: profile.ignoreLiterals,
		maxGapLines: profile.maxGapLines,
		similarity: profile.similarity,
		minNodes: profile.minNodes,
		gitignore: false,
		mode: "mild",
		reporters: ["json"],
		formatsExts: Object.fromEntries(
			Object.entries(profile.formats).map(([format, extensions]) => [
				format,
				extensions.map((extension) => extension.replace(/^\./, "")),
			]),
		),
		formatsNames: {
			docker: ["Dockerfile"],
			makefile: ["Makefile", "GNUmakefile"],
			cmake: ["CMakeLists.txt"],
		},
	});
	return configPath;
}
export async function worker(options) {
	if (
		options.version !== WORKER_VERSION ||
		typeof options.directory !== "string" ||
		!options.directory.startsWith("/tmp/pi-quality-dry-")
	) {
		throw new Error("Invalid DRY worker envelope");
	}
	if (options.operation === "probe") {
		const version = await run(options.executable, ["--version"], options.root, 10000);
		const formats = await run(options.executable, ["--list"], options.root, 10000);
		if (version.code !== 0 || formats.code !== 0 || !/(?:^|\s)5\.4\.1(?:\s|$)/.test(version.output.trim())) {
			throw new Error("jscpd 5.4.1 runtime probe failed");
		}
		return { version: "5.4.1", formats: formats.output.trim().split(/\s+/) };
	}
	if (options.operation === "serve") {
		await serveBaseline(options, capture, configureDetector, updateCapture);
		return { stopped: true };
	}
	if (options.operation === "baseline" || options.operation === "update") {
		return queryBaseline(options);
	}
	if (options.operation === "query") {
		if (!safeRelative(options.path) || typeof options.code !== "string") {
			throw new Error("Invalid current DRY source");
		}
		const reason = pathExcluded(options.path, options);
		const format = formatOf(options.path, options.profile.formats, options.supported);
		const bytes = Buffer.byteLength(options.code);
		if (reason || !format || bytes > options.maxFileBytes) {
			return {
				excluded: { path: options.path, reason: reason ?? (!format ? "unsupported/document" : "size limit") },
			};
		}
		if (containsSecrets(options.code) && !isAuthorizedPath(options.path, options)) {
			return { excluded: { path: options.path, reason: "sensitive content" } };
		}
		const file = {
			path: options.path,
			hash: hash(options.code),
			format,
			bytes,
			lines: options.code.split("\n").length,
			suppressed: /jscpd:ignore-(?:start|end)/.test(options.code),
			windows: [],
		};
		return { file, ...(await queryBaseline({ ...options, format })) };
	}
	if (options.operation === "index") {
		const manifest = JSON.parse(await readFile(join(options.directory, "manifest.json"), "utf8"));
		const requestedPaths = options.paths === undefined ? undefined : new Set(options.paths);
		const sources = requestedPaths
			? manifest.files.filter((file) => requestedPaths.has(file.path))
			: manifest.files;
		const files = [];
		let next = options.offset ?? 0;
		let bytes = 0;
		while (next < sources.length) {
			const source = sources[next];
			if (!safeRelative(source.path)) {
				throw new Error("Invalid DRY index path");
			}
			const file = JSON.parse(
				await readFile(join(options.directory, "index", `${source.path}.json`), "utf8"),
			);
			const size = Buffer.byteLength(JSON.stringify(file));
			if (size > SHARD_BYTES / 2) {
				throw new Error("DRY lexical file exceeds export shard budget");
			}
			if (files.length && bytes + size > SHARD_BYTES / 2) {
				break;
			}
			files.push(file);
			bytes += size;
			next++;
		}
		return { files, next: next < sources.length ? next : null };
	}
	if (options.operation === "manifest") {
		return JSON.parse(await readFile(join(options.directory, "manifest.json"), "utf8"));
	}
	if (options.operation === "report") {
		const bytes = await readFile(join(options.directory, "report.json"));
		const offset = options.offset ?? 0;
		if (!Number.isInteger(offset) || offset < 0 || offset > bytes.length) {
			throw new Error("Invalid DRY export offset");
		}
		return {
			totalBytes: bytes.length,
			content: bytes.subarray(offset, offset + SHARD_BYTES / 2).toString("base64"),
		};
	}
	if (options.operation === "evidence") {
		const full = join(options.directory, "sources", options.path);
		if (!safeRelative(options.path) || !inside(join(options.directory, "sources"), full)) {
			throw new Error("Invalid evidence path");
		}
		const bytes = await readFile(full);
		if (hash(bytes) !== options.hash) {
			throw new Error("Staged evidence hash changed");
		}
		return {
			text: bytes
				.toString("utf8")
				.split("\n")
				.slice(options.range[0] - 1, options.range[1])
				.join("\n"),
		};
	}
	throw new Error("Unknown DRY worker operation");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	let input = "";
	for await (const bytes of process.stdin) {
		input += bytes;
	}
	try {
		process.stdout.write(JSON.stringify(await worker(JSON.parse(input))));
	} catch (error) {
		process.stderr.write(String(error));
		process.exitCode = 1;
	}
}
