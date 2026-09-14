// Isolated UI host. No Pi agent runtime, project discovery, or package installation.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createHostLoader, openBrowserIfActive } from "./host-loader.mjs";
import { readOwnedViewerPatch } from "./viewer-patch.mjs";

const [piPackageDir, plannotatorDir] = process.argv.slice(2);
const input = createInterface({ input: process.stdin });
let server;
let started = false;
let stopped = false;
const emit = (event) => process.stdout.write(`PR_REVIEW_UI ${JSON.stringify(event)}\n`);
const stop = () => {
	if (stopped) return;
	stopped = true;
	server?.stop();
	input.close();
	process.stdin.destroy();
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
process.stdin.once("end", stop);
const nativeFetch = globalThis.fetch;
globalThis.fetch = (request, options) => {
	const url = new URL(typeof request === "string" || request instanceof URL ? request : request.url);
	if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
		throw new Error("Viewer external network access is disabled");
	return nativeFetch(request, options);
};
input.on("line", (line) => {
	void (async () => {
		// The trusted parent sends the complete captured diff; its size is not a review quota.
		const request = JSON.parse(line);
		if (request.type === "cancel") return stop();
		if (
			started ||
			request.type !== "start" ||
			!(
				(request.patchFile === "diff.patch" && request.patch === undefined) ||
				(request.patchFile === undefined && typeof request.patch === "string")
			) ||
			typeof request.label !== "string" ||
			!Array.isArray(request.annotations)
		)
			throw new Error("Invalid viewer request");
		const diffType = request.diffType ?? "uncommitted";
		if (!["uncommitted", "last-commit", "since-base", "branch"].includes(diffType))
			throw new Error("Invalid captured diff scope");
		if (
			request.base != null &&
			(typeof request.base !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(request.base))
		)
			throw new Error("Invalid captured base");
		started = true;
		if (
			process.env.PLANNOTATOR_AI !== "disabled" ||
			process.env.PLANNOTATOR_SHARE !== "disabled" ||
			!process.env.PLANNOTATOR_DATA_DIR ||
			process.env.PLANNOTATOR_REMOTE !== "0"
		)
			throw new Error("Viewer isolation settings missing");
		const patch = request.patchFile ? await readOwnedViewerPatch(process.cwd(), process.ppid) : request.patch;
		if (stopped) return;
		const manifest = JSON.parse(await readFile(join(plannotatorDir, "package.json"), "utf8"));
		if (manifest.name !== "@plannotator/pi-extension" || manifest.version !== "0.27.12")
			throw new Error("Unsupported installed Plannotator version");
		const loader = createHostLoader(piPackageDir);
		const module = await loader.import(join(plannotatorDir, "server.ts"));
		if (typeof module.startReviewServer !== "function")
			throw new Error("Plannotator review server export unavailable");
		const html = await readFile(join(plannotatorDir, "review-editor.html"), "utf8");
		if (stopped) return;
		server = await module.startReviewServer({
			rawPatch: patch,
			gitRef: request.label,
			diffType,
			...(request.base ? { initialBase: request.base } : {}),
			htmlContent: html,
			origin: "pi",
			project: "pr-review",
			sharingEnabled: false,
			approvalNotesSupported: true,
		});
		if (stopped) return server.stop();
		const url = new URL(server.url);
		if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Viewer is not local");
		let ids = [];
		if (request.annotations.length) {
			const response = await fetch(`${server.url}/api/external-annotations`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ annotations: request.annotations }),
			});
			const body = await response.json();
			if (
				response.status !== 201 ||
				!Array.isArray(body.ids) ||
				body.ids.length !== request.annotations.length ||
				new Set(body.ids).size !== body.ids.length
			)
				throw new Error("Viewer annotation seeding failed");
			ids = body.ids;
		}
		if (stopped) return;
		emit({ type: "ready", url: server.url, ids });
		if (request.openBrowser !== false) {
			await openBrowserIfActive(
				() => loader.import(join(plannotatorDir, "server/network.ts")),
				server.url,
				() => stopped,
			);
		}
		if (stopped) return;
		const decision = await server.waitForDecision();
		if (stopped) return;
		emit({ type: "decision", decision });
		setTimeout(stop, 500);
	})().catch(() => {
		if (stopped) return;
		emit({
			type: "error",
			message: "Plannotator viewer failed. Check the supported installed version and local runtime.",
		});
		process.exitCode = 1;
		stop();
	});
});
