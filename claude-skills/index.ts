import { existsSync, statSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function findProjectClaudeSkillPaths(cwd: string): string[] {
	const paths: string[] = [];
	let directory = resolve(cwd);

	while (true) {
		const skillPath = join(directory, ".claude", "skills");
		if (isDirectory(skillPath)) {
			paths.push(skillPath);
		}

		if (existsSync(join(directory, ".git"))) {
			break;
		}

		const parent = dirname(directory);
		if (parent === directory || directory === parse(directory).root) {
			break;
		}

		directory = parent;
	}

	return paths;
}

export default function claudeSkills(pi: ExtensionAPI): void {
	pi.on("project_trust", async (event, ctx) => {
		const skillPaths = findProjectClaudeSkillPaths(event.cwd);
		if (skillPaths.length === 0 || !ctx.hasUI) {
			return { trusted: "undecided" };
		}

		const trusted = await ctx.ui.confirm(
			"Load project Claude skills?",
			`Pi found Claude skills in:\n${skillPaths.join("\n")}\n\nTrust this project and load them?`,
		);

		return {
			trusted: trusted ? "yes" : "no",
			remember: true,
		};
	});

	pi.on("resources_discover", (_event, ctx) => {
		const skillPaths = ctx.isProjectTrusted()
			? findProjectClaudeSkillPaths(ctx.cwd)
			: [];

		return { skillPaths: [...new Set(skillPaths)] };
	});
}
