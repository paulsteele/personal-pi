const CORPUS_ERROR_MARKER = "DRY_CORPUS_ERROR";
const DOMINANT_CHILD_SHARE = 0.8;
const LISTED_DIRECTORIES = 8;

function parentDirectories(path) {
	const segments = path.split("/").slice(0, -1);
	return segments.slice(0, 2).map((_segment, depth) => segments.slice(0, depth + 1).join("/"));
}
/**
 * Totals per one- and two-segment directory prefix. A top-level directory is represented by its
 * dominant child when that child holds most of its weight, so suggestions stay as narrow as possible.
 */
function representativeDirectories(weightByPath) {
	const weightByDirectory = new Map();
	for (const [path, weight] of weightByPath) {
		for (const directory of parentDirectories(path)) {
			weightByDirectory.set(directory, (weightByDirectory.get(directory) ?? 0) + weight);
		}
	}
	const representatives = [];
	for (const [directory, weight] of weightByDirectory) {
		if (directory.includes("/")) {
			continue;
		}
		let dominantChild = { directory, weight: 0 };
		for (const [child, childWeight] of weightByDirectory) {
			if (child.startsWith(`${directory}/`) && childWeight > dominantChild.weight) {
				dominantChild = { directory: child, weight: childWeight };
			}
		}
		const childDominates = dominantChild.weight >= weight * DOMINANT_CHILD_SHARE;
		representatives.push(childDominates ? dominantChild : { directory, weight });
	}
	return representatives.sort(
		(left, right) => right.weight - left.weight || left.directory.localeCompare(right.directory),
	);
}
/**
 * Lists the heaviest directories and greedily chooses the largest ones to exclude until the
 * remaining weight fits `limit`.
 */
export function largestDirectories(weightByPath, limit) {
	const total = [...weightByPath.values()].reduce((sum, weight) => sum + weight, 0);
	const representatives = representativeDirectories(weightByPath);
	const suggestedExclude = [];
	let remaining = total;
	for (const { directory, weight } of representatives) {
		if (remaining <= limit) {
			break;
		}
		suggestedExclude.push(directory);
		remaining -= weight;
	}
	return { total, largest: representatives.slice(0, LISTED_DIRECTORIES), suggestedExclude };
}
export function corpusError(payload) {
	return new Error(`${CORPUS_ERROR_MARKER} ${JSON.stringify(payload)}`);
}
export function parseCorpusError(text) {
	const marker = text.indexOf(`${CORPUS_ERROR_MARKER} `);
	if (marker < 0) {
		return undefined;
	}
	return JSON.parse(text.slice(marker + CORPUS_ERROR_MARKER.length + 1).split("\n")[0]);
}
