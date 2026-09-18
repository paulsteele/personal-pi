import { rm } from "node:fs/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { review } from "./runner.js";
import { capture } from "./snapshot.js";
import { hash, loadPrompts } from "./prompts.js";
import { TaskStore, RecoveryGate } from "./tasks.js";
import { commit, fixture, put, testConfig, testDraft } from "./test-fixtures.js";

it.each([
	{ failScout: false, blockArchitecture: false, concurrency: 4 },
	{ failScout: true, blockArchitecture: false, concurrency: 4 },
	{ failScout: false, blockArchitecture: true, concurrency: 4 },
	{ failScout: false, blockArchitecture: true, concurrency: 1 },
	{ failScout: false, blockArchitecture: false, concurrency: 4, readabilityFinding: true },
])(
	"reviews directly without regeneration or acknowledgments ($failScout / $blockArchitecture / $concurrency / $readabilityFinding)",
	async ({ failScout, blockArchitecture, concurrency, readabilityFinding = false }) => {
		const repo = await fixture();
		await put(repo.root, "rules.md", "Read the whole change.\n");
		const before = readabilityFinding
			? "const retryDelayMs = 5000;\nexport const retry = (fn: () => void) => setTimeout(fn, retryDelayMs);\n"
			: "export const enabled = false;\n";
		const after = readabilityFinding
			? "const retryDelaySeconds = 5000;\nexport const retry = (fn: () => void) => setTimeout(fn, retryDelaySeconds);\n"
			: "export const enabled = true;\n";
		await put(repo.root, "a.ts", before);
		await commit(repo.root);
		await put(repo.root, "a.ts", after);
		const prompts = await loadPrompts();
		const signal = new AbortController().signal,
			snapshot = await capture(repo, { kind: "local" }, testConfig);
		const model = {
			provider: "fake",
			id: "test",
			api: "openai-responses",
			reasoning: false,
			contextWindow: 100000,
			maxTokens: 4000,
		};
		const phases = new Map<string, number>();
		const finding = {
			title: readabilityFinding ? "Retry delay name claims the wrong unit" : "Changed default",
			severity: readabilityFinding ? "low" : "medium",
			file: "a.ts",
			side: "new",
			startLine: 1,
			endLine: 1,
			problem: readabilityFinding
				? "retryDelaySeconds still holds milliseconds and is passed directly to setTimeout."
				: "Fixture defect",
			suggestion: readabilityFinding ? "Keep the name retryDelayMs." : "Check the default",
			rationale: readabilityFinding
				? "Behavior is unchanged, but the new name misleads a maintainer about the delay's unit."
				: "Fixture rationale",
			evidence: [{ file: "a.ts", side: "new", line: 1, quote: after.trimEnd() }],
		};
		const registry = {
			find: () => model,
			hasConfiguredAuth: () => true,
			getApiKeyAndHeaders: async () => ({ ok: true }),
			getProvider: () => ({
				streamSimple: (
					_model: unknown,
					context: { messages: Array<{ role: string; content: Array<{ text?: string }> }> },
				) => {
					const input = JSON.parse(
						context.messages.find((message) => message.role === "user")!.content[0]!.text!,
					);
					const kind = input.lens?.id ?? (input.candidateIds ? "verify" : "scout");
					if (kind === "readability") {
						expect(input.lens.name).toBe("Human Readability");
						expect(input.lens.focus).toBe(`${prompts.text["personas/readability"]}\n`);
						expect(input.assignedFiles).toEqual(["a.ts"]);
					}
					const phase = phases.get(kind) ?? 0;
					phases.set(kind, phase + 1);
					let name = "submit_result",
						args: unknown;
					if (kind === "scout")
						args = {
							specialists: [],
							areas: [{ id: "core", name: "Core", files: ["a.ts"], reason: "Shared change", related: [] }],
						};
					else {
						expect(
							[...input.sharedContext, ...input.suppliedContext]
								.map((entry: { id: string }) => entry.id)
								.sort(),
						).toEqual(
							kind === "verify"
								? ["candidate:F1", "diff:a.ts", "doc:rules.md"]
								: ["diff:a.ts", "doc:rules.md"],
						);
						if (kind === "$architecture" && blockArchitecture && phase === 0) {
							name = "report_blocker";
							args = { reason: "Fixture needs retry" };
						} else if (kind === "$architecture" && phase === (blockArchitecture ? 1 : 0)) {
							name = "record_checkpoint";
							args = {
								advisories: [
									{
										title: "Explicit default",
										files: ["a.ts"],
										concern: "Default policy should be documented",
										recommendation: "Document ownership",
										tradeoffs: "More documentation",
										evidence: finding.evidence,
									},
								],
							};
						} else
							args =
								kind === "verify"
									? { verdicts: [{ id: "F1", verdict: "confirmed", reason: "Captured evidence checked" }] }
									: {
											complete: true,
											limitations: [],
											findings: kind === (readabilityFinding ? "readability" : "security") ? [finding] : [],
										};
					}
					const message = {
						role: "assistant",
						api: model.api,
						provider: model.provider,
						model: model.id,
						timestamp: Date.now(),
						stopReason: "toolUse",
						content: [{ type: "toolCall", id: `${kind}-${phase}`, name, arguments: args }],
						usage: {
							input: 1,
							output: 1,
							cacheRead: 100,
							cacheWrite: 20,
							totalTokens: 122,
							cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
						},
					} as AssistantMessage;
					const stream = createAssistantMessageEventStream();
					if (kind === "scout" && failScout)
						stream.push({
							type: "error",
							reason: "error",
							error: {
								...message,
								content: [],
								stopReason: "error",
								errorMessage: "Fixture scout unavailable",
							},
						});
					else stream.push({ type: "done", reason: "toolUse", message });
					return stream;
				},
			}),
		};
		const tasks = new TaskStore(),
			recovery = new RecoveryGate(tasks, signal);
		let otherReviewersFinishedBeforeRetry = false;
		tasks.onChange(() => {
			if (
				blockArchitecture &&
				recovery.blockers.size &&
				[...tasks.records.values()].filter((task) => task.stage === "review" && task.state === "completed")
					.length === 5
			) {
				otherReviewersFinishedBeforeRetry = true;
				recovery.retry();
			}
		});
		try {
			const report = await review({
				ctx: { modelRegistry: registry } as unknown as ExtensionContext,
				config: { ...testConfig, concurrency, maxJobs: 1, maxTurns: 1, maxInputBytes: 1 },
				profile: {
					schemaVersion: 1,
					contextVersion: 1,
					repoId: repo.id,
					generatedAt: "now",
					generationModel: "fake/test",
					sourceHashes: { "rules.md": hash("obsolete profile content") },
					draft: { ...testDraft, requiredReading: ["rules.md"] },
				},
				snapshot,
				prompts,
				scope: { kind: "local" },
				signal,
				progress: () => {},
				tasks,
				recovery,
			});
			expect(report.issues).toEqual([]);
			expect(report.status).toBe("complete");
			expect(report.tasks).toHaveLength(8);
			expect(report.tasks!.filter((task) => task.stage === "review")).toHaveLength(6);
			expect(
				report.tasks!.every(
					(task) =>
						(task.state === "completed" || (failScout && task.id === "scout" && task.state === "skipped")) &&
						(task.remaining ?? 0) === 0,
				),
			).toBe(true);
			expect(report.findings).toHaveLength(1);
			expect(report.findings[0]).toMatchObject({
				...finding,
				reviewer: readabilityFinding ? "Human Readability" : "Security",
			});
			expect(report.ledger).toMatchObject([{ id: "F1", verdict: "confirmed" }]);
			expect(report.advisories).toHaveLength(1);
			expect(report.metrics!.peakActive).toBeLessThanOrEqual(concurrency);
			const requests = blockArchitecture ? 10 : 9;
			expect(report.usage.input).toBe(requests);
			expect(report.usage.cacheRead).toBe(requests * 100);
			expect(report.usage.cacheWrite).toBe(requests * 20);
			expect(report.usage.totalTokens).toBe(requests * 122);
			expect(report.usage.costBreakdown?.cacheWrite).toBeCloseTo(requests * 0.04);
			expect(report.usage.byRequest?.first.requests).toBe(8);
			expect(report.usage.byRequest?.continuation.requests).toBe(requests - 8);
			if (blockArchitecture) expect(otherReviewersFinishedBeforeRetry).toBe(true);
		} finally {
			await snapshot.dispose?.();
			await rm(repo.root, { recursive: true, force: true });
		}
	},
);
