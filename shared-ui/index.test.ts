import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chooseMenu,
  createPanelFrame,
  afterPanelsClose,
  isPanelOpen,
  discoverSettingsSections,
  groupPluginSettings,
  openSettingsSection,
  presentPanel,
  registerSettingsSection,
  settingsFlowContext,
  type SettingsSection,
} from "./index.js";
import { fileSettingsDraft } from "./storage.js";
import * as configEditors from "./external-editor.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
};

function menuHarness(answers: Array<string | undefined>) {
  const frames: string[] = [];
  let active: any;
  let complete: ((value: unknown) => void) | undefined;
  const custom = vi.fn(
    (factory: any, options: any) =>
      new Promise((resolve) => {
        const done = (value: unknown) => {
          active = undefined;
          resolve(value);
        };
        complete = done;
        active = factory(
          { terminal: { rows: 24, columns: 120 }, requestRender() {} },
          theme,
          { matches: (data: string) => data === "\x1b", getKeys: () => ["escape"] },
          done,
        );
        options?.onHandle?.({ focus() {} });
        frames.push(active.render(120).join("\n"));
        if (answers.length) {
          queueMicrotask(() => done(answers.shift()));
        }
      }),
  );
  const ctx = {
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    modelRegistry: { getAvailable: () => [] },
    ui: { custom, notify: vi.fn() },
  } as unknown as ExtensionContext;
  return {
    ctx,
    frames,
    custom,
    active: () => active,
    finish: (value: unknown) => complete?.(value),
  };
}

function sectionFixture() {
  let saved = { enabled: true, limit: 10, untouched: "preserve" };
  const apply = vi.fn(async (value: Record<string, unknown>) => {
    saved = value as typeof saved;
  });
  const section: SettingsSection = {
    id: "fixture",
    title: "Fixture",
    description: "Scenario settings",
    effect: "Applied now",
    fields: [{ path: "enabled", label: "Enabled", kind: "boolean" }],
    load: async () => ({ value: { ...saved }, apply }),
  };
  return { section, apply, saved: () => saved };
}

it("saves an accepted field edit immediately without an Apply button", async () => {
  const fixture = sectionFixture();
  const ui = menuHarness(["field:enabled", "value:false", "back"]);
  await openSettingsSection(ui.ctx, fixture.section, new AbortController().signal);
  expect(fixture.apply).toHaveBeenCalledTimes(1);
  expect(fixture.saved()).toEqual({ enabled: false, limit: 10, untouched: "preserve" });
  expect(ui.frames.join("\n")).not.toContain("Apply changes");
  expect(ui.frames.join("\n")).not.toContain("Discard unsaved changes");
});

it("saves JSON configuration when the external editor returns without rendering its contents", async () => {
  const fixture = sectionFixture();
  fixture.section.fields = [{ path: "rules", label: "Rules", kind: "json" }];
  const rules = { included: ["private-pattern"] };
  fixture.section.load = async () => ({ value: { rules }, apply: fixture.apply });
  const editor = vi.spyOn(configEditors, "editConfigDraft").mockResolvedValue('{"included":[]}');
  const ui = menuHarness(["field:rules", "back"]);
  await openSettingsSection(ui.ctx, fixture.section, new AbortController().signal);
  const formattedRules = `{
  "included": [
    "private-pattern"
  ]
}`;
  expect(editor).toHaveBeenCalledWith(ui.ctx, "Rules", formattedRules, expect.any(AbortSignal));
  expect(ui.frames.join("\n")).not.toContain("private-pattern");
  expect(ui.frames.join("\n")).toContain("open in $EDITOR");
  expect(fixture.apply).toHaveBeenCalledExactlyOnceWith(
    { rules: { included: [] } },
    expect.any(AbortSignal),
  );
});

it("opening and leaving a section does not save defaults", async () => {
  const fixture = sectionFixture();
  const ui = menuHarness(["back"]);
  await openSettingsSection(ui.ctx, fixture.section, new AbortController().signal);
  expect(fixture.apply).not.toHaveBeenCalled();
  expect(fixture.saved().enabled).toBe(true);
});

