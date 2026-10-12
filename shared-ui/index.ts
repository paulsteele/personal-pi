import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  Input,
  SelectList,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type OverlayHandle,
} from "@earendil-works/pi-tui";

export interface PanelTheme {
  fg(
    color: "accent" | "muted" | "text" | "success" | "warning" | "error" | "borderAccent",
    text: string,
  ): string;
  bg(color: "customMessageBg" | "selectedBg", text: string): string;
}

export function createPanelFrame(theme: PanelTheme, width: number) {
  const innerWidth = Math.max(0, width - 2);
  const contentWidth = Math.max(0, width - 4);
  const paint = (value: string, selected = false) =>
    value
      .split("\x1b[0m")
      .map((part) => theme.bg(selected ? "selectedBg" : "customMessageBg", theme.fg("text", part)))
      .join("\x1b[0m");
  const line = (value: string, selected = false) => {
    const truncatedValue = truncateToWidth(value, contentWidth, "…", true);
    const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(truncatedValue)));
    return (
      paint(theme.fg("borderAccent", "│")) +
      paint(` ${truncatedValue}${padding} `, selected) +
      paint(theme.fg("borderAccent", "│"))
    );
  };
  const rule = (left: string, right: string, title = "") => {
    const label = truncateToWidth(title, innerWidth, "…");
    return paint(
      theme.fg(
        "borderAccent",
        `${left}${label}${"─".repeat(Math.max(0, innerWidth - visibleWidth(label)))}${right}`,
      ),
    );
  };
  return { contentWidth, paint, line, rule };
}

type CustomPanelCallback = Parameters<ExtensionContext["ui"]["custom"]>[0];
type CustomPanelArguments = Parameters<CustomPanelCallback>;

type PanelFactory<T> = (
  tui: CustomPanelArguments[0],
  theme: CustomPanelArguments[1],
  keys: CustomPanelArguments[2],
  done: (result: T) => void,
) => Component & { dispose?(): void };

const panelContexts = new WeakMap<object, number>();
const deferredPanelCleanup = new WeakMap<object, Array<() => void>>();
const panelOwner = (ctx: ExtensionContext): object => ctx.sessionManager ?? ctx.ui;
const setupActionOwners = new WeakMap<object, number>();

export function isSettingsActionActive(ctx: ExtensionContext): boolean {
  return (setupActionOwners.get(panelOwner(ctx)) ?? 0) > 0;
}

export function afterPanelsClose(ctx: ExtensionContext, cleanup: () => void): void {
  if (!isPanelOpen(ctx)) {
    cleanup();
    return;
  }
  const owner = panelOwner(ctx);
  const callbacks = deferredPanelCleanup.get(owner) ?? [];
  callbacks.push(cleanup);
  deferredPanelCleanup.set(owner, callbacks);
}

export function isPanelOpen(ctx: ExtensionContext): boolean {
  return (panelContexts.get(panelOwner(ctx)) ?? 0) > 0;
}

export function presentPanel<T>(
  ctx: ExtensionContext,
  factory: PanelFactory<T>,
  options: {
    signal?: AbortSignal;
    visible?: () => boolean;
    onRenderReady?: () => void;
    width?: number;
  } = {},
): { result: Promise<T>; close(): void } {
  let handle: OverlayHandle | undefined;
  let finish: (() => void) | undefined;
  let closing = false;
  let finished = false;
  const shouldShow = () => !options.signal?.aborted && options.visible?.() !== false;
  const close = () => {
    closing = true;
    if (handle && finish) {
      if (shouldShow()) {
        handle.focus();
      }
      finish();
    }
  };
  options.signal?.throwIfAborted();
  options.signal?.addEventListener("abort", close, { once: true });
  const owner = panelOwner(ctx);
  panelContexts.set(owner, (panelContexts.get(owner) ?? 0) + 1);
  const createPanel = () =>
    ctx.ui.custom<T>(
      (tui, theme, keys, done) => {
        const complete = (value: T) => {
          if (finished) {
            return;
          }
          finished = true;
          done(value);
        };
        finish = () => complete(undefined as T);
        return factory(tui, theme, keys, complete);
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: options.width ?? 120,
          maxHeight: "100%",
          margin: 1,
          visible: shouldShow,
        },
        onHandle(value) {
          handle = value;
          if (closing) {
            close();
          } else {
            options.onRenderReady?.();
          }
        },
      },
    );
  const immediatePanelResult = new Promise<T>((resolve) => resolve(createPanel()));
  const result = immediatePanelResult.finally(() => {
    panelContexts.set(owner, Math.max(0, (panelContexts.get(owner) ?? 1) - 1));
    options.signal?.removeEventListener("abort", close);
    if (!isPanelOpen(ctx)) {
      const callbacks = deferredPanelCleanup.get(owner) ?? [];
      deferredPanelCleanup.delete(owner);
      for (const cleanup of callbacks) {
        cleanup();
      }
    }
  });
  return { result, close };
}

