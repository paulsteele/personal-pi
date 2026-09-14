import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { hash } from "./prompts.js";
import { redact } from "./report.js";
import { publish, readStored } from "./storage.js";
import type { TaskStore } from "./tasks.js";

/** Small coalesced diagnostic record; no prompts, source bodies, or worker transcripts. */
export async function createRunJournal(root: string, repoId: string, tasks: TaskStore, onError: () => void) {
	const path = join(root, "repos", repoId, `latest-run-${process.pid}.json`);
	const runId = randomUUID(),
		startedAt = new Date().toISOString();
	// A process owns only its own latest-run file. CAS protects against late writes from a retired session.
	let revision = (await readStored(root, path))?.revision;
	let closed = false,
		failed = false,
		writing = false,
		timer: ReturnType<typeof setTimeout> | undefined;
	let pending = Promise.resolve();
	const persist = (finished: boolean) => {
		if (!finished && writing) return pending;
		writing = true;
		const value = JSON.parse(
			JSON.stringify(
				{
					runId,
					pid: process.pid,
					startedAt,
					updatedAt: new Date().toISOString(),
					finished,
					phase: tasks.phase,
					progress: tasks.progress,
					model: tasks.model,
					tasks: [...tasks.records.values()].map((task) => ({
						...task,
						files: undefined,
						fileCount: task.files.length,
						unreviewed: task.unreviewed?.slice(0, 50),
						recent: tasks.events.get(task.id)?.slice(-5),
					})),
				},
				(_key, value) => (typeof value === "string" ? redact(value) : value),
			),
		);
		pending = pending
			.then(async () => {
				if (failed) return;
				try {
					await publish(root, path, value, revision);
					revision = hash(JSON.stringify(value, null, 2) + "\n");
				} catch {
					failed = true;
					try {
						onError();
					} catch {
						/* Diagnostics must not stop work. */
					}
				}
			})
			.finally(() => {
				writing = false;
			});
		return pending;
	};
	await persist(false);
	const unsubscribe = tasks.onChange(() => {
		if (!closed && !failed && !timer)
			timer = setTimeout(() => {
				timer = undefined;
				void persist(false);
			}, 1000);
	});
	return {
		path,
		async close() {
			if (closed) return;
			closed = true;
			unsubscribe();
			clearTimeout(timer);
			await persist(true);
		},
	};
}
