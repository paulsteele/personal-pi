import { stripTerminalSequences } from "@earendil-works/pi-tui";

export interface SidebarSandboxState {
	sessionId: string;
	revision: number;
	phase: "starting" | "ready" | "changing" | "unavailable" | "stopped" | "off";
	definitionPath: string;
	toolingSources?: string[];
	toolingRevision?: string;
	containerName?: string;
	containerId?: string;
	image?: string;
	cwd?: string;
	mounts: { source: string; destination: string; access: "ro" | "rw" }[];
	ports: number[];
	error?: string;
}

function safeText(value: unknown): value is string {
	return typeof value === "string" && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value);
}

export function parseSandboxState(value: unknown): SidebarSandboxState | undefined {
	if (!value || typeof value !== "object") {
		return;
	}
	const state = value as Record<string, unknown>;
	if (state.version !== 1) {
		return;
	}
	if (!safeText(state.sessionId) || !safeText(state.definitionPath)) {
		return;
	}
	if (!Number.isSafeInteger(state.revision)) {
		return;
	}
	const phases: SidebarSandboxState["phase"][] = [
		"starting",
		"ready",
		"changing",
		"unavailable",
		"stopped",
		"off",
	];
	if (typeof state.phase !== "string" || !phases.includes(state.phase as SidebarSandboxState["phase"])) {
		return;
	}
	if (
		!Array.isArray(state.mounts) ||
		state.mounts.length > 100 ||
		!Array.isArray(state.ports) ||
		state.ports.length > 64
	) {
		return;
	}
	const mounts: SidebarSandboxState["mounts"] = [];
	for (const value of state.mounts) {
		if (!value || typeof value !== "object") {
			return;
		}
		const mount = value as Record<string, unknown>;
		if (
			!safeText(mount.source) ||
			!safeText(mount.destination) ||
			(mount.access !== "ro" && mount.access !== "rw")
		) {
			return;
		}
		mounts.push({ source: mount.source, destination: mount.destination, access: mount.access });
	}
	if (!state.ports.every((port) => Number.isInteger(port) && port > 0 && port <= 65535)) {
		return;
	}
	const optional: Record<string, string> = {};
	for (const field of ["containerName", "containerId", "image", "cwd", "toolingRevision"]) {
		if (state[field] !== undefined) {
			if (!safeText(state[field])) {
				return;
			}
			optional[field] = state[field];
		}
	}
	if (state.error !== undefined) {
		if (typeof state.error !== "string") {
			return;
		}
		optional.error = stripTerminalSequences(state.error)
			.replace(/[\u0000-\u001f\u007f]/g, " ")
			.slice(0, 4096);
	}
	const maximumToolingSourceCount = 8;
	if (state.toolingSources !== undefined) {
		if (!Array.isArray(state.toolingSources)) {
			return;
		}
		if (state.toolingSources.length > maximumToolingSourceCount) {
			return;
		}
		if (!state.toolingSources.every(safeText)) {
			return;
		}
	}
	return {
		sessionId: state.sessionId,
		revision: state.revision as number,
		phase: state.phase as SidebarSandboxState["phase"],
		definitionPath: state.definitionPath,
		...(state.toolingSources ? { toolingSources: state.toolingSources as string[] } : {}),
		mounts,
		ports: state.ports as number[],
		...optional,
	};
}