it("later edits use the reloaded saved settings", async () => {
  const fixture = sectionFixture();
  fixture.section.fields.push({ path: "limit", label: "Limit", kind: "number" });
  const ui = menuHarness(["field:enabled", "value:false", "field:limit", "20", "back"]);
  await openSettingsSection(ui.ctx, fixture.section, new AbortController().signal);
  expect(fixture.apply).toHaveBeenNthCalledWith(
    1,
    { enabled: false, limit: 10, untouched: "preserve" },
    expect.any(AbortSignal),
  );
  expect(fixture.apply).toHaveBeenNthCalledWith(
    2,
    { enabled: false, limit: 20, untouched: "preserve" },
    expect.any(AbortSignal),
  );
});

it("runs setup actions without an Apply step", async () => {
  const fixture = sectionFixture();
  const run = vi.fn(async () => {});
  fixture.section.actions = [{ id: "setup", label: "Setup", run }];
  const ui = menuHarness(["action:setup", "back"]);
  await openSettingsSection(ui.ctx, fixture.section, new AbortController().signal);
  expect(run).toHaveBeenCalledOnce();
  expect(fixture.apply).not.toHaveBeenCalled();
});

it("cancelled fields leave their section unchanged", async () => {
  const fixture = sectionFixture();
  const ui = menuHarness(["field:enabled", undefined, "back"]);
  await openSettingsSection(ui.ctx, fixture.section, new AbortController().signal);
  expect(fixture.apply).not.toHaveBeenCalled();
});

it("a rejected edit preserves the saved value and allows another edit", async () => {
  const fixture = sectionFixture();
  fixture.apply.mockRejectedValueOnce(new Error("invalid settings"));
  const ui = menuHarness(["field:enabled", "value:false", "field:enabled", "value:false", "back"]);
  await openSettingsSection(ui.ctx, fixture.section, new AbortController().signal);
  expect(ui.ctx.ui.notify).toHaveBeenCalledWith("invalid settings", "error");
  expect(fixture.apply).toHaveBeenCalledTimes(2);
  expect(fixture.saved().enabled).toBe(false);
});

it("never renders the existing credential value in the settings menu or replacement editor", async () => {
  const fixture = sectionFixture();
  const secret = "private-api-token";
  fixture.section.fields = [
    { path: "credential", label: "Credential", kind: "string", secret: true },
  ];
  fixture.section.load = async () => ({ value: { credential: secret }, apply: fixture.apply });
  const editor = vi.spyOn(configEditors, "editConfigDraft").mockResolvedValue(undefined);
  const ui = menuHarness(["field:credential", "replace", "back"]);
  await openSettingsSection(ui.ctx, fixture.section, new AbortController().signal);
  expect(ui.frames.join("\n")).not.toContain(secret);
  expect(editor).toHaveBeenCalledWith(
    ui.ctx,
    "Credential — replacement",
    "",
    expect.any(AbortSignal),
  );
  expect(fixture.apply).not.toHaveBeenCalled();
});

it("requires an idle interactive session before loading a settings section", async () => {
  const fixture = sectionFixture();
  const ui = menuHarness([]);
  ui.ctx.isIdle = () => false;
  await expect(
    openSettingsSection(ui.ctx, fixture.section, new AbortController().signal),
  ).rejects.toThrow("idle interactive");
  expect(ui.custom).not.toHaveBeenCalled();
});

it("selects menu entries with keyboard navigation", async () => {
  const ui = menuHarness([]);
  const pending = chooseMenu(
    ui.ctx,
    "Choose",
    [
      { id: "one", label: "One" },
      { id: "two", label: "Two" },
    ],
    new AbortController().signal,
  );
  await Promise.resolve();
  ui.active().handleInput("\x1b[B");
  ui.active().handleInput("\r");
  expect(await pending).toBe("two");
});

