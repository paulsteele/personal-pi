import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, type OverlayHandle } from "@earendil-works/pi-tui";
import { redact } from "./report.js";
import { TaskStore, type RecoveryGate, type TaskRecord, type TaskState } from "./tasks.js";
import type { WorkPhase } from "./work-ui.js";

interface ThemeLike {
	fg(
		color: "accent" | "muted" | "text" | "success" | "warning" | "error" | "borderAccent",
		text: string,
	): string;
	bg(color: "customMessageBg" | "selectedBg", text: string): string;
}
const taskStyles: Record<TaskState, { symbol: string; color: Parameters<ThemeLike["fg"]>[0] }> = {
	queued: { symbol: "○", color: "muted" },
	running: { symbol: "●", color: "accent" },
	compacting: { symbol: "↻", color: "accent" },
	retrying: { symbol: "↻", color: "warning" },
	blocked: { symbol: "!", color: "warning" },
	completed: { symbol: "✓", color: "success" },
	cancelled: { symbol: "×", color: "muted" },
	failed: { symbol: "×", color: "error" },
	skipped: { symbol: "–", color: "muted" },
};
const singleLine = (value: string) => redact(value).replace(/[\r\n\t]/g, " ");
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
	private pageSize = 1;
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
			if (this.keys.matches(data, "tui.select.pageUp")) move = -this.pageSize;
			if (this.keys.matches(data, "tui.select.pageDown")) move = this.pageSize;
			if (this.detail) this.detailOffset = Math.max(0, this.detailOffset + move);
			else this.selected = Math.max(0, Math.min(this.store.records.size - 1, this.selected + move));
		}
		this.renderNow();
	}
	private taskLine(task: TaskRecord, selected: boolean, width: number, now: number): string {
		const style = taskStyles[task.state],
			elapsed = task.startedAt ? `${Math.floor(((task.endedAt ?? now) - task.startedAt) / 1000)}s` : "—",
			prefix = `${selected ? "▸" : " "}${style.symbol} ${task.state.padEnd(10)} `,
			suffix = ` ${`${task.files.length} files`.padStart(9)} ${elapsed.padStart(5)}`,
			nameWidth = width - visibleWidth(prefix) - visibleWidth(suffix),
			name = singleLine(task.name);
		return (
			this.theme.fg(style.color, prefix) +
			this.theme.fg("text", nameWidth >= 12 ? truncateToWidth(name, nameWidth, "…", true) : name) +
			(nameWidth >= 12 ? this.theme.fg("muted", suffix) : "")
		);
	}
	render(width: number): string[] {
		if (width < 1) return [];
		const height = Math.max(1, this.height()),
			rows = [...this.store.records.values()],
			now = Date.now();
		this.selected = Math.max(0, Math.min(this.selected, rows.length - 1));
		const task = rows[this.selected],
			cancelKey = this.keys.getKeys("tui.select.cancel").join("/"),
			help = this.confirmCancel
				? "Cancel the whole review? y confirms; any other key returns"
				: `↑↓ / PgUp/PgDn scroll · Enter ${this.detail ? "queue" : "details"} · ${cancelKey} hide · r retry · c cancel`;
		// Truncation and Text wrapping can emit full SGR resets. Reapply the fill
		// after each reset so even ellipses and trailing padding stay opaque.
		const paint = (value: string, selected = false) =>
			value
				.split("\x1b[0m")
				.map((part) =>
					this.theme.bg(selected ? "selectedBg" : "customMessageBg", this.theme.fg("text", part)),
				)
				.join("\x1b[0m");
		const helpColor = this.confirmCancel ? "warning" : "muted";
		if (width < 6 || height < 5) {
			this.pageSize = 1;
			const compact = this.confirmCancel
				? [help]
				: ["PR REVIEW", task ? `${task.state}: ${task.name}` : this.store.phase, help];
			return compact
				.slice(0, height)
				.map((text) =>
					paint(
						this.theme.fg(
							this.confirmCancel ? "warning" : "text",
							truncateToWidth(singleLine(text), width, "…", true),
						),
					),
				);
		}
		const contentWidth = width - 4,
			innerWidth = width - 2;
		const line = (value: string, selected = false) =>
			paint(this.theme.fg("borderAccent", "│")) +
			paint(` ${truncateToWidth(value, contentWidth, "…", true)} `, selected) +
			paint(this.theme.fg("borderAccent", "│"));
		const plain = (value: string) => line(singleLine(value));
		const rule = (left: string, right: string, title = "") => {
			const label = truncateToWidth(title, innerWidth, "…"),
				fill = "─".repeat(Math.max(0, innerWidth - visibleWidth(label)));
			return paint(this.theme.fg("borderAccent", `${left}${label}${fill}${right}`));
		};
		const footer = new Text(help, 0, 0)
			.render(contentWidth)
			.slice(0, Math.min(3, Math.max(1, height - 8)))
			.map((text) => line(this.theme.fg(helpColor, text)));
		// Reserve the frame and footer before allocating scrollable content.
		const bodyHeight = height - footer.length - 3;
		const body: string[] = [];
		if (bodyHeight >= 4) body.push(plain(taskSummary(this.store)));
		if (bodyHeight >= 7) body.push(plain(this.store.phase));
		if (this.store.progress) {
			const progress = new Text(redact(this.store.progress), 0, 0).render(contentWidth);
			body.push(...progress.slice(0, Math.min(2, Math.max(0, bodyHeight - 10))).map((text) => line(text)));
		}
		if (body.length) body.push(rule("├", "┤"));
		const available = bodyHeight - body.length;
		if (!this.detail) {
			const showPosition = rows.length > 0 && available >= 2,
				previewCount = task ? Math.min(3, Math.max(0, available - 4)) : 0,
				capacity = Math.max(1, available - Number(showPosition) - (previewCount ? previewCount + 1 : 0)),
				start = Math.max(0, this.selected - capacity + 1);
			this.pageSize = capacity;
			for (let i = start; i < Math.min(rows.length, start + capacity); i++)
				body.push(line(this.taskLine(rows[i]!, i === this.selected, contentWidth, now), i === this.selected));
			if (!rows.length) body.push(plain("No review tasks yet."));
			if (showPosition)
				body.push(line(this.theme.fg("muted", `Task ${this.selected + 1}/${rows.length} · Enter details`)));
			if (task && previewCount) {
				body.push(rule("├", "┤"));
				const preview = [
					`Selected: ${task.name} · ${task.activity}`,
					`${task.remaining === undefined ? "" : `${(task.total ?? 0) - task.remaining}/${task.total} context resources · `}${task.turns} turns · ${task.compactions} compactions · ${task.retries} retries · updated ${Math.floor((now - task.updatedAt) / 1000)}s ago`,
					task.reason,
				];
				body.push(...preview.slice(0, previewCount).map(plain));
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
			const key = `${task.id}:${task.updatedAt}:${task.turns}:${task.requests}:${task.state}:${contentWidth}:${this.store.progress}:${this.store.model}:${this.store.journalPath}`;
			if (this.detailCache?.key !== key)
				this.detailCache = {
					key,
					lines: details.flatMap((text) => new Text(redact(text), 0, 0).render(contentWidth)),
				};
			const wrapped = this.detailCache.lines,
				capacity = Math.max(1, available - Number(available >= 2));
			this.pageSize = capacity;
			this.detailOffset = Math.min(this.detailOffset, Math.max(0, wrapped.length - capacity));
			body.push(...wrapped.slice(this.detailOffset, this.detailOffset + capacity).map((text) => line(text)));
			if (available >= 2)
				body.push(
					line(
						this.theme.fg(
							"muted",
							`Details ${this.detailOffset + 1}–${Math.min(wrapped.length, this.detailOffset + capacity)}/${wrapped.length}`,
						),
					),
				);
		} else body.push(plain("No review tasks yet."));
		return [rule("╭", "╮", "─ PR REVIEW "), ...body, rule("├", "┤"), ...footer, rule("╰", "╯")];
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
							() => Math.max(1, (tui.terminal?.rows ?? 24) - 2),
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
						overlayOptions: { anchor: "center", width: 120, maxHeight: "100%", margin: 1 },
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
