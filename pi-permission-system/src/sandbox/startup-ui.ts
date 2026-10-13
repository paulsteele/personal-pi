import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { awaitSandboxWork } from "./cancellation.ts";
import { SandboxStartupLog } from "./startup-log.ts";
import {
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Component,
  type OverlayHandle,
} from "@earendil-works/pi-tui";

export interface SandboxStartupProgress {
  stage(text: string): void;
  output(text: string): void;
  diagnostic?(text: string): void;
}

export interface SandboxStartupDisplay {
  run<T>(
    title: string,
    operation: (progress: SandboxStartupProgress) => Promise<T>,
    cancellationSignal?: AbortSignal,
  ): Promise<T>;
}

export const silentStartupProgress: SandboxStartupProgress = {
  stage() {},
  output() {},
};

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const animationIntervalMs = 100;
const maxLogLines = 200;
const maxLogLineChars = 2000;

function displayText(text: string): string {
  return stripTerminalSequences(text).replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
    "",
  );
}

export class SandboxStartupConsole implements Component, SandboxStartupProgress {
  private readonly startedAtMs = Date.now();
  private currentStage = "Preparing sandbox…";
  private stages: string[] = [];
  private lines: string[] = [];
  private pendingLine = "";
  private scrollbackLines = 0;
  private viewportLogRows = 1;
  private timer?: ReturnType<typeof setInterval>;
  private hiddenByUser = false;
  private suspensionDepth = 0;
  private disposed = false;
  private handle?: OverlayHandle;

  constructor(
    private readonly title: string,
    private readonly project: string,
    private readonly theme: Pick<Theme, "fg"> & Partial<Pick<Theme, "bg">>,
    private readonly terminalRows: () => number,
    private readonly requestRender: () => void,
  ) {}

  attach(handle: OverlayHandle): void {
    if (this.disposed) {
      return;
    }
    this.handle = handle;
    this.updateVisibility();
  }

  stage(text: string): void {
    this.currentStage = displayText(text);
    if (this.stages.at(-1) !== this.currentStage) {
      this.stages = [...this.stages, this.currentStage].slice(-8);
    }
    this.output(`${text}\n`);
  }

  output(text: string): void {
    if (this.disposed) {
      return;
    }
    const chunks = displayText(text)
      .replace(/\r\n/g, "\n")
      .split(/[\r\n]/);
    chunks[0] = this.pendingLine + chunks[0];
    this.pendingLine = chunks.pop()!.slice(-maxLogLineChars);
    const completedLines = chunks
      .filter((line) => line.length > 0)
      .map((line) => line.slice(-maxLogLineChars));
    this.lines = [...this.lines, ...completedLines].slice(-maxLogLines);
    if (this.scrollbackLines > 0) {
      this.scrollbackLines = Math.min(maxLogLines, this.scrollbackLines + completedLines.length);
    }
    this.requestRender();
  }

  suspend(): () => void {
    this.suspensionDepth++;
    this.updateVisibility();
    let resumed = false;
    return () => {
      if (resumed || this.disposed) {
        return;
      }
      resumed = true;
      this.suspensionDepth--;
      this.updateVisibility();
    };
  }

