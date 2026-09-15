/** Exact releases validated by the opt-in compatibility and production viewer probes. */
export const supportedPlannotatorVersions: readonly string[] = ["0.27.12", "0.27.14"];

export function assertSupportedPlannotatorVersion(version: unknown): void {
	if (typeof version !== "string" || !supportedPlannotatorVersions.includes(version))
		throw new Error(
			`Installed Plannotator version ${typeof version === "string" ? version : "(missing or invalid)"} is not yet validated for PR review. Supported versions: ${supportedPlannotatorVersions.join(", ")}. Load a supported version, then run /reload.`,
		);
}
