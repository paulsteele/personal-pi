import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { PermissionScope, type PermissionWait } from "./permissions.js";
import { registryStream, type Registry } from "./worker.js";
import { testConfig } from "./test-fixtures.js";
import { commitToolResult } from "./tool-commit.js";

const source = (name: string) => ({ path: `/repo/${name}`, side: "new" as const, version: "blob" });
function liveScope() {
	let revision = "old";
	const check = vi.fn(async (action) =>
		revision === "new" && action.effects?.some((item: { path: string }) => item.path === "/repo/A")
			? { kind: "denied" as const, reason: "A was revoked" }
			: { kind: "allowed" as const, revision },
	);
	const scope = new PermissionScope({
		check,
		revision: () => revision,
		nextTurn() {},
		endTurn() {},
		close() {},
	});
	return {
		scope,
		check,
		revoke() {
			revision = "new";
		},
		revision: () => revision,
	};
}

it("restarts the complete transfer when A is revoked during B's decision", async () => {
	const h = liveScope(),
		published = vi.fn();
	h.check.mockImplementation(async (action) => {
		if (action.effects?.[0]?.path === "/repo/B") h.revoke();
		return h.revision() === "new" && action.effects?.[0]?.path === "/repo/A"
			? { kind: "denied", reason: "A was revoked" }
			: { kind: "allowed", revision: h.revision() };
	});
	await expect(
		h.scope.authorizeSources([source("A"), source("B")], "Publish").then(published),
	).rejects.toThrow("A was revoked");
	expect(published).not.toHaveBeenCalled();
	expect(h.check.mock.calls.map(([action]) => action.effects?.[0]?.path)).toEqual([
		"/repo/A",
		"/repo/B",
		"/repo/A",
	]);
});

it("returns a stable transfer revision and yields during both deduplication and allow sweeps", async () => {
	let ticks = 0,
		finished = false,
		firstCheckTick = -1;
	const tick = () => {
		ticks++;
		if (!finished) setImmediate(tick);
	};
	setImmediate(tick);
	const h = liveScope();
	h.check.mockImplementation(async () => {
		if (firstCheckTick < 0) firstCheckTick = ticks;
		return { kind: "allowed", revision: "old" };
	});
	try {
		expect(
			await h.scope.authorizeSources(
				Array.from({ length: 160 }, (_, i) => source(String(i))),
				"Bulk",
			),
		).toBe("old");
		expect(firstCheckTick).toBeGreaterThan(0);
		expect(ticks).toBeGreaterThan(firstCheckTick);
	} finally {
		finished = true;
	}
});

it("observes cancellation during a large immediately-allowed sweep", async () => {
	const h = liveScope(),
		controller = new AbortController();
	const pending = h.scope.authorizeSources(
		Array.from({ length: 500 }, (_, i) => source(String(i))),
		"Bulk",
		controller.signal,
	);
	setImmediate(() => controller.abort());
	await expect(pending).rejects.toBeDefined();
	expect(h.check.mock.calls.length).toBeLessThan(500);
});

it.each([false, true])(
	"rechecks local scan restrictions after a policy change (hasMatches=%s)",
	async (hasMatches) => {
		let revoked = false;
		const disclosure = vi.fn(async () => ({ kind: "allowed" as const, revision: "active" }));
		const localScan = vi.fn(async () =>
			revoked
				? { kind: "denied" as const, reason: "source revoked" }
				: { kind: "allowed" as const, revision: "active" },
		);
		const scope = new PermissionScope({
			check: disclosure,
			checkLocalSearch: localScan,
			revision: () => (revoked ? "revoked" : "active"),
			nextTurn() {},
			endTurn() {},
			close() {},
		});
		await expect(
			scope.searchMatches({ toolName: "read", input: {}, effects: [source("A")] }, async () => {
				revoked = true;
				return hasMatches ? ["matching content"] : [];
			}),
		).rejects.toThrow("source revoked");
		expect(localScan).toHaveBeenCalledTimes(2);
		expect(disclosure).not.toHaveBeenCalled();
		expect(scope.dependencies).toEqual([]);
	},
);

it("discards matching content when its disclosure is revoked while awaiting approval", async () => {
	let revoked = false;
	const scope = new PermissionScope({
		check: async () => {
			if (revoked) return { kind: "denied", reason: "disclosure revoked" };
			revoked = true;
			return { kind: "allowed", revision: "active" };
		},
		checkLocalSearch: async () => ({ kind: "allowed", revision: "active" }),
		revision: () => (revoked ? "revoked" : "active"),
		nextTurn() {},
		endTurn() {},
		close() {},
	});
	await expect(
		scope.searchMatches({ toolName: "read", input: {}, effects: [source("A")] }, async () => [
			"matching content",
		]),
	).rejects.toThrow("disclosure revoked");
	expect(scope.dependencies).toEqual([]);
});