  private updateVisibility(): void {
    if (this.disposed) {
      return;
    }
    const hidden = this.hiddenByUser || this.suspensionDepth > 0;
    this.handle?.setHidden(hidden);
    clearInterval(this.timer);
    this.timer = undefined;
    if (!hidden && this.handle) {
      this.timer = setInterval(this.requestRender, animationIntervalMs);
    }
    this.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.hiddenByUser = true;
      this.updateVisibility();
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "pageUp")) {
      const scrollRows = matchesKey(data, "pageUp") ? this.viewportLogRows : 1;
      this.scrollbackLines = Math.min(this.lines.length, this.scrollbackLines + scrollRows);
    } else if (matchesKey(data, "down") || matchesKey(data, "pageDown")) {
      const scrollRows = matchesKey(data, "pageDown") ? this.viewportLogRows : 1;
      this.scrollbackLines = Math.max(0, this.scrollbackLines - scrollRows);
    } else if (matchesKey(data, "end")) {
      this.scrollbackLines = 0;
    }
    this.requestRender();
  }

  render(width: number): string[] {
    const columns = Math.max(0, Math.trunc(width));
    const rows = Math.max(1, this.terminalRows());
    const elapsedMs = Math.max(0, Date.now() - this.startedAtMs);
    const elapsedSeconds = Math.floor(elapsedMs / 1000);
    const elapsed = `${String(Math.floor(elapsedSeconds / 60)).padStart(2, "0")}:${String(elapsedSeconds % 60).padStart(2, "0")}`;
    const frame = spinnerFrames[Math.floor(elapsedMs / animationIntervalMs) % spinnerFrames.length];
    const framed = columns >= 24 && rows >= 12;
    const contentWidth = framed ? columns - 4 : columns;
    const fillTerminalRow = (value: string) => {
      const clipped = truncateToWidth(value, columns, "…");
      const padded = clipped + " ".repeat(Math.max(0, columns - visibleWidth(clipped)));
      return this.theme.bg?.("customMessageBg", padded) ?? padded;
    };
    const renderContentRow = (value: string) => {
      if (!framed) {
        return fillTerminalRow(value);
      }
      const clipped = truncateToWidth(value, contentWidth, "…");
      return fillTerminalRow(
        this.theme.fg("borderAccent", "│") +
          ` ${clipped}${" ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)))} ` +
          this.theme.fg("borderAccent", "│"),
      );
    };
    const renderFrameDivider = (leftBorder: string, rightBorder: string, label = "") => {
      const innerWidth = columns - 2;
      const title = truncateToWidth(label, innerWidth, "…");
      return fillTerminalRow(
        this.theme.fg(
          "borderAccent",
          `${leftBorder}${title}${"─".repeat(Math.max(0, innerWidth - visibleWidth(title)))}${rightBorder}`,
        ),
      );
    };
    const elapsedLabel = ` ${elapsed}`;
    const heading = truncateToWidth(
      `${frame} ${this.title}`,
      Math.max(0, contentWidth - visibleWidth(elapsedLabel) - 1),
    );
    const headingGap = " ".repeat(
      Math.max(0, contentWidth - visibleWidth(heading) - visibleWidth(elapsedLabel)),
    );
    const titleRow =
      this.theme.fg("accent", heading) + headingGap + this.theme.fg("muted", elapsedLabel);
    const header = framed
      ? [
          renderFrameDivider("╭", "╮", "─ DEVCONTAINER "),
          renderContentRow(titleRow),
          renderContentRow(this.theme.fg("muted", displayText(this.project))),
          renderContentRow(""),
          renderContentRow(this.theme.fg("muted", "CURRENT STAGE")),
          renderContentRow(this.theme.fg("accent", `› ${this.currentStage}`)),
        ]
      : [
          renderContentRow(titleRow),
          renderContentRow(this.theme.fg("muted", displayText(this.project))),
          renderContentRow(this.theme.fg("text", this.currentStage)),
        ];
    if (framed && rows >= 18) {
      const previousStage = this.stages.at(-2);
      header.push(
        renderContentRow(
          this.theme.fg(
            "dim",
            previousStage ? `✓ ${previousStage}` : "Waiting for startup progress",
          ),
        ),
      );
    }
    if (framed) {
      header.push(renderContentRow(""), renderFrameDivider("├", "┤", "─ BUILD & STARTUP OUTPUT "));
    }
    const footerRows = framed ? 3 : 2;
    this.viewportLogRows = Math.max(0, rows - header.length - footerRows);
    const log = this.pendingLine ? [...this.lines, this.pendingLine] : this.lines;
    const maxScrollback = Math.max(0, log.length - this.viewportLogRows);
    this.scrollbackLines = Math.min(this.scrollbackLines, maxScrollback);
    const end = log.length - this.scrollbackLines;
    const visibleLog = log.slice(Math.max(0, end - this.viewportLogRows), end);
    const logPadding = Array<string>(Math.max(0, this.viewportLogRows - visibleLog.length)).fill(
      "",
    );
    const following = this.scrollbackLines === 0;
    const logPosition = following
      ? "● Following live output"
      : `↑ ${this.scrollbackLines} lines back · End to follow`;
    const footer = this.theme.fg(
      "muted",
      "↑/↓ scroll · End latest · Esc return to thread (startup continues)",
    );
    const footerLines = framed
      ? [
          renderFrameDivider("├", "┤", `─ ${logPosition} `),
          renderContentRow(footer),
          renderFrameDivider("╰", "╯"),
        ]
      : [renderContentRow(this.theme.fg("dim", logPosition)), renderContentRow(footer)];
    return [
      ...header,
      ...visibleLog.map((logLine) => renderContentRow(this.theme.fg("toolOutput", logLine))),
      ...logPadding.map(() => renderContentRow("")),
      ...footerLines,
    ].slice(0, rows);
  }

  invalidate(): void {}

  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

export class SandboxStartupUI implements SandboxStartupDisplay {
  private presentationOwner?: AbortController;
  private active?: { console: SandboxStartupConsole; finish: () => void };
  private activeProgress?: SandboxStartupProgress;
  latestLogPath?: string;

  constructor(
    private readonly context: () => ExtensionContext | undefined,
    private readonly logDirectory?: () => string,
  ) {}

