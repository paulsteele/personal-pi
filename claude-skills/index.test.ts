import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import claudeSkills, { findProjectClaudeSkillPaths } from "./index.ts";

const roots: string[] = [];

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-claude-skills-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("findProjectClaudeSkillPaths", () => {
	test("discovers skills from cwd through the repository root", () => {
		const root = tempRoot();
		mkdirSync(join(root, ".git"));
		mkdirSync(join(root, ".claude", "skills"), { recursive: true });
		mkdirSync(join(root, "packages", ".claude", "skills"), { recursive: true });
		const cwd = join(root, "packages", "app", "src");
		mkdirSync(cwd, { recursive: true });

		expect(findProjectClaudeSkillPaths(cwd)).toEqual([
			join(root, "packages", ".claude", "skills"),
			join(root, ".claude", "skills"),
		]);
	});

	test("stops at the nearest repository root", () => {
		const outer = tempRoot();
		mkdirSync(join(outer, ".claude", "skills"), { recursive: true });
		const repo = join(outer, "repo");
		mkdirSync(join(repo, ".git"), { recursive: true });
		mkdirSync(join(repo, ".claude", "skills"), { recursive: true });
		const cwd = join(repo, "nested");
		mkdirSync(cwd);

		expect(findProjectClaudeSkillPaths(cwd)).toEqual([join(repo, ".claude", "skills")]);
	});

	test("returns no paths when none exist", () => {
		const root = tempRoot();
		mkdirSync(join(root, ".git"));
		const cwd = join(root, "src");
		mkdirSync(cwd);
		expect(findProjectClaudeSkillPaths(cwd)).toEqual([]);
	});

	test("accepts a symlink whose target is a directory", () => {
		const root = tempRoot();
		mkdirSync(join(root, ".git"));
		const target = join(root, "shared-skills");
		mkdirSync(target);
		mkdirSync(join(root, ".claude"));
		symlinkSync(target, join(root, ".claude", "skills"), "dir");

		expect(findProjectClaudeSkillPaths(root)).toEqual([join(root, ".claude", "skills")]);
	});
});

type Handler = (event: any, ctx: any) => Promise<any> | any;

function extensionHarness() {
	const handlers = new Map<string, Handler>();
	claudeSkills({ on: (name: string, handler: Handler) => handlers.set(name, handler) } as never);
	return handlers;
}

describe("claudeSkills extension", () => {
	test("asks for full project trust when project Claude skills exist", async () => {
		const root = tempRoot();
		mkdirSync(join(root, ".git"));
		mkdirSync(join(root, ".claude", "skills"), { recursive: true });
		const handlers = extensionHarness();
		let prompt = "";
		const result = await handlers.get("project_trust")?.(
			{ cwd: root },
			{ hasUI: true, ui: { confirm: async (_title: string, message: string) => ((prompt = message), true) } },
		);

		expect(result).toEqual({ trusted: "yes", remember: true });
		expect(prompt).toContain(join(root, ".claude", "skills"));
	});

	test("does not prompt without a UI and leaves trust undecided", async () => {
		const root = tempRoot();
		mkdirSync(join(root, ".git"));
		mkdirSync(join(root, ".claude", "skills"), { recursive: true });
		const handlers = extensionHarness();
		const result = await handlers.get("project_trust")?.(
			{ cwd: root },
			{ hasUI: false, ui: { confirm: async () => { throw new Error("must not prompt"); } } },
		);
		expect(result).toEqual({ trusted: "undecided" });
	});

	test("contributes skills only for a trusted project", async () => {
		const root = tempRoot();
		mkdirSync(join(root, ".git"));
		const skills = join(root, ".claude", "skills");
		mkdirSync(skills, { recursive: true });
		const handlers = extensionHarness();
		const discover = handlers.get("resources_discover");

		expect(await discover?.({}, { cwd: root, isProjectTrusted: () => false })).toEqual({ skillPaths: [] });
		expect(await discover?.({}, { cwd: root, isProjectTrusted: () => true })).toEqual({ skillPaths: [skills] });
	});
});
