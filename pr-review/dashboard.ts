import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type OverlayHandle } from "@earendil-works/pi-tui";
import { redact } from "./report.js";
import { TaskStore, type RecoveryGate } from "./tasks.js";
import type { WorkPhase } from "./work-ui.js";

interface ThemeLike {
	fg(color: "accent" | "dim" | "text" | "success" | "warning" | "error" | "border", text: string): string;
}
interface Keys {
	matches(data: string, action: string): boolean;
	getKeys(action: string): string[];
}
export function taskSummary(store: TaskStore): string {
	const rows = [...store.records.values()];
	const count = (states: string[]) => rows.filter((row) => states.includes(row.state)).length;
	return `${count(["running", "retrying", "compacting"])} running · ${count(["queued"])} queued · ${count(["completed"])} done · ${count(["blocked"])} blocked`;
}
export class DashboardComponent {
	private selected = 0;
	private detail = false;
	private detailOffset = 0;
	private confirmCancel = false;
	private detailCache: { key: string; lines: string[] } | undefined;
	constructor(
		private store: TaskStore,
		private theme: ThemeLike,
		private keys: Keys,
		private height: () => number,
		private renderNow: () => void,
		private hide: () => void,
		private cancel: () => void,
		private retry: () => void,
	) {}
	handleInput(data: string) {
		if (this.confirmCancel) {
			if (data === "y" || data === "Y") this.cancel();
			this.confirmCancel = false;
			this.renderNow();
			return;
		}
		if (this.keys.matches(data, "tui.select.cancel")) {
			this.hide();
			return;
		}
		if (data === "c") this.confirmCancel = true;
		else if (data === "r") this.retry();
		else if (this.keys.matches(data, "tui.select.confirm") || data === "\t") {
			this.detail = !this.detail;
			this.detailOffset = 0;
		} else {
			let move = 0;
			if (this.keys.matches(data, "tui.select.up")) move = -1;
			if (this.keys.matches(data, "tui.select.down")) move = 1;
			if (this.keys.matches(data, "tui.select.pageUp")) move = -Math.max(1, this.height() - 10);
			if (this.keys.matches(data, "tui.select.pageDown")) move = Math.max(1, this.height() - 10);
			if (this.detail) this.detailOffset = Math.max(0, this.detailOffset + move);
			else this.selected = Math.max(0, Math.min(this.store.records.size - 1, this.selected + move));
		}
		this.renderNow();
	}
	render(width: number): string[] {
		if (width < 1) return [];
		const height = Math.max(1, this.height()),
			rows = [...this.store.records.values()],
			now = Date.now();
		this.selected = Math.max(0, Math.min(this.selected, rows.length - 1));
		const task = rows[this.selected];
		const plain = (value: string) => truncateToWidth(redact(value), width);
		const lines = [
			this.theme.fg("accent", plain(`PR REVIEW · ${taskSummary(this.store)}`)),
			plain(this.store.phase),
			...(this.store.progress
				? new Text(redact(this.store.progress), 0, 0).render(width).slice(0, Math.max(1, height - 5))
				: []),
		];
		if (!this.detail) {
			const capacity = Math.max(1, height - lines.length - 6),
				start = Math.max(0, this.selected - capacity + 1);
			for (let i = start; i < Math.min(rows.length, start + capacity); i++) {
				const row = rows[i]!,
					elapsed = row.startedAt ? `${Math.floor(((row.endedAt ?? now) - row.startedAt) / 1000)}s` : "—";
				lines.push(
					this.theme.fg(
						i === this.selected ? "accent" : row.state === "blocked" ? "warning" : "text",
						plain(
							`${i === this.selected ? ">" : " "} ${row.state.padEnd(10)} ${row.name} · ${row.files.length} files · ${elapsed}`,
						),
					),
				);
			}
			if (rows.length)
				lines.push(this.theme.fg("dim", plain(`Task ${this.selected + 1}/${rows.length} · Enter details`)));
			if (task) {
				lines.push(plain(`Selected: ${task.name} · ${task.activity}`));
				lines.push(
					plain(
						`${task.remaining === undefined ? "" : `${(task.total ?? 0) - task.remaining}/${task.total} context resources · `}${task.turns} turns · ${task.compactions} compactions · ${task.retries} retries · updated ${Math.floor((now - task.updatedAt) / 1000)}s ago`,
					),
				);
				lines.push(plain(task.reason));
			}
		} else if (task) {
			const details = [
				task.name,
				...(this.store.progress ? [`Progress: ${this.store.progress}`] : []),
				`Model: ${this.store.model || "not selected"}`,
				...(this.store.journalPath ? [`Progress log: ${this.store.journalPath}`] : []),
				`State: ${task.state} · ${task.activity}`,
				`Assignment: ${task.reason}`,
				`Coverage: ${task.remaining === undefined ? "not applicable" : `${(task.total ?? 0) - task.remaining}/${task.total} context resources supplied`}`,
				`Usage: ${task.usage.input} input / ${task.usage.output} output · $${task.usage.cost.toFixed(4)}`,
				`${task.turns} turns · ${task.requests} requests · ${task.compactions} compactions · ${task.retries} retries`,
				"Pending obligations:",
				...(task.unreviewed ?? []),
				"Assigned files:",
				...task.files,
				"Recent activity:",
				...(this.store.events.get(task.id) ?? []).map(
					(e) => `${new Date(e.at).toLocaleTimeString()} ${e.text}`,
				),
			];
			const key = `${task.id}:${task.updatedAt}:${task.turns}:${task.requests}:${task.state}:${width}:${this.store.progress}`;
			if (this.detailCache?.key !== key)
				this.detailCache = {
					key,
					lines: details.flatMap((line) => new Text(redact(line), 0, 0).render(width)),
				};
			const wrapped = this.detailCache.lines;
			this.detailOffset = Math.min(this.detailOffset, Math.max(0, wrapped.length - 1));
			lines.push(
				...wrapped.slice(this.detailOffset, this.detailOffset + Math.max(1, height - lines.length - 2)),
			);
		}
		const cancelKey = this.keys.getKeys("tui.select.cancel").join("/");
		const help = this.confirmCancel
			? "Cancel the whole review? y confirms; any other key returns"
			: `↑↓ / PgUp/PgDn scroll · Enter ${this.detail ? "queue" : "details"} · ${cancelKey} hide · r retry · c cancel`;
		return [...lines.slice(0, Math.max(0, height - 1)), this.theme.fg("dim", plain(help))];
	}
	invalidate() {
		this.detailCache = undefined;
	}
}
export interface ReviewDashboard {
	work: WorkPhase;
	show(): void;
	hide(): void;
	update(message: string): void;
	dispose(): void;
}
export function createReviewDashboard(
	ctx: ExtensionContext,
	store: TaskStore,
	options: { cancel: () => void; recovery?: RecoveryGate; readonly?: boolean },
): ReviewDashboard {
	let disposed = false,
		visible = false,
		dismissed = false,
		inWork = false,
		shown = false,
		previousBlocked = 0;
	let generation = 0,
		close: (() => void) | undefined,
		requestRender: (() => void) | undefined;
	let heartbeat: ReturnType<typeof setInterval> | undefined,
		renderTimer: ReturnType<typeof setTimeout> | undefined;
	const safely = (fn: () => void) => {
		try {
			fn();
		} catch {
			/* Session/UI retirement must not stop the pipeline. */
		}
	};
	const stopTimers = () => {
		clearInterval(heartbeat);
		clearTimeout(renderTimer);
		heartbeat = undefined;
		renderTimer = undefined;
	};
	const hide = (deliberate: boolean) => {
		if (deliberate) dismissed = true;
		visible = false;
		generation++;
		stopTimers();
		const ownedClose = close;
		close = undefined;
		requestRender = undefined;
		if (ownedClose) safely(ownedClose);
	};
	const show = () => {
		if (disposed || visible || ctx.mode !== "tui") return;
		if (!inWork && !options.readonly) {
			safely(() => ctx.ui.notify("Review dashboard is suspended while approval UI is active.", "info"));
			return;
		}
		dismissed = false;
		visible = true;
		shown = true;
		const owner = ++generation;
		let mounted: OverlayHandle | undefined,
			finish: (() => void) | undefined,
			closeRequested = false;
		const closeOwned = () => {
			closeRequested = true;
			// done() on older Pi pops the front overlay. Never call it before ours mounts.
			if (!mounted || !finish) return;
			mounted.focus();
			finish();
		};
		close = closeOwned;
		try {
			void ctx.ui
				.custom<void>(
					(tui, theme, keys, done) => {
						let finished = false;
						finish = () => {
							if (!finished) {
								finished = true;
								done(undefined);
							}
						};
						if (!disposed && owner === generation) requestRender = () => tui.requestRender();
						const component = new DashboardComponent(
							store,
							theme,
							keys,
							() => Math.max(1, (tui.terminal?.rows ?? 24) - 4),
							() => tui.requestRender(),
							() => {
								hide(true);
								updateSummary();
							},
							options.cancel,
							() => options.recovery?.retry(),
						);
						return {
							render: (width: number) => component.render(width),
							invalidate: () => component.invalidate(),
							handleInput: (data: string) => component.handleInput(data),
							dispose: () => {
								if (owner === generation) {
									stopTimers();
									visible = false;
									requestRender = undefined;
									close = undefined;
								}
							},
						};
					},
					{
						overlay: true,
						overlayOptions: { anchor: "center", width: "95%", maxHeight: "95%", margin: 1 },
						onHandle: (value) => {
							mounted = value;
							if (disposed || owner !== generation || closeRequested) safely(closeOwned);
							else {
								heartbeat = setInterval(() => safely(() => requestRender?.()), 1000);
								heartbeat.unref?.();
							}
						},
					},
				)
				.catch(() => {
					if (owner !== generation) return;
					visible = false;
					stopTimers();
					close = undefined;
					requestRender = undefined;
					safely(() =>
						ctx.ui.notify(
							"Review dashboard unavailable; progress continues in text. Use /pr retry or /pr cancel if blocked.",
							"warning",
						),
					);
				});
		} catch {
			visible = false;
			stopTimers();
		}
		updateSummary();
	};
	let previousSummary = "",
		previousProgress = "",
		widgetVisible = false;
	const updateSummary = () => {
		if (disposed || renderTimer) return;
		// Coalesce the actual host UI calls, not just the final overlay requestRender.
		renderTimer = setTimeout(() => {
			renderTimer = undefined;
			if (disposed) return;
			const blocked = [...store.records.values()].filter((task) => task.state === "blocked").length;
			if (!visible && blocked > previousBlocked)
				safely(() =>
					ctx.ui.notify("PR review is blocked. Use /pr status, /pr retry, or /pr cancel.", "warning"),
				);
			previousBlocked = blocked;
			const summary = redact(`PR: ${taskSummary(store)} · ${store.phase} · /pr status`);
			if (!options.readonly) {
				if (summary !== previousSummary) safely(() => ctx.ui.setStatus("pr-review", summary));
				if (visible && widgetVisible) {
					safely(() => ctx.ui.setWidget("pr-review", undefined));
					widgetVisible = false;
				} else if (
					!visible &&
					(!widgetVisible || summary !== previousSummary || store.progress !== previousProgress)
				) {
					safely(() => ctx.ui.setWidget("pr-review", [summary, ...(store.progress ? [store.progress] : [])]));
					widgetVisible = true;
				}
			}
			previousSummary = summary;
			previousProgress = store.progress;
			if (visible) safely(() => requestRender?.());
		}, 100);
	};
	const unsubscribe = store.onChange(updateSummary);
	return {
		show,
		hide: () => {
			hide(true);
			updateSummary();
		},
		update(message) {
			if (!disposed) {
				store.setProgress(redact(message));
			}
		},
		async work<T>(label: string, task: () => Promise<T>): Promise<T> {
			inWork = true;
			store.setPhase(label);
			if (!dismissed && (!shown || !visible)) show();
			try {
				return await task();
			} finally {
				hide(false);
				inWork = false;
				updateSummary();
			}
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			hide(false);
			unsubscribe();
			safely(() => ctx.ui.setStatus("pr-review", undefined));
			safely(() => ctx.ui.setWidget("pr-review", undefined));
		},
	};
}
