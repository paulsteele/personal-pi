import { Worker } from "node:worker_threads";

export interface DiffIndex {
	metadataOnly: boolean;
	oldRanges: Array<[number, number]>;
	newRanges: Array<[number, number]>;
}

/** One lazy, sequential diff worker per capture; failures retire it before reuse. */
export class ExactDiffWorker {
	private worker: Worker | undefined;
	private failure: Error | undefined;
	private busy = false;
	private closing: Promise<void> = Promise.resolve();

	async dispose(): Promise<void> {
		const worker = this.worker;
		this.worker = undefined;
		this.failure = undefined;
		if (worker) {
			const prior = this.closing;
			this.closing = Promise.all([prior, worker.terminate()]).then(() => {});
		}
		await this.closing;
	}

	async diff(data: Record<string, unknown>, signal?: AbortSignal): Promise<DiffIndex> {
		signal?.throwIfAborted();
		if (this.busy) throw new Error("Exact diff worker already busy");
		this.busy = true;
		try {
			if (this.failure) await this.dispose();
			await this.closing;
			signal?.throwIfAborted();
			if (!this.worker) {
				const worker = new Worker(new URL("./snapshot-diff.mjs", import.meta.url));
				this.worker = worker;
				// Observe idle failures too; the next diff replaces the retired worker.
				worker.on("error", (error) => {
					if (this.worker === worker) this.failure = error;
				});
				worker.on("exit", () => {
					if (this.worker === worker) this.failure = new Error("Exact diff worker stopped");
				});
			}
			const worker = this.worker;
			return await new Promise<DiffIndex>((resolve, reject) => {
				const finish = (error?: Error, value?: DiffIndex) => {
					signal?.removeEventListener("abort", abort);
					worker.off("message", message);
					worker.off("error", failed);
					worker.off("exit", exited);
					if (error) reject(error);
					else resolve(value!);
				};
				const abort = () => finish(new Error("Capture cancelled"));
				const message = (value: DiffIndex & { error?: string }) =>
					finish(value.error ? new Error(value.error) : undefined, value);
				const failed = (error: Error) => finish(error);
				const exited = () => finish(new Error("Exact diff worker stopped"));
				worker.once("message", message);
				worker.once("error", failed);
				worker.once("exit", exited);
				signal?.addEventListener("abort", abort, { once: true });
				if (signal?.aborted) abort();
				else {
					try {
						worker.postMessage(data);
					} catch (error) {
						finish(error instanceof Error ? error : new Error("Exact diff dispatch failed"));
					}
				}
			});
		} catch (error) {
			// Await termination before capture can remove backing files or send another job.
			await this.dispose();
			throw error;
		} finally {
			this.busy = false;
		}
	}
}
