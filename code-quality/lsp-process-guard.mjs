import { spawn } from "node:child_process";

const [command, ...args] = process.argv.slice(2);
if (!command || !process.send) process.exit(2);
const child = spawn(command, args, { detached: true, stdio: ["pipe", "pipe", "pipe"], env: process.env });
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
process.stdin.pipe(child.stdin);
child.stdin.on("error", () => {});
let stopping = false;
let leaderExited = false;
let forceTimer;

function notifyBroker(message) {
	if (process.connected) process.send?.(message, () => {});
}

function signalGroup(signal) {
	if (!child.pid) return;
	try {
		process.kill(-child.pid, signal);
	} catch (error) {
		if (error.code !== "ESRCH" && error.code !== "EPERM")
			process.stderr.write(`LSP group termination: ${error.message}\n`);
	}
}

function stop() {
	if (stopping) return;
	stopping = true;
	process.stdin.unpipe(child.stdin);
	child.stdin.end();
	signalGroup("SIGTERM");
	forceTimer = setTimeout(() => {
		signalGroup("SIGKILL");
		process.exit(leaderExited ? 0 : 1);
	}, 1000);
}

function reportChildFailure(error) {
	notifyBroker({ kind: "failed", reason: error.message });
	stop();
}

function handleControlMessage(message) {
	if (message?.kind === "stop") stop();
}

child.once("spawn", () => notifyBroker({ kind: "started", pid: child.pid }));
child.once("error", reportChildFailure);
child.once("exit", (code, signal) => {
	leaderExited = true;
	notifyBroker({ kind: "exited", code, signal });
	stop();
});
process.on("message", handleControlMessage);
process.on("disconnect", stop);
process.stdout.on("error", stop);
process.stderr.on("error", stop);
process.on("SIGTERM", stop);
process.on("SIGHUP", stop);
process.on("exit", () => {
	clearTimeout(forceTimer);
	signalGroup("SIGKILL");
});
