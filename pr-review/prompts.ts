import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const names = [
	"methodology",
	"global-rules",
	"discover",
	"profile",
	"propose",
	"reviewer",
	"architecture",
	"verifier",
	"consolidate",
	"fix-handoff",
	"personas/security",
	"personas/performance",
	"personas/correctness",
	"personas/style",
	"personas/readability",
] as const;
export type PromptName = (typeof names)[number];
export const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
export interface Prompts {
	text: Record<PromptName, string>;
	hashes: Record<string, string>;
}
export async function loadPrompts(): Promise<Prompts> {
	const text = {} as Record<PromptName, string>;
	const hashes: Record<string, string> = {};
	for (const name of names) {
		const content = await readFile(new URL(`./prompts/${name}.md`, import.meta.url), "utf8");
		if (!content.trim() || Buffer.byteLength(content) > 32000)
			throw new Error(`Invalid shared prompt: ${name}`);
		text[name] = content;
		hashes[name] = hash(content);
	}
	return { text, hashes };
}
export function systemPrompt(prompts: Prompts, stage: PromptName): string {
	return [prompts.text.methodology, prompts.text["global-rules"], prompts.text[stage]].join("\n\n");
}
