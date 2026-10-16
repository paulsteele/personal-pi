import { expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { parseDryStatus } from "../src/quality-dry.js";
import { parseQualityHeader } from "../src/quality-activity.js";
import { renderQualityContent } from "../src/sidebar.js";

const readyStatus = {
	toolPhase: "ready",
	scanPhase: "ready",
	version: "5.4.1",
	executable: "/opt/pi-tools/jscpd/5.4.1/bin/jscpd",
	files: 40,
	windows: 100,
	bytes: 20000,
	excluded: 3,
	formatCount: 224,
	astFormatCount: 15,
	cloneCounts: { exact: 1, renamed: 2, gap: 3, ast: 4 },
	scope: "/repo",
	revision: "a".repeat(64),
};
it("retains only bounded presentation metadata", () => {
	const parsed = parseDryStatus({ ...readyStatus, sourceCode: "must not reach Sidebar" });
	expect(parsed).toEqual(readyStatus);
	expect(parseDryStatus({ ...readyStatus, scanPhase: "approved" })).toBeUndefined();
	expect(parseDryStatus({ ...readyStatus, files: -1 })).toBeUndefined();
});
it("shows a legacy limited scan as ready", () => {
	expect(parseDryStatus({ ...readyStatus, scanPhase: "limited" })?.scanPhase).toBe("ready");
});
it("renders a ready-scan warning line by line under Attention", () => {
	const warning = [
		"DRY is scanning directories that look vendored or generated:",
		"  internal-packages   (11 NuGet packages, 0.4 MiB)",
		"  build/tools/.store  (NuGet tool store, 0.1 MiB)",
	].join("\n");
	const header = parseQualityHeader({
		version: 1,
		sessionId: "fixture",
		revision: 1,
		phase: "ready",
		modelId: "provider/shared",
		dry: { ...readyStatus, warning },
	});
	const theme = {
		fg: (_role: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
	};
	const rows = renderQualityContent(header, theme, 80, false);
	expect(header?.dry?.warning).toBe(warning);
	expect(rows.join("\n")).toContain("ATTENTION");
	expect(rows).toContain("  internal-packages   (11 NuGet packages, 0.4 MiB)");
	expect(rows).toContain("  build/tools/.store  (NuGet tool store, 0.1 MiB)");
});
it("renders the detailed Quality tab safely at narrow widths", () => {
	const header = parseQualityHeader({
		version: 1,
		sessionId: "fixture",
		revision: 1,
		phase: "ready",
		modelId: "provider/shared",
		dry: readyStatus,
	});
	const theme = {
		fg: (_role: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
	};
	for (const width of [28, 44]) {
		const rows = renderQualityContent(header, theme, width, false);
		expect(rows.join("\n")).toContain("JSCPD");
		expect(rows.join("\n")).not.toContain("REPOSITORY SCAN");
		expect(rows.join("\n")).toContain("5.4.1");
		expect(rows.join("\n")).toMatch(/Scan\n\s+ready/);
		expect(rows.join("\n")).toMatch(/Scope\n\s+\/repo/);
		expect(rows.join(" ")).not.toMatch(/not code\s+approval/);
		expect(rows.join("\n")).not.toContain("Controls");
		expect(rows.join("\n")).not.toContain("Settings");
		for (const row of rows) {
			expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		}
	}
});
