import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  TuiAltScreen,
  visibleWidth,
  type Component,
  type OverlayHandle,
} from "@earendil-works/pi-tui";
import { afterEach, expect, it, vi } from "vitest";
import { SandboxStartupConsole, SandboxStartupUI } from "../src/sandbox/startup-ui.ts";

const plainTheme = { fg: (_color: string, text: string) => text } as Pick<Theme, "fg">;
afterEach(() => {
  vi.useRealTimers();
});

function consoleFixture(width = 80, rows = 16) {
  const render = vi.fn();
  const setHidden = vi.fn();
  const console = new SandboxStartupConsole(
    "Starting devcontainer",
    "/projects/開発 🚀",
    plainTheme,
    () => rows,
    render,
  );
  console.attach({ setHidden } as unknown as OverlayHandle);
  return { console, render, setHidden, lines: () => console.render(width) };
}

it("animates the spinner and elapsed clock without requiring progress output", () => {
  vi.useFakeTimers();
  const fixture = consoleFixture();
  expect(fixture.lines()[0]).toContain("DEVCONTAINER");
  expect(fixture.lines()[1]).toMatch(/⠋ Starting devcontainer\s+00:00/);
  vi.advanceTimersByTime(100);
  expect(fixture.lines()[1]).toContain("⠙ Starting devcontainer");
  vi.advanceTimersByTime(65_000);
  expect(fixture.lines()[1]).toContain("01:05");
  expect(fixture.render).toHaveBeenCalled();
  fixture.console.dispose();
  fixture.render.mockClear();
  vi.advanceTimersByTime(500);
  expect(fixture.render).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("frames current and previous stages above the live output without fabricating completion percentages", () => {
  const fixture = consoleFixture(80, 24);
  try {
    fixture.console.stage("Resolving definition");
    fixture.console.stage("Building tool image");
    fixture.console.output("layer downloaded\n");
    const rendered = fixture.lines();
    expect(rendered[0]).toMatch(/^╭─ DEVCONTAINER /);
    expect(rendered.at(-1)).toMatch(/^╰─+╯$/);
    expect(rendered.join("\n")).toContain("CURRENT STAGE");
    expect(rendered.join("\n")).toContain("› Building tool image");
    expect(rendered.join("\n")).toContain("✓ Resolving definition");
    expect(rendered.join("\n")).toContain("BUILD & STARTUP OUTPUT");
    expect(rendered.join("\n")).toContain("Following live output");
    expect(rendered.join("\n")).toContain("layer downloaded");
  } finally {
    fixture.console.dispose();
  }
});

it.each([
  { width: 0, rows: 1 },
  { width: 1, rows: 2 },
  { width: 12, rows: 6 },
  { width: 80, rows: 24 },
])("fills a $width-column by $rows-row screen without overflow", ({ width, rows }) => {
  const fixture = consoleFixture(width, rows);
  try {
    fixture.console.stage("Pulling 開発 image 🚀…");
    fixture.console.output("A very long log line ".repeat(100));
    const lines = fixture.lines();
    expect(lines).toHaveLength(rows);
    expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
  } finally {
    fixture.console.dispose();
  }
});

function rendererFixture(columns: number, rows: number) {
  vi.useFakeTimers();
  let input!: (data: string) => void;
  const terminal = {
    columns,
    rows,
    write: vi.fn(),
    start: vi.fn((onInput: (data: string) => void) => {
      input = onInput;
    }),
    stop: vi.fn(),
    hideCursor: vi.fn(),
    showCursor: vi.fn(),
  };
  const renderer = new TuiAltScreen(terminal as never);
  const threadInput = vi.fn();
  renderer.setLayoutRoot({
    render: () => ["conversation thread"],
    handleInput: threadInput,
    invalidate() {},
  });
  const console = new SandboxStartupConsole(
    "Starting devcontainer",
    "/project",
    plainTheme,
    () => terminal.rows,
    () => renderer.requestRender(),
  );
  renderer.start();
  const handle = renderer.showOverlay(console, {
    anchor: "top-left",
    width: "100%",
    maxHeight: "100%",
    margin: 0,
  });
  console.attach(handle);
  renderer.renderNow(true);
  return {
    renderer,
    terminal,
    console,
    handle,
    input: (data: string) => input(data),
    dispose() {
      console.dispose();
      handle.hide();
      renderer.stop();
    },
  };
}

it("renders the startup console fullscreen and resizes it with the terminal", () => {
  const fixture = rendererFixture(80, 16);
  try {
    expect(fixture.handle.getBounds()).toEqual({ row: 0, col: 0, width: 80, height: 16 });
    expect(fixture.handle.isFocused()).toBe(true);
    expect(fixture.terminal.write.mock.calls.map(([text]) => text).join("")).toContain(
      "Starting devcontainer",
    );
    fixture.terminal.columns = 28;
    fixture.terminal.rows = 10;
    fixture.renderer.renderNow(true);
    expect(fixture.handle.getBounds()).toEqual({ row: 0, col: 0, width: 28, height: 10 });
  } finally {
    fixture.dispose();
  }
});

it("yields real renderer focus to an approval and recaptures it when the approval finishes", () => {
  const fixture = rendererFixture(80, 16);
  try {
    const resume = fixture.console.suspend();
    expect(fixture.handle.isHidden()).toBe(true);
    const approvalInput = vi.fn();
    const approval = {
      render: () => ["Approve replacement?"],
      handleInput: approvalInput,
      invalidate() {},
    };
    fixture.renderer.setFocus(approval);
    fixture.input("y");
    expect(approvalInput).toHaveBeenCalledWith("y");
    resume();
    expect(fixture.handle.isFocused()).toBe(true);
  } finally {
    fixture.dispose();
  }
});

it("dismisses the real startup overlay when Esc is pressed", () => {
  const fixture = rendererFixture(80, 16);
  try {
    fixture.input("\x1b");
    expect(fixture.handle.isHidden()).toBe(true);
  } finally {
    fixture.dispose();
  }
});

it("assembles chunked output, removes terminal controls, and keeps a bounded live tail", () => {
  const fixture = consoleFixture();
  try {
    fixture.console.output("Pulling lay");
    fixture.console.output("er\n\x1b[31mChecking image\x1b[0m\rStarting hooks\n");
    const log = fixture.lines().join("\n");
    expect(log).toContain("Pulling layer");
    expect(log).toContain("Checking image");
    expect(log).toContain("Starting hooks");
    expect(log).not.toContain("\x1b");
    fixture.console.output(Array.from({ length: 400 }, (_, index) => `layer-${index}\n`).join(""));
    expect(fixture.lines().join("\n")).toContain("layer-399");
    expect(fixture.lines().join("\n")).not.toContain("layer-0 ");
    fixture.console.handleInput("\x1b[5~");
    expect(fixture.lines().join("\n")).not.toContain("layer-399");
    fixture.console.handleInput("\x1b[F");
    expect(fixture.lines().join("\n")).toContain("layer-399");
  } finally {
    fixture.console.dispose();
  }
});

it("steps aside for nested approvals and preserves an Esc dismissal when they finish", () => {
  vi.useFakeTimers();
  const fixture = consoleFixture();
  const resumeOuter = fixture.console.suspend();
  const resumeInner = fixture.console.suspend();
  expect(fixture.setHidden).toHaveBeenLastCalledWith(true);
  expect(vi.getTimerCount()).toBe(0);
  resumeInner();
  expect(fixture.setHidden).toHaveBeenLastCalledWith(true);
  resumeOuter();
  expect(fixture.setHidden).toHaveBeenLastCalledWith(false);
  expect(vi.getTimerCount()).toBe(1);
  fixture.console.handleInput("\x1b");
  const resumeApproval = fixture.console.suspend();
  resumeApproval();
  resumeApproval();
  expect(fixture.setHidden).toHaveBeenLastCalledWith(true);
  expect(vi.getTimerCount()).toBe(0);
  fixture.console.dispose();
});

function uiFixture(mode: "tui" | "rpc" | "print" = "tui") {
  let component: Component & { dispose?(): void };
  const setHidden = vi.fn();
  const finish = vi.fn();
  type CustomUI = ExtensionContext["ui"]["custom"];
  const custom = vi.fn(
    (factory: Parameters<CustomUI>[0], options?: Parameters<CustomUI>[1]) =>
      new Promise<unknown>((resolve, reject) => {
        Promise.resolve(
          factory(
            { terminal: { rows: 20 }, requestRender: vi.fn() } as never,
            plainTheme as Theme,
            {} as never,
            (value) => {
              finish();
              component?.dispose?.();
              resolve(value);
            },
          ),
        )
          .then((created) => {
            component = created;
            options?.onHandle?.({ setHidden } as unknown as OverlayHandle);
          })
          .catch(reject);
      }),
  );
  const ctx = { mode, hasUI: mode !== "print", cwd: "/project", ui: { custom } };
  const ui = new SandboxStartupUI(() => ctx as unknown as ExtensionContext);
  return { ui, custom, finish, setHidden, component: () => component };
}

it("keeps one full-screen interaction through nested startup operations and closes it on success", async () => {
  const fixture = uiFixture();
  await expect(
    fixture.ui.run("Starting devcontainer", async (progress) => {
      progress.stage("Pulling image");
      expect(fixture.component().render(80).join("\n")).toContain("Pulling image");
      return fixture.ui.run("Updating mounts", async (nestedProgress) => {
        expect(nestedProgress).toBe(progress);
        return "ready";
      });
    }),
  ).resolves.toBe("ready");
  expect(fixture.custom).toHaveBeenCalledTimes(1);
  expect(fixture.custom).toHaveBeenCalledWith(
    expect.any(Function),
    expect.objectContaining({
      overlay: true,
      overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 },
    }),
  );
  expect(fixture.finish).toHaveBeenCalledTimes(1);
});

it("continues approved work exactly once when the progress UI rejects installation", async () => {
  const operation = vi.fn(async () => "ready");
  const notify = vi.fn();
  const rejectProgressUIInstallation = vi.fn(async () => {
    throw new Error("UI unavailable");
  });
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: "/project",
    ui: { custom: rejectProgressUIInstallation, notify },
  };
  const ui = new SandboxStartupUI(() => ctx as unknown as ExtensionContext);
  expect(await ui.run("Starting", operation)).toBe("ready");
  expect(operation).toHaveBeenCalledOnce();
  expect(notify).toHaveBeenCalledOnce();
});

