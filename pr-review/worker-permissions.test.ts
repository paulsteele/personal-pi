import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { Type } from "typebox";
import { runWorker, type Registry } from "./worker.js";
import { ReviewSubmission } from "./types.js";
import { testAccess, testConfig } from "./test-fixtures.js";
import { PermissionScope } from "./permissions.js";
import { CoverageLedger } from "./tasks.js";
import { snapshotTools, type Snapshot } from "./snapshot.js";

const complete = { complete: true, limitations: [], findings: [] };
function registry(calls: Array<{ name: string; arguments: unknown }>) {
	const seen: unknown[] = [];
	const model = {
		provider: "fake",
		id: "test",
		api: "openai-responses",
		reasoning: false,
		contextWindow: 100000,
		maxTokens: 2000,
	};
	let at = 0;
	const value = {
		find: () => model,
		hasConfiguredAuth: () => true,
		getApiKeyAndHeaders: async () => ({ ok: true }),
		getProvider: () => ({
			streamSimple: (_model: unknown, context: unknown) => {
				seen.push(JSON.parse(JSON.stringify(context)));
				const call = calls[at++] ?? { name: "submit_result", arguments: complete };
				const stream = createAssistantMessageEventStream();
				const message = {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					timestamp: 0,
					stopReason: "toolUse",
					content: [{ type: "toolCall", id: `call-${at}`, ...call }],
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				} as AssistantMessage;
				stream.push({ type: "done", reason: "toolUse", message });
				return stream;
			},
		}),
	} as unknown as Registry;
	return { value, seen };
}

it("refuses unmediated workers before any provider request", async () => {
	const provider = registry([]);
	const result = await runWorker({
		registry: provider.value,
		config: testConfig,
		schema: ReviewSubmission,
		system: "policy",
		input: {},
	});
	expect(result).toMatchObject({ ok: false, permissionFailure: true });
	expect(provider.seen).toEqual([]);
});

it("gates actual tool execution and does not disclose denied output", async () => {
	const provider = registry([{ name: "read", arguments: { path: "/repo/private.ts" } }]);
	const execute = vi.fn(async () => ({
		content: [{ type: "text" as const, text: "PRIVATE_SENTINEL" }],
		details: {},
	}));
	const result = await runWorker({
		registry: provider.value,
		config: testConfig,
		schema: ReviewSubmission,
		system: "policy",
		input: {},
		permissions: testAccess(async (action) =>
			action.toolName === "read"
				? { kind: "denied", reason: "read denied" }
				: { kind: "allowed", revision: "fixture" },
		),
		tools: [
			{
				name: "read",
				label: "Read",
				description: "Read fixture",
				parameters: Type.Object({ path: Type.String() }),
				execute,
			},
		],
	});
	expect(result.ok).toBe(true); // Optional blocked read can be worked around, not silently executed.
	expect(execute).not.toHaveBeenCalled();
	expect(JSON.stringify(provider.seen)).not.toContain("PRIVATE_SENTINEL");
	expect(JSON.stringify(provider.seen)).toContain("read denied");
});

it("does not accept a final submission denied by tool policy", async () => {
	const provider = registry([]);
	const result = await runWorker({
		registry: provider.value,
		config: testConfig,
		schema: ReviewSubmission,
		system: "policy",
		input: {},
		permissions: testAccess(async () => ({ kind: "denied", reason: "submission denied" })),
	});
	expect(result).toMatchObject({ ok: false, permissionFailure: true, error: "submission denied" });
	expect(provider.seen).toHaveLength(1);
});

it.each(["read_source_page", "read_change", "read_candidate"])(
	"does not credit a %s result rejected by the outer guard",
	async (name) => {
		let changed = false;
		const id =
			name === "read_change" ? "diff:doc.md" : name === "read_candidate" ? "candidate:F" : "doc:doc.md";
		const ledger = new CoverageLedger([id]);
		const text = "UNDISCLOSED_PAGE";
		const page = async () => {
			changed = true;
			return { text, total: text.length, nextOffset: null };
		};
		const snapshot = {
			repo: { root: "/repo" },
			changes: [{ file: "doc.md", oldPath: "doc.md" }],
			page,
			changePage: page,
		} as unknown as Snapshot;
		const permissions = new PermissionScope({
			revision: () => (changed ? "new" : "old"),
			nextTurn() {},
			endTurn() {},
			close() {},
			check: async (action) =>
				changed && action.toolName === name
					? { kind: "denied", reason: "outer tool denied" }
					: { kind: "allowed", revision: changed ? "new" : "old" },
		});
		const tools =
			name === "read_candidate"
				? [
						{
							name,
							label: name,
							description: "Candidate",
							parameters: Type.Object({ path: Type.String() }),
							execute: async () => {
								await page();
								ledger.deliver(id, 0, text.length, text.length);
								return { content: [{ type: "text" as const, text }], details: {} };
							},
						},
					]
				: snapshotTools(snapshot, (...args) => ledger.deliver(...args));
		const provider = registry([{ name, arguments: { path: "doc.md" } }]);
		const result = await runWorker({
			registry: provider.value,
			config: testConfig,
			schema: ReviewSubmission,
			system: "policy",
			input: {},
			permissions,
			tools,
			coverage: ledger,
		});
		expect(result.ok).toBe(false);
		expect(ledger.remaining).toEqual([id]);
		expect(JSON.stringify(provider.seen)).not.toContain(text);
		expect(JSON.stringify(provider.seen)).toContain("Context not yet supplied");
	},
);

it("authorizes source-derived input for the receiving worker before the first model call", async () => {
	const provider = registry([]);
	const check = vi.fn(async () => ({ kind: "denied" as const, reason: "recipient cannot read this source" }));
	const result = await runWorker({
		registry: provider.value,
		config: testConfig,
		schema: ReviewSubmission,
		system: "policy",
		input: { candidate: { quote: "PRIVATE_CANDIDATE_SENTINEL" } },
		dependencies: [{ path: "/repo/private.ts", side: "new", version: "blob" }],
		permissions: testAccess(check),
	});
	expect(result).toMatchObject({ ok: false, permissionFailure: true });
	expect(check).toHaveBeenCalled();
	expect(provider.seen).toEqual([]);
});
