import { parentPort, workerData } from "node:worker_threads";
import { readFileSync, writeFileSync } from "node:fs";
import { structuredPatch } from "diff";

try {
	const decode = (path) => {
		const data = readFileSync(path);
		const text = data.toString("utf8");
		if (data.includes(0) || !Buffer.from(text).equals(data)) throw new Error("binary/non-UTF8 content");
		return text;
	};
	const { oldFile, newFile, oldPath, file, oldMode, newMode, output } = workerData;
	const diff = structuredPatch(
		oldMode ? `a/${oldPath}` : "/dev/null",
		newMode ? `b/${file}` : "/dev/null",
		decode(oldFile),
		decode(newFile),
		"",
		"",
		{ context: 20 },
	);
	if (!diff) throw new Error("Exact diff unavailable");
	const quote = (path) => (/[\s"\\]/.test(path) ? JSON.stringify(path) : path);
	const lines = [`diff --git ${quote(`a/${oldPath}`)} ${quote(`b/${file}`)}`];
	if (!oldMode) lines.push(`new file mode ${newMode}`);
	else if (!newMode) lines.push(`deleted file mode ${oldMode}`);
	else if (oldMode !== newMode) lines.push(`old mode ${oldMode}`, `new mode ${newMode}`);
	if (oldPath !== file)
		lines.push("similarity index 100%", `rename from ${quote(oldPath)}`, `rename to ${quote(file)}`);
	if (diff.hunks.length) lines.push(`--- ${quote(diff.oldFileName)}`, `+++ ${quote(diff.newFileName)}`);
	const oldRanges = [],
		newRanges = [];
	const addLine = (ranges, line) => {
		const last = ranges.at(-1);
		if (last && last[1] + 1 === line) last[1] = line;
		else ranges.push([line, line]);
	};
	for (const hunk of diff.hunks) {
		lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
		let oldLine = hunk.oldStart,
			newLine = hunk.newStart;
		for (const line of hunk.lines) {
			lines.push(line);
			if (line.startsWith("-")) addLine(oldRanges, oldLine++);
			else if (line.startsWith("+")) addLine(newRanges, newLine++);
			else if (line.startsWith(" ")) {
				oldLine++;
				newLine++;
			}
		}
	}
	writeFileSync(output, `${lines.join("\n")}\n`, { mode: 0o600, flag: "wx" });
	parentPort.postMessage({ metadataOnly: diff.hunks.length === 0, oldRanges, newRanges });
} catch (error) {
	parentPort.postMessage({ error: error instanceof Error ? error.message : "Exact diff failed" });
}
