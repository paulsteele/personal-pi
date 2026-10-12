import { expect, it } from "vitest";
import { automaticLspRoute, type InstalledLanguageTool } from "./lsp-auto-routes.js";

const tools: InstalledLanguageTool[] = [
	{ id: "typescript", version: "6.0.1", executable: "/opt/tools/typescript" },
	{ id: "pyright", version: "1.1.414", executable: "/opt/tools/pyright" },
	{ id: "roslyn", version: "5.12.0", executable: "/opt/tools/roslyn" },
	{ id: "gopls", version: "0.23.0", executable: "/opt/tools/gopls" },
	{ id: "rust-analyzer", version: "1.98.1", executable: "/opt/tools/rust-analyzer" },
];

it("selects provisioned TypeScript for the containing package without saved configuration", () => {
	const result = automaticLspRoute({
		file: "web/src/app.ts",
		files: ["web/package.json", "backend/pyproject.toml"],
		tools,
	});
	expect(result).toMatchObject({
		kind: "route",
		route: { preset: "typescript", root: "web", command: "/opt/tools/typescript", version: "6.0.1" },
	});
});

it("keeps punctuation-colliding workspace roots distinct", () => {
	const files = ["a/b/package.json", "a-b/package.json"];
	const nested = automaticLspRoute({ file: "a/b/app.ts", files, tools });
	const flat = automaticLspRoute({ file: "a-b/app.ts", files, tools });
	expect(nested.kind).toBe("route");
	expect(flat.kind).toBe("route");
	if (nested.kind === "route" && flat.kind === "route") {
		expect(nested.route.id).not.toBe(flat.route.id);
	}
});

it("selects Pyright defaults for a standalone Python file", () => {
	expect(automaticLspRoute({ file: "app.py", files: ["app.py"], tools })).toMatchObject({
		kind: "route",
		route: { preset: "pyright", root: "." },
	});
});

it("prefers the containing Go workspace over a nested module", () => {
	expect(
		automaticLspRoute({ file: "services/api/main.go", files: ["go.work", "services/api/go.mod"], tools }),
	).toMatchObject({
		kind: "route",
		route: { preset: "gopls", root: "." },
	});
});

it("selects a single C# solution automatically", () => {
	expect(
		automaticLspRoute({ file: "src/App.cs", files: ["App.sln", "src/App.csproj"], tools }),
	).toMatchObject({
		kind: "route",
		route: { preset: "roslyn", root: ".", project: "App.sln" },
	});
});

it("reports competing C# solutions instead of choosing one silently", () => {
	expect(
		automaticLspRoute({ file: "src/App.cs", files: ["First.sln", "Second.sln", "src/App.csproj"], tools }),
	).toMatchObject({ kind: "unavailable" });
});

it("reports a missing provisioned server without proposing an install", () => {
	expect(automaticLspRoute({ file: "app.py", files: [], tools: [] })).toEqual({
		kind: "unavailable",
		reason: "Provisioned pyright is missing; rebuild the sandbox toolset",
	});
});

it("does not claim LSP coverage for a Markdown file", () => {
	expect(automaticLspRoute({ file: "README.md", files: [], tools })).toEqual({ kind: "not-applicable" });
});

it("reports incomplete discovery before selecting a workspace", () => {
	expect(automaticLspRoute({ file: "src/App.cs", files: ["App.sln"], tools, truncated: true })).toMatchObject(
		{ kind: "unavailable" },
	);
});
