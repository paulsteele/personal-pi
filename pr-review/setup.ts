import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveModel } from "./config.js";
import { loadProfile, validateDraft } from "./profile.js";
import { loadPrompts, systemPrompt } from "./prompts.js";
import { capture, snapshotTools } from "./snapshot.js";
import { profilePath, publish, readStored } from "./storage.js";
import {
	DiscoverySubmission,
	ProfileDraft,
	type Config,
	type Draft,
	type Profile,
	type Repo,
} from "./types.js";
import { runWorker } from "./worker.js";
import { directWork, type WorkPhase } from "./work-ui.js";

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
const draftPaths = (root: string, repo: Repo) => ({
	draft: join(root, "repos", repo.id, "profile-draft.json"),
	state: join(root, "repos", repo.id, "profile-draft-state.json"),
});
const draftMessage = (path: string) =>
	`Review profile draft saved at:\n${path}\n\nOpen this file in your editor and make any changes. Nothing has been activated.\nWhen ready, run /pr setup approve. Your existing approved profile remains active until then.`;
interface DraftState {
	repoId: string;
	generatedAt: string;
	generationModel: string;
}
async function saveDraft(
	root: string,
	repo: Repo,
	draft: Draft,
	state: DraftState,
	signal: AbortSignal,
): Promise<string> {
	const paths = draftPaths(root, repo);
	const previous = await readStored(root, paths.draft),
		metadata = await readStored(root, paths.state);
	await publish(root, paths.draft, validateDraft(draft), previous?.revision, signal);
	await publish(root, paths.state, state, metadata?.revision, signal);
	return draftMessage(paths.draft);
}
/** Activation is a separate explicit command. No model call, giant modal, recapture, or staleness gate. */
export async function approveSetup(repo: Repo, root: string, signal: AbortSignal): Promise<string> {
	const paths = draftPaths(root, repo);
	const stored = await readStored(root, paths.draft),
		metadata = await readStored(root, paths.state);
	if (!stored || !metadata)
		throw new Error(
			"No pending profile draft. Run /pr setup first (or /pr setup edit for an existing profile).",
		);
	const state = metadata.value as DraftState;
	if (
		!state ||
		state.repoId !== repo.id ||
		typeof state.generatedAt !== "string" ||
		typeof state.generationModel !== "string"
	)
		throw new Error("Invalid profile draft metadata; regenerate the draft with /pr setup regenerate.");
	const draft = validateDraft(stored.value);
	const current = await loadProfile(root, repo.id);
	if (
		(await readStored(root, paths.draft))?.revision !== stored.revision ||
		(await readStored(root, paths.state))?.revision !== metadata.revision
	)
		throw new Error("Profile draft changed during approval; inspect it and run /pr setup approve again.");
	const profile: Profile = {
		schemaVersion: 1,
		contextVersion: 1,
		repoId: repo.id,
		generatedAt: state.generatedAt,
		generationModel: state.generationModel,
		draft,
		sourceHashes: {},
	};
	await publish(root, profilePath(root, repo.id), profile, current?.revision, signal);
	// Keep the human-edited draft on disk. Mark it activated so a later /pr setup edit starts from the active profile.
	await publish(root, paths.state, { ...state, activated: true }, metadata.revision).catch(() => {});
	return `Saved generated PR review context at ${profilePath(root, repo.id)}. Run /pr to review. Ordinary repository changes do not require setup again.`;
}
export async function setup(
	ctx: ExtensionContext,
	repo: Repo,
	root: string,
	signal: AbortSignal,
	progress: (text: string) => void,
	work: WorkPhase = directWork,
	mode: "normal" | "edit" | "regenerate" = "normal",
): Promise<string> {
	const prior = await loadProfile(root, repo.id);
	const paths = draftPaths(root, repo);
	const pending = await readStored(root, paths.draft),
		metadata = await readStored(root, paths.state);
	if (mode !== "regenerate" && pending && metadata && !(metadata.value as { activated?: boolean }).activated)
		return draftMessage(paths.draft);
	if (mode === "normal" && prior)
		return `PR review is already configured. Run /pr; setup is not required after repository changes.\nApproved profile: ${profilePath(root, repo.id)}\nUse /pr setup edit to get an editable draft, or /pr setup regenerate only when you explicitly want a newly generated profile.`;
	if (mode === "edit") {
		if (!prior) throw new Error("No approved profile to edit. Run /pr setup first.");
		return saveDraft(
			root,
			repo,
			prior.profile.draft,
			{
				repoId: repo.id,
				generatedAt: new Date().toISOString(),
				generationModel: prior.profile.generationModel,
			},
			signal,
		);
	}
	const config = (await loadConfig(root)) ?? (await chooseModel(ctx, root, signal, work));
	const prompts = await loadPrompts();
	const snapshot = await work("Capturing repository context", () =>
		capture(repo, { kind: "local" }, config, [], signal),
	);
	try {
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
			throw new Error(`Repository discovery failed: ${discovery.error}. No approved profile was changed.`);
		const answers: Array<{ question: string; answer: string }> = [];
		for (const question of discovery.value.questions) {
			if (question.options.length < 2) throw new Error("Discovery returned an invalid interview question");
			const custom = "Write an answer…";
			let answer = await ctx.ui.select(question.question, [...question.options, custom], { signal });
			if (answer === custom) answer = await ctx.ui.input(question.question, undefined, { signal });
			if (answer === undefined) throw new Error("Setup cancelled");
			answers.push({ question: question.question, answer });
		}
		const generated = await work(`Generating repository profile (${config.provider}/${config.model})`, () =>
			runWorker({
				registry: ctx.modelRegistry,
				config,
				schema: ProfileDraft,
				system: systemPrompt(prompts, "profile"),
				input: { discovery: discovery.value, answers, previousProfile: prior?.profile },
				tools,
				signal,
				progress,
			}),
		);
		if (!generated.ok)
			throw new Error(`Profile generation failed: ${generated.error}. No approved profile was changed.`);
		return saveDraft(
			root,
			repo,
			validateDraft(generated.value),
			{
				repoId: repo.id,
				generatedAt: new Date().toISOString(),
				generationModel: `${config.provider}/${config.model}`,
			},
			signal,
		);
	} finally {
		await snapshot.dispose?.();
	}
}