it("selects an entry by clicking its row inside the frame", async () => {
  const ui = menuHarness([]);
  const pending = chooseMenu(
    ui.ctx,
    "Choose",
    [
      { id: "one", label: "One" },
      { id: "two", label: "Two" },
    ],
    new AbortController().signal,
  );
  const row = { button: "left", x: 3, y: 2 };
  ui.active().handleMouse({ ...row, type: "press" });
  ui.active().handleMouse({ ...row, type: "click" });
  expect(await pending).toBe("two");
});

it("closes a cancelled deferred overlay only after its own handle mounts", async () => {
  let options: any;
  let done: any;
  const ctx = {
    ui: {
      custom: (factory: any, next: any) => {
        options = next;
        return new Promise((resolve) => {
          done = vi.fn(resolve);
          factory({}, theme, {}, done);
        });
      },
    },
  } as unknown as ExtensionContext;
  const controller = new AbortController();
  const panel = presentPanel<void>(ctx, () => ({ render: () => [], invalidate() {} }), {
    signal: controller.signal,
  });
  await Promise.resolve();
  controller.abort();
  expect(done).not.toHaveBeenCalled();
  options.onHandle({ focus() {} });
  await panel.result;
  expect(done).toHaveBeenCalledTimes(1);
});

it("uses the PR frame's opaque padded rows with bounded Unicode widths", () => {
  for (const width of [8, 28, 120]) {
    const frame = createPanelFrame(theme, width);
    expect(visibleWidth(frame.line("λ界"))).toBe(width);
    expect(visibleWidth(frame.rule("╭", "╮", "─ Settings "))).toBe(width);
  }
});

it("discovers sections across independent subscribers and supports unsubscribe", () => {
  const handlers = new Set<(value: unknown) => void>();
  const pi = {
    events: {
      on(_channel: string, handler: (value: unknown) => void) {
        handlers.add(handler);
        return () => {
          handlers.delete(handler);
        };
      },
      emit(_channel: string, value: unknown) {
        for (const handler of handlers) {
          handler(value);
        }
      },
    },
  };
  const fixture = sectionFixture();
  const retire = registerSettingsSection(pi, fixture.section);
  expect(discoverSettingsSections(pi).map((section) => section.id)).toEqual(["fixture"]);
  retire();
  expect(discoverSettingsSections(pi)).toEqual([]);
});

it("defers sidebar cleanup until its foreground panel completes", async () => {
  const ui = menuHarness([]);
  const cleanup = vi.fn();
  const panel = presentPanel<void>(ui.ctx, () => ({ render: () => [], invalidate() {} }));
  afterPanelsClose(ui.ctx, cleanup);
  expect(isPanelOpen(ui.ctx)).toBe(true);
  expect(cleanup).not.toHaveBeenCalled();
  panel.close();
  await panel.result;
  expect(isPanelOpen(ui.ctx)).toBe(false);
  expect(cleanup).toHaveBeenCalledTimes(1);
});

it("shares foreground panel ownership across same-session contexts and nested settings wrappers", async () => {
  const ui = menuHarness([]);
  const otherContext = { ...ui.ctx, ui: { ...ui.ctx.ui } };
  const sessionManager = {} as ExtensionContext["sessionManager"];
  ui.ctx.sessionManager = sessionManager;
  otherContext.sessionManager = sessionManager;
  const wrapped = settingsFlowContext(
    settingsFlowContext(ui.ctx, new AbortController().signal),
    new AbortController().signal,
  );
  const panel = presentPanel<void>(wrapped, () => ({ render: () => [], invalidate() {} }));
  const cleanup = vi.fn();
  afterPanelsClose(otherContext, cleanup);
  expect(isPanelOpen(ui.ctx)).toBe(true);
  expect(cleanup).not.toHaveBeenCalled();
  panel.close();
  await panel.result;
  expect(cleanup).toHaveBeenCalledOnce();
});

it("closes a framed dialog when its nested workflow aborts without cancelling the settings owner", async () => {
  const ui = menuHarness([]);
  const settings = new AbortController();
  const workflow = new AbortController();
  const wrapped = settingsFlowContext(ui.ctx, settings.signal);
  const dialog = wrapped.ui.select("Workflow", ["Continue"], { signal: workflow.signal });
  workflow.abort();
  await expect(dialog).rejects.toThrow();
  expect(ui.active()).toBeUndefined();
  expect(settings.signal.aborted).toBe(false);
});