it("cancels pending overlay installation without running startup or reviving a late presenter", async () => {
  type CustomUI = ExtensionContext["ui"]["custom"];
  let mount!: () => void;
  const completed = vi.fn();
  const custom = vi.fn(
    (factory: Parameters<CustomUI>[0], options?: Parameters<CustomUI>[1]) =>
      new Promise<void>((resolve) => {
        const finishInstallation = () => {
          completed();
          resolve();
        };
        mount = () => {
          factory(
            { terminal: { rows: 20 }, requestRender: vi.fn() } as never,
            plainTheme as Theme,
            {} as never,
            finishInstallation,
          );
          options?.onHandle?.({ setHidden: vi.fn() } as unknown as OverlayHandle);
        };
      }),
  );
  const ui = new SandboxStartupUI(
    () =>
      ({
        mode: "tui",
        hasUI: true,
        cwd: "/project",
        ui: { custom, notify: vi.fn() },
      }) as unknown as ExtensionContext,
  );
  const operation = vi.fn(async () => "ready");
  const cancellation = new AbortController();
  const pending = ui.run("Starting", operation, cancellation.signal);
  const rejected = expect(pending).rejects.toThrow("Cancelled startup");
  cancellation.abort(new Error("Cancelled startup"));
  await rejected;
  mount();
  expect(completed).toHaveBeenCalledOnce();
  expect(operation).not.toHaveBeenCalled();
});

