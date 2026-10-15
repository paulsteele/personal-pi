import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { DRY_SCENARIOS } from "./dry-scenarios.js";
import { reviewDry } from "./dry-reviewer.js";
import { digest } from "./proposal.js";
import type { DryEvidence } from "./dry-types.js";
import type { ReviewerRegistry } from "./reviewer-call.js";

if (!process.argv.includes("--confirm-provider-calls")) {
	throw new Error(
		"Opt-in provider calls require --confirm-provider-calls; only synthetic fixtures are disclosed",
	);
}
const loaded = loadConfig(getAgentDir());
if (loaded.error || !loaded.config.provider || !loaded.config.model) {
	throw new Error(loaded.error ?? "Configure /quality-model before DRY judgment calibration");
}
const runtime = await ModelRuntime.create({ allowModelNetwork: false });
const registry: ReviewerRegistry = {
	find: (provider, model) => runtime.getModel(provider, model),
	hasConfiguredAuth: (model) => runtime.hasConfiguredAuth(model.provider),
	complete: (model, context, options) => runtime.complete(model, context, options),
};
function evidenceForScenario(scenario: (typeof DRY_SCENARIOS)[number]): DryEvidence {
	const changedLineCount = scenario.changed.split("\n").length;
	const counterpartLineCount = scenario.counterpart.split("\n").length;
	return {
		id: digest(scenario.name),
		changed: {
			file: `/calibration/new.${scenario.extension}`,
			range: [1, changedLineCount],
			hash: digest(scenario.changed),
			text: scenario.changed,
			changedRanges: [[1, changedLineCount]],
		},
		counterpart: {
			file: `/calibration/existing.${scenario.extension}`,
			range: [1, counterpartLineCount],
			hash: digest(scenario.counterpart),
			text: scenario.counterpart,
			changedRanges: [],
		},
		signals: ["synthetic-pair"],
		score: 1,
	};
}
let mismatches = 0;
for (const scenario of DRY_SCENARIOS) {
	const evidence = evidenceForScenario(scenario);
	const result = await reviewDry({
		registry,
		config: loaded.config,
		evidence: [evidence],
		notes: scenario.notes,
	});
	const actual = result.kind === "verdict" ? result.value.verdict : result.kind;
	if (actual !== scenario.expected) {
		mismatches++;
	}
	console.log(JSON.stringify({ name: scenario.name, expected: scenario.expected, actual }));
}
console.log(
	JSON.stringify({ cases: DRY_SCENARIOS.length, mismatches, syntheticOnly: true, benchmark: false }),
);
