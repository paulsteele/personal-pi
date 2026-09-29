import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import type { Diagnostic } from "vscode-languageserver-protocol";
import { LspProbe } from "./lsp-probe.js";

it.each([1, 2, 3, 4, undefined])(
	"retains severity %s despite an earlier empty clearing notification",
	async (severity) => {
		const root = await mkdtemp(join(tmpdir(), "quality-lsp-probe-"));
		const probe = new LspProbe(
			{
				name: "delayed-diagnostics",
				command: process.execPath,
				args: [fileURLToPath(new URL("./fixtures/lsp-probe-server.mjs", import.meta.url))],
			},
			root,
		);
		const uri = pathToFileURL(join(root, "example.txt")).href;
		try {
			await probe.initialize();
			await probe.sync("example.txt", "plaintext", "clean");
			await probe.sync("example.txt", "plaintext", severity === undefined ? "unspecified" : String(severity));
			const report = await probe.request<{ items: Diagnostic[]; resultId: string }>(
				"textDocument/diagnostic",
				{ textDocument: { uri } },
			);
			expect(report.resultId).toBe("2");
			expect(report.items).toHaveLength(1);
			expect(report.items[0]).toMatchObject({ message: "Finding for revision 2" });
			expect(report.items[0]!.severity).toBe(severity);
			expect(
				probe.events.some(
					(event) =>
						event.method === "textDocument/publishDiagnostics" &&
						(event.params as { diagnostics: Diagnostic[] }).diagnostics.length === 0,
				),
			).toBe(true);

			await probe.sync("example.txt", "plaintext", "clean");
			const repaired = await probe.request<{ items: Diagnostic[]; resultId: string }>(
				"textDocument/diagnostic",
				{ textDocument: { uri } },
			);
			expect(repaired).toEqual({ kind: "full", resultId: "3", items: [] });
		} finally {
			await probe.stop();
			await rm(root, { recursive: true, force: true });
		}
		expect(probe.child.exitCode).toBe(0);
	},
);
