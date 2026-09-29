import { createProtocolConnection } from "vscode-languageserver-protocol/node";

const connection = createProtocolConnection(process.stdin, process.stdout);
const documents = new Map();
const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

connection.onRequest("initialize", () => ({
	capabilities: {
		textDocumentSync: 1,
		diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false },
	},
}));
connection.onNotification("initialized", () => {});
connection.onNotification("workspace/didChangeConfiguration", () => {});
connection.onNotification("textDocument/didOpen", ({ textDocument }) => {
	documents.set(textDocument.uri, textDocument);
});
connection.onNotification("textDocument/didChange", ({ textDocument, contentChanges }) => {
	documents.set(textDocument.uri, { ...textDocument, text: contentChanges[0].text });
	void connection.sendNotification("textDocument/publishDiagnostics", {
		uri: textDocument.uri,
		version: textDocument.version,
		diagnostics: [],
	});
});
connection.onNotification("textDocument/didSave", () => {});
connection.onRequest("textDocument/diagnostic", async ({ textDocument, previousResultId }) => {
	const document = documents.get(textDocument.uri);
	const resultIsUnchanged = previousResultId === String(document.version);
	if (resultIsUnchanged) {
		return { kind: "unchanged", resultId: previousResultId };
	}
	const diagnosticDelayAfterClearingMs = Number(process.env.PROBE_DIAGNOSTIC_DELAY_MS ?? 30);
	await new Promise((resolve) => setTimeout(resolve, diagnosticDelayAfterClearingMs));
	const diagnostics =
		document.text === "clean"
			? []
			: [
					{
						message: `Finding for revision ${document.version}`,
						range,
						...(document.text === "unspecified" ? {} : { severity: Number(document.text) }),
					},
				];
	return { kind: "full", resultId: String(document.version), items: diagnostics };
});
connection.onRequest("shutdown", () => null);
connection.onNotification("exit", () => process.exit(0));
connection.listen();
