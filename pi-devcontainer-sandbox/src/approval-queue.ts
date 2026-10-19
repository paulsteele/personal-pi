/** FIFO only for human interaction. Never holds a lock around classifiers or tool execution. */
export class ApprovalQueue {
  private readonly lifetime = new AbortController();
  private readonly pending: Array<() => void> = [];
  private active = false;

  run<T>(signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const combined = signal
      ? AbortSignal.any([signal, this.lifetime.signal])
      : this.lifetime.signal;
    if (combined.aborted) return Promise.reject(combined.reason);
    return new Promise<T>((resolve, reject) => {
      let started = false;
      const abort = () => {
        if (!started) {
          const at = this.pending.indexOf(start);
          if (at >= 0) this.pending.splice(at, 1);
          combined.removeEventListener("abort", abort);
          reject(combined.reason);
        }
        // An active prompt owns its UI until its abort-aware action has dismissed it.
      };
      const start = () => {
        started = true;
        this.active = true;
        Promise.resolve()
          .then(() => {
            combined.throwIfAborted();
            return action(combined);
          })
          .then(resolve, reject)
          .finally(() => {
            combined.removeEventListener("abort", abort);
            this.active = false;
            this.pump();
          });
      };
      combined.addEventListener("abort", abort, { once: true });
      this.pending.push(start);
      if (combined.aborted) abort();
      this.pump();
    });
  }

  dispose(): void {
    this.lifetime.abort();
  }

  private pump(): void {
    if (!this.active && !this.lifetime.signal.aborted) this.pending.shift()?.();
  }
}
