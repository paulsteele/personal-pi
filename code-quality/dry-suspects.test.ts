import { expect, it } from "vitest";
import { suspectDirectories, type LinguistAttribute } from "./dry-suspects.mjs";

const noLinguistAttributes = new Map<string, LinguistAttribute>();
const noInclude = { include: [] };
function staged(bytesByPath: Record<string, number>): Map<string, number> {
	return new Map(Object.entries(bytesByPath));
}

it("reports the shallowest directory that only holds NuGet packages", () => {
	const paths = [
		"internal-packages/Foo/Foo.nuspec",
		"internal-packages/Foo/lib/Foo.xml",
		"internal-packages/Bar/.nupkg.metadata",
		"internal-packages/Bar/content/Bar.cs",
		"lib/countly-sdk-windows/countly.nuspec",
		"lib/countly-sdk-windows/Countly.cs",
		"lib/owned/Owned.cs",
		"Source/App.cs",
	];
	const stagedBytes = staged({
		"internal-packages/Foo/lib/Foo.xml": 300,
		"internal-packages/Bar/content/Bar.cs": 100,
		"lib/countly-sdk-windows/Countly.cs": 50,
		"lib/owned/Owned.cs": 10,
		"Source/App.cs": 900,
	});
	expect(suspectDirectories(paths, stagedBytes, noLinguistAttributes, noInclude)).toEqual([
		{ directory: "internal-packages", suspectSignal: "2 NuGet packages", files: 2, bytes: 400 },
		{ directory: "lib/countly-sdk-windows", suspectSignal: "1 NuGet package", files: 1, bytes: 50 },
	]);
});
it("reports CocoaPods, Carthage, and NuGet tool store directories by name", () => {
	const paths = [
		"ios/Pods/Alamofire/Source.swift",
		"Carthage/Checkouts/Kit/Kit.swift",
		"tools/.store/csharpier/x.cs",
	];
	const stagedBytes = staged(Object.fromEntries(paths.map((path) => [path, 10])));
	expect(
		suspectDirectories(paths, stagedBytes, noLinguistAttributes, noInclude).map(
			({ directory, suspectSignal }) => [directory, suspectSignal],
		),
	).toEqual([
		["Carthage", "Carthage checkout"],
		["ios", "CocoaPods"],
		["tools", "NuGet tool store"],
	]);
});
it("reports directories marked linguist-vendored or linguist-generated", () => {
	const paths = ["src/app.ts", "src/generated/api.ts", "src/generated/models.ts"];
	const stagedBytes = staged({ "src/app.ts": 10, "src/generated/api.ts": 20, "src/generated/models.ts": 30 });
	const linguistAttributes = new Map<string, LinguistAttribute>([
		["src/generated/api.ts", "generated"],
		["src/generated/models.ts", "generated"],
	]);
	expect(suspectDirectories(paths, stagedBytes, linguistAttributes, noInclude)).toEqual([
		{ directory: "src/generated", suspectSignal: "linguist-generated", files: 2, bytes: 50 },
	]);
});
it("does not report a single generated file inside owned source", () => {
	const paths = ["src/app.ts", "src/api.generated-client.ts"];
	const stagedBytes = staged({ "src/app.ts": 10, "src/api.generated-client.ts": 20 });
	const linguistAttributes = new Map<string, LinguistAttribute>([
		["src/api.generated-client.ts", "generated"],
	]);
	expect(suspectDirectories(paths, stagedBytes, linguistAttributes, noInclude)).toEqual([]);
});
it("stays silent for included directories and for excluded package trees that stage nothing", () => {
	const paths = [
		"packages/Vendor/Vendor.nuspec",
		"packages/Vendor/lib/Vendor.xml",
		"lib/countly-sdk-windows/countly.nuspec",
		"lib/countly-sdk-windows/Countly.cs",
		"src/app.cs",
	];
	const stagedBytes = staged({ "lib/countly-sdk-windows/Countly.cs": 50, "src/app.cs": 10 });
	const profile = { include: ["lib/countly-sdk-windows/"] };
	expect(suspectDirectories(paths, stagedBytes, noLinguistAttributes, profile)).toEqual([]);
});
it("lists at most eight suspects, largest first", () => {
	const packages = Array.from({ length: 10 }, (_, index) => `vendor-${index}`);
	const paths = packages.flatMap((name) => [`${name}/${name}.nuspec`, `${name}/lib.cs`]);
	const stagedBytes = staged(
		Object.fromEntries(packages.map((name, index) => [`${name}/lib.cs`, index + 1])),
	);
	const suspects = suspectDirectories(paths, stagedBytes, noLinguistAttributes, noInclude);
	expect(suspects.map((suspect) => suspect.directory)).toEqual([
		"vendor-9",
		"vendor-8",
		"vendor-7",
		"vendor-6",
		"vendor-5",
		"vendor-4",
		"vendor-3",
		"vendor-2",
	]);
});
