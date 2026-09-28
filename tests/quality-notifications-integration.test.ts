import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createQualityActivityPublisher } from "../code-quality/activity.ts";
import { QualityController, type QualityUI } from "../code-quality/controller.ts";
import { saveConfig } from "../code-quality/config.ts";
import { canonicalPath } from "../code-quality/capture.ts";
import { createQualityAttentionTracker } from "../desktop-notifications/core.ts";

// The controller, publisher, and notification tracker are real; the provider and terminal dialog are fixtures.
test("a pending quality failure reaches the notification consumer and cancellation clears it", async () => {
	const root = canonicalPath(mkdtempSync(join(tmpdir(), "quality-notifications-")));
	const cwd = join(root, "repo");
	mkdirSync(cwd);
	const agentDir = join(root, "agent");
	saveConfig(agentDir, { provider: "fixture", model: "reviewer" });
	const tracker = createQualityAttentionTracker("session");
	const notices: unknown[] = [];
	const activity = createQualityActivityPublisher({
		on: () => () => {},
		emit(channel, event) {
			if (channel !== "code-quality:attention") return;
			const update = tracker.update(event);
			if (update) notices.push(update);
		},
	});
	let dismissFailure!: () => void;
	const ui: QualityUI = {
		arbitrate: async () => undefined,
		coverage: async () => undefined,
		failure: async () => new Promise(resolve => { dismissFailure = () => resolve(undefined); }),
	};
	const ctx = {
		cwd, mode: "tui", sessionManager: { getSessionId: () => "session", getBranch: () => [] },
		ui: { setStatus() {}, notify() {} }, abort() {},
	} as unknown as ExtensionContext;
	const controller = new QualityController({ appendEntry() {}, sendMessage() {} }, agentDir, {
		activity, ui,
		review: async () => ({ kind: "failed", reason: "PRIVATE_PROVIDER_ERROR", metrics: { requests: 5, latencyMs: 0, usages: [] } }),
	});
	try {
		controller.start(ctx);
		const path = join(cwd, "a.ts");
		await controller.beforeTool("write", { path }, ctx);
		writeFileSync(path, "const count = 1;\n");
		const boundary = controller.boundary(ctx, "completed");
		const maxDialogPolls = 100;
		for (let dialogPoll = 0; dialogPoll < maxDialogPolls && !dismissFailure; dialogPoll++) {
			await new Promise(resolve => setTimeout(resolve, 1));
		}
		expect(tracker.active).toBe(true);
		expect(notices).toEqual([{
			action: "show", notification: {
				subtitle: "Quality review needs attention",
				body: "Retry the review, select a reviewer, or waive the quality check.",
			},
		}]);
		dismissFailure();
		await boundary;
		expect(tracker.active).toBe(false);
		expect(notices.at(-1)).toEqual({ action: "clear" });
		expect(JSON.stringify(notices)).not.toContain("PRIVATE_PROVIDER_ERROR");
	} finally {
		controller.dispose();
		activity.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});
