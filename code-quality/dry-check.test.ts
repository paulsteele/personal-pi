import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createDryGate, type DryCheckRequest } from "./dry-check.js";
import { DEFAULT_CONFIG } from "./config.js";
import { digest } from "./proposal.js";
import type { SandboxDryManager } from "./dry-sandbox-manager.js";
import type { ReviewerRegistry } from "./reviewer-call.js";
import type { DryEvidence } from "./dry-types.js";

function dryCheckScenario() {
	const text = "const retentionDays = 30;";
	const sourceHash = createHash("sha256").update(text).digest("hex");
	const evidence: DryEvidence = {
		id: digest("pair"),
		changed: { file: "/repo/new.ts", range: [1, 1], hash: sourceHash, text, changedRanges: [[1, 1]] },
		counterpart: { file: "/repo/existing.ts", range: [1, 1], hash: sourceHash, text, changedRanges: [] },
		signals: ["literal:30"],
		score: 1,
	};
	const manager = {
		revision: digest("manifest"),
		configRevision: digest("configuration"),
		generationId: "guest:1",
		prepare: vi.fn(async () => ({
			evidence: [evidence],
			coverage: [],
			manifestRevision: digest("manifest"),
		})),
		current: vi.fn(async () => true),
		retainCurrentCounterparts: vi.fn(async (pairs: DryEvidence[]) => pairs),
		updateLatest: vi.fn(),
	};
	const approval = { verdict: "approved", rationale: "Independent owners", findings: [] };
	const complete = vi.fn(async () => ({
		stopReason: "toolUse",
		content: [{ type: "toolCall", name: "submit_dry_verdict", arguments: approval }],
	}));
	const registry = {
		find: () => ({ provider: "fixture", id: "shared", contextWindow: 100000, maxTokens: 8000 }),
		hasConfiguredAuth: () => true,
		complete,
	} as unknown as ReviewerRegistry;
	const request: DryCheckRequest = {
		files: [],
		authorized: [],
		config: { ...DEFAULT_CONFIG, provider: "fixture", model: "shared" },
		registry,
		piSessionId: "parent",
		revision: digest("case"),
		notes: [],
		signal: new AbortController().signal,
	};
	return { manager, request, complete, evidence };
}
it("does not adopt an approval from a retired baseline generation", async () => {
	const { manager, request } = dryCheckScenario();
	manager.current.mockResolvedValue(false);
	const gate = createDryGate(manager as unknown as SandboxDryManager);
	const result = await gate.check(request);
	expect(result.kind).toBe("stale");
	expect(manager.updateLatest).not.toHaveBeenCalled();
});
it("rejects a replaced turn baseline even when the source manifest is unchanged", async () => {
	const { manager, request, complete } = dryCheckScenario();
	complete.mockImplementationOnce(async () => {
		manager.generationId = "guest:1:next-turn";
		return {
			stopReason: "toolUse",
			content: [
				{
					type: "toolCall",
					name: "submit_dry_verdict",
					arguments: { verdict: "approved", rationale: "Independent owners", findings: [] },
				},
			],
		};
	});
	const result = await createDryGate(manager as unknown as SandboxDryManager).check(request);
	expect(result.kind).toBe("stale");
	expect(manager.updateLatest).not.toHaveBeenCalled();
});
it("requests a fresh judgment for identical evidence on every check", async () => {
	const { manager, request, complete } = dryCheckScenario();
	const gate = createDryGate(manager as unknown as SandboxDryManager);
	expect((await gate.check(request)).kind).toBe("checked");
	expect((await gate.check(request)).kind).toBe("checked");
	expect(manager.prepare).toHaveBeenCalledTimes(2);
	expect(complete).toHaveBeenCalledTimes(2);
});
it("discards counterparts changed during judgment without rescanning or rejecting unrelated content", async () => {
	const { manager, request, complete, evidence } = dryCheckScenario();
	manager.retainCurrentCounterparts.mockResolvedValueOnce([evidence]).mockResolvedValueOnce([]);
	const gate = createDryGate(manager as unknown as SandboxDryManager);
	const result = await gate.check(request);
	expect(result.kind).toBe("checked");
	if (result.kind === "checked") {
		expect(result.assessment.verdict).toBeUndefined();
		expect(result.assessment.evidence).toEqual([]);
	}
	expect(complete).toHaveBeenCalledOnce();
});
it("keeps a no-candidate assessment distinct from a model verdict", async () => {
	const { manager, request, complete } = dryCheckScenario();
	manager.prepare.mockResolvedValue({ evidence: [], coverage: [], manifestRevision: manager.revision });
	const gate = createDryGate(manager as unknown as SandboxDryManager);
	const result = await gate.check(request);
	expect(result.kind).toBe("checked");
	if (result.kind === "checked") {
		expect(result.assessment.verdict).toBeUndefined();
	}
	expect(complete).not.toHaveBeenCalled();
	expect(manager.updateLatest).toHaveBeenCalledWith(expect.objectContaining({ outcome: "no_candidates" }));
});
