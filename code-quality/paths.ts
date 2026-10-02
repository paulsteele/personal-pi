import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
		const parent = dirname(path);
		if (parent === path) {
			throw error;
		}
		return resolve(canonicalPath(parent), basename(path));
	}
}

export function inside(root: string, path: string): boolean {
	const relativePath = relative(root, path);
	const parentDirectoryPrefix = `..${sep}`;
	return (
		!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(parentDirectoryPrefix)
	);
}