it("does not retain search dependencies when the outer tool result is rejected", async () => {
	const scope = new PermissionScope({
		check: async () => ({ kind: "allowed", revision: "active" }),
		checkLocalSearch: async () => ({ kind: "allowed", revision: "active" }),
		revision: () => "active",
		nextTurn() {},
		endTurn() {},
		close() {},
	});
	await expect(
		commitToolResult(async () => {
			const matches = await scope.searchMatches(
				{ toolName: "read", input: {}, effects: [source("A")] },
				async () => ["matching content"],
			);
			expect(matches).toEqual(["matching content"]);
			expect(scope.dependencies).toEqual([]);
			throw new Error("outer tool rejected");
		}),
	).rejects.toThrow("outer tool rejected");
	expect(scope.dependencies).toEqual([]);
	await commitToolResult(() =>
		scope.searchMatches({ toolName: "read", input: {}, effects: [source("A")] }, async () => [
			"matching content",
		]),
	);
	expect(scope.dependencies).toEqual([source("A")]);
});

it("fails closed without local-search support and never starts the scan", async () => {
	const { scope, check } = liveScope();
	const scan = vi.fn(async () => []);
	await expect(scope.searchMatches({ toolName: "read", input: {} }, scan)).rejects.toThrow("unavailable");
	expect(scan).not.toHaveBeenCalled();
	expect(check).not.toHaveBeenCalled();
});

it("discards a cancelled scan before requesting disclosure", async () => {
	const controller = new AbortController();
	const disclosure = vi.fn(async () => ({ kind: "allowed" as const, revision: "active" }));
	const scope = new PermissionScope({
		check: disclosure,
		checkLocalSearch: async () => ({ kind: "allowed", revision: "active" }),
		revision: () => "active",
		nextTurn() {},
		endTurn() {},
		close() {},
	});
	await expect(
		scope.searchMatches({ toolName: "read", input: {}, signal: controller.signal }, async () => {
			controller.abort();
			return ["matching content"];
		}),
	).rejects.toThrow();
	expect(disclosure).not.toHaveBeenCalled();
	expect(scope.dependencies).toEqual([]);
});

const model = {
	provider: "fake",
	id: "test",
	api: "openai-responses",
	reasoning: false,
	contextWindow: 16000,
	maxTokens: 1000,
};
function provider() {
	const sent = vi.fn(() => {
		const stream = createAssistantMessageEventStream();
		const message = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			timestamp: 0,
			content: [{ type: "text", text: "done" }],
			stopReason: "stop",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		} as AssistantMessage;
		stream.push({ type: "done", reason: "stop", message });
		return stream;
	});
	const auth = vi.fn(async () => ({ ok: true }));
	const registry = {
		getApiKeyAndHeaders: auth,
		getProvider: () => ({ streamSimple: sent }),
	} as unknown as Registry;
	return { registry, sent, auth };
}

it("does not dispatch a mixed-revision multi-source context", async () => {
	const h = liveScope(),
		p = provider(),
		denied = vi.fn();
	await h.scope.authorizeSources([source("A"), source("B")], "Prepare");
	h.check.mockImplementation(async (action) => {
		if (action.effects?.[0]?.path === "/repo/B") h.revoke();
		return h.revision() === "new" && action.effects?.[0]?.path === "/repo/A"
			? { kind: "denied", reason: "A was revoked" }
			: { kind: "allowed", revision: h.revision() };
	});
	const stream = await registryStream(p.registry, testConfig, undefined, undefined, {
		scope: h.scope,
		wait: (operation) => operation(),
		denied,
	})(model as never, { messages: [] } as never, {});
	expect((await stream.result()).stopReason).toBe("error");
	expect(p.sent).not.toHaveBeenCalled();
	expect(p.auth).not.toHaveBeenCalled();
});

it.each(["authentication", "permit"])("rechecks at provider dispatch after delayed %s", async (delay) => {
	const h = liveScope(),
		p = provider(),
		denied = vi.fn();
	await h.scope.authorizeSources([source("A")], "Prepare");
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	let waiting = false;
	const wait: PermissionWait = async (operation) => {
		const revision = await operation();
		if (delay === "permit" && !waiting) {
			waiting = true;
			await blocked;
		}
		return revision;
	};
	if (delay === "authentication")
		p.auth.mockImplementationOnce(async () => {
			waiting = true;
			await blocked;
			return { ok: true };
		});
	const stream = await registryStream(p.registry, testConfig, undefined, undefined, {
		scope: h.scope,
		wait,
		denied,
	})(model as never, { messages: [] } as never, {});
	await vi.waitFor(() => expect(waiting).toBe(true));
	h.revoke();
	release();
	const result = await stream.result();
	expect(result.stopReason).toBe("error");
	expect(p.sent).not.toHaveBeenCalled();
	expect(denied).toHaveBeenCalledWith(expect.objectContaining({ kind: "denied" }));
});
