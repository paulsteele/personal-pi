import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	encodeArgument,
	isHyprlandAddress,
	isMacWindowId,
	latestFinalAssistantText,
	notificationPreview,
	replacementKey,
	safeProjectLabel,
} from "./core.ts";

type NativeTarget =
	| { platform: "mac"; id: number; key: string }
	| { platform: "hyprland"; id: string; key: string };

type PermissionPrompt = { requestId?: unknown; surface?: unknown; value?: unknown };
type PermissionDecision = { requestId?: unknown };
type AskUserBlocked = { active?: unknown };
type CommandResult = { stdout: string; stderr: string; code: number | null };

type Runtime = {
	ctx: ExtensionContext;
	target?: NativeTarget;
	project: string;
	disabled: boolean;
	warned: boolean;
	generation: number;
	queue: Promise<void>;
	permissionRequest?: string;
	dunst?: ChildProcess;
	dunstId?: string;
	focusSocket?: Socket;
	unsubscribers: Array<() => void>;
};

const EXTENSION_DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const FOCUS_HELPER = join(EXTENSION_DIR, "focus-terminal.sh");

function normalTitle(project: string): string {
	return `Pi - ${project}`;
}

function parseJsonLine<T>(stdout: string): T | undefined {
	for (const line of stdout.trim().split("\n").reverse()) {
		try {
			return JSON.parse(line) as T;
		} catch {
			// The first hs call can print extension-loading diagnostics before JSON.
		}
	}
	return undefined;
}

async function exec(command: string, args: string[], timeout = 5000): Promise<CommandResult> {
	return await new Promise((resolve) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] as const });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
		child.stdout.on("data", (chunk) => (stdout += String(chunk)));
		child.stderr.on("data", (chunk) => (stderr += String(chunk)));
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ stdout, stderr: `${stderr}${error.message}`, code: null });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ stdout, stderr, code });
		});
	});
}

function warnOnce(runtime: Runtime, message: string): void {
	if (runtime.warned) return;
	runtime.warned = true;
	runtime.ctx.ui.notify(`Desktop notifications disabled: ${message}`, "warning");
}

function enqueue(runtime: Runtime, task: (generation: number) => Promise<void>): Promise<void> {
	const generation = runtime.generation;
	runtime.queue = runtime.queue
		.then(() => task(generation))
		.catch((error) => warnOnce(runtime, error instanceof Error ? error.message : String(error)));
	return runtime.queue;
}

async function hsCall(expression: string): Promise<Record<string, unknown>> {
	const result = await exec("/opt/homebrew/bin/hs", ["-c", `return ${expression}`]);
	const parsed = parseJsonLine<Record<string, unknown>>(result.stdout);
	if (result.code !== 0 || !parsed) throw new Error(result.stderr.trim() || "Hammerspoon IPC failed");
	return parsed;
}

