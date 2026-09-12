import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveModel } from "./config.js";
import { assertFresh, fingerprints, validateDraft } from "./profile.js";
import { hash, loadPrompts, systemPrompt } from "./prompts.js";
import { capture, snapshotTools } from "./snapshot.js";
import { profilePath, publish, readStored } from "./storage.js";
import {
	DiscoverySubmission,
	ProfileDraft,
	ProfileSchema,
	validate,
	type Config,
	type Profile,
	type Repo,
} from "./types.js";
import { runWorker } from "./worker.js";
import { awaitWithSignal, directWork, type WorkPhase } from "./work-ui.js";

export async function chooseModel(
	ctx: ExtensionContext,
	root: string,
	signal?: AbortSignal,
	work: WorkPhase = directWork,
): Promise<Config> {
	const available = ctx.modelRegistry.getAvailable();
	const choice = await ctx.ui.select(
		"Independent PR review model",
		available.map((model) => `${model.provider}/${model.id}`),
		signal ? { signal } : undefined,
	);
	const model = available.find((item) => `${item.provider}/${item.id}` === choice);
	if (!model) throw new Error("Model selection cancelled");
	const thinking = model.reasoning
		? await ctx.ui.select(
				"Independent reviewer reasoning",
				["off", "low", "medium", "high"],
				signal ? { signal } : undefined,
			)
		: "off";
	if (!thinking) throw new Error("Reasoning selection cancelled");
	return work("Saving independent review model", () =>
		saveModel(root, model.provider, model.id, thinking as Config["thinking"], signal),
	);
}
export async function setup(
	ctx: ExtensionContext,
	repo: Repo,
	root: string,
	signal: AbortSignal,
	progress: (text: string) => void,
	work: WorkPhase = directWork,
): Promise<string> {
	const config = (await loadConfig(root)) ?? (await chooseModel(ctx, root, signal, work));
	const prompts = await loadPrompts();
	const path = profilePath(root, repo.id);
	const prior = await readStored(root, path);
	// Do not silently replace malformed profiles, even during regeneration.
	if (prior) validateDraft(validate(ProfileSchema, prior.value).draft);
	const snapshot = await work("Capturing repository context", () =>
		capture(repo, { kind: "local" }, config, [], signal),
	);
	const legacy = ".claude/skills/pr/SKILL.md";
	let legacySkill: string | undefined;
	if (
		snapshot.paths().includes(legacy) &&
		(await ctx.ui.confirm("Import existing PR skill?", `Use ${legacy} as repository-context input only?`, {
			signal,
		}))
	)
		legacySkill = (await snapshot.read(legacy)).toString();
	const tools = snapshotTools(snapshot);
	const discovery = await work(`Discovering repository context (${config.provider}/${config.model})`, () =>
		runWorker({
			registry: ctx.modelRegistry,
			config,
			schema: DiscoverySubmission,
			system: systemPrompt(prompts, "discover"),
			input: { files: snapshot.paths().slice(0, 1000), totalFiles: snapshot.paths().length, legacySkill },
			tools,
			signal,
			progress,
		}),
	);
	if (!discovery.ok)
		throw new Error(
			`Repository discovery failed: ${discovery.error}. Setup has not reached profile approval.`,
		);
	const answers: Array<{ question: string; answer: string }> = [];
	for (const question of discovery.value.questions) {
		if (question.options.length < 2) throw new Error("Discovery returned an invalid interview question");
		const custom = "Write an answer…";
		let answer = await ctx.ui.select(question.question, [...question.options, custom], { signal });
		if (answer === custom) answer = await ctx.ui.input(question.question, undefined, { signal });
		if (answer === undefined) throw new Error("Setup cancelled");
		answers.push({ question: question.question, answer });
	}
	const corrections: string[] = [];
	for (let attempt = 0; attempt < 4; attempt++) {
		signal.throwIfAborted();
		const generated = await work(`Generating repository profile (${config.provider}/${config.model})`, () =>
			runWorker({
				registry: ctx.modelRegistry,
				config,
				schema: ProfileDraft,
				system: systemPrompt(prompts, "profile"),
				input: { discovery: discovery.value, answers, corrections, previousProfile: prior?.value },
				tools,
				signal,
				progress,
			}),
		);
		if (!generated.ok)
			throw new Error(`Profile generation failed: ${generated.error}. No new profile was approved.`);
		const draft = validateDraft(generated.value);
		draft.freshnessSources = [
			...new Set([...draft.freshnessSources, ...discovery.value.sources, ...(legacySkill ? [legacy] : [])]),
		];
		validateDraft(draft);
		await work("Validating generated document references", () =>
			fingerprints(draft, (file) => snapshot.read(file)),
		);
		const preview = await awaitWithSignal(
			ctx.ui.editor(
				prior ? "Regenerated PR profile — inspect or edit" : "New PR profile — inspect or edit",
				JSON.stringify(draft, null, 2),
			),
			signal,
		);
		if (preview === undefined) throw new Error("Setup cancelled");
		const edited = validateDraft(JSON.parse(preview));
		const decision = await ctx.ui.select(
			"Activate this generated review context?",
			["Approve", "Revise with feedback", "Cancel"],
			{ signal },
		);
		if (decision === "Revise with feedback") {
			const feedback = await ctx.ui.input("What should change?", undefined, { signal });
			if (feedback === undefined) throw new Error("Setup cancelled");
			corrections.push(feedback);
			continue;
		}
		if (decision !== "Approve") throw new Error("Setup cancelled");
		await work("Rechecking sources and saving approved profile", async () => {
			const profile: Profile = {
				schemaVersion: 1,
				contextVersion: 1,
				repoId: repo.id,
				generatedAt: new Date().toISOString(),
				generationModel: `${config.provider}/${config.model}`,
				draft: edited,
				sourceHashes: await fingerprints(edited, (file) => snapshot.read(file)),
			};
			const fresh = await capture(repo, { kind: "local" }, config, [], signal);
			await assertFresh(profile, (file) => fresh.read(file));
			if (hash(JSON.stringify((await loadPrompts()).hashes)) !== hash(JSON.stringify(prompts.hashes)))
				throw new Error("Shared instructions changed during setup; retry");
			signal.throwIfAborted();
			await publish(root, path, profile, prior?.revision, signal);
		});
		return `Saved generated PR review context at ${path}. Fixed rules remain versioned in the harness.`;
	}
	throw new Error("Setup revision budget exhausted; rerun /pr setup");
}
