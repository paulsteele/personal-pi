import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkEvidence, exactGroups, validateGroups } from "./findings.js";
import { assertFresh, validateDraft } from "./profile.js";
import { hash, systemPrompt, type Prompts } from "./prompts.js";
import { selectLenses } from "./selection.js";
import { snapshotTools, type Change, type Snapshot } from "./snapshot.js";
import {
	BASELINES,
	ConsolidationSubmission,
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
import { runWorker, type WorkerUsage } from "./worker.js";
import { directWork, type WorkPhase } from "./work-ui.js";
import {
	documentBytes,
	JobBudgetExceeded,
	packReviewInputs,
	packVerificationInputs,
	prepareChanges,
	type ReviewInput,
} from "./batching.js";

export async function boundedMap<T, U>(
	items: T[],
	concurrency: number,
	signal: AbortSignal,
	run: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
	const result: U[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, items.length) }, async () => {
			for (;;) {
				signal.throwIfAborted();
				const index = next++;
				if (index >= items.length) return;
				result[index] = await run(items[index]!, index);
			}
		}),
	);
	return result;
}
async function documents(
	snapshot: Snapshot,
	paths: string[],
	maxBytes: number,
): Promise<Record<string, string>> {
	const entries: Array<[string, string]> = [];
	let bytes = 2;
	for (const path of new Set(paths)) {
		const text = (await snapshot.read(path)).toString();
		bytes += documentBytes(path, text) + (entries.length ? 1 : 0);
		if (bytes > maxBytes) throw new Error("Required convention material exceeds worker context budget");
		entries.push([path, text]);
	}
	return Object.fromEntries(entries);
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
}): Promise<Report> {
	const { ctx, config, profile, snapshot, prompts, signal, progress } = options;
	const work = options.work ?? directWork;
	await work("Checking context freshness", () => assertFresh(profile, (path) => snapshot.read(path)));
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
		usage: { input: 0, output: 0, cost: 0 },
	};
	const addUsage = (usage: WorkerUsage) => {
		report.usage.input += usage.input;
		report.usage.output += usage.output;
		report.usage.cost += usage.cost;
	};
	const tools = snapshotTools(snapshot);
	const candidates: Candidate[] = [];
	try {
		if (!snapshot.changes.length) {
			report.status = snapshot.omitted.some((item) => !item.reason.startsWith("excluded:"))
				? "incomplete"
				: "no-changes";
			return report;
		}
		if (snapshot.omitted.some((item) => !item.reason.startsWith("excluded:")))
			report.issues.push("Some changed files could not be reviewed; see omissions");
		let lenses = selectLenses(profile.draft, snapshot.changes, prompts);
		const proposals = await work(
			`Looking for additional specialists (${config.provider}/${config.model})`,
			() =>
				runWorker({
					registry: ctx.modelRegistry,
					config,
					schema: ProposalSubmission,
					system: systemPrompt(prompts, "propose"),
					input: {
						project: profile.draft.summary,
						selected: lenses,
						changedFiles: snapshot.changes.map((change) => change.file),
						// Evidence can be inspected in full through snapshot tools; this scout gets bounded previews.
						diffPreviews: snapshot.changes.slice(0, 50).map((change) => ({
							file: change.file,
							patchPreview: change.patch.slice(0, 1000),
							truncated: change.patch.length > 1000,
						})),
						previewsIncomplete: snapshot.changes.length > 50,
					},
					tools,
					signal,
					progress: (note) => progress(`Specialist scout: ${note}`),
				}),
		);
		addUsage(proposals.usage);
		if (proposals.ok) {
			const valid: typeof proposals.value.specialists = [];
			const ids = new Set(lenses.map((lens) => lens.id));
			await work("Validating proposed specialists", async () => {
				for (const proposal of proposals.value.specialists) {
					try {
						validateDraft({
							...profile.draft,
							specialists: [...profile.draft.specialists, proposal.specialist],
						});
						if (
							ids.has(proposal.specialist.id) ||
							!proposal.files.length ||
							!proposal.files.every((file) => snapshot.changes.some((change) => change.file === file))
						)
							throw new Error("Proposal lacks changed-file evidence or duplicates a lens");
						await documents(snapshot, proposal.specialist.requiredReading, config.maxInputBytes);
						ids.add(proposal.specialist.id);
						valid.push(proposal);
					} catch {
						report.issues.push(`Invalid specialist proposal: ${proposal.specialist.name}`);
					}
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
							reading: [...profile.draft.requiredReading, ...item.specialist.requiredReading],
							reason: `User-approved proposal: ${item.reason}`,
						});
					else report.declined.push(item.specialist.name);
				}
			}
		} else report.issues.push(`Specialist proposal stage incomplete: ${proposals.error}`);
		if (lenses.length > config.maxReviewers) {
			const extras = lenses.filter((lens) => !BASELINES.some((id) => id === lens.id));
			const selected = await chooseMany(
				ctx,
				"Roster exceeds budget: select specialists to retain",
				extras.map((lens) => ({ id: lens.id, label: lens.name })),
				signal,
				extras.map((lens) => lens.id),
				config.maxReviewers - 4,
			);
			for (const lens of extras)
				if (!selected.includes(lens.id)) report.declined.push(`${lens.name} (user narrowed roster)`);
			lenses = lenses.filter((lens) => BASELINES.some((id) => id === lens.id) || selected.includes(lens.id));
		}
		report.lenses = lenses;
		type Job = { lens: Lens; input: ReviewInput };
		const jobs: Job[] = [];
		const blocked = new Set<string>();
		await work("Preparing reviewer context", async () => {
			const parts = await prepareChanges(snapshot.changes, signal);
			const system = systemPrompt(prompts, "reviewer");
			for (const lens of lenses) {
				signal.throwIfAborted();
				try {
					const base = {
						project: profile.draft.summary,
						lens,
						requiredDocuments: await documents(snapshot, lens.reading, config.maxInputBytes),
					};
					const packed = await packReviewInputs(base, parts, {
						system,
						maxBytes: config.maxInputBytes,
						maxJobs: config.maxJobs - jobs.length,
						signal,
					});
					for (const file of packed.omitted) {
						blocked.add(lens.id);
						report.issues.push(`${lens.name}: ${file} exceeds worker context budget`);
					}
					for (const input of packed.inputs) jobs.push({ lens, input });
				} catch (error) {
					if (signal.aborted || error instanceof JobBudgetExceeded) throw error;
					blocked.add(lens.id);
					report.issues.push(
						`${lens.name}: ${error instanceof Error ? error.message : "required convention material unavailable"}`,
					);
				}
			}
		});
		if (jobs.length > config.maxJobs)
			throw new Error(
				"Review requires more jobs than configured budget; narrow the scope or adjust runtime limits",
			);
		const results = await work(
			`Reviewing changes (${jobs.length} jobs, ${config.concurrency} concurrent)`,
			() =>
				boundedMap(jobs, config.concurrency, signal, async (job, index) => {
					progress(`Review ${index + 1}/${jobs.length}: ${job.lens.name}`);
					return runWorker({
						registry: ctx.modelRegistry,
						config,
						schema: ReviewSubmission,
						system: systemPrompt(prompts, "reviewer"),
						input: job.input,
						tools,
						signal,
						progress: (note) => progress(`${job.lens.name} [${index + 1}/${jobs.length}]: ${note}`),
					});
				}),
		);
		const dirty = new Set<string>();
		for (let index = 0; index < results.length; index++) {
			const result = results[index]!,
				job = jobs[index]!;
			addUsage(result.usage);
			if (!result.ok) {
				blocked.add(job.lens.id);
				report.issues.push(`${job.lens.name}: ${result.error}`);
				continue;
			}
			if (!result.value.complete || result.value.limitations.length) {
				blocked.add(job.lens.id);
				report.issues.push(`${job.lens.name}: incomplete. ${result.value.limitations.join("; ")}`);
			}
			for (const finding of result.value.findings) {
				dirty.add(job.lens.id);
				if (!job.input.changes.some((change) => change.file === finding.file))
					report.issues.push(
						`${job.lens.name}: finding outside assigned chunk; independent verification required`,
					);
				candidates.push({ ...finding, id: `F${candidates.length + 1}`, reviewer: job.lens.name });
			}
		}
		report.clean = lenses
			.filter(
				(lens) => !blocked.has(lens.id) && !dirty.has(lens.id) && jobs.some((job) => job.lens.id === lens.id),
			)
			.map((lens) => lens.name);
		const packedVerification = await work("Preparing verification context", () =>
			packVerificationInputs({
				project: profile.draft.summary,
				candidates,
				lenses,
				snapshot,
				system: systemPrompt(prompts, "verifier"),
				maxBytes: config.maxInputBytes,
				maxJobs: config.maxJobs - jobs.length,
				signal,
			}),
		);
		for (const rejected of packedVerification.rejected)
			report.ledger.push({ id: rejected.id, verdict: "inconclusive", reason: rejected.reason });
		const batches = packedVerification.batches;
		const verified = await work(`Verifying findings (${batches.length} batches)`, () =>
			boundedMap(batches, config.concurrency, signal, async (batch, index) => {
				progress(`Verify ${index + 1}/${batches.length}: ${batch.candidates[0]!.file}`);
				return runWorker({
					registry: ctx.modelRegistry,
					config,
					schema: VerificationSubmission,
					system: systemPrompt(prompts, "verifier"),
					input: batch.input,
					tools,
					signal,
					progress: (note) => progress(`Verification [${index + 1}/${batches.length}]: ${note}`),
				});
			}),
		);
		for (let index = 0; index < verified.length; index++) {
			const result = verified[index]!,
				batch = batches[index]!.candidates;
			addUsage(result.usage);
			const verdicts = result.ok ? result.value.verdicts : [];
			if (verdicts.some((verdict) => !batch.some((finding) => finding.id === verdict.id)))
				report.issues.push("Verifier returned unknown candidate IDs");
			for (const candidate of batch) {
				const matched = verdicts.filter((verdict) => verdict.id === candidate.id);
				if (matched.length !== 1) {
					report.ledger.push({
						id: candidate.id,
						verdict: "inconclusive",
						reason: result.ok ? "Missing/duplicate verdict" : result.error,
					});
					continue;
				}
				const verdict = matched[0]!;
				if (verdict.verdict === "dropped" || verdict.verdict === "inconclusive") {
					report.ledger.push({ id: candidate.id, verdict: verdict.verdict, reason: verdict.reason });
					continue;
				}
				try {
					const finding = verdict.verdict === "corrected" ? verdict.corrected : candidate;
					if (!finding || finding.severity !== candidate.severity)
						throw new Error("Invalid correction/severity change");
					await checkEvidence(finding, snapshot);
					report.findings.push({ ...finding, id: candidate.id, reviewer: candidate.reviewer });
					report.ledger.push({ id: candidate.id, verdict: verdict.verdict, reason: verdict.reason });
				} catch (error) {
					report.ledger.push({
						id: candidate.id,
						verdict: "inconclusive",
						reason: error instanceof Error ? error.message : "Evidence validation failed",
					});
				}
			}
		}
		if (report.ledger.some((entry) => entry.verdict === "inconclusive"))
			report.issues.push("Some findings could not be verified");
		report.groups = exactGroups(report.findings);
		if (report.findings.length > 1) {
			const grouped = await work("Consolidating verified findings", () =>
				runWorker({
					registry: ctx.modelRegistry,
					config,
					schema: ConsolidationSubmission,
					system: systemPrompt(prompts, "consolidate"),
					input: { findings: report.findings },
					signal,
					progress: (note) => progress(`Consolidation: ${note}`),
				}),
			);
			addUsage(grouped.usage);
			try {
				if (!grouped.ok) throw new Error(grouped.error);
				report.groups = validateGroups(grouped.value.groups, report.findings);
			} catch {
				report.issues.push("Semantic consolidation unavailable; conservative exact grouping retained");
			}
		}
	} catch (error) {
		if (signal.aborted || error instanceof ReviewCancelled) report.status = "cancelled";
		else report.issues.push(error instanceof Error ? error.message : "Review pipeline failed");
	} finally {
		for (const candidate of candidates)
			if (!report.ledger.some((entry) => entry.id === candidate.id))
				report.ledger.push({
					id: candidate.id,
					verdict: "inconclusive",
					reason: "Verification interrupted or not run",
				});
		if (!report.groups.length && report.findings.length) report.groups = exactGroups(report.findings);
		report.elapsedMs = Date.now() - started;
	}
	if (report.status !== "cancelled" && report.issues.length) report.status = "incomplete";
	return report;
}
