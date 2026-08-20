import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import {
	getOsc8LinkAtColumn,
	hyperlink,
	Markdown,
	TuiAltScreen,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

const MARKER = "pi-copyable-block";
const COPY_URL_PREFIX = "pi-copy-code://";
// Version these keys whenever a prototype hook changes. Pi's /reload keeps the
// shared TUI module alive, so an old patch marker must not suppress a newer hook.
const PATCH_KEY = Symbol.for("pi.copyable-code-blocks.markdown-patch.v4");
const CLICK_PATCH_KEY = Symbol.for("pi.copyable-code-blocks.click-patch.v2");
const SHARED_STATE_KEY = Symbol.for("pi.copyable-code-blocks.shared-state.v1");
const RENDER_REVISION_KEY = Symbol.for("pi.copyable-code-blocks.render-revision.v1");

type CodeBlock = {
	language: string;
	code: string;
};

type MarkdownInternals = {
	theme: {
		codeBlock: (text: string) => string;
		codeBlockBorder: (text: string) => string;
		highlightCode?: (code: string, lang?: string) => string[];
	};
};

type CodeToken = {
	type: "code";
	text: string;
	lang?: string;
};

type PatchedPrototype = {
	[PATCH_KEY]?: boolean;
	[RENDER_REVISION_KEY]?: number;
	render: (width: number) => string[];
	invalidate: () => void;
	renderToken: (token: unknown, width: number, nextTokenType?: string, styleContext?: unknown) => string[];
};

type ClickPatchedPrototype = {
	[CLICK_PATCH_KEY]?: boolean;
	requestRender?: (force?: boolean) => void;
	handleViewportInput: (data: string) => { consume?: boolean } | undefined;
};

type SharedState = {
	nextId: number;
	codeById: Map<string, CodeBlock>;
	idByCode: Map<string, string>;
	onCopy?: (
		block: CodeBlock,
		url?: string,
		tui?: { requestRender?: (force?: boolean) => void },
	) => void;
	pressedByTui: WeakMap<object, string>;
	copiedUrl?: string;
	feedbackRevision?: number;
	feedbackTimer?: ReturnType<typeof setTimeout>;
};

function sharedState(): SharedState {
	const root = globalThis as typeof globalThis & { [SHARED_STATE_KEY]?: SharedState };
	return (root[SHARED_STATE_KEY] ??= {
		nextId: 1,
		codeById: new Map(),
		idByCode: new Map(),
		pressedByTui: new WeakMap(),
	});
}

function registerClickableBlock(block: CodeBlock): string {
	const key = `${block.language}\u0000${block.code}`;
	const state = sharedState();
	let id = state.idByCode.get(key);
	if (!id) {
		id = (state.nextId++).toString(36);
		state.idByCode.set(key, id);
		state.codeById.set(id, block);
	}
	return `${COPY_URL_PREFIX}${id}`;
}

function openingFence(line: string): { indent: string; fence: string; info: string } | undefined {
	const match = /^( {0,3})(`{3,}|~{3,})([^\r\n]*)$/.exec(line);
	if (!match) return undefined;
	return { indent: match[1], fence: match[2], info: match[3].trim() };
}

function isClosingFence(line: string, fence: string): boolean {
	const character = fence[0];
	const match = new RegExp(`^ {0,3}${character === "`" ? "`" : "~"}{${fence.length},}\\s*$`).exec(line);
	return match !== null;
}

/** Mark fenced blocks without changing the underlying session or model context. */
export function markCodeBlocks(markdown: string): string {
	const lines = markdown.split("\n");
	let activeFence: string | undefined;

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (activeFence) {
			if (isClosingFence(line, activeFence)) activeFence = undefined;
			continue;
		}

		const opening = openingFence(line);
		if (!opening || opening.info.includes(MARKER)) continue;
		const separator = opening.info ? " " : "";
		lines[index] = `${opening.indent}${opening.fence}${opening.info}${separator}${MARKER}`;
		activeFence = opening.fence;
	}

	return lines.join("\n");
}

/** Extract marked blocks from transformed Markdown. Also supports an unfinished streaming block. */
export function extractMarkedBlocks(markdown: string): CodeBlock[] {
	const lines = markdown.split("\n");
	const blocks: CodeBlock[] = [];

	for (let index = 0; index < lines.length; index++) {
		const opening = openingFence(lines[index]);
		if (!opening || !opening.info.split(/\s+/).includes(MARKER)) continue;

		const language = opening.info
			.split(/\s+/)
			.filter((part) => part && part !== MARKER)[0] ?? "";
		const body: string[] = [];
		index++;
		while (index < lines.length && !isClosingFence(lines[index], opening.fence)) {
			body.push(lines[index]);
			index++;
		}
		blocks.push({ language, code: body.join("\n") });
	}

	return blocks;
}

function styledPanelLine(
	content: string,
	width: number,
	border: (text: string) => string,
): string {
	if (width < 4) return truncateToWidth(content, width, "");
	const innerWidth = width - 4;
	const clipped = truncateToWidth(content, innerWidth, "");
	const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
	return `${border("│ ")}${clipped}${padding}${border(" │")}`;
}

function panelHeader(block: CodeBlock, width: number, border: (text: string) => string): string {
	if (width < 4) return border("─".repeat(Math.max(0, width)));
	const left = ` ${block.language || "code"} `;
	const url = registerClickableBlock(block);
	const copyText = sharedState().copiedUrl === url ? " ✓ Copied! " : " Copy ";
	const available = width - 2;
	const safeLeft = truncateToWidth(left, Math.max(0, available - visibleWidth(copyText)), "");
	const safeCopy = truncateToWidth(copyText, Math.max(0, available - visibleWidth(safeLeft)), "");
	const fill = "─".repeat(Math.max(0, available - visibleWidth(safeLeft) - visibleWidth(safeCopy)));
	const copy = hyperlink(border(safeCopy), url);
	return `${border(`╭${safeLeft}${fill}`)}${copy}${border("╮")}`;
}

function panelBottom(width: number, border: (text: string) => string): string {
	if (width < 2) return border("─".repeat(Math.max(0, width)));
	return border(`╰${"─".repeat(width - 2)}╯`);
}

function patchMarkdownRenderer(): void {
	// Markdown transforms run inside Markdown.render(), after the component's source
	// text has been read. Patch the token renderer rather than render() so we see the
	// transformed fence info in token.lang.
	const prototype = Markdown.prototype as unknown as PatchedPrototype;
	if (prototype[PATCH_KEY]) return;

	// Markdown normally caches by source text and width. Copy feedback is external
	// state, so include its revision in the cache lifecycle and invalidate when it changes.
	const originalRender = prototype.render;
	prototype.render = function renderWithCopyFeedback(width: number): string[] {
		const revision = sharedState().feedbackRevision ?? 0;
		if (this[RENDER_REVISION_KEY] !== revision) {
			this[RENDER_REVISION_KEY] = revision;
			this.invalidate();
		}
		return originalRender.call(this, width);
	};

	const originalRenderToken = prototype.renderToken;
	prototype.renderToken = function renderCopyableCodeBlock(
		token: unknown,
		width: number,
		nextTokenType?: string,
		styleContext?: unknown,
	): string[] {
		const candidate = token as Partial<CodeToken>;
		if (candidate.type !== "code" || typeof candidate.text !== "string" || !candidate.lang?.includes(MARKER)) {
			return originalRenderToken.call(this, token, width, nextTokenType, styleContext);
		}

		const component = this as unknown as MarkdownInternals;
		const language = candidate.lang
			.split(/\s+/)
			.filter((part) => part && part !== MARKER)[0] ?? "";
		const border = component.theme.codeBlockBorder;
		const block = { language, code: candidate.text };
		const codeLines = component.theme.highlightCode
			? component.theme.highlightCode(candidate.text, language || undefined)
			: candidate.text.split("\n").map((line) => component.theme.codeBlock(line));
		const output = [
			panelHeader(block, width, border),
			...codeLines.map((line) => styledPanelLine(line, width, border)),
			panelBottom(width, border),
		];
		if (nextTokenType && nextTokenType !== "space") output.push("");
		return output;
	};
	prototype[PATCH_KEY] = true;
}

type SgrMousePacket = { code: number; col: number; row: number; final: "M" | "m" };

function parseMousePacket(data: string): SgrMousePacket | undefined {
	const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
	if (!match) return undefined;
	return { code: Number(match[1]), col: Number(match[2]), row: Number(match[3]), final: match[4] as "M" | "m" };
}

function mouseUrl(tui: object, packet: SgrMousePacket): string | undefined {
	const screen = (tui as { previousScreen?: string[] }).previousScreen;
	if (!Array.isArray(screen)) return undefined;
	return getOsc8LinkAtColumn(screen[Math.max(0, packet.row - 1)] ?? "", Math.max(0, packet.col - 1));
}

function patchFullscreenClicks(): void {
	const prototype = TuiAltScreen.prototype as unknown as ClickPatchedPrototype;
	if (prototype[CLICK_PATCH_KEY]) return;
	const original = prototype.handleViewportInput;

	prototype.handleViewportInput = function handleCopyLink(data: string) {
		const packet = parseMousePacket(data);
		if (packet && (packet.code & ~(4 | 8 | 16 | 32)) === 0) {
			const url = mouseUrl(this, packet);
			const state = sharedState();
			if (packet.final === "M" && (packet.code & 32) === 0) {
				if (url?.startsWith(COPY_URL_PREFIX)) {
					state.pressedByTui.set(this, url);
					return { consume: true };
				}
			} else if (packet.final === "m") {
				const pressed = state.pressedByTui.get(this);
				state.pressedByTui.delete(this);
				if (pressed?.startsWith(COPY_URL_PREFIX)) {
					if (url === pressed) {
						const block = state.codeById.get(pressed.slice(COPY_URL_PREFIX.length));
						if (block) state.onCopy?.(block, pressed, this);
					}
					return { consume: true };
				}
			}
		}
		return original.call(this, data);
	};
	prototype[CLICK_PATCH_KEY] = true;
}

function assistantText(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" &&
			typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("\n");
}

function latestAssistantBlocks(ctx: ExtensionContext | ExtensionCommandContext): CodeBlock[] {
	const entries = ctx.sessionManager.getBranch();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		return extractMarkedBlocks(markCodeBlocks(assistantText(entry.message)));
	}
	return [];
}

function blockLabel(block: CodeBlock, index: number): string {
	const preview = block.code.split("\n").find((line) => line.trim())?.trim() || "empty block";
	const clipped = preview.length > 56 ? `${preview.slice(0, 53)}...` : preview;
	const lines = block.code ? block.code.split("\n").length : 0;
	return `${index + 1}. ${block.language || "code"} · ${lines} line${lines === 1 ? "" : "s"} · ${clipped}`;
}

async function chooseAndCopy(ctx: ExtensionContext | ExtensionCommandContext, requestedIndex?: number): Promise<void> {
	const blocks = latestAssistantBlocks(ctx);
	if (blocks.length === 0) {
		ctx.ui.notify("No fenced code blocks in the latest assistant message", "warning");
		return;
	}

	let index = requestedIndex;
	if (index === undefined) {
		if (blocks.length === 1) {
			index = 0;
		} else {
			const labels = blocks.map(blockLabel);
			const selected = await ctx.ui.select("Copy code block", labels);
			if (!selected) return;
			index = labels.indexOf(selected);
		}
	}

	if (index < 0 || index >= blocks.length) {
		ctx.ui.notify(`Code block ${index + 1} does not exist`, "error");
		return;
	}

	try {
		await copyToClipboard(blocks[index].code);
		ctx.ui.notify(`Copied ${blocks[index].language || "code"} block ${index + 1}`, "info");
	} catch (error) {
		ctx.ui.notify(`Could not copy code block: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

export default function copyableCodeBlocks(pi: ExtensionAPI): void {
	patchMarkdownRenderer();
	patchFullscreenClicks();

	pi.on("session_start", (_event, ctx) => {
		sharedState().onCopy = (block, clickedUrl, tui) => {
			void copyToClipboard(block.code)
				.then(() => {
					const state = sharedState();
					const url = clickedUrl ?? registerClickableBlock(block);
					state.copiedUrl = url;
					state.feedbackRevision = (state.feedbackRevision ?? 0) + 1;
					if (state.feedbackTimer) clearTimeout(state.feedbackTimer);
					tui?.requestRender?.(true);
					ctx.ui.notify(`Copied ${block.language || "code"} block`, "info");
					state.feedbackTimer = setTimeout(() => {
						if (state.copiedUrl === url) state.copiedUrl = undefined;
						state.feedbackRevision = (state.feedbackRevision ?? 0) + 1;
						state.feedbackTimer = undefined;
						tui?.requestRender?.(true);
					}, 1800);
				})
				.catch((error) =>
					ctx.ui.notify(
						`Could not copy code block: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					),
				);
		};
	});

	pi.on("session_shutdown", () => {
		const state = sharedState();
		state.onCopy = undefined;
		state.copiedUrl = undefined;
		state.feedbackRevision = (state.feedbackRevision ?? 0) + 1;
		if (state.feedbackTimer) clearTimeout(state.feedbackTimer);
		state.feedbackTimer = undefined;
	});

	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType !== "assistant") return markdown;
		return markCodeBlocks(markdown);
	});

	pi.registerCommand("copy-code", {
		description: "Copy a fenced code block from the latest assistant message",
		handler: async (args, ctx) => {
			const value = args.trim();
			const requested = /^\d+$/.test(value) ? Number(value) - 1 : undefined;
			await chooseAndCopy(ctx, requested);
		},
	});

}
