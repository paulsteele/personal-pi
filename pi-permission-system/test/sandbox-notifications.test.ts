import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import sandboxExtension from "../src/sandbox-extension.ts";
import desktopNotifications from "../../desktop-notifications/index.ts";
import { decodeArgument } from "../../desktop-notifications/core.ts";

const nativeCalls = vi.hoisted(() => ({
  sent: [] as string[],
  cleared: 0,
  terminalMarker: "",
  finishResolution: undefined as (() => void) | undefined,
  delayResolution: false,
}));

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn(command: string, args: string[]) {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      killed: false,
      kill: vi.fn(),
    });
    const finish = (output: unknown) => {
      child.stdout.write(JSON.stringify(output));
      child.emit("close", 0);
    };
    queueMicrotask(() => {
      if (command === "hyprctl") {
        if (args[0] === "clients") {
          const resolveWindow = () =>
            finish([
              {
                address: "0x123",
                title: nativeCalls.terminalMarker,
                class: "Alacritty",
              },
            ]);
          if (nativeCalls.delayResolution) {
            nativeCalls.finishResolution = resolveWindow;
          } else {
            resolveWindow();
          }
        } else {
          finish({ address: "0x456" });
        }
        return;
      }
      if (command === "dunstify") {
        if (args[0] === "--close") {
          nativeCalls.cleared++;
          finish({});
        } else {
          nativeCalls.sent.push(args.slice(-2).join("\n"));
          child.stdout.write("17\n");
        }
        return;
      }
      const expression = args[1]!;
      if (expression.includes("piNotify.resolve")) {
        const resolveWindow = () => finish({ ok: true, windowId: 123 });
        if (nativeCalls.delayResolution) {
          nativeCalls.finishResolution = resolveWindow;
        } else {
          resolveWindow();
        }
      } else if (expression.includes("piNotify.send")) {
        const encodedFields = [...expression.matchAll(/'([^']*)'/g)].map((match) => match[1]!);
        nativeCalls.sent.push(
          encodedFields
            .slice(-3)
            .map((value) => decodeArgument(value))
            .join("\n"),
        );
        finish({ ok: true });
      } else if (expression.includes("piNotify.clear")) {
        nativeCalls.cleared++;
        finish({ ok: true });
      } else {
        finish({ ok: true, focused: false });
      }
    });
    return child;
  },
}));

vi.mock("node:net", () => ({
  createConnection: () => Object.assign(new EventEmitter(), { destroy: vi.fn() }),
}));

vi.mock("../src/sandbox/definition.ts", async (original) => ({
  ...(await original<typeof import("../src/sandbox/definition.ts")>()),
  selectDefinition: async () => ({ path: "/fixture/devcontainer.json" }),
}));

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  nativeCalls.sent.length = 0;
  nativeCalls.cleared = 0;
  nativeCalls.delayResolution = false;
  nativeCalls.finishResolution = undefined;
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function sandboxNotificationFixture(delayResolution = false) {
  const agentDir = await mkdtemp(join(tmpdir(), "sandbox-notifications-"));
  directories.push(agentDir);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("HYPRLAND_INSTANCE_SIGNATURE", "fixture");
  nativeCalls.delayResolution = delayResolution;
  const bus = new EventEmitter();
  const permissionEvents: Array<{
    eventName: string;
    data: { requestId: string; surface: string };
  }> = [];
  const lifecycleHandlers = new Map<
    string,
    Array<(lifecycleEvent: unknown, context: unknown) => Promise<unknown>>
  >();
  const pi = {
    events: {
      on(channel: string, handler: (data: unknown) => void) {
        bus.on(channel, handler);
        return () => {
          bus.off(channel, handler);
        };
      },
      emit(eventName: string, data: { requestId: string; surface: string }) {
        if (eventName.startsWith("permissions:")) {
          permissionEvents.push({ eventName, data });
        }
        bus.emit(eventName, data);
      },
    },
    on(
      eventName: string,
      handler: (lifecycleEvent: unknown, context: unknown) => Promise<unknown>,
    ) {
      lifecycleHandlers.set(eventName, [...(lifecycleHandlers.get(eventName) ?? []), handler]);
    },
    registerTool() {},
    registerCommand() {},
    registerEntryRenderer() {},
  };
  let dismissPermission: ((choice?: string) => void) | undefined;
  const ui = {
    notify() {},
    setStatus() {},
    setTitle(title: string) {
      nativeCalls.terminalMarker = title;
    },
    select: vi.fn(
      (_title: string) =>
        new Promise<string | undefined>((resolve) => {
          dismissPermission = resolve;
        }),
    ),
  };
  const context = {
    cwd: agentDir,
    hasUI: true,
    mode: "rpc",
    sessionManager: { getSessionId: () => "session", getBranch: () => [] },
    ui,
  };
  desktopNotifications(pi as never);
  sandboxExtension(pi as never);
  const [startNotifier, startSandbox] = lifecycleHandlers.get("session_start")!;
  return {
    permissionEvents,
    bus,
    ui,
    startNotifier: () => startNotifier!({}, { ...context, mode: "tui" }),
    startSandbox: () => startSandbox!({}, context),
    dismissPermission: () => {
      dismissPermission!();
    },
    shutdown: async () => {
      for (const handler of lifecycleHandlers.get("session_shutdown") ?? []) {
        await handler({}, context);
      }
    },
  };
}

