import type { ActivityState } from "./types.js";

/** Plain, actionable labels for the agent's current activity. */
export function activityLabel(activity: ActivityState): "READY" | "WORKING" {
	return activity === "working" ? "WORKING" : "READY";
}
