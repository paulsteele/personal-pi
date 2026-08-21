import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import plannotatorSidebar from "./index.ts";
import { ATELIER_PANEL_CHANNEL } from "./core.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
	const root = join(tmpdir(), `plannotator-sidebar-${crypto.randomUUID()}`);
	roots.push(root);
	await mkdir(root, { recursive: true });
	await writeFile(join(root, "PLAN.md"), "- [ ] First\n- [ ] Second\n", "utf8");
	return root;
}

function harness(cwd: string) {
	const handlers = new Map<string, Array<(event: any, ctx?: any) => unknown>>();
	const busHandlers = new Map<string, Array<(event: any) => unknown>>();
	const emitted: Array<{ channel: string; event: any }> = [];
	const widgets: Array<[string, unknown]> = [];
	let entries: any[] = [
		{ type: "custom", customType: "plannotator-execute", data: { lastSubmittedPath: "PLAN.md" } },
		{ type: "custom", customType: "plannotator", data: { phase: "executing", lastSubmittedPath: "PLAN.md" } },
	];
	const pi = {
		on(name: string, handler: (event: any, ctx?: any) => unknown) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		events: {
			on(channel: string, handler: (event: any) => unknown) {
				busHandlers.set(channel, [...(busHandlers.get(channel) ?? []), handler]);
				return () => busHandlers.set(channel, (busHandlers.get(channel) ?? []).filter((item) => item !== handler));
			},
			emit(channel: string, event: any) {
				emitted.push({ channel, event });
				for (const handler of busHandlers.get(channel) ?? []) handler(event);
			},
		},
	};
	const ctx = {
		cwd,
		sessionManager: { getBranch: () => entries },
		ui: { setWidget: (key: string, value: unknown) => widgets.push([key, value]) },
	};
	plannotatorSidebar(pi as any);
	return {
		emitted,
		widgets,
		setEntries(next: any[]) { entries = next; },
		async fire(name: string) {
			for (const handler of handlers.get(name) ?? []) await handler({}, ctx);
			await new Promise((resolve) => setTimeout(resolve, 5));
		},
		emit(channel: string, event: any) { pi.events.emit(channel, event); },
	};
}

describe("Atelier compatibility lifecycle", () => {
	test("publishes progress, replays discovery, and clears only Plannotator's widget", async () => {
		const h = harness(await fixture());
		await h.fire("session_start");
		const registrations = h.emitted.filter(({ event }) => event.type === "register");
		expect(registrations).toHaveLength(1);
		expect(registrations[0]?.event.panel.id).toBe("plannotator:progress");
		expect(registrations[0]?.event.panel.rows[0].text).toBe("0/2 complete");
		expect(h.widgets).toContainEqual(["plannotator-progress", undefined]);

		h.emit(ATELIER_PANEL_CHANNEL, { version: 1, type: "discover", requestId: "atelier-9" });
		const replay = h.emitted.filter(({ event }) => event.type === "register" && event.requestId === "atelier-9");
		expect(replay).toHaveLength(1);
		expect(replay[0]?.event.revision).toBeGreaterThan(registrations[0]?.event.revision);
	});

	test("unregisters when the active branch returns to idle", async () => {
		const root = await fixture();
		const h = harness(root);
		await h.fire("session_start");
		h.setEntries([{ type: "custom", customType: "plannotator", data: { phase: "idle" } }]);
		await h.fire("session_tree");
		expect(h.emitted.some(({ event }) => event.type === "unregister" && event.id === "plannotator:progress")).toBe(true);
	});
});
