import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { BrokerRegistry } from "./lsp-broker-protocol.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, it } from "vitest";
import { attachBroker, brokerKey, type BrokerConnection } from "./lsp-broker-registry.js";
import { digest } from "./proposal.js";
import type { LspRoute } from "./lsp-profile.js";

function fakeRoute(): LspRoute {
	return {
		id: "fixture",
		root: ".",
		preset: "custom",
		command: process.execPath,
		args: [fileURLToPath(new URL("./fixtures/lsp-probe-server.mjs", import.meta.url))],
		version: "1",
		extensions: { ".txt": "plaintext" },
		env: {},
		initializationOptions: {},
		settings: {},
		startupTimeoutMs: 10000,
		diagnosticTimeoutMs: 2000,
	};
}

it("shares a broker between clients and keeps it alive until the last detach", async () => {
	const temporary = await realpath(await mkdtemp(join(tmpdir(), "quality-broker-")));
	const root = join(temporary, "project");
	const agentDir = join(temporary, "agent");
	await mkdir(root);
	const file = join(root, "example.txt");
	await writeFile(file, "2");
	const connections: BrokerConnection[] = [];
	try {
		const [first, second] = await Promise.all([
			attachBroker(agentDir, root, fakeRoute(), "first", () => {}, AbortSignal.timeout(15000)),
			attachBroker(agentDir, root, fakeRoute(), "second", () => {}, AbortSignal.timeout(15000)),
		]);
		connections.push(first, second);
		expect(second.registry.generation).toBe(first.registry.generation);
		expect(second.registry.pid).toBe(first.registry.pid);
		const result = await first.check(
			[{ path: file, hash: digest("2"), languageId: "plaintext" }],
			AbortSignal.timeout(15000),
		);
		expect(result).toMatchObject({ kind: "checked", findings: [{ severity: 2 }] });
		const stale = await second.check(
			[{ path: file, hash: digest("older"), languageId: "plaintext" }],
			AbortSignal.timeout(15000),
		);
		expect(stale.kind).toBe("stale");
		await first.close();
		const afterCreatorClosed = await second.check(
			[{ path: file, hash: digest("2"), languageId: "plaintext" }],
			AbortSignal.timeout(15000),
		);
		expect(afterCreatorClosed).toMatchObject({ kind: "checked", findings: [{ severity: 2 }] });
		await second.close();
		await sleep(1200);
		expect(() => process.kill(first.registry.pid, 0)).toThrow();
	} finally {
		for (const connection of connections) await connection.close();
		await rm(temporary, { recursive: true, force: true });
	}
}, 30000);

it("survives creator-process death and retires after the surviving client detaches", async () => {
	const temporary = await realpath(await mkdtemp(join(tmpdir(), "quality-broker-crash-")));
	const root = join(temporary, "project");
	const agentDir = join(temporary, "agent");
	await mkdir(root);
	const file = join(root, "example.txt");
	await writeFile(file, "clean");
	const ownerFixture = fileURLToPath(new URL("./fixtures/lsp-broker-owner.mjs", import.meta.url));
	const ownerScenario = { agentDir, root, route: fakeRoute(), clientId: "creator" };
	const owner = spawn(process.execPath, [ownerFixture, JSON.stringify(ownerScenario)], {
		stdio: ["ignore", "ignore", "inherit", "ipc"],
	});
	let survivor: BrokerConnection | undefined;
	try {
		const registry = await new Promise<BrokerRegistry>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Creator did not attach")), 15000);
			owner.once("error", reject);
			owner.once("message", (message) => {
				clearTimeout(timer);
				resolve((message as { registry: BrokerRegistry }).registry);
			});
		});
		survivor = await attachBroker(
			agentDir,
			root,
			fakeRoute(),
			"survivor",
			() => {},
			AbortSignal.timeout(15000),
		);
		expect(survivor.registry.pid).toBe(registry.pid);
		owner.kill("SIGKILL");
		await sleep(150);
		expect(
			await survivor.check(
				[{ path: file, hash: digest("clean"), languageId: "plaintext" }],
				AbortSignal.timeout(15000),
			),
		).toMatchObject({ kind: "checked", findings: [] });
		await survivor.close();
		await sleep(1200);
		expect(() => process.kill(registry.pid, 0)).toThrow();
	} finally {
		owner.kill("SIGKILL");
		await survivor?.close();
		await rm(temporary, { recursive: true, force: true });
	}
}, 30000);

