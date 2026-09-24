import { basename } from "node:path";

export const EXCLUDED_FILENAMES = new Set([
	"bun.lock",
	"bun.lockb",
	"package-lock.json",
	"npm-shrinkwrap.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"Cargo.lock",
	"Gemfile.lock",
	"poetry.lock",
	"uv.lock",
	"Pipfile.lock",
	"composer.lock",
	"packages.lock.json",
	"project.assets.json",
	"go.sum",
	"pubspec.lock",
	"Podfile.lock",
	"Package.resolved",
]);
export const GENERATED_SUFFIXES = [
	".g.cs",
	".g.i.cs",
	".generated.cs",
	".generated.ts",
	".generated.tsx",
	".gen.go",
	".pb.go",
	".g.dart",
	".freezed.dart",
] as const;

function filenameRule(path: string): string | undefined {
	const name = basename(path);
	if (EXCLUDED_FILENAMES.has(name)) return name;
	const suffix = GENERATED_SUFFIXES.find((suffix) => name.length > suffix.length && name.endsWith(suffix));
	return suffix ? `*${suffix}` : undefined;
}

export function exclusionRule(requestedPath: string, canonicalPath = requestedPath): string | undefined {
	const requested = filenameRule(requestedPath);
	return requested && filenameRule(canonicalPath) ? requested : undefined;
}