async function resolveMacTarget(runtime: Runtime, marker: string): Promise<NativeTarget> {
	const preflight = await hsCall("piNotify.preflight()");
	if (preflight.ok !== true) throw new Error("grant Hammerspoon Accessibility permission, then reload Pi");
	for (let attempt = 0; attempt < 12; attempt++) {
		const result = await hsCall(`piNotify.resolve('${encodeArgument(marker)}')`);
		if (result.ok === true && isMacWindowId(result.windowId)) {
			return { platform: "mac", id: result.windowId, key: replacementKey("mac", result.windowId) };
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("could not resolve the marked Alacritty window");
}

type HyprClient = { address?: unknown; title?: unknown; class?: unknown; initialClass?: unknown };

async function resolveHyprlandTarget(marker: string): Promise<NativeTarget> {
	for (let attempt = 0; attempt < 12; attempt++) {
		const result = await exec("hyprctl", ["clients", "-j"]);
		if (result.code !== 0) throw new Error(result.stderr.trim() || "hyprctl clients failed");
		const clients = JSON.parse(result.stdout) as HyprClient[];
		const client = clients.find(
			(item) => item.title === marker && /alacritty/i.test(String(item.class ?? item.initialClass ?? "")),
		);
		if (client && isHyprlandAddress(client.address)) {
			return {
				platform: "hyprland",
				id: client.address,
				key: replacementKey("hyprland", client.address),
			};
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("could not resolve the marked Alacritty window in Hyprland");
}

async function resolveTarget(runtime: Runtime): Promise<void> {
	if (runtime.ctx.mode !== "tui") {
		runtime.disabled = true;
		return;
	}
	const marker = `pi-notify-${process.pid}-${Date.now().toString(36)}`;
	runtime.ctx.ui.setTitle(marker);
	try {
		if (process.platform === "darwin") {
			runtime.target = await resolveMacTarget(runtime, marker);
		} else if (process.platform === "linux" && process.env.HYPRLAND_INSTANCE_SIGNATURE) {
			runtime.target = await resolveHyprlandTarget(marker);
		} else {
			runtime.disabled = true;
			warnOnce(runtime, "supported environments are macOS Alacritty and Linux Alacritty on Hyprland");
		}
	} finally {
		runtime.ctx.ui.setTitle(normalTitle(runtime.project));
	}
	if (runtime.target?.platform === "hyprland") startHyprlandFocusWatcher(runtime, runtime.target.id);
}

async function isFocused(target: NativeTarget): Promise<boolean> {
	if (target.platform === "mac") {
		const result = await hsCall(`piNotify.isFocused(${target.id})`);
		return result.ok === true && result.focused === true;
	}
	const result = await exec("hyprctl", ["activewindow", "-j"]);
	if (result.code !== 0) return false;
	const active = JSON.parse(result.stdout) as { address?: unknown };
	return String(active.address).toLowerCase() === target.id.toLowerCase();
}

async function playLinuxSound(): Promise<void> {
	let result = await exec("canberra-gtk-play", ["-i", "complete", "-d", "pi-desktop-notify"], 3000);
	if (result.code === 0) return;
	for (const file of [
		"/usr/share/sounds/freedesktop/stereo/complete.oga",
		"/usr/share/sounds/freedesktop/stereo/message.oga",
	]) {
		result = await exec("paplay", [file], 3000);
		if (result.code === 0) return;
	}
	throw new Error("install canberra-gtk-play or paplay for notification sounds");
}

async function clearNotification(runtime: Runtime): Promise<void> {
	const target = runtime.target;
	if (!target) return;
	if (target.platform === "mac") {
		await hsCall(`piNotify.clear('${encodeArgument(target.key)}')`);
		return;
	}
	if (runtime.dunstId && /^\d+$/.test(runtime.dunstId)) {
		await exec("dunstify", ["--close", runtime.dunstId]);
	}
	runtime.dunstId = undefined;
	if (runtime.dunst && !runtime.dunst.killed) runtime.dunst.kill("SIGTERM");
	runtime.dunst = undefined;
}

async function sendMac(target: Extract<NativeTarget, { platform: "mac" }>, title: string, subtitle: string, body: string): Promise<void> {
	const result = await hsCall(
		`piNotify.send('${encodeArgument(target.key)}',${target.id},'${encodeArgument(title)}','${encodeArgument(subtitle)}','${encodeArgument(body)}')`,
	);
	if (result.ok !== true) throw new Error(String(result.error ?? "Hammerspoon notification failed"));
}

async function sendDunst(runtime: Runtime, target: Extract<NativeTarget, { platform: "hyprland" }>, title: string, subtitle: string, body: string): Promise<void> {
	await clearNotification(runtime);
	const child = spawn(
		"dunstify",
		[
			"--app-name=Pi",
			`--stack-tag=${target.key}`,
			"--print-id",
			"--wait",
			"--action=default,Open terminal",
			"--urgency=normal",
			`${title} — ${subtitle}`,
			body,
		],
		{ stdio: ["ignore", "pipe", "pipe"] as const },
	);
	runtime.dunst = child;
	let buffer = "";
	child.stdout.on("data", (chunk) => {
		buffer += String(chunk);
		const lines = buffer.split(/\r?\n/);
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			const value = line.trim();
			if (/^\d+$/.test(value)) runtime.dunstId = value;
			if (value === "default") void exec(FOCUS_HELPER, [target.id]);
		}
	});
	child.on("close", () => {
		if (runtime.dunst === child) runtime.dunst = undefined;
	});
	child.on("error", (error) => warnOnce(runtime, error.message));
	await playLinuxSound();
}

async function sendNotification(runtime: Runtime, subtitle: string, body: string, generation: number): Promise<void> {
	if (runtime.disabled || generation !== runtime.generation) return;
	const target = runtime.target;
	if (!target) return;
	if (await isFocused(target)) {
		await clearNotification(runtime);
		return;
	}
	if (generation !== runtime.generation) return;
	const title = `Pi · ${runtime.project}`;
	if (target.platform === "mac") await sendMac(target, title, subtitle, body);
	else await sendDunst(runtime, target, title, subtitle, body);
}

function startHyprlandFocusWatcher(runtime: Runtime, targetAddress: string): void {
	const runtimeDir = process.env.XDG_RUNTIME_DIR;
	const signature = process.env.HYPRLAND_INSTANCE_SIGNATURE;
	if (!runtimeDir || !signature) return;
	const path = join(runtimeDir, "hypr", signature, ".socket2.sock");
	const socket = createConnection(path);
	runtime.focusSocket = socket;
	let buffer = "";
	socket.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			const match = /^activewindowv2>>(0x[0-9a-fA-F]+)$/.exec(line.trim());
			if (match && match[1].toLowerCase() === targetAddress.toLowerCase()) {
				runtime.generation++;
				enqueue(runtime, async () => clearNotification(runtime));
			}
		}
	});
	socket.on("error", (error) => warnOnce(runtime, `Hyprland focus listener: ${error.message}`));
}