it("serializes restart requests and hands a closing broker to a new client safely", async () => {
	const temporary = await realpath(await mkdtemp(join(tmpdir(), "quality-broker-restart-")));
	const root = join(temporary, "project");
	const agentDir = join(temporary, "agent");
	await mkdir(root);
	const file = join(root, "example.txt");
	await writeFile(file, "clean");
	const connections: BrokerConnection[] = [];
	try {
		const first = await attachBroker(
			agentDir,
			root,
			fakeRoute(),
			"first",
			() => {},
			AbortSignal.timeout(15000),
		);
		const second = await attachBroker(
			agentDir,
			root,
			fakeRoute(),
			"second",
			() => {},
			AbortSignal.timeout(15000),
		);
		connections.push(first, second);
		const firstRestart = first.restart(AbortSignal.timeout(15000));
		const secondRestart = second.restart(AbortSignal.timeout(15000));
		await Promise.all([firstRestart, secondRestart]);
		expect(first.status?.generation).toBe(second.status?.generation);
		expect(first.status?.generation).not.toBe(first.registry.generation);
		await first.close();
		const closing = second.close();
		const replacement = await attachBroker(
			agentDir,
			root,
			fakeRoute(),
			"replacement",
			() => {},
			AbortSignal.timeout(15000),
		);
		connections.push(replacement);
		await closing;
		const replacementResult = await replacement.check(
			[{ path: file, hash: digest("clean"), languageId: "plaintext" }],
			AbortSignal.timeout(15000),
		);
		expect(replacementResult).toMatchObject({ kind: "checked", findings: [] });
	} finally {
		for (const connection of connections) await connection.close();
		await rm(temporary, { recursive: true, force: true });
	}
}, 30000);

it("cancels one waiter without cancelling another client's identical check", async () => {
	const temporary = await realpath(await mkdtemp(join(tmpdir(), "quality-broker-cancel-")));
	const root = join(temporary, "project"),
		agentDir = join(temporary, "agent");
	await mkdir(root);
	const file = join(root, "example.txt");
	await writeFile(file, "4");
	const route = { ...fakeRoute(), env: { PROBE_DIAGNOSTIC_DELAY_MS: "300" } };
	const connections: BrokerConnection[] = [];
	try {
		const first = await attachBroker(
			agentDir,
			root,
			route,
			"cancelled",
			() => {},
			AbortSignal.timeout(15000),
		);
		const second = await attachBroker(
			agentDir,
			root,
			route,
			"remaining",
			() => {},
			AbortSignal.timeout(15000),
		);
		connections.push(first, second);
		const requests = [{ path: file, hash: digest("4"), languageId: "plaintext" }];
		const cancellation = new AbortController();
		const cancelledCheck = expect(first.check(requests, cancellation.signal)).rejects.toThrow("cancelled");
		const remainingCheck = second.check(requests, AbortSignal.timeout(15000));
		await sleep(100);
		cancellation.abort();
		await cancelledCheck;
		expect(await remainingCheck).toMatchObject({ kind: "checked", findings: [{ severity: 4 }] });
	} finally {
		for (const connection of connections) await connection.close();
		await rm(temporary, { recursive: true, force: true });
	}
}, 30000);

it("retires the guard after broker death before starting a replacement", async () => {
	const temporary = await realpath(await mkdtemp(join(tmpdir(), "quality-broker-death-")));
	const root = join(temporary, "project"),
		agentDir = join(temporary, "agent");
	await mkdir(root);
	const file = join(root, "example.txt");
	await writeFile(file, "clean");
	const connections: BrokerConnection[] = [];
	try {
		const original = await attachBroker(
			agentDir,
			root,
			fakeRoute(),
			"original",
			() => {},
			AbortSignal.timeout(15000),
		);
		connections.push(original);
		const requests = [{ path: file, hash: digest("clean"), languageId: "plaintext" }];
		expect((await original.check(requests, AbortSignal.timeout(15000))).kind).toBe("checked");
		const guard = JSON.parse(await readFile(join(original.registry.directory, "guard.json"), "utf8")) as {
			pid: number;
		};
		process.kill(original.registry.pid, "SIGKILL");
		await sleep(100);
		const replacement = await attachBroker(
			agentDir,
			root,
			fakeRoute(),
			"replacement",
			() => {},
			AbortSignal.timeout(15000),
		);
		connections.push(replacement);
		expect(replacement.registry.pid).not.toBe(original.registry.pid);
		expect(() => process.kill(guard.pid, 0)).toThrow();
		expect((await replacement.check(requests, AbortSignal.timeout(15000))).kind).toBe("checked");
	} finally {
		for (const connection of connections) await connection.close();
		await rm(temporary, { recursive: true, force: true });
	}
}, 30000);

it("does not share servers across workspaces or settings but ignores display names", () => {
	const route = fakeRoute();
	expect(brokerKey("/repo", route)).toBe(brokerKey("/repo", { ...route, id: "another-label" }));
	expect(brokerKey("/repo", route)).not.toBe(brokerKey("/worktree", route));
	expect(brokerKey("/repo", route)).not.toBe(brokerKey("/repo", { ...route, settings: { strict: true } }));
});
