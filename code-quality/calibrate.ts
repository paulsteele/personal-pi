import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { buildReviewChunks } from "./capture.js";
import { review, type ReviewerRegistry } from "./reviewer.js";

interface CalibrationExample {
	name: string;
	expected: "approved" | "needs_work";
	before?: string;
	after: string;
	extension: string;
}

const examples: CalibrationExample[] = [
	{
		name: "API-discovery narration",
		expected: "needs_work",
		after:
			"// TUnit.Mocks 1.49 exposes ReturnsRaw rather than ReturnsAsync for generic Task-returning methods.\nmock.ReturnsRaw(Task.FromResult(value));\n",
		extension: "cs",
	},
	{
		name: "Named local",
		expected: "approved",
		after:
			"const retryDelayMs = Math.min(30_000, 1_000 * 2 ** attempt);\nscheduleRetry(attempt, retryDelayMs);\n",
		extension: "ts",
	},
	{
		name: "Named alternatives",
		expected: "approved",
		after:
			'const isOwner = user.id === document.ownerId;\nconst isAdmin = user.roles.includes("admin");\nconst canEditDocument = isOwner || isAdmin;\n',
		extension: "ts",
	},
	{
		name: "Explicit assertions",
		expected: "approved",
		after:
			'expect(result.status).toBe("refunded");\nexpect(result.refundedAmount).toBe(payment.amount);\nexpect(result.remainingAmount).toBe(0);\n',
		extension: "ts",
	},
	{
		name: "Changelog temporal facts",
		expected: "approved",
		after: "# Changelog\n\n## 1.49\n\n- Updated mock setup to the new generic task-return API.\n",
		extension: "md",
	},
	{
		name: "Unit-bearing names",
		expected: "approved",
		after:
			"const delaySeconds = response.retryAfter;\nconst delayMs = delaySeconds * 1_000;\nscheduler.schedule(job, delayMs);\n",
		extension: "ts",
	},
	{
		name: "Unused import is outside readability review",
		expected: "approved",
		after: 'import { readFile } from "node:fs/promises";\nexport const retryDelayMs = 1000;\n',
		extension: "ts",
	},
	{
		name: "Mechanical line wrapping is outside readability review",
		expected: "approved",
		after:
			'const invitation = { email: "reader@example.test", role: "viewer", expiresAt: new Date("2025-01-02"), acceptedAt: null };\nsendInvitation(invitation);\n',
		extension: "ts",
	},
	{
		name: "Clear raw-versus-normalized comparison is not a readability defect",
		expected: "approved",
		after:
			"function updateModelLabel(modelId: string) {\n  if (currentModelLabel === modelId) return;\n  currentModelLabel = modelId.slice(0, 240);\n  publishModelLabel(currentModelLabel);\n}\n",
		extension: "ts",
	},
	{
		name: "Partial assertions clearly communicate relevant expectations",
		expected: "approved",
		after:
			'it("publishes approval for the edited file", () => {\n  const approvals = events.filter(event => event.phase === "approved");\n  expect(approvals).toMatchObject([{ toolCallId: "edit-a", phase: "approved" }]);\n});\n',
		extension: "ts",
	},
	{
		name: "Changed UI expectations are judged for readability, not preserved behavior",
		expected: "approved",
		before:
			'it("shows review progress", () => {\n  const activityRow = renderActivity({ phase: "checking", reviewAttempt: 2 });\n  expect(activityRow).toContain("Quality · checking · try 2/5");\n});\n',
		after:
			'it("shows the inline checking badge", () => {\n  const activityRow = renderActivity({ phase: "checking", reviewAttempt: 2 });\n  expect(activityRow).toContain("󰅴 ?");\n});\n',
		extension: "ts",
	},
	{
		name: "Generation-guarded cleanup communicates session ownership",
		expected: "approved",
		after:
			"async function showReviewDecision() {\n  const reviewSessionGeneration = sessionGeneration;\n  pendingDecision = true;\n  try {\n    return await promptForDecision();\n  } finally {\n    if (reviewSessionGeneration === sessionGeneration) pendingDecision = false;\n  }\n}\n",
		extension: "ts",
	},
];

const loaded = loadConfig(getAgentDir());
if (loaded.error || !loaded.config.provider || !loaded.config.model)
	throw new Error(loaded.error ?? "Configure /quality-model before running opt-in calibration");
const runtime = await ModelRuntime.create({ allowModelNetwork: false });
const registry: ReviewerRegistry = {
	find: (provider, model) => runtime.getModel(provider, model),
	hasConfiguredAuth: (model) => runtime.hasConfiguredAuth(model.provider),
	complete: (model, context, options) => runtime.complete(model, context, options),
};
let mismatches = 0;
for (const example of examples) {
	const path = `/calibration/example.${example.extension}`;
	const chunks = buildReviewChunks(
		[{ path, before: example.before ?? "", after: example.after }],
		loaded.config,
		"/calibration",
	);
	const result = await review({ registry, config: loaded.config, request: { ...chunks[0]!, notes: [] } });
	const actual = result.kind === "verdict" ? result.value.verdict : result.kind;
	if (actual !== example.expected) mismatches++;
	console.log(JSON.stringify({ name: example.name, expected: example.expected, actual, result }));
}
console.log(JSON.stringify({ cases: examples.length, mismatches, advisoryOnly: true }));
