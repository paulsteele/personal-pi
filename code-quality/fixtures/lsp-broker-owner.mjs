import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { attachBroker } = await jiti.import("../lsp-broker-registry.ts");
const { agentDir, root, route, clientId } = JSON.parse(process.argv[2]);
const connection = await attachBroker(agentDir, root, route, clientId, () => {}, AbortSignal.timeout(15000));
process.send?.({ kind: "attached", registry: connection.registry });
process.on("message", async (message) => {
	if (message?.kind !== "close") return;
	await connection.close();
	process.exit(0);
});
