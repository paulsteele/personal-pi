const LISTED_SUSPECTS = 8;
const VENDORED_DIRECTORY_NAMES = new Map([
	["Pods", "CocoaPods"],
	["Carthage", "Carthage checkout"],
	["third_party", "third_party directory"],
	[".store", "NuGet tool store"],
]);
const PACKAGE_MARKERS = [
	{ ecosystem: "NuGet package", matches: (name) => /\.nuspec$|\.nupkg$|^\.nupkg\.metadata$/i.test(name) },
	{ ecosystem: "CocoaPods spec", matches: (name) => name.endsWith(".podspec") },
];

function parentOf(path) {
	const slash = path.lastIndexOf("/");
	return slash < 0 ? "" : path.slice(0, slash);
}
function nameOf(path) {
	return path.slice(path.lastIndexOf("/") + 1);
}
function ancestorsOf(path) {
	const ancestors = [];
	for (let directory = parentOf(path); directory; directory = parentOf(directory)) {
		ancestors.push(directory);
	}
	return ancestors;
}
function isSameOrInside(path, directory) {
	return path === directory || path.startsWith(`${directory}/`);
}
function coveredBy(path, prefixes) {
	return prefixes.some((prefix) => isSameOrInside(path, prefix));
}
function packageRoots(paths) {
	const roots = new Map();
	for (const path of paths) {
		const marker = PACKAGE_MARKERS.find(({ matches }) => matches(nameOf(path)));
		const root = parentOf(path);
		if (marker && root) {
			roots.set(root, marker.ecosystem);
		}
	}
	return roots;
}
function vendoredDirectories(paths) {
	const directories = new Map();
	for (const path of paths) {
		const segments = path.split("/").slice(0, -1);
		const vendoredDepth = segments.findIndex((segment) => VENDORED_DIRECTORY_NAMES.has(segment));
		if (vendoredDepth >= 0) {
			const directory = segments.slice(0, vendoredDepth + 1).join("/");
			directories.set(directory, VENDORED_DIRECTORY_NAMES.get(segments[vendoredDepth]));
		}
	}
	return directories;
}
/**
 * Detects directories whose staged files all come from one vendored/generated signal, reporting the
 * shallowest directory that contains nothing but marked files.
 */
class SignalOwnership {
	constructor(stagedBytesByPath, marked) {
		this.stagedBytesByPath = stagedBytesByPath;
		this.stagedByDirectory = new Map();
		this.markedByDirectory = new Map();
		for (const path of stagedBytesByPath.keys()) {
			const isMarked = marked(path);
			for (const directory of ancestorsOf(path)) {
				this.stagedByDirectory.set(directory, (this.stagedByDirectory.get(directory) ?? 0) + 1);
				if (isMarked) {
					this.markedByDirectory.set(directory, (this.markedByDirectory.get(directory) ?? 0) + 1);
				}
			}
		}
	}
	fullyMarked(directory) {
		const staged = this.stagedByDirectory.get(directory) ?? 0;
		return staged > 0 && staged === this.markedByDirectory.get(directory);
	}
	owningDirectory(directory) {
		if (!this.fullyMarked(directory)) {
			return undefined;
		}
		let owner = directory;
		while (parentOf(owner) && this.fullyMarked(parentOf(owner))) {
			owner = parentOf(owner);
		}
		return owner;
	}
	stagedTotals(directory) {
		let bytes = 0;
		for (const [path, size] of this.stagedBytesByPath) {
			if (path.startsWith(`${directory}/`)) {
				bytes += size;
			}
		}
		return { files: this.stagedByDirectory.get(directory) ?? 0, bytes };
	}
}
function markedUnder(units, include) {
	return (path) => !coveredBy(path, include) && ancestorsOf(path).some((directory) => units.has(directory));
}
function packageSignal(roots, owner) {
	const ecosystems = [...roots]
		.filter(([root]) => isSameOrInside(root, owner))
		.map(([, ecosystem]) => ecosystem);
	const ecosystem = ecosystems[0];
	return `${ecosystems.length} ${ecosystem}${ecosystems.length === 1 ? "" : "s"}`;
}
function linguistSignals(linguistAttributeByPath) {
	return new Map([...linguistAttributeByPath].map(([path, attribute]) => [path, `linguist-${attribute}`]));
}
/**
 * @param {string[]} paths every discovered path, including excluded ones
 * @param {Map<string, number>} stagedBytesByPath staged source sizes
 * @param {Map<string, "vendored" | "generated">} linguistAttributeByPath `.gitattributes` linguist markings
 * @param {{ include: string[] }} profile
 */
export function suspectDirectories(paths, stagedBytesByPath, linguistAttributeByPath, profile) {
	const include = profile.include.map((prefix) => prefix.replace(/\/+$/, "")).filter(Boolean);
	const suspects = new Map();
	const report = (owner, suspectSignal, ownership) => {
		if (!owner) {
			return;
		}
		const alreadyReportedByEarlierSignal = [...suspects.keys()].some((reportedDirectory) =>
			isSameOrInside(owner, reportedDirectory),
		);
		if (alreadyReportedByEarlierSignal) {
			return;
		}
		for (const reportedDirectory of suspects.keys()) {
			const isReportedDescendant = isSameOrInside(reportedDirectory, owner);
			if (isReportedDescendant) {
				suspects.delete(reportedDirectory);
			}
		}
		suspects.set(owner, { directory: owner, suspectSignal, ...ownership.stagedTotals(owner) });
	};
	const roots = packageRoots(paths);
	const packageOwnership = new SignalOwnership(
		stagedBytesByPath,
		markedUnder(new Set(roots.keys()), include),
	);
	for (const root of roots.keys()) {
		const owner = packageOwnership.owningDirectory(root);
		report(owner, owner && packageSignal(roots, owner), packageOwnership);
	}
	const vendored = vendoredDirectories(paths);
	const vendoredOwnership = new SignalOwnership(
		stagedBytesByPath,
		markedUnder(new Set(vendored.keys()), include),
	);
	for (const [directory, signal] of vendored) {
		report(vendoredOwnership.owningDirectory(directory), signal, vendoredOwnership);
	}
	const linguist = linguistSignals(linguistAttributeByPath);
	const linguistOwnership = new SignalOwnership(
		stagedBytesByPath,
		(path) => linguist.has(path) && !coveredBy(path, include),
	);
	for (const [path, signal] of linguist) {
		report(linguistOwnership.owningDirectory(parentOf(path)), signal, linguistOwnership);
	}
	return [...suspects.values()]
		.sort((left, right) => right.bytes - left.bytes || left.directory.localeCompare(right.directory))
		.slice(0, LISTED_SUSPECTS);
}
