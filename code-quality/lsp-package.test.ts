import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createJiti } from "jiti";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import type { attachBroker } from "./lsp-broker-registry.js";
import { digest } from "./proposal.js";
import type { LspRoute } from "./lsp-profile.js";

it("loads the packed extension through Pi and launches its standalone broker", async () => {
	const packageRoot = fileURLToPath(new URL(".", import.meta.url));
	const directory = await realpath(await mkdtemp(join(tmpdir(), "quality-packed-")));
	const execute = promisify(execFile);
	try {
		const packed = await execute(
			"npm",
			["pack", "--json", "--ignore-scripts", "--pack-destination", directory],
			{ cwd: packageRoot },
		);
		const archive = JSON.parse(packed.stdout)[0].filename;
		await execute("tar", ["-xzf", join(directory, archive), "-C", directory]);
		const extracted = join(directory, "package");
		const manifest = JSON.parse(await readFile(join(extracted, "package.json"), "utf8"));
		const packagedDependencies = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies });
		for (const dependency of packagedDependencies) {
			const target = join(extracted, "node_modules", dependency);
			await mkdir(dirname(target), { recursive: true });
			await symlink(await realpath(join(packageRoot, "node_modules", dependency)), target);
		}
		const cwd = join(directory, "project"),
			agentDir = join(directory, "agent");
		await mkdir(cwd);
		await mkdir(agentDir);
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory({ defaultProjectTrust: "always" }),
			additionalExtensionPaths: [join(extracted, "index.ts")],
			noExtensions: true,
			noSkills: true,
			noThemes: true,
			noPromptTemplates: true,
			noContextFiles: true,
		});
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		expect(loader.getExtensions().extensions).toHaveLength(1);
		const jiti = createJiti(import.meta.url);
		const packedBroker = await jiti.import<{ attachBroker: typeof attachBroker }>(
			join(extracted, "lsp-broker-registry.ts"),
		);
		const probeServerPath = fileURLToPath(new URL("./fixtures/lsp-probe-server.mjs", import.meta.url));
		const route: LspRoute = {
			id: "packed",
			root: ".",
			preset: "custom",
			command: process.execPath,
			args: [probeServerPath],
			version: "1",
			extensions: { ".txt": "plaintext" },
			env: {},
			settings: {},
			initializationOptions: {},
			startupTimeoutMs: 10000,
			diagnosticTimeoutMs: 2000,
		};
		const path = join(cwd, "example.txt");
		await writeFile(path, "clean");
		const connection = await packedBroker.attachBroker(
			agentDir,
			cwd,
			route,
			"packed-client",
			() => {},
			AbortSignal.timeout(15000),
		);
		try {
			const result = await connection.check(
				[{ path, hash: digest("clean"), languageId: "plaintext" }],
				AbortSignal.timeout(15000),
			);
			expect(result).toMatchObject({ kind: "checked", findings: [] });
		} finally {
			await connection.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 30000);
