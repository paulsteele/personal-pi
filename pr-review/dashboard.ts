import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPanelFrame, presentPanel } from "@paulsteele/pi-shared-ui";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { redact } from "./report.js";
import { formatUsage, formatCost, REQUEST_KINDS } from "./usage.js";
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
	permission: { symbol: "?", color: "warning" },
	checking: { symbol: "◇", color: "accent" },
	waiting_slot: { symbol: "○", color: "muted" },
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
	return `${count(["running", "retrying", "compacting"])} running · ${count(["queued"])} queued · ${count(["completed"])} done · ${count(["blocked"])} blocked${count(["checking"]) ? ` · ${count(["checking"])} checking permissions` : ""}${count(["waiting_slot"]) ? ` · ${count(["waiting_slot"])} waiting for slot` : ""}${count(["permission"]) ? ` · ${count(["permission"])} awaiting human approval` : ""}`;
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
		const { paint, line, rule } = createPanelFrame(this.theme, width);
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
		const contentWidth = width - 4;
		const plain = (value: string) => line(singleLine(value));
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
				`Usage: ${formatUsage(task.usage)}`,
				formatCost(task.usage),
				...(task.usage.byRequest
					? REQUEST_KINDS.map(
							(kind) =>
								`${kind}: ${task.usage.byRequest![kind].requests} requests; ${formatUsage(task.usage.byRequest![kind])}`,
						)
					: []),
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
/** Listen to actual prompt spans, not coalesced ui_prompt events (the dashboard itself is custom UI). */
export function trackPermissionPrompts(events: ExtensionAPI["events"], changed: (active: boolean) => void) {
	const pending = new Set<string>();
	let disposed = false;
	const update = (raw: unknown, showing: boolean) => {
		if (disposed || !raw || typeof raw !== "object") return;
		const id = (raw as { requestId?: unknown }).requestId;
		if (typeof id !== "string" || !id || id.length > 256) return;
		const active = pending.size > 0;
		if (showing) pending.add(id);
		else pending.delete(id);
		if (active !== pending.size > 0) changed(pending.size > 0);
	};
	const unsubscribePrompt = events.on("permissions:ui_prompt", (raw) => update(raw, true));
	const unsubscribeDecision = events.on("permissions:decision", (raw) => update(raw, false));
	return {
		get active() {
			return pending.size > 0;
		},
		dispose() {
			disposed = true;
			unsubscribePrompt();
			unsubscribeDecision();
			pending.clear();
		},
	};
}

export interface ReviewDashboard {
	work: WorkPhase;
	approval: WorkPhase;
	setPermissionPromptActive(active: boolean): void;
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
		permissionPromptActive = false,
		approvalPromptActive = false,
		visible = false,
		dismissed = false,
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
		if (disposed || visible || ctx.mode !== "tui") {
			return;
		}
		if (permissionPromptActive) {
			safely(() => ctx.ui.notify("Finish the permission prompt before reopening PR status.", "info"));
			return;
		}
		if (approvalPromptActive) {
			safely(() => ctx.ui.notify("Review dashboard is suspended while approval UI is active.", "info"));
			return;
		}
		dismissed = false;
		visible = true;
		const owner = ++generation;
		try {
			const panel = presentPanel<void>(
				ctx,
				(tui, theme, keys, _done) => {
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
						render: (width: number) =>
							permissionPromptActive || approvalPromptActive ? [] : component.render(width),
						invalidate: () => component.invalidate(),
						handleInput: (data: string) => {
							if (!permissionPromptActive && !approvalPromptActive) {
								component.handleInput(data);
							}
						},
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
					visible: () => !permissionPromptActive && !approvalPromptActive,
					onRenderReady: () => {
						if (!disposed && owner === generation) {
							heartbeat = setInterval(() => safely(() => requestRender?.()), 1000);
							heartbeat.unref?.();
						}
					},
				},
			);
			close = panel.close;
			if (disposed || owner !== generation) {
				panel.close();
			}
			void panel.result.catch(() => {
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
		setPermissionPromptActive(active) {
			if (disposed || permissionPromptActive === active) return;
			permissionPromptActive = active;
			if (active) {
				// Stay minimized across subsequent work phases; reopening is an explicit user action.
				hide(true);
				updateSummary();
			}
		},
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
			store.setPhase(label);
			if (!dismissed) {
				show();
			}
			return await task();
		},
		async approval<T>(label: string, task: () => Promise<T>): Promise<T> {
			approvalPromptActive = true;
			hide(false);
			store.setPhase(label);
			try {
				return await task();
			} finally {
				approvalPromptActive = false;
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