function shutdown(runtime: Runtime): void {
	runtime.generation++;
	for (const unsubscribe of runtime.unsubscribers.splice(0)) unsubscribe();
	runtime.focusSocket?.destroy();
	runtime.focusSocket = undefined;
	if (runtime.dunst && !runtime.dunst.killed) runtime.dunst.kill("SIGTERM");
	void clearNotification(runtime).catch(() => {});
}

export default function desktopNotifications(pi: ExtensionAPI): void {
	let runtime: Runtime | undefined;

	pi.on("session_start", async (_event, ctx) => {
		if (runtime) shutdown(runtime);
		runtime = {
			ctx,
			project: safeProjectLabel(ctx.cwd),
			disabled: false,
			warned: false,
			generation: 0,
			queue: Promise.resolve(),
			unsubscribers: [],
		};
		const current = runtime;
		const promptUnsubscribe = pi.events.on("permissions:ui_prompt", (raw) => {
			if (runtime !== current) return;
			const event = raw as PermissionPrompt;
			if (typeof event.requestId !== "string") return;
			current.permissionRequest = event.requestId;
			current.generation++;
			enqueue(current, async (generation) => {
				const surface = typeof event.surface === "string" ? event.surface : "permission";
				const value = typeof event.value === "string" ? event.value : "Pi needs your decision";
				await sendNotification(current, `Permission needed: ${surface}`, notificationPreview(value, 180), generation);
			});
		});
		const decisionUnsubscribe = pi.events.on("permissions:decision", (raw) => {
			if (runtime !== current) return;
			const event = raw as PermissionDecision;
			if (typeof event.requestId !== "string" || event.requestId !== current.permissionRequest) return;
			current.permissionRequest = undefined;
			current.generation++;
			enqueue(current, async () => clearNotification(current));
		});
		const questionUnsubscribe = pi.events.on("rpiv:ask-user:blocked", (raw) => {
			if (runtime !== current) return;
			const event = raw as AskUserBlocked;
			// active=false is emitted after the user answers or cancels the
			// questionnaire. Merely focusing the terminal emits nothing.
			if (event.active !== false) return;
			current.generation++;
			enqueue(current, async () => clearNotification(current));
		});
		current.unsubscribers.push(promptUnsubscribe, decisionUnsubscribe, questionUnsubscribe);
		try {
			await resolveTarget(current);
		} catch (error) {
			current.disabled = true;
			warnOnce(current, error instanceof Error ? error.message : String(error));
			ctx.ui.setTitle(normalTitle(current.project));
		}
	});

	const clearWhenWorkStarts = async (): Promise<void> => {
		if (!runtime) return;
		const current = runtime;
		current.generation++;
		// Await the serialized clear. Previously these lifecycle handlers only
		// queued it and returned, which allowed user input/model startup to race
		// ahead while the old notification remained visible.
		await enqueue(current, async () => clearNotification(current));
	};

	// Clear as soon as typed/RPC input is accepted. message_start is a second,
	// authoritative signal for user messages injected by hosts/extensions that
	// can bypass the input hook.
	pi.on("input", async () => {
		await clearWhenWorkStarts();
		return { action: "continue" };
	});
	pi.on("message_start", async (event) => {
		if (event.message.role === "user") await clearWhenWorkStarts();
	});
	pi.on("agent_start", async () => clearWhenWorkStarts());

	// An interactive tool (for example, ask_user_question) resumes inside the
	// existing agent run, so agent_start does not fire after a manual answer.
	// The following model turn is the reliable signal that Pi is working again.
	pi.on("turn_start", async () => clearWhenWorkStarts());

	pi.on("agent_settled", async (_event, ctx) => {
		if (!runtime || runtime.permissionRequest) return;
		const current = runtime;
		const text = latestFinalAssistantText(ctx.sessionManager.getBranch());
		if (!text) return;
		enqueue(current, async (generation) => {
			await sendNotification(current, "Ready for input", notificationPreview(text), generation);
		});
	});

	pi.on("session_shutdown", async () => {
		if (!runtime) return;
		shutdown(runtime);
		runtime = undefined;
	});

	pi.registerCommand("notify-test", {
		description: "Test desktop notification preflight, replacement, focus, and cleanup",
		handler: async (_args, ctx) => {
			if (!runtime || runtime.ctx !== ctx || !runtime.target || runtime.disabled) {
				ctx.ui.notify("Desktop notifications are not ready; review the startup warning and README", "error");
				return;
			}
			const target = runtime.target;
			const focused = await isFocused(target);
			ctx.ui.notify(`${target.platform} target ${target.id}; focused=${focused}`, "info");
			runtime.generation++;
			const generation = runtime.generation;
			await clearNotification(runtime);
			if (focused) {
				ctx.ui.notify("Switch away from this terminal and run /notify-test again to display the test", "warning");
				return;
			}
			await sendNotification(runtime, "Notification test", "Click to focus this exact terminal window.", generation);
		},
	});
}
