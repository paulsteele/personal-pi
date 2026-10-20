import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const FIXTURE_GIT_TIMEOUT_MS = 2_000;

function fixtureEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const inherited = Object.fromEntries(
		Object.entries(environment).filter(([name]) => !name.startsWith("GIT_")),
	);
	return {
		...inherited,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
	};
}

export async function runFixtureGit(
	cwd: string,
	args: string[],
	options: { environment?: NodeJS.ProcessEnv } = {},
): Promise<string> {
	const result = await execute(
		"git",
		[
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.invalid",
			"-c",
			"commit.gpgsign=false",
			"-c",
			"tag.gpgsign=false",
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"core.fsmonitor=false",
			"-c",
			"init.templateDir=",
			"-c",
			"init.defaultBranch=main",
			"-c",
			"gc.auto=0",
			...args,
		],
		{
			cwd,
			env: fixtureEnvironment(options.environment ?? process.env),
			timeout: FIXTURE_GIT_TIMEOUT_MS,
		},
	);
	return result.stdout;
}