it("restores the progress screen after approval and cleans up when startup fails", async () => {
  const fixture = uiFixture();
  await expect(
    fixture.ui.run("Rebuilding devcontainer", async () => {
      await fixture.ui.withoutScreen(async () => {
        expect(fixture.setHidden).toHaveBeenLastCalledWith(true);
      });
      expect(fixture.setHidden).toHaveBeenLastCalledWith(false);
      throw new Error("Image build failed");
    }),
  ).rejects.toThrow("Image build failed");
  expect(fixture.finish).toHaveBeenCalledTimes(1);
  await fixture.ui.run("Starting devcontainer", async () => "ready");
  expect(fixture.custom).toHaveBeenCalledTimes(2);
  expect(fixture.finish).toHaveBeenCalledTimes(2);
});

it("releases the startup interaction and timer during session shutdown", async () => {
  vi.useFakeTimers();
  const fixture = uiFixture();
  let finishStartup!: () => void;
  let started!: () => void;
  const startupStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = fixture.ui.run("Starting devcontainer", async () => {
    started();
    await new Promise<void>((resolve) => {
      finishStartup = resolve;
    });
  });
  await startupStarted;
  expect(vi.getTimerCount()).toBe(1);
  fixture.ui.dispose();
  fixture.ui.dispose();
  expect(fixture.finish).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  finishStartup();
  await pending;
  expect(fixture.finish).toHaveBeenCalledTimes(1);
});

it.each(["rpc", "print"] as const)("runs startup without custom UI in %s mode", async (mode) => {
  const fixture = uiFixture(mode);
  await expect(
    fixture.ui.run("Starting devcontainer", async (progress) => {
      progress.stage("Starting");
      progress.output("output");
      return "ready";
    }),
  ).resolves.toBe("ready");
  expect(fixture.custom).not.toHaveBeenCalled();
});
