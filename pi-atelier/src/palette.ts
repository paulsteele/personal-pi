export type PaletteRole =
	| "accent"
	| "primary"
	| "muted"
	| "dim"
	| "ready"
	| "working"
	| "added"
	| "input"
	| "output"
	| "cache"
	| "cost"
	| "context"
	| "permissionPolicy"
	| "permissionSecurity"
	| "permissionAuto"
	| "permissionHuman"
	| "menu"
	| "warning"
	| "error";

interface PaletteTheme {
	readonly name?: string;
	fg(color: string, text: string): string;
}

type Rgb = readonly [number, number, number];

const FIXED_DARK: Record<PaletteRole, Rgb> = {
	accent: [177, 140, 255],
	primary: [147, 197, 253],
	muted: [128, 128, 128],
	dim: [102, 102, 102],
	ready: [110, 168, 254],
	working: [255, 159, 67],
	added: [134, 239, 172],
	input: [110, 168, 254],
	output: [177, 140, 255],
	cache: [125, 211, 252],
	cost: [255, 159, 67],
	context: [110, 168, 254],
	permissionPolicy: [110, 168, 254],
	permissionSecurity: [255, 170, 64],
	permissionAuto: [177, 140, 255],
	permissionHuman: [125, 211, 252],
	menu: [177, 140, 255],
	warning: [255, 159, 67],
	error: [255, 93, 115],
};

const UNNAMED_THEME: Record<PaletteRole, string> = {
	accent: "accent",
	primary: "thinkingLow",
	muted: "muted",
	dim: "dim",
	ready: "thinkingLow",
	working: "mdHeading",
	added: "success",
	input: "thinkingLow",
	output: "thinkingHigh",
	cache: "syntaxType",
	cost: "mdHeading",
	context: "thinkingLow",
	permissionPolicy: "thinkingLow",
	permissionSecurity: "warning",
	permissionAuto: "thinkingHigh",
	permissionHuman: "syntaxType",
	menu: "thinkingHigh",
	warning: "warning",
	error: "error",
};

const NO_COLOR: Record<PaletteRole, string> = {
	accent: "accent",
	primary: "text",
	muted: "muted",
	dim: "dim",
	ready: "text",
	working: "text",
	added: "success",
	input: "text",
	output: "text",
	cache: "text",
	cost: "text",
	context: "text",
	permissionPolicy: "text",
	permissionSecurity: "warning",
	permissionAuto: "text",
	permissionHuman: "text",
	menu: "text",
	warning: "warning",
	error: "error",
};

export interface AtelierPalette {
	paint(role: PaletteRole, text: string): string;
}

function rgb([red, green, blue]: Rgb, text: string): string {
	return `\u001b[38;2;${red};${green};${blue}m${text}\u001b[39m`;
}

export function createPalette(theme: PaletteTheme, colorEnabled: boolean): AtelierPalette {
	return {
		paint(role, text) {
			if (!colorEnabled) return theme.fg(NO_COLOR[role], text);
			if (!theme.name) return theme.fg(UNNAMED_THEME[role], text);
			return rgb(FIXED_DARK[role], text);
		},
	};
}
