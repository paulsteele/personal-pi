import { createRequire } from "node:module";
import { join } from "node:path";

/** Use the installed Pi host's loader and public module resolutions; never install anything. */
export function createHostLoader(piPackageDir) {
	const anchor = join(piPackageDir, "package.json");
	const require = createRequire(anchor);
	const { createJiti } = require("jiti");
	const resolver = createJiti(anchor, { fsCache: false, interopDefault: true });
	const alias = {};
	for (const name of [
		"@earendil-works/pi-agent-core",
		"@earendil-works/pi-ai",
		"@earendil-works/pi-ai/compat",
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-tui",
		"typebox",
		"typebox/value",
		"typebox/compile",
	]) {
		alias[name] = resolver.esmResolve(name);
	}
	return createJiti(anchor, { fsCache: false, interopDefault: true, alias });
}

/** Retire an awaited import before it can launch a browser for a cancelled session. */
export async function openBrowserIfActive(load, url, isStopped) {
	if (isStopped()) return false;
	const network = await load();
	if (isStopped()) return false;
	await network.openBrowser(url);
	return !isStopped();
}
