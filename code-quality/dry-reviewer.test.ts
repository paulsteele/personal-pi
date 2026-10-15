import { expect, it, vi } from "vitest";
import { reviewDry } from "./dry-reviewer.js";
import { DEFAULT_CONFIG } from "./config.js";
import type { ReviewerRegistry } from "./reviewer-call.js";

it("uses the shared quality model and trace without requiring an exact patch", async () => {
	const approvedVerdict = { verdict: "approved", rationale: "Independent representations", findings: [] };
	const complete = vi.fn(async () => ({
		stopReason: "toolUse",
		content: [{ type: "toolCall", name: "submit_dry_verdict", arguments: approvedVerdict }],
	}));
	const sharedModel = { provider: "litellm", id: "shared", contextWindow: 100000, maxTokens: 8000 };
	const registry = {
		find: vi.fn(() => sharedModel),
		hasConfiguredAuth: () => true,
		complete,
	} as unknown as ReviewerRegistry;
	const result = await reviewDry({
		registry,
		config: { ...DEFAULT_CONFIG, provider: "litellm", model: "shared" },
		piSessionId: "parent",
		evidence: [],
		notes: [],
	});
	expect(registry.find).toHaveBeenCalledWith("litellm", "shared");
	expect(result.kind).toBe("verdict");
	const request = complete.mock.calls[0] as unknown as [
		unknown,
		{ systemPrompt: string; tools: unknown[] },
		{ headers: unknown; maxTokens: number },
	];
	expect(request[2].headers).toEqual({ "x-litellm-trace-id": "pi-parent-quality" });
	expect(request[2].maxTokens).toBe(1024);
	expect(request[1].systemPrompt).toContain("DRY quality policy");
	expect(JSON.stringify(request[1].tools)).not.toContain('"edits"');
});