export interface MenuItem {
  id: string;
  label: string;
  description?: string | undefined;
}

export async function chooseMenu(
  ctx: ExtensionContext,
  title: string,
  items: MenuItem[],
  signal: AbortSignal,
): Promise<string | undefined> {
  const panel = presentPanel<string | undefined>(
    ctx,
    (tui, theme, _keys, done) => {
      const list = new SelectList(
        items.map((item) => ({
          value: item.id,
          label: item.label,
          ...(item.description ? { description: item.description } : {}),
        })),
        Math.max(1, Math.min(items.length, tui.terminal.rows - 10)),
        {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("text", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("muted", text),
          noMatch: (text) => theme.fg("warning", text),
        },
      );
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(undefined);
      return {
        render(width: number) {
          const frame = createPanelFrame(theme, width);
          return [
            frame.rule("╭", "╮", `─ ${title} `),
            ...list.render(frame.contentWidth).map((row) => frame.line(row)),
            frame.rule("├", "┤"),
            frame.line("↑↓ select · Enter open · Esc back"),
            frame.rule("╰", "╯"),
          ];
        },
        invalidate() {
          list.invalidate();
        },
        handleInput(data: string) {
          list.handleInput(data);
          tui.requestRender();
        },
        handleMouse(event: Parameters<SelectList["handleMouse"]>[0]) {
          if (event.y < 1 || event.x < 2) {
            return;
          }
          return list.handleMouse({ ...event, x: event.x - 2, y: event.y - 1 });
        },
      } as Component;
    },
    { signal },
  );
  const selected = await panel.result;
  signal.throwIfAborted();
  return selected;
}

export async function inputPanel(
  ctx: ExtensionContext,
  title: string,
  value: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const panel = presentPanel<string | undefined>(
    ctx,
    (tui, theme, _keys, done) => {
      const input = new Input();
      input.setValue(value);
      input.onSubmit = (text) => done(text);
      input.onEscape = () => done(undefined);
      return {
        get focused() {
          return input.focused;
        },
        set focused(value: boolean) {
          input.focused = value;
        },
        render(width: number) {
          const frame = createPanelFrame(theme, width);
          return [
            frame.rule("╭", "╮", `─ ${title} `),
            ...input.render(frame.contentWidth).map((row) => frame.line(row)),
            frame.rule("├", "┤"),
            frame.line("Enter accept · Esc discard field"),
            frame.rule("╰", "╯"),
          ];
        },
        invalidate() {
          input.invalidate();
        },
        handleInput(data: string) {
          input.handleInput(data);
          tui.requestRender();
        },
      };
    },
    { signal },
  );
  return panel.result;
}

export async function editorPanel(
  ctx: ExtensionContext,
  title: string,
  value: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const panel = presentPanel<string | undefined>(
    ctx,
    (tui, theme, keys, done) => {
      const editor = new Editor(tui, {
        borderColor: (text) => theme.fg("borderAccent", text),
        selectList: {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("text", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("muted", text),
          noMatch: (text) => theme.fg("warning", text),
        },
      });
      editor.setText(value);
      editor.disableSubmit = true;
      return {
        get focused() {
          return editor.focused;
        },
        set focused(value: boolean) {
          editor.focused = value;
        },
        render(width: number) {
          const frame = createPanelFrame(theme, width);
          const rows = editor
            .render(frame.contentWidth)
            .slice(0, Math.max(1, tui.terminal.rows - 8));
          return [
            frame.rule("╭", "╮", `─ ${title} `),
            ...rows.map((row) => frame.line(row)),
            frame.rule("├", "┤"),
            frame.line("Ctrl+S accept field · Esc discard field"),
            frame.rule("╰", "╯"),
          ];
        },
        invalidate() {
          editor.invalidate();
        },
        handleInput(data: string) {
          if (matchesKey(data, "ctrl+s")) {
            done(editor.getExpandedText());
            return;
          }
          if (keys.matches(data, "tui.select.cancel")) {
            done(undefined);
            return;
          }
          editor.handleInput(data);
          tui.requestRender();
        },
      };
    },
    { signal },
  );
  return panel.result;
}

export function settingsFlowContext(ctx: ExtensionContext, signal: AbortSignal): ExtensionContext {
  return {
    ...ctx,
    signal,
    ui: {
      ...ctx.ui,
      async select(title, options, dialogOptions) {
        return chooseMenu(
          ctx,
          title,
          options.map((label) => ({ id: label, label })),
          dialogOptions?.signal ? AbortSignal.any([signal, dialogOptions.signal]) : signal,
        );
      },
      async input(title, placeholder, dialogOptions) {
        const dialogSignal = dialogOptions?.signal
          ? AbortSignal.any([signal, dialogOptions.signal])
          : signal;
        return inputPanel(ctx, title, placeholder ?? "", dialogSignal);
      },
      async editor(title, prefill) {
        return editorPanel(ctx, title, prefill ?? "", signal);
      },
    },
  };
}

export interface SettingsField {
  path: string;
  label: string;
  kind: "boolean" | "number" | "string" | "json" | "model";
  choices?: string[] | undefined;
  group?: string;
  description?: string | undefined;
  secret?: boolean;
  edit?(
    ctx: ExtensionContext,
    current: unknown,
    signal: AbortSignal,
  ): Promise<{ value: unknown } | undefined>;
}
export interface SettingsDraft {
  value: Record<string, unknown>;
  needsInitialPublication?: boolean;
  apply(value: Record<string, unknown>, signal?: AbortSignal): Promise<void>;
}
export interface SettingsSection {
  plugin?: { id: string; title: string; description: string };
  children?: SettingsSection[];
  id: string;
  title: string;
  description: string;
  fields: SettingsField[];
  load(ctx: ExtensionContext): Promise<SettingsDraft>;
  actions?: Array<MenuItem & { run(ctx: ExtensionContext, signal: AbortSignal): Promise<void> }>;
  effect: string;
}
export const SETTINGS_DISCOVER = "pi-settings:discover:v1";

export function registerSettingsSection(
  pi: Pick<ExtensionAPI, "events">,
  section: SettingsSection,
): () => void {
  return pi.events.on(SETTINGS_DISCOVER, (raw) => {
    const request = raw as { version?: unknown; accept?: unknown };
    if (request?.version === 1 && typeof request.accept === "function") {
      request.accept(section);
    }
  });
}

export function discoverSettingsSections(pi: Pick<ExtensionAPI, "events">): SettingsSection[] {
  const sections = new Map<string, SettingsSection>();
  pi.events.emit(SETTINGS_DISCOVER, {
    version: 1,
    accept(section: SettingsSection) {
      if (
        section &&
        typeof section.id === "string" &&
        typeof section.load === "function" &&
        !sections.has(section.id)
      ) {
        sections.set(section.id, section);
      }
    },
  });
  return [...sections.values()];
}

export function groupPluginSettings(sections: SettingsSection[]): SettingsSection[] {
  const roots = new Map<string, SettingsSection>();
  for (const section of sections) {
    if (!section.plugin) {
      roots.set(section.id, section);
      continue;
    }
    const plugin = section.plugin;
    let root = roots.get(plugin.id);
    if (!root) {
      root = {
        ...section,
        id: plugin.id,
        title: plugin.title,
        description: plugin.description,
        children: [],
      };
      roots.set(plugin.id, root);
    }
    root.children?.push(section);
  }
  return [...roots.values()];
}

async function openPluginSettings(
  ctx: ExtensionContext,
  section: SettingsSection,
  signal: AbortSignal,
): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    const children = section.children ?? [];
    const choice = await chooseMenu(
      ctx,
      section.title,
      [
        ...children.map((child) => ({
          id: child.id,
          label: child.title,
          description: child.description,
        })),
        { id: "back", label: "Back to plugins" },
      ],
      signal,
    );
    if (!choice || choice === "back") {
      return;
    }
    const child = children.find((child) => child.id === choice);
    if (child) {
      await openSettingsSection(ctx, child, signal);
    }
  }
}

