import { describe, expect, it } from "vitest";
import { activityLabel } from "../src/activity.js";

describe("activity labels", () => {
	it.each([
		["ready", "READY"],
		["working", "WORKING"],
	] as const)("renders %s plainly", (activity, expected) => {
		expect(activityLabel(activity)).toBe(expected);
	});
});
