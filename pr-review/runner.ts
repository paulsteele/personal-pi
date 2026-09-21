import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static, type TSchema } from "typebox";
import { emptyUsage, sumUsage } from "./usage.js";
import {
	checkAdvisory,
	checkEvidence,
	exactGroups,
	validateGroups,
	deduplicateCandidates,
	needsSemanticConsolidation,
} from "./findings.js";
import { validateDraft } from "./profile.js";
import { hash, systemPrompt, type Prompts } from "./prompts.js";
import { selectLenses } from "./selection.js";
import { contextResources, snapshotTools, type Snapshot } from "./snapshot.js";
import {
	ConsolidationSubmission,
	CheckpointSchema,
	ProposalSubmission,
	ReviewSubmission,
	VerificationSubmission,
	type Candidate,
	type Config,
	type Lens,
	type Profile,
	type Report,
	type Scope,
} from "./types.js";
import { chooseMany, ReviewCancelled } from "./ui.js";
import { runWorker, type WorkerResult } from "./worker.js";
import {
	PermissionBlocked,
	isPermissionBlocked,
	WORKER_CONTROL_TOOLS,
	type ReviewPermissions,
	type SourceEffect,
} from "./permissions.js";
import { directWork, type WorkPhase } from "./work-ui.js";
import { packVerificationInputs } from "./batching.js";
import { planReviewTasks, reviewAreas } from "./planning.js";
import { redact } from "./report.js";
import { CoverageLedger, RecoveryGate, TaskStore } from "./tasks.js";
import { deferToolCommit } from "./tool-commit.js";

export type SuspendWork = <T>(wait: () => Promise<T>) => Promise<T>;

