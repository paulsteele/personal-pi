/**
 * Auto mode — a Claude-Code-style permission classifier for Pi.
 *
 * Registers an authorizer chain link with `@gotgenes/pi-permission-system`.
 * The link is consulted only when the deterministic policy lands on `ask`, and
 * reviews the concrete action with a light model instead of interrupting the
 * operator for routine work.
 *
 * Three invariants govern this extension:
 *
 * 1. **The runtime toggle is the sole authority.** The link defers everything
 *    while auto mode is off, so a stale `authorizerChain` entry left in the
 *    permission-system config can never grant authority on its own.
 * 2. **Every uncertainty defers.** Missing config, unresolved model, auth
 *    failure, timeout, malformed reply, capped surface — all fall through to
 *    the human prompt. Auto mode can only remove a prompt it is confident
 *    about, or add a denial.
 * 3. **The permission policy is never rewritten.** This extension reads the
 *    permission-system config; it never writes it.
 */

import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classify, type ModelCaller, type ReviewContext, type ReviewFacts } from "./classifier.ts";

import { loadAutoModeConfig, saveAutoModeModel, type AutoModeConfig, type ConfigLoadResult } from "./config.ts";
import {
	applyCap,
	cacheKey,
	DecisionLog,
	DEFER,
	footerLabel,
	isCappedSurface,
	resolveGateSurface,
	VerdictCache,
	type AutoModeSnapshot,
	type DecisionRecord,
	type DeferReason,
	type Verdict,
} from "./core.ts";
import { publishPanel, type PanelPublisher } from "./panel.ts";

/** The chain-link name the operator must list in `authorizerChain`. */
const LINK_NAME = "auto";
const STATUS_KEY = "auto-mode";

/**
 * Process-global slot the permission system publishes its service into.
 *
 * Read directly rather than through `getPermissionsService()`. That helper is
 * only a typed read of this same slot, and importing the package by its bare
 * specifier is unreliable here: its `exports` map lists a `types` condition
 * ahead of `default`, so some loaders resolve the declaration file and hand
 * back a module with no runtime exports. `Symbol.for` is process-global by
 * spec, which is precisely why the package chose it as the seam, so reading
 * the slot works regardless of how the module graph resolved.
 */
const SERVICE_KEY = Symbol.for("@gotgenes/pi-permission-system:service");

/** Narrow shapes for the permission-system service, kept structural so this
 * extension degrades gracefully when the package is absent or a different
 * major version is installed. */
interface AuthorizerLogLike {
	review(event: string, details?: Record<string, unknown>): void;
	debug(event: string, details?: Record<string, unknown>): void;
}
interface PermissionsServiceLike {
	registerAuthorizer?(
		name: string,
		authorize: (details: unknown, query: unknown, log: AuthorizerLogLike) => Promise<Verdict>,
	): () => void;
}

interface Runtime {
	ctx: ExtensionContext;
	config: AutoModeConfig;
	load: ConfigLoadResult;
	enabled: boolean;
	cache: VerdictCache;
	log: DecisionLog;
	panel: PanelPublisher;
	gitRemotes: readonly string[];
	disposers: Array<() => void>;
	notifiedIssues: boolean;
}

