import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Loader, Text } from "@earendil-works/pi-tui";

/** Work phases must not open select/input/editor/custom dialogs themselves. */
export type WorkPhase = <T>(label: string, task: () => Promise<T>) => Promise<T>;
export const directWork: WorkPhase = (_label, task) => task();

type PhaseResult<T> = { ok: true; value: T } | { ok: false; error: unknown };
const cancelled = (signal: AbortSignal): unknown => signal.reason ?? new Error("PR operation cancelled");

/** Race an abort without leaving an unhandled late rejection (not all UI APIs accept a signal). */
export function awaitWithSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => {
			signal.removeEventListener("abort", abort);
			reject(cancelled(signal));
		};
		pending.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	});
}

/** One visible, cancellable spinner per non-interactive phase, never around the entire command. */
export function createWorkUI(
	ctx: ExtensionContext,
	signal: AbortSignal,
	onCancel: () => void,
): {
	run: WorkPhase;
	update(message: string): void;
} {
	let update: ((message: string) => void) | undefined;
	let busy = false;
	return {
		update(message) {
			update?.(message);
		},
		async run<T>(label: string, task: () => Promise<T>): Promise<T> {
			signal.throwIfAborted();
			if (busy) throw new Error("Cannot nest PR work phases");
			busy = true;
			let dispose: (() => void) | undefined;
			try {
				const result = await awaitWithSignal(
					ctx.ui.custom<PhaseResult<T>>((tui, theme, keys, done) => {
						const body = new Container();
						const spinner = new Loader(
							tui,
							(text) => theme.fg("accent", text),
							(text) => theme.fg("text", text),
							label,
						);
						body.addChild(spinner);
						body.addChild(
							new Text(theme.fg("dim", `${keys.getKeys("tui.select.cancel").join(" / ")} to cancel`), 1, 0),
						);
						const started = Date.now();
						let detail = "";
						let closed = false;
						let launch: ReturnType<typeof setImmediate> | undefined;
						const render = () => {
							if (!closed)
								spinner.setMessage(
									`${label} · ${Math.floor((Date.now() - started) / 1000)}s${detail ? `\n${detail}` : ""}`,
								);
						};
						const heartbeat = setInterval(render, 1000);
						const cleanup = () => {
							closed = true;
							clearInterval(heartbeat);
							if (launch) clearImmediate(launch);
							spinner.stop();
							signal.removeEventListener("abort", abort);
						};
						const finish = (value: PhaseResult<T>) => {
							if (closed) return;
							cleanup();
							done(value);
						};
						const abort = () => finish({ ok: false, error: cancelled(signal) });
						dispose = cleanup;
						update = (message) => {
							detail = message;
							render();
						};
						signal.addEventListener("abort", abort, { once: true });
						// Let Pi mount the component first. Synchronous failures must not orphan its spinner.
						launch = setImmediate(() => {
							if (signal.aborted) {
								abort();
								return;
							}
							void Promise.resolve()
								.then(task)
								.then(
									(value) => finish({ ok: true, value }),
									(error) => finish({ ok: false, error }),
								)
								.catch(() => {
									/* A retired session can reject its UI close; the abort race still settles. */
								});
						});
						return {
							render: (width: number) => body.render(width),
							invalidate: () => body.invalidate(),
							handleInput: (data: string) => {
								if (keys.matches(data, "tui.select.cancel")) onCancel();
							},
							dispose: cleanup,
						};
					}),
					signal,
				);
				signal.throwIfAborted();
				if (!result.ok) throw result.error;
				return result.value;
			} finally {
				dispose?.();
				update = undefined;
				busy = false;
			}
		},
	};
}
