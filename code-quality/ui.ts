import {
	Editor,
	Key,
	matchesKey,
	Text,
	truncateToWidth,
	wrapTextWithAnsi,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	generateDiffString,
	renderDiff,
	type MessageRenderer,
	type EntryRenderer,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Decision, QualityUI } from "./controller.js";
import type { QualityCase } from "./case.js";
import { CHECKING_QUALITY_LABEL, qualityFeedbackLabel } from "./feedback.js";

function plain(value: string): string {
	return value
		.replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g, "")
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}
export function reviewText(state: QualityCase): string {
	const parts = [
		`Quality decision · rounds ${state.attempts}/${state.limit}`,
		`Case ${state.id}`,
		`Reviewer: ${plain(state.verdict?.rationale ?? "")}`,
	];
	if (state.objection) parts.push(`Agent disagreement: ${plain(state.objection)}`);
	for (const finding of state.verdict?.findings ?? [])
		parts.push(`${plain(finding.file)}:${finding.line} [${finding.rule}] ${plain(finding.rationale)}`);
	for (const file of state.files) {
		const proposed = state.verdict?.proposed[file.path];
		if (proposed === undefined) continue;
		parts.push(
			`\n${plain(file.path)} — current / proposed`,
			plain(generateDiffString(file.after ?? "", proposed, 4).diff),
		);
	}
	return parts.join("\n\n");
}
export const feedbackRenderer: MessageRenderer = (message, options, theme) => {
	const text = plain(typeof message.content === "string" ? message.content : JSON.stringify(message.content));
	const label = qualityFeedbackLabel(message.details);
	return new Text(
		options.expanded ? `${theme.fg("accent", label)}\n${text}` : theme.fg("accent", label),
		0,
		0,
	);
};

export const checkingRenderer: EntryRenderer = (_entry, _options, theme) =>
	new Text(theme.fg("muted", CHECKING_QUALITY_LABEL), 0, 0);

export class ArbitrationPanel implements Component {
	private selected = 0;
	private scroll = 0;
	private mode: "choose" | "notes" = "choose";
	private editor: Editor;
	private wrapped: string[] = [];
	private lastWidth = 0;
	private focusedValue = false;
	private readonly labels = ["Accept original", "Accept proposed", "Allow another five cycles"];
	private readonly choices = ["original", "proposed", "continue"] as const;
	constructor(
		private tui: TUI,
		private theme: Theme,
		private state: QualityCase,
		private done: (decision: Decision | undefined) => void,
	) {
		this.editor = new Editor(tui, {
			borderColor: (text) => theme.fg("border", text),
			selectList: {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("muted", text),
				noMatch: (text) => theme.fg("warning", text),
			},
		});
		this.editor.onSubmit = (text) => {
			this.done({ choice: this.choices[this.selected]!, note: text });
		};
	}
	get focused(): boolean {
		return this.focusedValue;
	}
	set focused(value: boolean) {
		this.focusedValue = value;
		this.editor.focused = value && this.mode === "notes";
	}
	invalidate(): void {
		this.lastWidth = 0;
		this.editor.invalidate();
	}
	render(width: number): string[] {
		if (this.lastWidth !== width) {
			const lines = reviewText(this.state).split("\n");
			this.wrapped = lines.flatMap((line) => wrapTextWithAnsi(renderDiff(line), Math.max(1, width)));
			this.lastWidth = width;
		}
		const available = Math.max(3, Math.min(20, this.tui.terminal.rows - 14));
		this.scroll = Math.min(this.scroll, Math.max(0, this.wrapped.length - available));
		const lines = [
			this.theme.fg("accent", "QUALITY · human decision"),
			...this.wrapped.slice(this.scroll, this.scroll + available),
			this.theme.fg(
				"muted",
				`Review lines ${this.scroll + 1}–${Math.min(this.wrapped.length, this.scroll + available)}/${this.wrapped.length} · PgUp/PgDn scroll`,
			),
		];
		if (this.mode === "choose") {
			lines.push(
				...this.labels.map((label, i) =>
					i === this.selected ? this.theme.fg("accent", `› ${label}`) : `  ${label}`,
				),
				"↑/↓ choose · enter resolve · n add notes · esc pause",
			);
		} else {
			lines.push(
				`Decision: ${this.labels[this.selected]}`,
				"Case-only notes · enter save & resolve · shift+enter newline · esc pause",
				...this.editor.render(width),
			);
		}
		return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
	}
	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
			this.scroll = Math.max(0, this.scroll + (matchesKey(data, Key.pageUp) ? -10 : 10));
			this.tui.requestRender();
			return;
		}
		if (this.mode === "notes") {
			this.editor.handleInput(data);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.done({ choice: this.choices[this.selected]!, note: "" });
			return;
		}
		if (matchesKey(data, Key.up)) this.selected = (this.selected + 2) % 3;
		if (matchesKey(data, Key.down)) this.selected = (this.selected + 1) % 3;
		if (matchesKey(data, "n")) {
			this.mode = "notes";
			this.editor.focused = this.focused;
		}
		this.tui.requestRender();
	}
}

export const qualityUI: QualityUI = {
	async arbitrate(ctx, state, signal) {
		if (signal.aborted) return;
		return ctx.ui.custom<Decision | undefined>((tui, theme, _keys, done) => {
			let settled = false;
			const finish = (decision: Decision | undefined) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", abort);
				done(decision);
			};
			const abort = () => finish(undefined);
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) queueMicrotask(abort);
			const panel = new ArbitrationPanel(tui, theme, state, finish);
			return Object.assign(panel, { dispose: () => signal.removeEventListener("abort", abort) });
		});
	},
	async coverage(ctx, path, reason, provider, signal) {
		const choice = await ctx.ui.select(
			`Quality coverage: ${plain(path)}\n${plain(reason)}\nReviewer: ${plain(provider)}`,
			["Authorize this file's review", "Waive this file's quality review"],
			{ signal },
		);
		return choice?.startsWith("Authorize") ? "authorize" : choice?.startsWith("Waive") ? "waive" : undefined;
	},
	async failure(ctx, reason, signal) {
		const choice = await ctx.ui.select(
			plain(reason),
			["Retry review", "Select reviewer model", "Waive this quality check"],
			{ signal },
		);
		return choice?.startsWith("Retry")
			? "retry"
			: choice?.startsWith("Select")
				? "model"
				: choice?.startsWith("Waive")
					? "waive"
					: undefined;
	},
};
