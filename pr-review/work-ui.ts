import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Loader, Text } from "@earendil-works/pi-tui";

/** Ordinary dialogs stay between phases; signalled permission prompts can temporarily own the editor. */
export type WorkPhase = <T>(label: string, task: () => Promise<T>) => Promise<T>;
export const directWork: WorkPhase = (_label, task) => task();
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

export interface WorkUI {
	run: WorkPhase;
	update(message: string): void;
	setPermissionPromptActive(active: boolean): void;
	dispose(): void;
}

/** Presentation can be replaced; the logical phase runs exactly once independently of its spinner. */
export function createWorkUI(ctx: ExtensionContext, signal: AbortSignal, onCancel: () => void): WorkUI {
	let phase: { label: string; started: number; detail: string } | undefined;
	let permissionActive = false,
		disposed = false;
	let close: (() => void) | undefined, render: (() => void) | undefined;
	let resume: ReturnType<typeof setImmediate> | undefined;
	const hide = () => {
		clearImmediate(resume);
		resume = undefined;
		const owned = close;
		close = undefined;
		render = undefined;
		owned?.();
	};
	const show = () => {
		if (!phase || disposed || signal.aborted || permissionActive || close) return;
		const owner = phase;
		try {
			void ctx.ui
				.custom<void>((tui, theme, keys, done) => {
					const body = new Container();
					const spinner = new Loader(
						tui,
						(text) => theme.fg("accent", text),
						(text) => theme.fg("text", text),
						owner.label,
					);
					body.addChild(spinner);
					body.addChild(
						new Text(theme.fg("dim", `${keys.getKeys("tui.select.cancel").join(" / ")} to cancel`), 1, 0),
					);
					let closed = false;
					const refresh = () => {
						if (!closed)
							spinner.setMessage(
								`${owner.label} · ${Math.floor((Date.now() - owner.started) / 1000)}s${owner.detail ? `\n${owner.detail}` : ""}`,
							);
					};
					const heartbeat = setInterval(refresh, 1000);
					const cleanup = () => {
						closed = true;
						clearInterval(heartbeat);
						spinner.stop();
						if (close === finish) {
							close = undefined;
							render = undefined;
						}
					};
					const finish = () => {
						if (closed) return;
						cleanup();
						done(undefined);
					};
					close = finish;
					render = refresh;
					refresh();
					return {
						render: (width: number) => (closed || permissionActive ? [] : body.render(width)),
						invalidate: () => body.invalidate(),
						handleInput: (data: string) => {
							if (!closed && !permissionActive && keys.matches(data, "tui.select.cancel")) onCancel();
						},
						dispose: cleanup,
					};
				})
				.catch(() => {
					if (phase === owner) {
						hide();
						ctx.ui.notify("PR phase display unavailable; work continues.", "warning");
					}
				});
		} catch {
			hide();
		}
	};
	return {
		update(message) {
			if (phase) phase.detail = message;
			render?.();
		},
		setPermissionPromptActive(active) {
			if (disposed || permissionActive === active) return;
			permissionActive = active;
			if (active) hide();
			else if (phase && !signal.aborted) {
				// Let permission/note UI close fully; a following queued prompt cancels this restore.
				resume = setImmediate(() => {
					resume = undefined;
					show();
				});
			}
		},
		dispose() {
			disposed = true;
			hide();
		},
		async run<T>(label: string, task: () => Promise<T>): Promise<T> {
			signal.throwIfAborted();
			if (disposed) throw new Error("PR phase UI is disposed");
			if (phase) throw new Error("Cannot nest PR work phases");
			phase = { label, started: Date.now(), detail: "" };
			let launch: ReturnType<typeof setImmediate> | undefined;
			try {
				show();
				const work = new Promise<T>((resolve, reject) => {
					// Mount the initial presenter before launching, even for synchronous task failures.
					launch = setImmediate(() => {
						launch = undefined;
						if (signal.aborted) {
							reject(cancelled(signal));
							return;
						}
						Promise.resolve().then(task).then(resolve, reject);
					});
				});
				const value = await awaitWithSignal(work, signal);
				signal.throwIfAborted();
				return value;
			} finally {
				if (launch) clearImmediate(launch);
				phase = undefined;
				hide();
			}
		},
	};
}
