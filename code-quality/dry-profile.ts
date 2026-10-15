import {
	projectStoragePath,
	resolveProjectLocation,
	type ProjectLocation,
} from "@paulsteele/pi-project-locations";
import { join } from "node:path";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname } from "node:path";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { publishLspJson } from "./lsp-profile.js";
import { digest } from "./proposal.js";

export const DryProfileSchema = Type.Object(
	{
		version: Type.Literal(1),
		minTokens: Type.Integer({ minimum: 10, maximum: 1000 }),
		minLines: Type.Integer({ minimum: 1, maximum: 100 }),
		ignoreIdentifiers: Type.Boolean(),
		ignoreLiterals: Type.Boolean(),
		maxGapLines: Type.Integer({ minimum: 0, maximum: 20 }),
		similarity: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
		minNodes: Type.Integer({ minimum: 5, maximum: 1000 }),
		workers: Type.Integer({ minimum: 1, maximum: 16 }),
		entryLimit: Type.Integer({ minimum: 100, maximum: 100000 }),
		maxSourceBytes: Type.Integer({ minimum: 1024, maximum: 536870912 }),
		exclude: Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { maxItems: 64 }),
		formats: Type.Record(
			Type.String({ pattern: "^[a-zA-Z0-9_-]+$" }),
			Type.Array(Type.String({ pattern: "^\\.[a-zA-Z0-9]+$" }), { maxItems: 20 }),
		),
	},
	{ additionalProperties: false },
);
export type DryProfile = Static<typeof DryProfileSchema>;
export const DEFAULT_DRY_PROFILE: DryProfile = {
	version: 1,
	minTokens: 40,
	minLines: 3,
	ignoreIdentifiers: true,
	ignoreLiterals: true,
	maxGapLines: 2,
	similarity: 0.8,
	minNodes: 20,
	workers: 2,
	entryLimit: 50000,
	maxSourceBytes: 128 * 1024 * 1024,
	exclude: [],
	formats: {},
};
export function parseDryProfile(value: unknown): DryProfile {
	let profile = value;
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const { maxCacheBytes: _retiredCacheBudget, ...settings } = value as Record<string, unknown>;
		profile = settings;
	}
	if (!Check(DryProfileSchema, profile)) {
		throw new Error("Invalid DRY retrieval profile");
	}
	return structuredClone(profile as DryProfile);
}
export function dryProfilePath(agentDir: string, project: ProjectLocation): string {
	return projectStoragePath(join(agentDir, "extensions", "code-quality"), project, "dry-profile.json");
}
async function readDryProfileText(path: string): Promise<string> {
	let currentPath = path;
	while (true) {
		try {
			if ((await lstat(currentPath)).isSymbolicLink()) {
				throw new Error("Refusing symlink in private DRY profile");
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw error;
			}
		}
		const parentPath = dirname(currentPath);
		const reachedRoot = parentPath === currentPath;
		if (reachedRoot) {
			break;
		}
		currentPath = parentPath;
	}
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const metadata = await file.stat();
		if (!metadata.isFile() || metadata.size > 1024 * 1024) {
			throw new Error("Invalid or oversized private DRY profile");
		}
		return await file.readFile("utf8");
	} finally {
		await file.close();
	}
}
async function hasDryProfile(agentDir: string, project: ProjectLocation): Promise<boolean> {
	try {
		await readDryProfileText(dryProfilePath(agentDir, project));
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return false;
		}
		throw error;
	}
}
export async function resolveDryProject(cwd: string, agentDir: string): Promise<ProjectLocation> {
	return resolveProjectLocation(cwd, { hasProfile: (project) => hasDryProfile(agentDir, project) });
}
export async function loadDryProfile(
	agentDir: string,
	project: ProjectLocation,
): Promise<{ profile: DryProfile; revision?: string }> {
	try {
		const text = await readDryProfileText(dryProfilePath(agentDir, project));
		return { profile: parseDryProfile(JSON.parse(text)), revision: digest(text) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { profile: structuredClone(DEFAULT_DRY_PROFILE) };
		}
		throw error;
	}
}
export async function saveDryProfile(
	agentDir: string,
	project: ProjectLocation,
	value: unknown,
	expected?: string,
): Promise<void> {
	await publishLspJson(dryProfilePath(agentDir, project), parseDryProfile(value), expected);
}
