import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { PermissionScope, type PermissionWait } from "./permissions.js";
import { registryStream, type Registry } from "./worker.js";
import { testConfig } from "./test-fixtures.js";

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