/** Logical tasks retain their state while recovery releases and reacquires an execution permit. */
export async function boundedMap<T, U>(
	items: T[],
	concurrency: number,
	signal: AbortSignal,
	run: (item: T, index: number, suspend: SuspendWork) => Promise<U>,
	onPermitWait?: (item: T, waiting: boolean, index: number) => void,
): Promise<U[]> {
	if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Invalid concurrency");
	type Release = () => void;
	const waiting = new Set<(error?: unknown) => void>();
	let active = 0;
	const acquire = (): Promise<Release> => {
		signal.throwIfAborted();
		return new Promise((resolve, reject) => {
			const grant = (error?: unknown) => {
				waiting.delete(grant);
				if (error !== undefined) return reject(error);
				active++;
				let released = false;
				resolve(() => {
					if (released) return;
					released = true;
					active--;
					waiting.values().next().value?.();
				});
			};
			if (active < concurrency) grant();
			else waiting.add(grant);
		});
	};
	const abort = () => {
		for (const grant of waiting) grant(signal.reason ?? new Error("Review cancelled"));
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		const workers = await Promise.allSettled(
			items.map(async (item, index) => {
				const notify = (waiting: boolean) => {
					try {
						onPermitWait?.(item, waiting, index);
					} catch {
						/* presentation only */
					}
				};
				notify(true);
				let release: Release | undefined = await acquire();
				notify(false);
				const suspend: SuspendWork = async (wait) => {
					if (!release) throw new Error("Task is already suspended");
					release();
					release = undefined;
					try {
						return await wait();
					} finally {
						notify(true);
						release = await acquire();
						notify(false);
					}
				};
				try {
					signal.throwIfAborted();
					return await run(item, index, suspend);
				} finally {
					release?.();
				}
			}),
		);
		const failure = workers.find((item): item is PromiseRejectedResult => item.status === "rejected");
		if (failure) throw failure.reason;
		return workers.map((item) => (item as PromiseFulfilledResult<U>).value);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}
export async function review(options: {
	ctx: ExtensionContext;
	config: Config;
	profile: Profile;
	snapshot: Snapshot;
	prompts: Prompts;
	scope: Scope;
	signal: AbortSignal;
	progress: (message: string) => void;
	work?: WorkPhase;
	tasks?: TaskStore;
	recovery?: RecoveryGate;
	permissions?: ReviewPermissions;
}): Promise<Report> {
	const { ctx, config, profile, snapshot, prompts, signal, progress } = options;
	const permissions = options.permissions;
	if (!permissions || !snapshot.withPermissions)
		throw new PermissionBlocked("unavailable", "PR workers require task-bound permissions");
	const work = options.work ?? directWork,
		tasks = options.tasks ?? new TaskStore();
	const started = Date.now();
	const report: Report = {
		version: 1,
		id: randomUUID(),
		repoId: snapshot.repo.id,
		project: profile.draft.name,
		createdAt: new Date().toISOString(),
		scope: options.scope,
		baseline: snapshot.baseline,
		head: snapshot.head,
		fingerprint: snapshot.fingerprint,
		profileHash: hash(JSON.stringify(profile)),
		promptHashes: prompts.hashes,
		model: `${config.provider}/${config.model}`,
		status: "complete",
		lenses: [],
		declined: [],
		clean: [],
		issues: [],
		omitted: snapshot.omitted,
		changedFiles: snapshot.changes.length,
		findings: [],
		groups: [],
		ledger: [],
		elapsedMs: 0,
		usage: emptyUsage(),
	};
	tasks.model = report.model;
	const candidates: Candidate[] = [];
	const candidateSources = new Map<string, SourceEffect[]>();
	const queued = (id: string, stage: string, name: string, files: string[], reason: string) => {
		tasks.add({ id, stage, name, files, reason });
	};
	async function model<T extends TSchema>(
		id: string,
		schema: T,
		stage: Parameters<typeof systemPrompt>[1],
		input: unknown,
		tools: AgentTool[] | ((view: Snapshot) => AgentTool[]),
		coverage?: CoverageLedger,
		validateResult?: (value: Static<T>, view: Snapshot) => Promise<void> | void,
		candidateResources: Candidate[] = [],
		suspend: SuspendWork = (wait) => wait(),
		dependencies: readonly SourceEffect[] = [],
	): Promise<WorkerResult<Static<T>>> {
		const optional = stage === "propose" || stage === "consolidate";
		const recover = async (reason: string) => {
			await suspend(() => options.recovery!.block(id, reason, "queued"));
			tasks.update(id, { state: "running" }, "Execution resumed");
		};
		const task = tasks.records.get(id)!;
		const declaredTools = typeof tools === "function" ? tools(snapshot) : tools;
		const access = permissions!.task({
			id,
			name: task.name,
			assignment: `PR ${stage} task for ${task.files.length} captured files; read-only repository context as needed.`,
			model: `${config.provider}/${config.model}`,
			tools: [...new Set(["read", ...declaredTools.map((tool) => tool.name), ...WORKER_CONTROL_TOOLS])],
			kind: "worker",
			signal,
		});
		const workerSnapshot = snapshot.withPermissions!(access);
		const workerTools = typeof tools === "function" ? tools(workerSnapshot) : tools;
		const checkPermissions: SuspendWork = async (check) => {
			const prior = task.state;
			tasks.update(id, { state: "checking" }, "Checking permissions");
			try {
				// Retain the execution slot: this worker may already own a full packed context.
				return await check();
			} finally {
				if (task.state === "checking") tasks.update(id, { state: prior });
			}
		};
		tasks.update(id, {
			state: "running",
			startedAt: task.startedAt ?? Date.now(),
			total: coverage?.total,
			remaining: coverage?.remaining.length,
			unreviewed: coverage?.remaining,
		});
		let priorUsage = emptyUsage();
		const sessionId = randomUUID();
		const resourceLimit = Math.max(
			16000,
			(ctx.modelRegistry.find?.(config.provider, config.model)?.contextWindow ?? 32000) * 3,
		);
		const assignedLens =
			stage === "reviewer" || stage === "architecture" ? (input as { lens: Partial<Lens> }).lens : undefined;
		const sharedIds = profile.draft.requiredReading
			.map((file) => `doc:${file}`)
			.filter((id) => coverage?.ids.includes(id))
			.sort();
		try {
			for (;;) {
				access.endTurn();
				coverage?.resetDelivery();
				const priorTurns = task.turns;
				async function* resources() {
					for (const candidate of candidateResources) {
						signal.throwIfAborted();
						const text = JSON.stringify(candidate);
						yield { id: `candidate:${candidate.id}`, text, total: text.length };
					}
					yield* contextResources(
						workerSnapshot,
						coverage!.ids
							.filter((id) => id.startsWith("diff:") || id.startsWith("doc:"))
							.sort(
								(a, b) => Number(b.startsWith("doc:")) - Number(a.startsWith("doc:")) || a.localeCompare(b),
							),
						resourceLimit,
						signal,
					);
				}
				let result: WorkerResult<Static<T>>;
				try {
					await checkPermissions(() =>
						access.authorizeSources(
							dependencies,
							"Receive source-derived input from previous review stages",
							signal,
						),
					);
					result = await runWorker({
						registry: ctx.modelRegistry,
						config,
						schema,
						system: systemPrompt(prompts, stage),
						input,
						sessionId,
						continuing: task.requests > 0,
						assignment: assignedLens
							? { id: assignedLens.id, name: assignedLens.name, focus: assignedLens.focus }
							: undefined,
						...(coverage
							? { sharedResources: contextResources(workerSnapshot, sharedIds, resourceLimit, signal) }
							: {}),
						tools: workerTools,
						permissions: access,
						suspendPermissions: checkPermissions,
						signal,
						coverage,
						resources: coverage ? resources() : undefined,
						allowAdvisories: stage === "architecture",
						allowFindings: stage === "architecture" || stage === "reviewer",
						validateResult: async (value) => {
							if (stage === "reviewer" || stage === "architecture") {
								const submission = value as Static<typeof ReviewSubmission>;
								for (const finding of submission.findings)
									if (
										!task.files.some(
											(file) =>
												file === finding.file ||
												snapshot.changes.find((change) => change.file === file)?.oldPath === finding.file,
										)
									)
										throw new Error("Finding outside assigned scope");
							}
							await validateResult?.(value, workerSnapshot);
						},
						validateCheckpoint: async (value) => {
							for (const finding of value.findings ?? [])
								if (
									!task.files.some(
										(file) =>
											file === finding.file ||
											snapshot.changes.find((c) => c.file === file)?.oldPath === finding.file,
									)
								)
									throw new Error("Finding outside assigned scope");
							for (const advisory of value.advisories ?? []) await checkAdvisory(advisory, workerSnapshot);
						},
						recover: options.recovery && !optional ? recover : undefined,
						progress: (note) => progress(redact(`${task.name}: ${note}`)),
						event: (event) => {
							if (signal.aborted) return;
							const changes: Partial<typeof task> = { remaining: coverage?.remaining.length };
							if (event.type === "coverage") changes.unreviewed = coverage?.remaining;
							if (event.type === "request") changes.requests = task.requests + 1;
							if (event.type === "turn") changes.turns = priorTurns + (event.turns ?? 0);
							if (event.type === "compacting") {
								changes.state = "compacting";
								changes.compactions = task.compactions + 1;
							}
							if (event.type === "continued" || event.type === "turn") changes.state = "running";
							if (event.usage) changes.usage = sumUsage(priorUsage, event.usage);
							tasks.update(id, changes, event.text);
						},
					});
				} catch (error) {
					if (!isPermissionBlocked(error)) throw error;
					result = { ok: false, error: error.message, usage: emptyUsage(), permissionFailure: true };
				}
				result = { ...result, dependencies: access.dependencies };
				priorUsage = sumUsage(priorUsage, result.usage);
				if (signal.aborted) {
					tasks.update(id, { state: "cancelled", endedAt: Date.now(), usage: priorUsage });
					return result;
				}
				if (result.ok) {
					tasks.update(
						id,
						{
							state: "completed",
							endedAt: Date.now(),
							remaining: coverage?.remaining.length,
							unreviewed: coverage?.remaining,
							usage: priorUsage,
						},
						"Completed",
					);
					return result;
				}
				if (!options.recovery || (optional && !result.permissionFailure)) {
					if (result.permissionFailure)
						report.issues.push(`Permission blocked: ${task.name}: ${result.error}`);
					tasks.update(
						id,
						{
							state: optional && !result.permissionFailure ? "skipped" : "failed",
							endedAt: Date.now(),
							usage: priorUsage,
						},
						result.error,
					);
					return result;
				}
				await recover(result.error);
			}
		} finally {
			access.close();
		}
	}
	try {
		await snapshot.permissions?.beforeDispatch(signal);
		const blockers = snapshot.omitted.filter((item) => !item.reason.startsWith("excluded:"));
		if (blockers.length)
			throw new Error(
				`Capture blocked: ${blockers.map((item) => `${item.file}: ${item.reason}`).join("; ")}`,
			);
		if (!snapshot.changes.length) {
			report.status = "no-changes";
			return report;
		}
		let lenses = await work("Selecting review scopes", () =>
			selectLenses(profile.draft, snapshot.changes, prompts, signal),
		);
		const sources = new Set(snapshot.paths());
		const missing = new Set(lenses.flatMap((lens) => lens.reading).filter((path) => !sources.has(path)));
		if (missing.size)
			report.contextNotes = [
				`Saved document references no longer present: ${[...missing].join(", ")}. Reviewing current code and available guidance; setup regeneration is not required.`,
			];
		lenses = lenses.map((lens) => ({ ...lens, reading: lens.reading.filter((path) => sources.has(path)) }));
		queued(
			"scout",
			"planning",
			"Plan areas / specialists",
			snapshot.changes.map((c) => c.file),
			"Whole-change routing",
		);
		const proposals = await work("Planning review areas and specialists", () =>
			model(
				"scout",
				ProposalSubmission,
				"propose",
				{
					project: profile.draft.summary,
					selected: lenses,
					changedFiles: snapshot.changes.slice(0, 100).map((c) => c.file),
					manifestIncomplete: snapshot.changes.length > 100,
					manifestTool: "list_changes",
				},
				(view) => snapshotTools(view),
			),
		);
		const planningSources = proposals.ok ? (proposals.dependencies ?? []) : [];
		let proposedAreas: Static<typeof ProposalSubmission>["areas"];
		if (proposals.ok) {
			proposedAreas = proposals.value.areas;
			const proposedIds = new Set(lenses.map((lens) => lens.id));
			const knownSources = new Set(snapshot.paths());
			const valid = proposals.value.specialists.filter((item) => {
				try {
					validateDraft({ ...profile.draft, specialists: [...profile.draft.specialists, item.specialist] });
					if (
						proposedIds.has(item.specialist.id) ||
						!item.files.length ||
						!item.files.every((file) => snapshot.changes.some((change) => change.file === file)) ||
						!item.specialist.requiredReading.every((path) => knownSources.has(path))
					)
						throw new Error("Invalid specialist identity, scope, or reading");
					proposedIds.add(item.specialist.id);
					return true;
				} catch {
					(report.contextNotes ??= []).push(
						`Ignored invalid optional specialist proposal: ${item.specialist.name}`,
					);
					return false;
				}
			});
			if (valid.length) {
				const chosen = await chooseMany(
					ctx,
					"Add specialists for this review only?",
					valid.map((item) => ({ id: item.specialist.id, label: `${item.specialist.name}: ${item.reason}` })),
					signal,
				);
				for (const item of valid) {
					if (chosen.includes(item.specialist.id))
						lenses.push({
							id: item.specialist.id,
							name: item.specialist.name,
							focus: item.specialist.focus,
							reading: [
								...new Set([...profile.draft.requiredReading, ...item.specialist.requiredReading]),
							].filter((path) => sources.has(path)),
							reason: `User-approved proposal: ${item.reason}`,
							matchedFiles: item.files,
							exactScope: true,
						});
					else report.declined.push(item.specialist.name);
				}
			}
		} else
			(report.contextNotes ??= []).push(
				`Optional specialist scout unavailable: ${proposals.error}. Using the saved roster and deterministic area grouping.`,
			);
		const areaPlan = reviewAreas(snapshot.changes, proposedAreas);
		report.areas = areaPlan.areas;
		const jobs = planReviewTasks(lenses, areaPlan.areas, snapshot.changes, prompts.text.architecture);
		lenses = [...lenses, jobs.find((job) => job.architecture)!.lens];
		report.lenses = lenses;
		for (const job of jobs)
			queued(
				job.id,
				"review",
				job.lens.name,
				job.files,
				`${job.lens.reason}${areaPlan.fallback ? "; deterministic area fallback" : ""}`,
			);
		const settled = new Map<
			string,
			{ result: WorkerResult<Static<typeof ReviewSubmission>>; coverage: CoverageLedger }
		>();
		try {
			await work(`Reviewing changes (${jobs.length} tasks, ${config.concurrency} concurrent)`, () =>
				boundedMap(
					jobs,
					config.concurrency,
					signal,
					async (job, _index, suspend) => {
						const coverage = new CoverageLedger([
							...job.files.map((file) => `diff:${file}`),
							...job.lens.reading.map((file) => `doc:${file}`),
						]);
						const { reading: _reading, focus, ...lens } = job.lens;
						const result = await model(
							job.id,
							ReviewSubmission,
							job.architecture ? "architecture" : "reviewer",
							{
								project: profile.draft.summary,
								// Reading is listed once below; architecture focus is already in the system policy.
								lens: { ...lens, ...(job.architecture ? {} : { focus }) },
								assignedFiles: job.files,
								relatedContextFiles: job.contextFiles,
								areas: areaPlan.areas,
								requiredReading: job.lens.reading,
								coverageTool: "coverage_state",
							},
							(view) => snapshotTools(view, (...args) => coverage.deliver(...args)),
							coverage,
							undefined,
							[],
							suspend,
							planningSources,
						);
						settled.set(job.id, { result, coverage });
						return result;
					},
					(job, waiting) =>
						tasks.update(
							job.id,
							{ state: waiting ? "waiting_slot" : "running" },
							waiting ? "Waiting for execution slot" : "Execution slot acquired",
						),
				),
			);
		} finally {
			for (const job of jobs) {
				const item = settled.get(job.id);
				if (!item) continue;
				const { result, coverage } = item;
				const findings = [...coverage.findings, ...(result.ok ? result.value.findings : [])];
				for (const finding of new Map(findings.map((f) => [JSON.stringify(f), f])).values()) {
					const candidate = { ...finding, id: `F${candidates.length + 1}`, reviewer: job.lens.name };
					candidates.push(candidate);
					candidateSources.set(candidate.id, result.dependencies ?? []);
				}
				if (job.architecture)
					report.advisories = coverage.advisories.map((advisory, i) => ({ ...advisory, id: `A${i + 1}` }));
				if (!result.ok) report.issues.push(`${job.lens.name}: ${result.error}`);
				else if (!result.value.complete || result.value.limitations.length)
					report.issues.push(`${job.lens.name}: ${result.value.limitations.join("; ") || "Incomplete"}`);
			}
			report.clean = lenses
				.filter((lens) =>
					jobs
						.filter((job) => job.lens.id === lens.id)
						.every((job) => {
							const item = settled.get(job.id);
							return (
								item?.result.ok &&
								item.result.value.complete &&
								!item.result.value.limitations.length &&
								!item.result.value.findings.length &&
								!item.coverage.findings.length &&
								!item.coverage.remaining.length
							);
						}),
				)
				.map((lens) => lens.name);
		}
		signal.throwIfAborted();
		const sorted = [...candidates].sort((a, b) => {
			const area = (file: string) => areaPlan.areas.findIndex((item) => item.files.includes(file));
			return area(a.file) - area(b.file) || a.file.localeCompare(b.file) || a.id.localeCompare(b.id);
		});
		const duplicates = deduplicateCandidates(sorted);
		const { batches } = await packVerificationInputs({
			project: profile.draft.summary,
			candidates: duplicates.candidates,
			members: duplicates.members,
			lenses,
			snapshot,
			system: systemPrompt(prompts, "verifier"),
			model: ctx.modelRegistry.find?.(config.provider, config.model),
			tools: [
				...snapshotTools(snapshot),
				{ name: "submit_result", parameters: VerificationSubmission },
				{ name: "record_checkpoint", parameters: CheckpointSchema },
			],
			signal,
		});
		for (let i = 0; i < batches.length; i++)
			queued(
				`verify:${i}`,
				"verification",
				`Verify ${i + 1}`,
				[...new Set(batches[i]!.candidates.map((c) => c.file))],
				`${batches[i]!.candidates.length} independent verdicts`,
			);
		await work(`Verifying findings (${batches.length} batches)`, () =>
			boundedMap(
				batches,
				config.concurrency,
				signal,
				async (batch, index, suspend) => {
					const ids = new Set(batch.candidates.map((c) => c.id));
					const coverage = new CoverageLedger([
						...batch.candidates.map((candidate) => `candidate:${candidate.id}`),
						...batch.input.requiredReading.map((path) => `doc:${path}`),
						...batch.input.changes.map((c) => `diff:${c.file}`),
					]);
					const validatedEvidence = new Map<string, string>();
					const validateVerdicts = async (value: Static<typeof VerificationSubmission>, view: Snapshot) => {
						if (
							value.verdicts.length !== ids.size ||
							new Set(value.verdicts.map((v) => v.id)).size !== ids.size ||
							value.verdicts.some((v) => !ids.has(v.id))
						)
							throw new Error("Missing, duplicate, or unknown verification IDs");
						for (const verdict of value.verdicts)
							if (verdict.verdict === "confirmed" || verdict.verdict === "corrected") {
								const candidate = batch.candidates.find((c) => c.id === verdict.id)!;
								const finding = verdict.verdict === "corrected" ? verdict.corrected : candidate;
								if (!finding || finding.severity !== candidate.severity)
									throw new Error("Invalid correction/severity change");
								await checkEvidence(finding, view);
								validatedEvidence.set(candidate.id, JSON.stringify(finding));
							}
					};
					const candidateTool: AgentTool = {
						name: "read_candidate",
						label: "Read candidate evidence",
						description:
							"Page the exact original candidate JSON by ID and character cursor, including oversized evidence.",
						parameters: Type.Object({
							id: Type.String(),
							cursor: Type.Optional(Type.Integer({ minimum: 0 })),
						}),
						async execute(_id, args, toolSignal) {
							toolSignal?.throwIfAborted();
							signal.throwIfAborted();
							const input = args as { id: string; cursor?: number },
								candidate = batch.candidates.find((c) => c.id === input.id);
							if (!candidate) throw new Error("Unknown candidate ID");
							const text = JSON.stringify(candidate),
								cursor = input.cursor ?? 0;
							coverage.deliver(
								`candidate:${candidate.id}`,
								cursor,
								Math.min(text.length, cursor + 8000),
								text.length,
							);
							return {
								content: [
									{
										type: "text",
										text: JSON.stringify({
											text: text.slice(cursor, cursor + 8000),
											nextOffset: cursor + 8000 < text.length ? cursor + 8000 : null,
										}),
									},
								],
								details: {},
							};
						},
					};
					const result = await model(
						`verify:${index}`,
						VerificationSubmission,
						"verifier",
						// Bodies are tracked resources, not untracked nested fields in paged task input.
						{ ...batch.input, candidates: [] },
						(view) => [...snapshotTools(view, (...args) => coverage.deliver(...args)), candidateTool],
						coverage,
						validateVerdicts,
						batch.candidates,
						suspend,
						batch.candidates.flatMap((candidate) =>
							duplicates.members
								.get(candidate.id)!
								.flatMap((member) => candidateSources.get(member.id) ?? []),
						),
					);
					for (const candidate of batch.candidates) {
						for (const member of duplicates.members.get(candidate.id)!)
							candidateSources.set(member.id, [
								...(candidateSources.get(member.id) ?? []),
								...(result.dependencies ?? []),
							]);
						const verdictFor = (entry: Report["ledger"][number]) => {
							for (const member of duplicates.members.get(candidate.id)!)
								report.ledger.push({
									...entry,
									id: member.id,
									...(member.id !== candidate.id ? { sharedWith: candidate.id } : {}),
								});
						};
						const matched = result.ok ? result.value.verdicts.filter((v) => v.id === candidate.id) : [];
						if (matched.length !== 1) {
							verdictFor({
								id: candidate.id,
								verdict: "inconclusive",
								reason: result.ok ? "Missing/duplicate verdict" : result.error,
							});
							continue;
						}
						const verdict = matched[0]!;
						if (verdict.verdict === "dropped" || verdict.verdict === "inconclusive")
							verdictFor({ id: candidate.id, verdict: verdict.verdict, reason: verdict.reason });
						else
							try {
								const finding = verdict.verdict === "corrected" ? verdict.corrected : candidate;
								if (!finding || finding.severity !== candidate.severity)
									throw new Error("Invalid correction/severity change");
								if (validatedEvidence.get(candidate.id) !== JSON.stringify(finding))
									await checkEvidence(finding, snapshot);
								for (const member of duplicates.members.get(candidate.id)!)
									report.findings.push({ ...finding, id: member.id, reviewer: member.reviewer });
								verdictFor({ id: candidate.id, verdict: verdict.verdict, reason: verdict.reason });
							} catch (error) {
								verdictFor({
									id: candidate.id,
									verdict: "inconclusive",
									reason: error instanceof Error ? error.message : "Invalid evidence",
								});
							}
					}
				},
				(_batch, waiting, index) =>
					tasks.update(
						`verify:${index}`,
						{ state: waiting ? "waiting_slot" : "running" },
						waiting ? "Waiting for execution slot" : "Execution slot acquired",
					),
			),
		);
		report.findings.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
		report.ledger.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
		if (report.ledger.some((v) => v.verdict === "inconclusive"))
			report.issues.push("Some findings remain inconclusive after verification");
		report.groups = exactGroups(report.findings);
		if (needsSemanticConsolidation(report.findings)) {
			queued(
				"consolidate",
				"consolidation",
				"Consolidate findings",
				[...new Set(report.findings.map((f) => f.file))],
				"Conservative semantic grouping",
			);
			const groups = new Map<string, string[][]>();
			const groupTool: AgentTool = {
				name: "record_groups",
				label: "Record grouping page",
				description:
					"Record a page of disjoint finding-ID groups under an idempotent key. Cover every finding across pages, then submit_result with empty groups.",
				parameters: Type.Object({ key: Type.String(), groups: ConsolidationSubmission.properties.groups }),
				executionMode: "sequential",
				async execute(_id, args) {
					const input = args as { key: string; groups: string[][] };
					const prior = groups.get(input.key);
					if (prior && JSON.stringify(prior) !== JSON.stringify(input.groups))
						throw new Error("Grouping checkpoint key reused");
					const proposed = [...groups]
						.filter(([key]) => key !== input.key)
						.flatMap(([, value]) => value)
						.concat(input.groups);
					const included = new Set(proposed.flat());
					validateGroups(
						proposed,
						report.findings.filter((finding) => included.has(finding.id)),
					);
					const commit = () => groups.set(input.key, input.groups);
					if (!deferToolCommit(commit)) commit();
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									acceptedKey: input.key,
									groupedIds: included.size,
								}),
							},
						],
						details: {},
					};
				},
			};
			const stateTool: AgentTool = {
				name: "group_state",
				label: "Grouping state",
				description: "Page authoritative ungrouped finding IDs after continuation. Offset counts IDs.",
				parameters: Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
				async execute(_id, args) {
					const grouped = new Set([...groups.values()].flat(2)),
						pending = report.findings.filter((f) => !grouped.has(f.id)).map((f) => f.id),
						offset = (args as { offset?: number }).offset ?? 0;
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									pending: pending.slice(offset, offset + 100),
									nextOffset: offset + 100 < pending.length ? offset + 100 : null,
								}),
							},
						],
						details: {},
					};
				},
			};
			const result = await work("Consolidating verified findings", () =>
				model(
					"consolidate",
					ConsolidationSubmission,
					"consolidate",
					{
						findings: report.findings,
						instructions:
							"For large outputs use record_groups incrementally and submit an empty final groups array. Singleton groups are valid; never omit a finding.",
					},
					[groupTool, stateTool],
					undefined,
					(value) => {
						validateGroups([...groups.values()].flat().concat(value.groups), report.findings);
					},
					[],
					undefined,
					report.findings.flatMap((finding) => candidateSources.get(finding.id) ?? []),
				),
			);
			if (result.ok)
				report.groups = validateGroups(
					[...groups.values()].flat().concat(result.value.groups),
					report.findings,
				);
			else
				(report.contextNotes ??= []).push(
					"Optional semantic consolidation unavailable; exact grouping retained without dropping findings.",
				);
		}
	} catch (error) {
		if (signal.aborted || error instanceof ReviewCancelled) {
			report.status = "cancelled";
			report.clean = [];
			tasks.cancel();
		} else
			report.issues.push(
				isPermissionBlocked(error)
					? `Permission blocked: ${error.message}`
					: error instanceof Error
						? error.message
						: "Review failed",
			);
	} finally {
		for (const candidate of candidates)
			if (!report.ledger.some((entry) => entry.id === candidate.id))
				report.ledger.push({
					id: candidate.id,
					verdict: "inconclusive",
					reason: "Verification interrupted or not run",
				});
		if (!report.groups.length && report.findings.length) report.groups = exactGroups(report.findings);
		report.tasks = tasks.snapshot();
		report.usage = report.tasks.reduce((sum, task) => sumUsage(sum, task.usage), emptyUsage());
		report.metrics = {
			peakActive: tasks.peakActive,
			modelRequests: report.tasks.reduce((sum, task) => sum + task.requests, 0),
			compactions: report.tasks.reduce((sum, task) => sum + task.compactions, 0),
		};
		report.elapsedMs = Date.now() - started;
	}
	if (report.status !== "cancelled" && report.issues.length) report.status = "incomplete";
	return report;
}
