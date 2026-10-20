import { describe, expect, it } from "vitest";
import type { TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { isObservationMilestone } from "./milestones.js";

function completedCommand(command: string, isError = false): Pick<TurnEndEvent, "message" | "toolResults"> {
	return {
		message: {
			role: "assistant",
			api: "openai-responses",
			provider: "test",
			model: "worker",
			timestamp: 0,
			stopReason: "toolUse",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			content: [{ type: "toolCall", id: "command", name: "bash", arguments: { command } }],
		},
		toolResults: [
			{ role: "toolResult", toolCallId: "command", toolName: "bash", content: [], isError, timestamp: 0 },
		],
	};
}

describe("observation milestones", () => {
	it.each([
		"bun run test",
		"npm run typecheck",
		"pytest tests",
		"cargo check",
		"go test ./...",
		"./gradlew build",
		"dotnet test",
		"bun run format:check",
	])("recognizes completed verification command %s", (command) => {
		expect(isObservationMilestone(completedCommand(command))).toBe(true);
	});

	it("refreshes on a failed inspection even when it is not a verification command", () => {
		expect(isObservationMilestone(completedCommand("ls missing-directory", true))).toBe(true);
	});

	it("does not treat a routine inspection as a milestone", () => {
		expect(isObservationMilestone(completedCommand("ls src"))).toBe(false);
	});

	it("waits for the verification result rather than refreshing on intent alone", () => {
		const event = completedCommand("bun run test");
		event.toolResults = [];
		expect(isObservationMilestone(event)).toBe(false);
	});

	it("refreshes when a clarification result arrives", () => {
		const event = completedCommand("unused");
		if (event.message.role !== "assistant" || event.message.content[0]?.type !== "toolCall") {
			throw new Error("Expected assistant call fixture");
		}
		event.message.content[0].name = "ask_user_question";
		expect(isObservationMilestone(event)).toBe(true);
	});
});
