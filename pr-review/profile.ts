import { posix } from "node:path";
import { hash } from "./prompts.js";
import { profilePath, readStored } from "./storage.js";
import { BASELINES, ProfileDraft, ProfileSchema, validate, type Draft, type Profile } from "./types.js";

export function safePath(path: string): string {
	if (
		!path ||
		path.includes("\0") ||
		path.includes("\\") ||
		posix.isAbsolute(path) ||
		posix.normalize(path) !== path ||
		path.split("/").some((part) => part === ".." || part.toLowerCase() === ".git") ||
		/^[a-z]:/i.test(path)
	)
		throw new Error(`Invalid repository-relative path: ${JSON.stringify(path)}`);
	return path;
}
export function safeGlob(glob: string): string {
	if (
		!glob ||
		glob.length > 256 ||
		glob.startsWith("/") ||
		glob.includes("\\") ||
		glob.includes("\0") ||
		glob.split("/").includes("..") ||
		(glob.match(/[{}]/g)?.length ?? 0) > 12
	)
		throw new Error("Invalid repository glob");
	return glob;
}
export function validateDraft(value: unknown): Draft {
	const draft = validate(ProfileDraft, value);
	const ids = new Set<string>(BASELINES);
	const baselineIds = new Set<string>();
	for (const supplement of draft.baselineFocus) {
		if (baselineIds.has(supplement.id)) throw new Error("Duplicate baseline context");
		baselineIds.add(supplement.id);
	}
	for (const specialist of draft.specialists) {
		if (ids.has(specialist.id)) throw new Error(`Duplicate/reserved reviewer ID: ${specialist.id}`);
		ids.add(specialist.id);
		if (
			specialist.always
				? specialist.anyOf.length !== 0
				: specialist.anyOf.length === 0 || specialist.anyOf.some((group) => group.length === 0)
		)
			throw new Error(`Invalid activation: ${specialist.id}`);
		for (const group of specialist.anyOf)
			for (const predicate of group) if (predicate.kind === "path") safeGlob(predicate.value);
	}
	for (const path of sourcePaths(draft)) safePath(path);
	for (const exclusion of draft.exclusions) safeGlob(exclusion.glob);
	return draft;
}
export function sourcePaths(draft: Draft): string[] {
	return [
		...new Set([
			...draft.freshnessSources,
			...draft.requiredReading,
			...draft.baselineFocus.flatMap((item) => item.requiredReading),
			...draft.specialists.flatMap((item) => item.requiredReading),
		]),
	].sort();
}
export async function fingerprints(
	draft: Draft,
	read: (path: string) => Promise<Buffer>,
): Promise<Record<string, string>> {
	const entries: Array<readonly [string, string]> = [];
	// Snapshot reads may spawn Git processes. Do not fan out the whole reading catalogue.
	for (const path of sourcePaths(draft)) entries.push([path, hash(await read(path))]);
	return Object.fromEntries(entries);
}
export async function loadProfile(
	root: string,
	repoId: string,
): Promise<{ profile: Profile; revision: string } | undefined> {
	const stored = await readStored(root, profilePath(root, repoId));
	if (!stored) return undefined;
	const profile = validate(ProfileSchema, stored.value);
	validateDraft(profile.draft);
	if (profile.repoId !== repoId) throw new Error("Profile belongs to another repository");
	if (JSON.stringify(Object.keys(profile.sourceHashes).sort()) !== JSON.stringify(sourcePaths(profile.draft)))
		throw new Error("Profile source fingerprints are incomplete; rerun /pr setup");
	return { profile, revision: stored.revision };
}
export async function assertFresh(profile: Profile, read: (path: string) => Promise<Buffer>): Promise<void> {
	const stale: string[] = [];
	for (const path of sourcePaths(profile.draft)) {
		try {
			if (hash(await read(path)) !== profile.sourceHashes[path]) stale.push(path);
		} catch {
			stale.push(path);
		}
	}
	if (stale.length)
		throw new Error(
			`Repository review context is stale; rerun /pr setup. Changed/missing sources: ${stale.join(", ")}`,
		);
}
