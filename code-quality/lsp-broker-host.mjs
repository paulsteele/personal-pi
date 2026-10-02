import { readFile } from "node:fs/promises";

try {
	const configuration = JSON.parse(await readFile(process.argv[2], "utf8"));
	const { createJiti } = await import("jiti");
	const jiti = createJiti(import.meta.url);
	const { runLspBroker } = await jiti.import("./lsp-broker.ts");
	await runLspBroker(configuration);
} catch (error) {
	process.send?.({ kind: "failed", reason: String(error) });
	process.stderr.write(`${String(error)}\n`);
	process.exitCode = 1;
}
