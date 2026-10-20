import { createHash } from "node:crypto";

export const MAX_LEXICAL_FEATURE_CHARS = 160;
const KEYWORDS = new Set(
	"const let var function return if else for while import export from async await new class public private static def fn func package true false null undefined void int string bool number this self try catch throw type interface extends implements use mod pub match case break continue".split(
		" ",
	),
);
function boundedFeature(family, value) {
	const feature = `${family}:${value}`;
	if (feature.length <= MAX_LEXICAL_FEATURE_CHARS && !value.startsWith("sha256:")) {
		return feature;
	}
	return `${family}:sha256:${createHash("sha256").update(value).digest("hex")}`;
}
export function lexicalFeatures(text) {
	const features = new Set();
	for (const identifierMatch of text.matchAll(/\b[A-Za-z_][A-Za-z_0-9]*\b/g)) {
		const identifier = identifierMatch[0];
		if (KEYWORDS.has(identifier) || identifier.length < 3) {
			continue;
		}
		features.add(boundedFeature("id", identifier.toLowerCase()));
		for (const identifierPart of identifier.replace(/([a-z])([A-Z])/g, "$1 $2").split(/[_\s]+/)) {
			if (identifierPart.length >= 3 && !KEYWORDS.has(identifierPart.toLowerCase())) {
				features.add(boundedFeature("word", identifierPart.toLowerCase()));
			}
		}
	}
	for (const call of text.matchAll(/\b([A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)*)\s*\(/g)) {
		if (!KEYWORDS.has(call[1])) {
			features.add(boundedFeature("call", call[1]));
		}
	}
	for (const literal of text.matchAll(/["']([^"'\n]{4,})["']|\b(\d{2,}(?:\.\d+)?)\b/g)) {
		features.add(boundedFeature("literal", literal[1] ?? literal[2]));
	}
	return [...features].sort();
}
export function lexicalWindows(text) {
	const lines = text.split("\n");
	const nonblank = lines
		.map((lineText, index) => ({ text: lineText, line: index + 1 }))
		.filter((lineEntry) => lineEntry.text.trim());
	const windows = [];
	const windowSize = 40;
	const windowStep = 20;
	for (let offset = 0; offset < nonblank.length; offset += windowStep) {
		const chunk = nonblank.slice(offset, offset + windowSize);
		windows.push({
			range: [chunk[0].line, chunk.at(-1).line],
			features: lexicalFeatures(chunk.map((line) => line.text).join("\n")),
		});
		if (offset + windowSize >= nonblank.length) {
			break;
		}
	}
	return windows;
}
