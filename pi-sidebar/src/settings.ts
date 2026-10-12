import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	chooseMenu,
	discoverSettingsSections,
	groupPluginSettings,
	isSettingsActionActive,
	openSettingsSection,
	type SettingsSection,
} from "@paulsteele/pi-shared-ui";
import { thirdPartySettings } from "./third-party-settings.js";

export interface SidebarSettingsController {
	sections(): SettingsSection[];
	open(id?: string): Promise<void>;
	cancel(): void;
	dispose(): void;
}

export function createSidebarSettings(pi: ExtensionAPI, ctx: ExtensionContext): SidebarSettingsController {
	const lifetime = new AbortController();
	let opening = false;
	let interaction: AbortController | undefined;
	const cancel = () => interaction?.abort();
	const pendingPrompts = new Set<string>();
	const promptId = (raw: unknown) => {
		const id = raw && typeof raw === "object" ? (raw as { requestId?: unknown }).requestId : undefined;
		return typeof id === "string" && id.length > 0 && id.length <= 256 ? id : undefined;
	};
	const unsubscribePrompt = pi.events.on("permissions:ui_prompt", (raw) => {
		const id = promptId(raw);
		if (!id) {
			return;
		}
		pendingPrompts.add(id);
		if (!isSettingsActionActive(ctx)) {
			cancel();
		}
	});
	const unsubscribeDecision = pi.events.on("permissions:decision", (raw) => {
		const id = promptId(raw);
		if (id) {
			pendingPrompts.delete(id);
		}
	});
	const contributedSections = () => [...discoverSettingsSections(pi), ...thirdPartySettings(pi)];
	const sections = () => groupPluginSettings(contributedSections());
	return {
		sections,
		async open(id) {
			if (opening || lifetime.signal.aborted) {
				return;
			}
			if (pendingPrompts.size > 0) {
				ctx.ui.notify("Finish the permission decision before reopening Settings.", "info");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Settings are available when the agent is idle.", "info");
				return;
			}
			opening = true;
			const controller = new AbortController();
			interaction = controller;
			const signal = AbortSignal.any([lifetime.signal, controller.signal]);
			try {
				let selected = id;
				for (;;) {
					signal.throwIfAborted();
					const available = sections();
					selected ??= await chooseMenu(
						ctx,
						"Plugin Settings",
						available.map((section) => ({
							id: section.id,
							label: section.title,
							description: section.description,
						})),
						signal,
					);
					if (!selected) {
						return;
					}
					const section =
						available.find((section) => section.id === selected) ??
						contributedSections().find((section) => section.id === selected);
					if (section) {
						await openSettingsSection(ctx, section, signal);
					}
					if (id) {
						return;
					}
					selected = undefined;
				}
			} catch (error) {
				if (!signal.aborted) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			} finally {
				interaction = undefined;
				opening = false;
			}
		},
		cancel,
		dispose() {
			lifetime.abort();
			unsubscribePrompt();
			unsubscribeDecision();
			pendingPrompts.clear();
		},
	};
}