function fieldValue(value: Record<string, unknown>, path: string): unknown {
  let current: unknown = value;
  for (const key of path.split(".")) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
function assignField(value: Record<string, unknown>, path: string, next: unknown): void {
  const keys = path.split(".");
  if (keys.some((key) => ["__proto__", "constructor", "prototype"].includes(key))) {
    throw new Error("Invalid settings field path");
  }
  let parent = value;
  for (const key of keys.slice(0, -1)) {
    if (!parent[key] || typeof parent[key] !== "object" || Array.isArray(parent[key])) {
      parent[key] = {};
    }
    parent = parent[key] as Record<string, unknown>;
  }
  const key = keys.at(-1)!;
  if (next === undefined) {
    delete parent[key];
  } else {
    parent[key] = next;
  }
}

async function editField(
  ctx: ExtensionContext,
  field: SettingsField,
  current: unknown,
  signal: AbortSignal,
): Promise<{ value: unknown } | undefined> {
  if (field.edit) {
    return field.edit(ctx, current, signal);
  }
  if (field.secret) {
    const choice = await chooseMenu(
      ctx,
      field.label,
      [
        { id: "replace", label: "Replace configured value" },
        { id: "unset", label: "Remove configured value" },
      ],
      signal,
    );
    if (!choice) {
      return undefined;
    }
    if (choice === "unset") {
      return { value: undefined };
    }
    const text = await editorPanel(ctx, `${field.label} — replacement`, "", signal);
    if (text === undefined || !text.trim()) {
      return undefined;
    }
    return { value: field.kind === "json" ? JSON.parse(text) : text };
  }
  if (field.kind === "boolean" || field.choices || field.kind === "model") {
    const choices =
      field.kind === "model"
        ? ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`)
        : (field.choices ?? ["true", "false"]);
    const choice = await chooseMenu(
      ctx,
      field.label,
      [
        { id: "unset", label: "Use default / unset" },
        ...choices.map((choice) => ({ id: `value:${choice}`, label: choice })),
      ],
      signal,
    );
    if (choice === undefined) {
      return undefined;
    }
    if (choice === "unset") {
      return { value: undefined };
    }
    if (field.kind === "boolean") {
      return { value: choice === "value:true" };
    }
    const valuePrefix = "value:";
    return { value: choice.slice(valuePrefix.length) };
  }
  const initial =
    current === undefined
      ? ""
      : field.kind === "json"
        ? JSON.stringify(current, null, 2)
        : String(current);
  const text =
    field.kind === "json"
      ? await editorPanel(ctx, field.label, initial, signal)
      : await inputPanel(ctx, field.label, initial, signal);
  signal.throwIfAborted();
  if (text === undefined) {
    return undefined;
  }
  if (!text.trim()) {
    return { value: undefined };
  }
  const value =
    field.kind === "json" ? JSON.parse(text) : field.kind === "number" ? Number(text) : text;
  if (field.kind === "number" && !Number.isFinite(value)) {
    throw new Error("Enter a finite number");
  }
  return { value };
}

export async function openSettingsSection(
  ctx: ExtensionContext,
  section: SettingsSection,
  signal: AbortSignal,
): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI || !ctx.isIdle()) {
    throw new Error("Plugin settings require an idle interactive session");
  }
  if (section.children) {
    await openPluginSettings(ctx, section, signal);
    return;
  }
  let loaded = await section.load(ctx);
  let draft = structuredClone(loaded.value);
  let error: string | undefined;
  for (;;) {
    signal.throwIfAborted();
    const dirty = JSON.stringify(draft) !== JSON.stringify(loaded.value);
    const fields = section.fields
      .filter((field) => !field.group)
      .map((field) => {
        const value = fieldValue(draft, field.path);
        let display: string;
        if (field.secret) {
          display = value === undefined ? "not set" : "configured (hidden)";
        } else if (value === undefined) {
          display = "default";
        } else {
          display = JSON.stringify(value);
        }
        return {
          id: `field:${field.path}`,
          label: `${field.label}: ${display}`,
          description: field.description,
        };
      });
    const groups = [
      ...new Set(section.fields.flatMap((field) => (field.group ? [field.group] : []))),
    ];
    const choice = await chooseMenu(
      ctx,
      `${section.title}${dirty ? " *" : ""}`,
      [
        ...fields,
        ...groups.map((group) => ({ id: `group:${group}`, label: `› ${group}` })),
        ...(section.actions ?? []).map(({ id, label, description }) => ({
          id: `action:${id}`,
          label,
          description,
        })),
        { id: "apply", label: "Apply changes", description: error ?? section.effect },
        { id: "back", label: "Back" },
      ],
      signal,
    );
    if (choice === undefined || choice === "back") {
      if (
        !dirty ||
        (await chooseMenu(
          ctx,
          "Discard unsaved changes?",
          [
            { id: "discard", label: "Discard" },
            { id: "keep", label: "Keep editing" },
          ],
          signal,
        )) === "discard"
      ) {
        return;
      }
      continue;
    }
    try {
      if (choice === "apply") {
        if (dirty || loaded.needsInitialPublication) {
          signal.throwIfAborted();
          if (!ctx.isIdle()) {
            throw new Error("Wait for the agent to finish before applying settings");
          }
          await loaded.apply(draft, signal);
          signal.throwIfAborted();
          ctx.ui.notify(section.effect, "info");
          loaded = await section.load(ctx);
          draft = structuredClone(loaded.value);
        }
      } else if (choice.startsWith("action:")) {
        if (dirty) {
          throw new Error("Apply or discard changes before opening a setup flow");
        }
        if (!ctx.isIdle()) {
          throw new Error("Wait for the agent to finish before starting a setup flow");
        }
        const owner = panelOwner(ctx);
        setupActionOwners.set(owner, (setupActionOwners.get(owner) ?? 0) + 1);
        try {
          await section.actions
            ?.find((action) => action.id === choice.slice(7))
            ?.run(settingsFlowContext(ctx, signal), signal);
        } finally {
          setupActionOwners.set(owner, Math.max(0, (setupActionOwners.get(owner) ?? 1) - 1));
        }
        signal.throwIfAborted();
        loaded = await section.load(ctx);
        draft = structuredClone(loaded.value);
      } else {
        let selectedFieldPath = choice.slice("field:".length);
        if (choice.startsWith("group:")) {
          const group = choice.slice("group:".length);
          const groupedFields = section.fields.filter((field) => field.group === group);
          const selected = await chooseMenu(
            ctx,
            group,
            groupedFields.map((field) => ({
              id: field.path,
              label: field.label,
              description: field.description,
            })),
            signal,
          );
          if (!selected) {
            continue;
          }
          selectedFieldPath = selected;
        }
        const field = section.fields.find((field) => field.path === selectedFieldPath);
        if (field) {
          const result = await editField(ctx, field, fieldValue(draft, field.path), signal);
          if (result) {
            assignField(draft, field.path, result.value);
          }
        }
      }
      error = undefined;
    } catch (failure) {
      signal.throwIfAborted();
      error = failure instanceof Error ? failure.message : String(failure);
      ctx.ui.notify(error, "error");
    }
  }
}
