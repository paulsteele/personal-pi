import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type {
	ContributedSidebarPanelId,
	SidebarPanelContribution,
	SidebarPanelDiscoveryEvent,
	SidebarPanelEvent,
	SidebarPanelRegisterEvent,
	SidebarPanelRole,
	SidebarPanelRow,
	SidebarPanelUnregisterEvent,
} from "../extensions/index.js";
import {
	BUILTIN_SIDEBAR_PANEL_IDS,
	isSidebarPanelContributionId,
	isSidebarPanelId,
	isSidebarPanelRequestId,
	SIDEBAR_PANEL_MAX_RAW_REQUEST_ID_CODE_UNITS,
} from "../extensions/index.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("local package contract", () => {
	it("publishes a Pi extension with compatible peers", () => {
		expect(pkg.name).toBe("pi-atelier-local");
		expect(pkg.version).toBe("0.8.2-local.2");
		expect(pkg.private).toBe(true);
		expect(pkg.description).toBe("Local, manually maintained Pi Atelier fork");
		expect(pkg.keywords).toContain("pi-package");
		expect(pkg.pi.extensions).toEqual(["./extensions/index.ts"]);
		expect(pkg.peerDependencies["@earendil-works/pi-coding-agent"]).toBe(">=0.80.7");
		expect(pkg.peerDependencies["@earendil-works/pi-tui"]).toBe(">=0.80.7");
		expect(pkg.engines.node).toBe(">=22.19.0");
		expect(pkg.files).toEqual(
			expect.arrayContaining(["extensions", "src", "README.md", "FORK.md", "LICENSE"]),
		);
	});

	it("documents fixed fullscreen Sidebar use", async () => {
		const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
		expect(readme).toContain("/atelier on|off|toggle");
		expect(readme).toContain("hides when the terminal is too narrow");
		expect(readme).toContain("44-column");
		expect(readme).not.toContain("Ctrl+Shift+R");
	});

	it("exports the deliberate structured contribution contract from the package entrypoint", () => {
		const contributedId: ContributedSidebarPanelId = "vendor:queue";
		const row: SidebarPanelRow = { text: "Ready", role: "ready" };
		const role: SidebarPanelRole = row.role ?? "primary";
		const contribution: SidebarPanelContribution = { id: contributedId, title: "Queue", rows: [row] };
		const register: SidebarPanelRegisterEvent = {
			version: 1,
			type: "register",
			source: "vendor",
			revision: 1,
			panel: contribution,
		};
		const unregister: SidebarPanelUnregisterEvent = {
			version: 1,
			type: "unregister",
			source: "vendor",
			revision: 2,
			id: contributedId,
		};
		const discovery: SidebarPanelDiscoveryEvent = { version: 1, type: "discover", requestId: "vendor-1" };
		const event: SidebarPanelEvent = register;
		// @ts-expect-error Built-ins are reserved and cannot be contributed.
		const invalidContribution: SidebarPanelContribution = { id: "agent", title: "Agent", rows: [] };
		expect(row).toEqual({ text: "Ready", role: "ready" });
		expect(role).toBe("ready");
		expect(register.panel).toBe(contribution);
		expect(unregister.id).toBe(contributedId);
		expect(discovery.requestId).toBe("vendor-1");
		expect(event.type).toBe("register");
		expect(invalidContribution.id).toBe("agent");
		expect(BUILTIN_SIDEBAR_PANEL_IDS).toEqual([
			"agent",
			"activity",
			"alerts",
			"context",
			"workspace",
			"usage",
		]);
		expect(isSidebarPanelContributionId(contributedId)).toBe(true);
		expect(isSidebarPanelContributionId("agent")).toBe(false);
		expect(isSidebarPanelId("agent")).toBe(true);
		expect(isSidebarPanelRequestId("vendor-1")).toBe(true);
		expect(SIDEBAR_PANEL_MAX_RAW_REQUEST_ID_CODE_UNITS).toBeGreaterThan(0);
	});
});