export default function autoMode(pi: ExtensionAPI): void {
	let runtime: Runtime | undefined;

	// ── Snapshot / presentation ────────────────────────────────────────────

	function snapshot(): AutoModeSnapshot {
		if (!runtime)
			return { enabled: false, usable: false, modelId: "unconfigured", allowed: 0, denied: 0, escalated: 0, recent: [] };
		const counts = runtime.log.counts;
		return {
			enabled: runtime.enabled,
			usable: runtime.load.usable,
			modelId:
				runtime.config.provider && runtime.config.model
					? `${runtime.config.provider}/${runtime.config.model}`
					: "unconfigured",
			allowed: counts.allowed,
			denied: counts.denied,
			escalated: counts.escalated,
			recent: runtime.log.recent(8),
		};
	}

	function refreshPresentation(): void {
		if (!runtime) return;
		const current = snapshot();
		if (runtime.ctx.hasUI) {
			// Only advertise a status while armed; a manual session should look
			// exactly as it did before this extension was installed.
			runtime.ctx.ui.setStatus(STATUS_KEY, current.enabled ? footerLabel(current) : undefined);
		}
		runtime.panel.update(current);
	}

	// ── Review pipeline ────────────────────────────────────────────────────

	/** Record one review to the shared permission review log and the panel. */
	function record(
		log: AuthorizerLogLike,
		requestId: string,
		facts: { surface: string; value: string },
		verdict: Verdict,
		deferReason: DeferReason | null,
		modelCalled: boolean,
		latencyMs: number | null,
		cached: boolean,
	): void {
		const entry: DecisionRecord = {
			requestId,
			surface: facts.surface,
			value: facts.value,
			verdict: verdict.kind,
			reason: verdict.reason ?? null,
			deferReason,
			modelCalled,
			latencyMs,
			cached,
			at: Date.now(),
		};
		runtime?.log.add(entry);
		// One durable entry per handled ask, joinable to the gate's own records
		// by requestId. A misconfiguration that silently defers everything shows
		// up here as a run of deferReason entries rather than an empty log.
		log.review("auto_mode.decision", {
			requestId,
			surface: entry.surface,
			verdict: entry.verdict,
			deferReason: entry.deferReason,
			modelCalled: entry.modelCalled,
			latencyMs: entry.latencyMs,
			cached: entry.cached,
			modelId: runtime ? `${runtime.config.provider}/${runtime.config.model}` : null,
		});
		refreshPresentation();
	}

	/** Extract the classifier's view of the ask from the prompt payload. */
	function toFacts(details: Record<string, unknown>, surface: string): ReviewFacts {
		const payload = details.payload as
			| { request?: Record<string, unknown>; evidence?: unknown }
			| undefined;
		const request = payload?.request ?? {};
		const str = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

		const evidence: Array<{ label: string; text: string; detail: string | null }> = [];
		if (Array.isArray(payload?.evidence)) {
			for (const item of payload.evidence) {
				if (typeof item !== "object" || item === null) continue;
				const entry = item as { label?: unknown; text?: unknown; detail?: unknown };
				if (typeof entry.label !== "string" || typeof entry.text !== "string") continue;
				evidence.push({ label: entry.label, text: entry.text, detail: str(entry.detail) });
			}
		}

		const requester = request.requester as { agentName?: unknown; forwarded?: unknown } | undefined;
		return {
			surface,
			toolName: str(request.toolName),
			invokedToolName: str(request.invokedToolName),
			value: str(request.value) ?? str(details.value) ?? "",
			matchedPattern: str(request.matchedPattern),
			commandContext: str(request.commandContext),
			executedUnit: str(request.executedUnit),
			agentName: str(requester?.agentName) ?? str(details.agentName),
			forwarded: requester?.forwarded === true,
			evidence,
		};
	}

	/** Recent user turns, newest last. Untrusted context for the classifier. */
	function recentUserTurns(ctx: ExtensionContext, limit: number): readonly string[] {
		if (limit <= 0) return [];
		const turns: string[] = [];
		try {
			const branch = ctx.sessionManager.getBranch();
			for (let i = branch.length - 1; i >= 0 && turns.length < limit; i--) {
				const entry = branch[i] as { type?: unknown; message?: { role?: unknown; content?: unknown } };
				if (entry?.type !== "message" || entry.message?.role !== "user") continue;
				const content = entry.message.content;
				const text =
					typeof content === "string"
						? content
						: Array.isArray(content)
							? content
									.filter(
										(part): part is { type: "text"; text: string } =>
											typeof part === "object" &&
											part !== null &&
											(part as { type?: unknown }).type === "text" &&
											typeof (part as { text?: unknown }).text === "string",
									)
									.map((part) => part.text)
									.join("\n")
							: "";
				if (text.trim()) turns.push(text.trim());
			}
		} catch {
			// A session-shape change must not break the gate.
		}
		return turns.reverse();
	}

	/** The link. Returns a verdict for one `ask`. Never throws. */
	async function authorize(rawDetails: unknown, _query: unknown, log: AuthorizerLogLike): Promise<Verdict> {
		const details = (typeof rawDetails === "object" && rawDetails !== null ? rawDetails : {}) as Record<
			string,
			unknown
		>;
		const requestId = typeof details.requestId === "string" ? details.requestId : "unknown";

		// 1. The runtime toggle is authoritative. Config drift grants nothing.
		if (!runtime?.enabled) {
			log.debug("auto_mode.short_circuit", { requestId, deferReason: "toggle-off" });
			return DEFER;
		}
		if (!runtime.load.usable) {
			record(log, requestId, { surface: "unknown", value: "" }, DEFER, "config-unusable", false, null, false);
			return DEFER;
		}

		// 2. Determine the gate surface the rule actually fired on.
		const surface = resolveGateSurface(details as never);
		if (surface === undefined) {
			record(log, requestId, { surface: "unknown", value: "" }, DEFER, "unknown-surface", false, null, false);
			return DEFER;
		}

		const facts = toFacts(details, surface);

		// 3. `path` and `external_directory` deliberately continue through the
		//    classifier. The local Bun patch exempts only the explicitly named
		//    `auto` link from pi-permission-system's delegation envelope, so this
		//    verdict can take effect without copying its ~2,800-line Bash/path
		//    parser into this plugin. Every other authorizer remains capped.

		// 4. Turn-scoped cache: one verdict per distinct action per turn.
		const key = cacheKey(surface, facts.value, facts.agentName);
		const cached = runtime.cache.get(key);
		if (cached) {
			record(log, requestId, facts, cached, null, false, null, true);
			return cached;
		}

		// 5. Resolve the model through Pi's registry (not a bare `getModel`), so
		//    registered custom providers such as litellm and llama-cpp resolve too.
		//    An unresolved model or missing auth defers rather than blocks.
		let model: ReturnType<ExtensionContext["modelRegistry"]["find"]>;
		try {
			model = runtime.ctx.modelRegistry.find(runtime.config.provider, runtime.config.model);
		} catch {
			model = undefined;
		}
		if (!model) {
			record(log, requestId, facts, DEFER, "model-unresolved", false, null, false);
			return DEFER;
		}
		if (!runtime.ctx.modelRegistry.hasConfiguredAuth(model)) {
			record(log, requestId, facts, DEFER, "auth-failed", false, null, false);
			return DEFER;
		}

		// 6. Review.
		const context: ReviewContext = {
			cwd: runtime.ctx.cwd,
			gitRemotes: runtime.gitRemotes,
			recentUserTurns: recentUserTurns(runtime.ctx, runtime.config.contextUserTurns),
		};
		const result = await classify({
			caller: runtime.ctx.modelRegistry as unknown as ModelCaller,
			model: model as never,
			facts,
			context,
			config: runtime.config,
			signal: runtime.ctx.signal,
		});

		// 7. Local mirror of the bounded-delegation cap, belt and braces.
		const capped = applyCap(result.verdict, surface);
		const verdict = capped.verdict;
		const deferReason = capped.deferReason ?? result.deferReason;

		log.debug("auto_mode.model_reply", {
			requestId,
			surface,
			verdict: verdict.kind,
			latencyMs: result.latencyMs,
		});

		runtime.cache.set(key, verdict);
		record(log, requestId, facts, verdict, deferReason, result.modelCalled, result.latencyMs, false);
		return verdict;
	}

	// ── Registration ───────────────────────────────────────────────────────

	/**
	 * Register the link against the currently published service.
	 *
	 * Called from `permissions:ready`, which fires at every `session_start`
	 * including `/reload`. The permission system publishes a fresh service each
	 * time and drops previous registrations, so re-registering per load is the
	 * documented pattern rather than a leak.
	 */
	function registerLink(): void {
		if (!runtime) return;
		try {
			const service = (globalThis as Record<symbol, unknown>)[SERVICE_KEY] as
				| PermissionsServiceLike
				| undefined;
			if (typeof service?.registerAuthorizer !== "function") return;
			const dispose = service.registerAuthorizer(LINK_NAME, authorize);
			runtime.disposers.push(dispose);
		} catch {
			// Absent, incompatible, or already registered — auto mode stays inert
			// and every ask keeps prompting exactly as it does today.
		}
	}

	async function readGitRemotes(): Promise<readonly string[]> {
		try {
			const result = await pi.exec("git", ["remote", "-v"], { timeout: 3000 });
			if (result.code !== 0) return [];
			const seen = new Set<string>();
			for (const line of result.stdout.split("\n")) {
				const match = /^(\S+)\s+(\S+)/.exec(line.trim());
				if (match) seen.add(`${match[1]} ${match[2]}`);
			}
			return [...seen];
		} catch {
			return [];
		}
	}

	function setEnabled(ctx: ExtensionContext, next: boolean): void {
		if (!runtime) return;
		runtime.enabled = next;
		// Claude Code drops every cached verdict on a mode change; a verdict
		// decided under one mode must not silently carry into another.
		runtime.cache.clear();
		refreshPresentation();

		if (!next) {
			ctx.ui.notify("Auto mode off — every permission request will prompt.", "info");
			return;
		}
		if (!runtime.load.usable) {
			ctx.ui.notify(
				"Auto mode armed, but no classifier model is configured. Set 'provider' and 'model' in " +
					"~/.pi/agent/extensions/auto-mode/config.json — until then every request still prompts.",
				"warning",
			);
			return;
		}
		ctx.ui.notify(`Auto mode on — ${runtime.config.provider}/${runtime.config.model} reviews each request.`, "info");
	}

	// ── Lifecycle ──────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		// Retire any previous generation before installing a new one.
		for (const dispose of runtime?.disposers ?? []) {
			try {
				dispose();
			} catch {
				// A failed disposer must not block a new session.
			}
		}
		runtime?.panel.dispose();

		const load = loadAutoModeConfig({
			agentDir: getAgentDir(),
			cwd: ctx.cwd,
			configDirName: CONFIG_DIR_NAME,
			projectTrusted: ctx.isProjectTrusted(),
		});

		runtime = {
			ctx,
			config: load.config,
			load,
			enabled: load.config.enabledByDefault && load.usable,
			cache: new VerdictCache(),
			log: new DecisionLog(load.config.maxDecisionLog),
			panel: publishPanel(pi),
			gitRemotes: [],
			disposers: [],
			notifiedIssues: false,
		};

		// Only surface config problems when the operator actually intends to use
		// auto mode; an unconfigured install should stay silent.
		if (ctx.hasUI && !runtime.notifiedIssues && load.config.enabledByDefault && load.issues.length > 0) {
			runtime.notifiedIssues = true;
			ctx.ui.notify(load.issues.join("\n"), "warning");
		}

		refreshPresentation();
		runtime.gitRemotes = await readGitRemotes();
	});

	// The service is published immediately before this fires, so the link can
	// be registered without racing load order.
	pi.events.on("permissions:ready", () => {
		registerLink();
	});

	// A verdict is scoped to the turn that produced it.
	pi.on("turn_start", () => {
		runtime?.cache.clear();
	});

	pi.on("session_shutdown", () => {
		for (const dispose of runtime?.disposers ?? []) {
			try {
				dispose();
			} catch {
				// Best-effort teardown.
			}
		}
		runtime?.panel.dispose();
		if (runtime?.ctx.hasUI) runtime.ctx.ui.setStatus(STATUS_KEY, undefined);
		runtime = undefined;
	});

	// ── Operator controls ──────────────────────────────────────────────────

	pi.registerCommand("auto-model", {
		description: "Select the classifier model used by auto mode for this session",
		handler: async (args, ctx) => {
			if (!runtime) return;

			const available = runtime.ctx.modelRegistry.getAvailable();
			const input = args.trim();
			let selected: (typeof available)[number] | undefined;

			if (input) {
				const slash = input.indexOf("/");
				if (slash <= 0 || slash === input.length - 1) {
					ctx.ui.notify("Usage: /auto-model <provider>/<model> (or run /auto-model with no argument to pick)", "warning");
					return;
				}
				const provider = input.slice(0, slash);
				const modelId = input.slice(slash + 1);
				selected = available.find((model) => model.provider === provider && model.id === modelId);
				if (!selected) {
					ctx.ui.notify(`Auto-mode model is not available: ${input}`, "error");
					return;
				}
			} else {
				if (!ctx.hasUI) {
					ctx.ui.notify("Pass a model as provider/model in non-interactive mode.", "warning");
					return;
				}
				const labels = available.map((model) => `${model.provider}/${model.id}`);
				const current = `${runtime.config.provider}/${runtime.config.model}`;
				// Put the current model first so Enter keeps it, while retaining the
				// registry's provider/model identity as the unambiguous selector.
				labels.sort((a, b) => (a === current ? -1 : b === current ? 1 : a.localeCompare(b)));
				const choice = await ctx.ui.select(`Auto-mode classifier (${current})`, labels);
				if (!choice) return;
				const slash = choice.indexOf("/");
				selected = available.find(
					(model) => model.provider === choice.slice(0, slash) && model.id === choice.slice(slash + 1),
				);
			}

			if (!selected) return;
			// Session-local by design: the command changes no files. Edit
			// extensions/auto-mode/config.json when the selection should persist.
			try {
				saveAutoModeModel(getAgentDir(), selected.provider, selected.id);
			} catch (error) {
				ctx.ui.notify(
					`Could not save auto-mode model: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}
			runtime.config = { ...runtime.config, provider: selected.provider, model: selected.id };
			runtime.cache.clear();
			ctx.ui.notify(`Auto-mode classifier: ${selected.provider}/${selected.id} (saved)`, "info");
			refreshPresentation();
		},
		getArgumentCompletions: (prefix: string) => {
			if (!runtime) return null;
			const needle = prefix.trim().toLowerCase();
			const items = runtime.ctx.modelRegistry
				.getAvailable()
				.map((model) => ({
					value: `${model.provider}/${model.id}`,
					label: `${model.provider}/${model.id}`,
					description: model.name,
				}))
				.filter((item) => item.value.toLowerCase().includes(needle));
			return items.length > 0 ? items : null;
		},
	});

	pi.registerCommand("auto", {
		description: "Toggle auto mode (classifier-reviewed permissions)",
		handler: async (args, ctx) => {
			if (!runtime) return;
			const argument = args.trim().toLowerCase();
			const next = argument === "on" ? true : argument === "off" ? false : !runtime.enabled;
			setEnabled(ctx, next);
		},
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "on", label: "on", description: "Arm auto mode for this session" },
				{ value: "off", label: "off", description: "Return to manual approval" },
			].filter((item) => item.value.startsWith(prefix.trim().toLowerCase()));
			return items.length > 0 ? items : null;
		},
	});

	pi.registerShortcut("ctrl+shift+a", {
		description: "Toggle auto mode",
		handler: async (ctx) => {
			if (runtime) setEnabled(ctx as ExtensionContext, !runtime.enabled);
		},
	});
}
