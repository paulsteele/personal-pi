const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const sourceDirectory = process.argv.at(-1);
let baselineCode = fs.readFileSync(path.join(sourceDirectory, "existing.ts"), "utf8");
fs.appendFileSync(path.join(sourceDirectory, "..", "launches"), "scan\n");
function rescan() {
	baselineCode = fs.readFileSync(path.join(sourceDirectory, "existing.ts"), "utf8");
	fs.appendFileSync(path.join(sourceDirectory, "..", "launches"), "rescan\n");
	return { structuredContent: { files: 1, byKind: {}, duplications: [] } };
}

function snippetResponse(code) {
	if (!code.includes("retentionDays")) {
		return { structuredContent: { count: 0, duplications: [] } };
	}
	const duplication = {
		file: "existing.ts",
		fileStartLine: 1,
		fileEndLine: baselineCode.split("\n").length,
		snippetStartLine: 1,
		snippetEndLine: code.split("\n").length,
		tokens: 40,
		kind: "renamed",
		fragment: "must not be exported",
	};
	return { structuredContent: { count: 1, duplications: [duplication] } };
}
function respond(rpcRequest) {
	if (rpcRequest.method === "initialize") {
		return { serverInfo: { version: "5.4.1" }, protocolVersion: "2025-11-25" };
	}
	if (rpcRequest.params.name === "get_statistics") {
		return {
			structuredContent: {
				files: 1,
				byKind: {},
				statistics: { total: { sources: 1 }, formats: { typescript: { sources: 1 } } },
			},
		};
	}
	if (rpcRequest.params.name === "check_current_directory") {
		return rescan();
	}
	if (rpcRequest.params.name === "check_duplication") {
		return snippetResponse(rpcRequest.params.arguments.code);
	}
	return { isError: true, content: [{ type: "text", text: "unexpected tool" }] };
}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
	const rpcRequest = JSON.parse(line);
	if (rpcRequest.id === undefined) {
		return;
	}
	const result = respond(rpcRequest);
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: rpcRequest.id, result })}\n`);
});
