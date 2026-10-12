import { createProtocolConnection } from "vscode-languageserver-protocol/node";

const connection = createProtocolConnection(process.stdin, process.stdout);
connection.onRequest("initialize", ({ processId }) => {
	const expectedProcessId = JSON.parse(process.env.EXPECTED_CLIENT_PROCESS_ID);
	if (processId !== expectedProcessId) {
		process.stderr.write(`Unexpected client process ID: ${JSON.stringify(processId)}\n`);
		process.exit(1);
	}
	return {
		capabilities: {
			textDocumentSync: 1,
			diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false },
		},
	};
});
connection.onRequest("shutdown", () => null);
connection.onNotification("exit", () => process.exit(0));
connection.listen();
