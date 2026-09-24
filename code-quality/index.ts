import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { QualityController, type RuntimePorts } from "./controller.js";
import { qualityUI, feedbackRenderer, checkingRenderer } from "./ui.js";
import { createQualityActivityPublisher, type QualityActivityPublisher } from "./activity.js";
import { QUALITY_CHECK_ENTRY } from "./feedback.js";

export function registerQualityGate(pi: ExtensionAPI, ports: RuntimePorts, agentDir = getAgentDir()): void {
	const runtime = new QualityController(pi, agentDir, { ...ports });
	let activity: QualityActivityPublisher | undefined;
	pi.registerMessageRenderer("code-quality:feedback", feedbackRenderer);
	pi.registerEntryRenderer(QUALITY_CHECK_ENTRY, checkingRenderer);
	pi.on("session_start", (_event, ctx) => {
		activity?.dispose();
		activity = ctx.mode === "tui" ? createQualityActivityPublisher(pi.events) : undefined;
		runtime.ports.activity = activity;
		runtime.start(ctx);
	});
	pi.on("session_tree", (_event, ctx) => runtime.start(ctx));
	pi.on("session_shutdown", () => {
		runtime.dispose();
		activity?.dispose();
		activity = undefined;
		runtime.ports.activity = undefined;
	});
	pi.on("before_agent_start", (event, ctx) => {
		event.systemPromptOptions.sections.code_quality =
			runtime.policy +
			(ctx.mode === "tui" && runtime.active
				? `\n${runtime.summary()}`
				: "\nQuality gate is inactive; policy is guidance only in this mode.");
	});
	pi.on("tool_call", (event, ctx) => runtime.beforeTool(event.toolName, event.input, ctx, event.toolCallId));
	pi.on("tool_execution_end", (event) => runtime.finishTool(event.toolCallId, event.isError));
	pi.on("turn_end", (event, ctx) => runtime.boundary(ctx, event.outcome));
	pi.on("agent_before_settle", (event, ctx) => runtime.boundary(ctx, event.outcome, true));
	pi.registerTool({
		name: "quality_response",
		label: "Quality response",
		description:
			"Send a bounded disagreement to the quality reviewer for reconsideration, or request user-approved helper/test paths. Corrections and disagreements share five review rounds before automatic operator arbitration. Cannot approve, disable, or waive a review.",
		executionMode: "sequential",
		parameters: Type.Object({
			action: Type.String({ enum: ["disagree", "request_scope"] }),
			caseId: Type.String(),
			revision: Type.String(),
			rationale: Type.String({ minLength: 1, maxLength: 2000 }),
			paths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 12 })),
		}),
		async execute(_id, input, _signal, _update, ctx) {
			const text = await runtime.respond(input as Parameters<typeof runtime.respond>[0], ctx);
			return { content: [{ type: "text", text }], details: undefined };
		},
	});
	pi.registerCommand("quality", {
		description: "Quality gate status, on/off, retry, or resolve",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			await runtime.command(args.trim(), ctx);
		},
	});
	pi.registerCommand("quality-model", {
		description: "Select and persist the isolated quality reviewer model",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Quality gate inactive outside TUI", "info");
				return;
			}
			await ctx.waitForIdle();
			if (await runtime.selectModel(ctx, args.trim()))
				ctx.ui.notify("Quality reviewer saved; /quality retry resumes a pending case", "info");
		},
	});
}
export default function codeQuality(pi: ExtensionAPI): void {
	registerQualityGate(pi, { ui: qualityUI });
}
