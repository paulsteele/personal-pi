import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";

const configuration = JSON.parse(await readFile(process.argv[2], "utf8"));
const jiti = createJiti(import.meta.url);
const { runLspBroker } = await jiti.import("./lsp-broker.ts");
try {
	await runLspBroker(configuration);
} catch (error) {
	process.send?.({ kind: "failed", reason: String(error) });
	process.stderr.write(`${String(error)}\n`);
	process.exitCode = 1;
}