  async run<T>(
    title: string,
    operation: (progress: SandboxStartupProgress) => Promise<T>,
    cancellationSignal?: AbortSignal,
  ): Promise<T> {
    cancellationSignal?.throwIfAborted();
    if (this.activeProgress) {
      return operation(this.activeProgress);
    }
    const warning = (message: string) => this.context()?.ui.notify(message, "warning");
    const log = this.logDirectory
      ? await SandboxStartupLog.create(this.logDirectory(), warning)
      : undefined;
    this.latestLogPath = log?.path;
    log?.record("start", title);
    try {
      return await this.present(
        title,
        async (display) => {
          const progress: SandboxStartupProgress = {
            stage: (text) => {
              log?.record("stage", text);
              display.stage(text);
            },
            output: (text) => {
              log?.record("output", text);
              display.output(text);
            },
            diagnostic: (text) => log?.record("diagnostic", text),
          };
          this.activeProgress = progress;
          if (log) {
            display.output(`Diagnostic log: ${log.path}\n`);
          }
          try {
            const result = await operation(progress);
            log?.record("success", title);
            return result;
          } finally {
            this.activeProgress = undefined;
          }
        },
        cancellationSignal,
      );
    } catch (error) {
      log?.record("failure", String(error));
      throw error;
    } finally {
      log?.close();
    }
  }

  private async present<T>(
    title: string,
    operation: (progress: SandboxStartupProgress) => Promise<T>,
    cancellationSignal?: AbortSignal,
  ): Promise<T> {
    cancellationSignal?.throwIfAborted();
    if (this.active) {
      return operation(this.active.console);
    }
    const ctx = this.context();
    if (!ctx?.hasUI || ctx.mode !== "tui") {
      return operation(silentStartupProgress);
    }
    const owner = new AbortController();
    this.presentationOwner = owner;
    const presentationSignal = cancellationSignal
      ? AbortSignal.any([cancellationSignal, owner.signal])
      : owner.signal;
    const abortPresentation = () => {
      if (this.presentationOwner === owner) {
        this.dispose();
      }
    };
    cancellationSignal?.addEventListener("abort", abortPresentation, { once: true });
    let installed!: () => void;
    let installationFailed!: (error: unknown) => void;
    const installation = new Promise<void>((resolve, reject) => {
      installed = resolve;
      installationFailed = reject;
    });
    let interaction: Promise<void>;
    let mountedProgress: SandboxStartupProgress = silentStartupProgress;
    try {
      interaction = ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) => {
          const console = new SandboxStartupConsole(
            title,
            ctx.cwd,
            theme,
            () => tui.terminal.rows,
            () => tui.requestRender(),
          );
          if (presentationSignal.aborted) {
            console.dispose();
            done();
            return console;
          }
          mountedProgress = console;
          this.active = { console, finish: () => done() };
          return console;
        },
        {
          overlay: true,
          overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 },
          onHandle: (handle) => {
            if (presentationSignal.aborted) {
              return;
            }
            this.active?.console.attach(handle);
            installed();
          },
        },
      );
    } catch (error) {
      cancellationSignal?.removeEventListener("abort", abortPresentation);
      this.dispose();
      cancellationSignal?.throwIfAborted();
      ctx.ui.notify(`Sandbox display unavailable: ${String(error)}`, "warning");
      return operation(silentStartupProgress);
    }
    interaction.catch(installationFailed);
    let progress: SandboxStartupProgress;
    try {
      await awaitSandboxWork(installation, presentationSignal);
      progress = mountedProgress;
    } catch (error) {
      if (presentationSignal.aborted) {
        cancellationSignal?.removeEventListener("abort", abortPresentation);
        if (this.presentationOwner === owner) {
          this.dispose();
        }
        throw error;
      }
      this.dispose();
      ctx.ui.notify(`Sandbox display unavailable: ${String(error)}`, "warning");
      progress = silentStartupProgress;
    }
    try {
      cancellationSignal?.throwIfAborted();
      return await operation(progress);
    } finally {
      cancellationSignal?.removeEventListener("abort", abortPresentation);
      if (this.presentationOwner === owner) {
        this.dispose();
      }
      await awaitSandboxWork(interaction, presentationSignal).catch(() => {});
    }
  }

  async withoutScreen<T>(operation: () => Promise<T>): Promise<T> {
    const resume = this.active?.console.suspend();
    try {
      return await operation();
    } finally {
      resume?.();
    }
  }

  dispose(): void {
    this.presentationOwner?.abort(new Error("Sandbox display retired"));
    this.presentationOwner = undefined;
    const active = this.active;
    this.active = undefined;
    active?.console.dispose();
    active?.finish();
  }
}
