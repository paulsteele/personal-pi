import { isDeepStrictEqual } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { selectWorkingPhrase } from "./activity.js";
import { aggregateMetrics, type UsageMessage } from "./metrics.js";
import type { ActivityState, AtelierState } from "./types.js";
import {
	createWorkspacePulseRefresh,
	inspectWorkspacePulse,
	type WorkspacePulseData,
	type WorkspacePulseInspection,
	type WorkspacePulseRefresh,
} from "./workspace-pulse.js";
export interface RuntimeDependencies {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	autoCompact: boolean | null;
	random?: () => number;
	requestRender(): void;
	inspectWorkspace?(): Promise<WorkspacePulseInspection>;
}

export function createInertAtelierState(autoCompact: boolean | null = null): AtelierState {
	return {
		activity: "ready",
		dirty: false,
		workspacePulse: { status: "unavailable" },
		metrics: aggregateMetrics([], { subscription: false, autoCompact }),
		extensionStatuses: [],
	};
}

export class AtelierRuntime {
	readonly #pi: ExtensionAPI;
	readonly #ctx: ExtensionContext;
	readonly #autoCompact: boolean | null;
	readonly #random: () => number;
	readonly #requestRender: () => void;
	readonly #workspacePulseRefresh: WorkspacePulseRefresh;
	#disposed = false;
	#lastWorkspaceData: WorkspacePulseData | undefined;
	#state: AtelierState;

	constructor(dependencies: RuntimeDependencies) {
		this.#pi = dependencies.pi;
		this.#ctx = dependencies.ctx;
		this.#autoCompact = dependencies.autoCompact;
		this.#random = dependencies.random ?? Math.random;
		this.#requestRender = dependencies.requestRender;
		const inspectWorkspace =
			dependencies.inspectWorkspace ??
			(() => inspectWorkspacePulse({ exec: this.#pi.exec.bind(this.#pi), cwd: this.#ctx.cwd }));
		this.#workspacePulseRefresh = createWorkspacePulseRefresh({
			inspect: inspectWorkspace,
			publish: (inspection) => this.#applyWorkspacePulseInspection(inspection),
		});
		this.#state = this.#inertState(this.#ctx.getContextUsage());
		this.refreshUsage();
	}

	/** State with no branch, workspace data, or usage history; context is included only when explicit. */
	#inertState(context: ReturnType<ExtensionContext["getContextUsage"]> = undefined): AtelierState {
		return {
			...createInertAtelierState(this.#autoCompact),
			workspacePulse: { status: "inspecting" },
			metrics: aggregateMetrics([], {
				subscription: false,
				autoCompact: this.#autoCompact,
				...(context ? { context } : {}),
			}),
		};
	}

	getState(): AtelierState {
		return this.#state;
	}

	setActivity(activity: ActivityState): void {
		if (this.#state.activity === activity) return;
		this.#state =
			activity === "working"
				? { ...this.#state, activity, workingLabel: selectWorkingPhrase(this.#random()) }
				: { ...this.#state, activity };
		this.#invalidate();
	}

	refreshUsage(): void {
		if (this.#disposed) return;
		const messages: UsageMessage[] = [];
		for (const entry of this.#ctx.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				messages.push(entry.message as UsageMessage);
			}
		}
		const model = this.#ctx.model;
		const context = this.#ctx.getContextUsage();
		const subscription = model ? this.#ctx.modelRegistry.isUsingOAuth(model) : false;
		const { modelId: _modelId, provider: _provider, ...stateWithoutModel } = this.#state;
		this.#state = {
			...stateWithoutModel,
			...(model ? { modelId: model.id, provider: model.provider } : {}),
			thinkingLevel: this.#pi.getThinkingLevel?.(),
			metrics: aggregateMetrics(messages, {
				subscription,
				autoCompact: this.#autoCompact,
				...(context ? { context } : {}),
			}),
		};
		this.#invalidate();
	}

	scheduleWorkspacePulseRefresh(): void {
		if (!this.#disposed) this.#workspacePulseRefresh.request();
	}

	async flushWorkspacePulseRefresh(): Promise<void> {
		if (!this.#disposed) await this.#workspacePulseRefresh.flush();
	}

	#applyWorkspacePulseInspection(inspection: WorkspacePulseInspection): void {
		if (this.#disposed) return;
		if (inspection.kind === "available") {
			const { kind: _kind, ...data } = inspection;
			this.#lastWorkspaceData = data;
			const { snapshot } = data;
			const dirty = snapshot.trackedFiles > 0;
			const pulseChanged = dirty || snapshot.untrackedFiles > 0;
			const status = snapshot.conflicts > 0 ? "conflict" : pulseChanged ? "changed" : "clean";
			const { branch: _branch, ...withoutBranch } = this.#state;
			this.#replaceState({
				...withoutBranch,
				...(data.branch ? { branch: data.branch } : {}),
				dirty,
				workspacePulse: { status, data },
			});
			return;
		}

		if (inspection.kind === "not-repo") {
			this.#lastWorkspaceData = undefined;
			const { branch: _branch, ...withoutBranch } = this.#state;
			this.#replaceState({
				...withoutBranch,
				dirty: false,
				workspacePulse: { status: "not-repo" },
			});
			return;
		}

		this.#replaceState({
			...this.#state,
			workspacePulse: this.#lastWorkspaceData
				? { status: "stale", data: this.#lastWorkspaceData }
				: { status: "unavailable" },
		});
	}

	/**
	 * Stops scheduled work and resets to inert state, so a footer that outlives its
	 * `setFooter(undefined)` cannot keep reporting the retired session's branch, usage, or activity.
	 */
	dispose(): void {
		this.#disposed = true;
		this.#workspacePulseRefresh.dispose();
		this.#lastWorkspaceData = undefined;
		this.#state = { ...this.#inertState(), workspacePulse: { status: "unavailable" } };
	}

	#replaceState(next: AtelierState): void {
		if (isDeepStrictEqual(this.#state, next)) return;
		this.#state = next;
		this.#invalidate();
	}

	#invalidate(): void {
		if (!this.#disposed) this.#requestRender();
	}
}
