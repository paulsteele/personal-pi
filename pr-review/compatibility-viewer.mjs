// Compatibility probe only. Not registered as a Pi resource or used for real reviews.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createHostLoader } from "./host-loader.mjs";

const [piPackageDir, plannotatorDir] = process.argv.slice(2);
let server;
let closing = false;
const lines = createInterface({ input: process.stdin });
const emit = (event) => process.stdout.write(`PR_REVIEW_COMPAT ${JSON.stringify(event)}\n`);
const stop = () => {
	if (closing) return;
	closing = true;
	server?.stop();
	lines.close();
	process.stdin.destroy();
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

// There must be no server-side non-loopback requests in a snapshot-only viewer.
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
	const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
	if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
		emit({ type: "unexpected-network", host: url.hostname });
		throw new Error("Non-loopback network access disabled in compatibility probe");
	}
	return originalFetch(input, options);
};

let started = false;
lines.on("line", (line) => {
	void (async () => {
		const request = JSON.parse(line);
		if (request.type === "cancel") return stop();
		if (request.type !== "start" || started) throw new Error("Invalid probe request");
		started = true;
		const manifest = JSON.parse(await readFile(join(plannotatorDir, "package.json"), "utf8"));
		if (manifest.name !== "@plannotator/pi-extension" || manifest.version !== "0.27.12") {
			throw new Error("Unsupported installed Plannotator version");
		}
		const loader = createHostLoader(piPackageDir);
		const module = await loader.import(join(plannotatorDir, "server.ts"));
		if (typeof module.startReviewServer !== "function") throw new Error("Missing review server export");
		if (closing) return;
		server = await module.startReviewServer({
			rawPatch: request.patch,
			gitRef: "PR review compatibility snapshot",
			htmlContent: await readFile(join(plannotatorDir, "review-editor.html"), "utf8"),
			origin: "pi",
			project: "pr-review-compatibility",
			sharingEnabled: false,
			approvalNotesSupported: true,
			// Deliberately no gitContext, workspace, PR metadata, or project cwd.
		});
		if (closing) return server.stop();
		const seededResponse = await fetch(`${server.url}/api/external-annotations`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ annotations: request.annotations }),
		});
		const seeded = await seededResponse.json();
		if (seededResponse.status !== 201 || !Array.isArray(seeded.ids))
			throw new Error("Annotation seeding failed");
		emit({ type: "ready", url: server.url, ids: seeded.ids });
		const result = await server.waitForDecision();
		emit({ type: "decision", result });
		// Let the server flush the HTTP decision response before closing it.
		setTimeout(stop, 100);
	})().catch((error) => {
		emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
		process.exitCode = 1;
		stop();
	});
});