it.each(["before notifier startup", "during terminal resolution", "after notifier startup"])(
  "notifies a real sandbox provisioning request %s and clears its matching decision",
  async (timing) => {
    const fixture = await sandboxNotificationFixture(timing === "during terminal resolution");
    try {
      let notifierStartup: Promise<unknown> | undefined;
      if (timing !== "before notifier startup") {
        notifierStartup = fixture.startNotifier();
        if (timing === "during terminal resolution") {
          await vi.waitFor(() => expect(nativeCalls.finishResolution).toBeTypeOf("function"));
        } else {
          await notifierStartup;
        }
      }
      const sandboxStartup = fixture.startSandbox();
      await vi.waitFor(() => expect(fixture.ui.select).toHaveBeenCalledOnce());
      const prompt = fixture.permissionEvents.find(
        (event) => event.eventName === "permissions:ui_prompt",
      )!;
      expect(prompt.data.surface).toBe("sandbox");
      expect(fixture.ui.select.mock.calls[0]![0]).toContain("Sandbox authorization");
      if (timing !== "after notifier startup") {
        expect(nativeCalls.sent).toEqual([]);
      }
      if (timing === "before notifier startup") {
        await fixture.startNotifier();
      } else if (timing === "during terminal resolution") {
        nativeCalls.finishResolution!();
        await notifierStartup;
      }
      await vi.waitFor(() => expect(nativeCalls.sent).toHaveLength(1));
      expect(nativeCalls.sent[0]).toContain("Permission needed: sandbox");
      expect(nativeCalls.sent[0]).toContain("Provision the shared development toolset?");
      fixture.bus.emit("permissions:decision", { requestId: "unrelated" });
      expect(nativeCalls.cleared).toBe(0);
      fixture.dismissPermission();
      await sandboxStartup;
      const decision = fixture.permissionEvents.find(
        (event) => event.eventName === "permissions:decision",
      )!;
      expect(decision.data.requestId).toBe(prompt.data.requestId);
      await vi.waitFor(() => expect(nativeCalls.cleared).toBe(1));
    } finally {
      await fixture.shutdown();
    }
  },
);

it("does not notify a sandbox request dismissed before terminal resolution finishes", async () => {
  const fixture = await sandboxNotificationFixture(true);
  try {
    const notifierStartup = fixture.startNotifier();
    await vi.waitFor(() => expect(nativeCalls.finishResolution).toBeTypeOf("function"));
    const sandboxStartup = fixture.startSandbox();
    await vi.waitFor(() => expect(fixture.ui.select).toHaveBeenCalledOnce());
    fixture.dismissPermission();
    await sandboxStartup;
    nativeCalls.finishResolution!();
    await notifierStartup;
    expect(nativeCalls.sent).toEqual([]);
    expect(fixture.bus.listenerCount("permissions:ui_prompt")).toBe(1);
    await fixture.shutdown();
    expect(fixture.bus.listenerCount("permissions:ui_prompt")).toBe(0);
    expect(fixture.bus.listenerCount("permissions:decision")).toBe(0);
  } finally {
    await fixture.shutdown();
  }
});
