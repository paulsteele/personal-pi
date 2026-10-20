import type { DryBaselinePhase } from "./dry-types.js";

export class DryBaselineDeadline {
	readonly startedAt = performance.now();
	readonly signal: AbortSignal;
	private readonly timeout = new AbortController();
	private readonly timer: ReturnType<typeof setTimeout>;
	phase: DryBaselinePhase = "baseline startup";
	constructor(
		readonly budgetMs: number,
		owner: AbortSignal,
	) {
		this.signal = AbortSignal.any([owner, this.timeout.signal]);
		this.timer = setTimeout(() => {
			this.timeout.abort(new Error(`DRY baseline timed out during ${this.phase} after ${budgetMs}ms`));
		}, budgetMs);
	}
	get remainingMs(): number {
		this.signal.throwIfAborted();
		return Math.max(1, Math.ceil(this.budgetMs - (performance.now() - this.startedAt)));
	}
	async wait<T>(operation: Promise<T>): Promise<T> {
		this.signal.throwIfAborted();
		let abort: (() => void) | undefined;
		try {
			return await Promise.race([
				operation,
				new Promise<never>((_resolve, reject) => {
					abort = () => reject(this.signal.reason);
					this.signal.addEventListener("abort", abort, { once: true });
					if (this.signal.aborted) {
						abort();
					}
				}),
			]);
		} finally {
			if (abort) {
				this.signal.removeEventListener("abort", abort);
			}
		}
	}
	close(): void {
		clearTimeout(this.timer);
	}
}
