export const CODE_BLOCK_MARKER = "pi-copyable-block";

export type CodeBlock = {
	language: string;
	code: string;
};

type Fence = { indent: string; fence: string; info: string };

function openingFence(line: string): Fence | undefined {
	const match = /^( {0,3})(`{3,}|~{3,})([^\r\n]*)$/.exec(line);
	if (!match) return undefined;
	return { indent: match[1], fence: match[2], info: match[3].trim() };
}

function isClosingFence(line: string, fence: string): boolean {
	const character = fence[0];
	return new RegExp(`^ {0,3}${character === "`" ? "`" : "~"}{${fence.length},}\\s*$`).test(line);
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
		if (!opening) continue;
		if (opening.info.split(/\s+/).includes(CODE_BLOCK_MARKER)) {
			// A previous render pass already marked this opening fence. Still track
			// its body so the closing fence cannot be mistaken for a new block.
			activeFence = opening.fence;
			continue;
		}
		const separator = opening.info ? " " : "";
		lines[index] = `${opening.indent}${opening.fence}${opening.info}${separator}${CODE_BLOCK_MARKER}`;
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
		if (!opening || !opening.info.split(/\s+/).includes(CODE_BLOCK_MARKER)) continue;

		const language = opening.info
			.split(/\s+/)
			.filter((part) => part && part !== CODE_BLOCK_MARKER)[0] ?? "";
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