it("accepting a displayed default publishes a missing settings file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settings-defaults-"));
  directories.push(directory);
  const path = join(directory, "config.json");
  const fixture = sectionFixture();
  fixture.section.load = () => fileSettingsDraft(path, () => {}, { enabled: true });
  const ui = menuHarness(["field:enabled", "value:true", "back"]);
  await openSettingsSection(ui.ctx, fixture.section, new AbortController().signal);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ enabled: true });
});

it("only one of two concurrent settings drafts can publish the same revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settings-conflict-"));
  directories.push(directory);
  const path = join(directory, "config.json");
  await writeFile(path, '{"enabled":true,"credential":"preserve"}');
  const first = await fileSettingsDraft(path);
  const second = await fileSettingsDraft(path);
  const results = await Promise.allSettled([
    first.apply({ ...first.value, enabled: false }),
    second.apply({ ...second.value, limit: 5 }),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  expect(JSON.parse(await readFile(path, "utf8")).credential).toBe("preserve");
});

it("saves a grouped field as soon as its edit is accepted", async () => {
  const fixture = sectionFixture();
  fixture.section.fields[0]!.group = "Advanced";
  const ui = menuHarness(["group:Advanced", "enabled", "value:false", "back"]);
  await openSettingsSection(ui.ctx, fixture.section, new AbortController().signal);
  expect(fixture.saved().enabled).toBe(false);
  expect(fixture.apply).toHaveBeenCalledTimes(1);
});

it("cancellation closes field editing without publishing the section draft", async () => {
  const fixture = sectionFixture();
  const ui = menuHarness([]);
  const controller = new AbortController();
  const pending = openSettingsSection(ui.ctx, fixture.section, controller.signal);
  await vi.waitFor(() => expect(ui.active()).toBeDefined());
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(fixture.apply).not.toHaveBeenCalled();
});

it("groups plugin-owned sections into one root without loading or changing their drafts", () => {
  const fixture = sectionFixture();
  const plugin = { id: "sandbox", title: "Sandbox", description: "Container configuration" };
  const sections = [
    { ...fixture.section, id: "sandbox", title: "General", plugin },
    { ...fixture.section, id: "host-commands", title: "Host Commands", plugin },
    { ...fixture.section, id: "observer", title: "Progress Observer" },
  ];
  const roots = groupPluginSettings(sections);
  expect(roots.map((root) => root.id)).toEqual(["sandbox", "observer"]);
  expect(roots[0]?.children?.map((child) => child.id)).toEqual(["sandbox", "host-commands"]);
  expect(sections[0]).not.toHaveProperty("children");
  expect(fixture.apply).not.toHaveBeenCalled();
});

it("returns from a plugin submenu without loading its root as editable settings", async () => {
  const fixture = sectionFixture();
  const plugin = { id: "sandbox", title: "Sandbox", description: "Settings" };
  const sections = [{ ...fixture.section, plugin }];
  const root = groupPluginSettings(sections)[0]!;
  const ui = menuHarness(["fixture", "back", "back"]);
  await openSettingsSection(ui.ctx, root, new AbortController().signal);
  expect(ui.frames[0]).toContain("Sandbox");
  expect(ui.frames[0]).not.toContain("Apply changes");
  expect(fixture.apply).not.toHaveBeenCalled();
});

it("preserves unrelated config keys and refuses stale file drafts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-settings-"));
  directories.push(directory);
  const path = join(directory, "config.json");
  await mkdir(directory, { recursive: true });
  await writeFile(path, '{"enabled":true,"credential":"keep"}');
  const first = await fileSettingsDraft(path);
  const stale = await fileSettingsDraft(path);
  await first.apply({ ...first.value, enabled: false });
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ enabled: false, credential: "keep" });
  await expect(stale.apply({ enabled: true })).rejects.toThrow("changed outside");
});
