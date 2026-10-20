import type { TurnEndEvent } from "@earendil-works/pi-coding-agent";

const VERIFICATION_COMMAND =
	/(?:^|[\s:;&|/])(?:test|pytest|vitest|jest|tsc|typecheck|lint|check|build|compile|cargo\s+(?:test|check|build)|go\s+test|dotnet\s+test|mvn\s+test)(?:[\s:;&|]|$)/i;

export function isObservationMilestone(event: Pick<TurnEndEvent, "message" | "toolResults">): boolean {
	if (event.toolResults.some((result) => result.isError)) {
		return true;
	}
	if (event.message.role !== "assistant") {
		return false;
	}
	const completedCalls = new Set(event.toolResults.map((result) => result.toolCallId));
	return event.message.content.some((part) => {
		if (part.type !== "toolCall" || !completedCalls.has(part.id)) {
			return false;
		}
		if (part.name === "ask_user_question") {
			return true;
		}
		return (
			part.name === "bash" &&
			typeof part.arguments.command === "string" &&
			VERIFICATION_COMMAND.test(part.arguments.command)
		);
	});
}
