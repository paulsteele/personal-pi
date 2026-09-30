import { createProtocolConnection } from "vscode-languageserver-protocol/node";

const connection = createProtocolConnection(process.stdin, process.stdout);
const documents = new Map();
const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

connection.onRequest("initialize", () => ({
	capabilities: {
		textDocumentSync: 1,
		diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: false },
	},
}));
connection.onNotification("textDocument/didOpen", ({ textDocument }) => {
	documents.set(textDocument.uri, textDocument.text);
});
connection.onNotification("textDocument/didChange", ({ textDocument, contentChanges }) => {
	documents.set(textDocument.uri, contentChanges[0].text);
});
connection.onNotification("textDocument/didClose", ({ textDocument }) => {
	documents.delete(textDocument.uri);
});
connection.onRequest("textDocument/diagnostic", ({ previousResultId }) => {
	if (previousResultId) return { kind: "unchanged", resultId: previousResultId };
	const hasDependencyOverlay = documents.has(process.env.PROBE_DEPENDENCY_URI);
	const items = hasDependencyOverlay ? [] : [{ message: "Dependency overlay closed", severity: 1, range }];
	return {
		kind: "full",
		resultId: "1",
		items,
	};
});
connection.onRequest("shutdown", () => null);
connection.onNotification("exit", () => process.exit(0));
connection.listen();
