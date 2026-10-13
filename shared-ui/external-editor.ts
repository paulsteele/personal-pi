import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { presentPanel } from "./index.js";

interface EditorOutcome {
  exitCode: number | null;
  error?: unknown;
}

async function runEditor(
  ctx: ExtensionContext,
  path: string,
  signal?: AbortSignal,
): Promise<number | null> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    throw new Error("External configuration editors require interactive TUI mode");
  }
  signal?.throwIfAborted();
  const command = process.env.EDITOR?.trim() || process.env.VISUAL?.trim() || "vi";
  const mounted = new EventTarget();
  const panel = presentPanel<EditorOutcome>(
    ctx,
    (tui, _theme, _keys, done) => {
      const launchFullscreenEditor = async () => {
        let outcome: EditorOutcome;
        tui.stop();
        try {
          signal?.throwIfAborted();
          tui.terminal.write("\x1b[2J\x1b[H");
          const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
          const args =
            process.platform === "win32"
              ? ["/d", "/s", "/c", `${command} "${path}"`]
              : ["-c", `exec ${command} "$1"`, "pi-config-editor", path];
          outcome = await new Promise<EditorOutcome>((complete) => {
            let error: unknown;
            const child = spawn(shell, args, { cwd: ctx.cwd, stdio: "inherit", signal });
            child.once("error", (failure) => {
              error = failure;
            });
            child.once("close", (exitCode) => complete({ exitCode, error }));
          });
        } catch (error) {
          outcome = { exitCode: null, error };
        } finally {
          tui.start();
          tui.requestRender(true);
        }
        done(outcome);
      };
      mounted.addEventListener(
        "ready",
        () => {
          void launchFullscreenEditor();
        },
        { once: true },
      );
      return { render: () => [], invalidate() {} };
    },
    {
      onRenderReady: () => {
        mounted.dispatchEvent(new Event("ready"));
      },
    },
  );
  const outcome = await panel.result;
  signal?.throwIfAborted();
  if (outcome.error) {
    throw outcome.error;
  }
  return outcome.exitCode;
}

export async function openConfigFile(
  ctx: ExtensionContext,
  path: string,
  signal?: AbortSignal,
): Promise<void> {
  const exitCode = await runEditor(ctx, resolve(ctx.cwd, path), signal);
  if (exitCode !== 0) {
    throw new Error(`Configuration editor exited unsuccessfully (${exitCode ?? "signal"})`);
  }
}

export async function editConfigDraft(
  ctx: ExtensionContext,
  title: string,
  content: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  signal?.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "pi-config-editor-"));
  const filename =
    title
      .split("\n")[0]!
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .slice(0, 80) || "config";
  const path = join(directory, `${filename}.json`);
  try {
    await writeFile(path, content, { mode: 0o600, flag: "wx" });
    const exitCode = await runEditor(ctx, path, signal);
    if (exitCode !== 0) {
      return undefined;
    }
    return (await readFile(path, "utf8")).replace(/^\uFEFF/, "").replace(/\r?\n$/, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
