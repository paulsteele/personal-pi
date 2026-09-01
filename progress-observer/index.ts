import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, type ObserverConfig, loadConfig, saveEnabled, saveModel } from "./config.js";
import { createObserverPublisher } from "./events.js";
import { buildObservationPrompt, observe } from "./observer.js";
import { createObserverScheduler, type ObserverScheduler } from "./scheduler.js";

interface Runtime {
	ctx: ExtensionContext;
	config: ObserverConfig;
	scheduler: ObserverScheduler;
	publisher: ReturnType<typeof createObserverPublisher>;
	configValid: boolean;
}

export default function progressObserver(pi: ExtensionAPI): void {
	let runtime: Runtime | undefined;

	const modelId = (config: ObserverConfig): string => `${config.provider}/${config.model}`;

	const createRuntime = (ctx: ExtensionContext): Runtime => {
		runtime?.scheduler.dispose();
		runtime?.publisher.dispose();
		const loaded = loadConfig(getAgentDir());
		const config = loaded.config ?? { ...DEFAULT_CONFIG, enabledByDefault: false };
		const publisher = createObserverPublisher(pi.events);
		let next!: Runtime;
		const scheduler = createObserverScheduler({
			config,
			modelId: modelId(config),
			onState: (snapshot) => publisher.update(snapshot),
			run: async (signal, previous) => {
				const model = next.ctx.modelRegistry.find(next.config.provider, next.config.model);
				if (!model || !next.ctx.modelRegistry.hasConfiguredAuth(model)) {
					return {
						kind: "unavailable" as const,
						message: `Observer model unavailable: ${modelId(next.config)}`,
					};
				}
				const prompt = buildObservationPrompt(next.ctx.sessionManager, previous);
				return observe({
					caller: next.ctx.modelRegistry as never,
					model: model as never,
					prompt,
					config: next.config,
					...(previous ? { previous } : {}),
					signal,
				});
			},
		});
		next = { ctx, config, scheduler, publisher, configValid: Boolean(loaded.config) };
		runtime = next;
		if (!loaded.config) scheduler.setUnavailable(loaded.issues.join("; "));
		return next;
	};

	const current = (ctx: ExtensionContext): Runtime => runtime ?? createRuntime(ctx);

	pi.on("session_start", (event, ctx) => {
		const next = createRuntime(ctx);
		if (ctx.mode !== "tui") {
			next.scheduler.setEnabled(false);
			return;
		}
		if (!next.configValid) return;
		const hasWork = ctx.sessionManager.buildContextEntries().length > 0;
		if (hasWork && (event.reason === "resume" || event.reason === "fork" || event.reason === "reload")) {
			next.scheduler.reset({ regenerate: true });
		}
	});

	pi.on("turn_end", (_event, ctx) => {
		const active = current(ctx);
		active.ctx = ctx;
		if (ctx.mode === "tui" && active.configValid) {
			active.scheduler.turnEnded(ctx.sessionManager.getLeafId() ?? `turn:${_event.turnIndex}`);
		}
	});
	pi.on("session_tree", (_event, ctx) => {
		const active = current(ctx);
		active.ctx = ctx;
		if (ctx.mode === "tui" && active.configValid) active.scheduler.reset({ regenerate: true });
	});
	pi.on("session_shutdown", () => {
		runtime?.scheduler.dispose();
		runtime?.publisher.dispose();
		runtime = undefined;
	});

	pi.registerCommand("observer", {
		description: "Control the passive progress observer (on, off, refresh)",
		handler: async (args, ctx) => {
			const active = current(ctx);
			active.ctx = ctx;
			const action = args.trim().toLowerCase();
			if (action === "refresh") {
				if (ctx.mode === "tui" && active.configValid) active.scheduler.refresh();
				return;
			}
			if (action !== "" && action !== "on" && action !== "off") {
				if (ctx.hasUI) ctx.ui.notify("Usage: /observer [on|off|refresh]", "warning");
				return;
			}
			const enabled = action === "on" ? true : action === "off" ? false : !active.config.enabledByDefault;
			try {
				active.config = saveEnabled(getAgentDir(), enabled);
				active.configValid = true;
				active.scheduler.setConfig(active.config, modelId(active.config));
				active.scheduler.setEnabled(enabled && ctx.mode === "tui");
			} catch (error) {
				active.scheduler.setUnavailable(error instanceof Error ? error.message : String(error));
			}
		},
	});

	pi.registerCommand("observer-model", {
		description: "Select and persist the passive progress observer model",
		handler: async (args, ctx) => {
			const active = current(ctx);
			active.ctx = ctx;
			const requested = args.trim();
			const available = ctx.modelRegistry.getAvailable();
			const selected = requested
				? available.find((model) => `${model.provider}/${model.id}` === requested)
				: ctx.hasUI
					? await (async () => {
							const choice = await ctx.ui.select(
								"Progress observer",
								available.map((model) => `${model.provider}/${model.id}`),
							);
							return available.find((model) => `${model.provider}/${model.id}` === choice);
						})()
					: undefined;
			if (!selected) {
				if (requested && ctx.hasUI) ctx.ui.notify(`Observer model not available: ${requested}`, "warning");
				return;
			}
			try {
				active.config = saveModel(getAgentDir(), selected.provider, selected.id);
				active.configValid = true;
				active.scheduler.setConfig(active.config, modelId(active.config));
				if (ctx.mode === "tui" && active.config.enabledByDefault) active.scheduler.refresh();
			} catch (error) {
				active.scheduler.setUnavailable(error instanceof Error ? error.message : String(error));
			}
		},
	});
}
