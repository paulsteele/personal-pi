import type { ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey } from "@earendil-works/pi-tui";
import type { PermissionPromptPayload } from "./payload.ts";
import { renderPermissionPrompt, type PromptTheme } from "./renderer.ts";

export type HumanPromptChoice = "approve" | "approve_note" | "deny" | "deny_note";

interface Option {
  key: "y" | "a" | "n" | "d";
  label: string;
  value: HumanPromptChoice;
}

const MANUAL_OPTIONS: readonly Option[] = [
  { key: "y", label: "Approve", value: "approve" },
  { key: "n", label: "Deny", value: "deny" },
];
const AUTO_OPTIONS: readonly Option[] = [
  { key: "y", label: "Approve", value: "approve" },
  { key: "a", label: "Approve + classifier note", value: "approve_note" },
  { key: "n", label: "Deny", value: "deny" },
  { key: "d", label: "Deny + classifier note", value: "deny_note" },
];

export async function presentPermissionPrompt(
  ctx: ExtensionContext,
  title: string,
  payload: PermissionPromptPayload,
  noteEnabled: boolean,
): Promise<HumanPromptChoice | null> {
  const options = noteEnabled ? AUTO_OPTIONS : MANUAL_OPTIONS;
  if (ctx.mode !== "tui") {
    const rendered = renderPermissionPrompt(payload, 80);
    const labels = options.map((option) => `${option.key} ${option.label.toLowerCase()}`);
    const selected = await ctx.ui.select(`${title}\n${rendered.lines.join("\n")}`, labels);
    return (
      options.find((option) => `${option.key} ${option.label.toLowerCase()}` === selected)?.value ??
      null
    );
  }
  return ctx.ui.custom<HumanPromptChoice | null>((tui, theme, keybindings, done) => {
    return new PermissionPromptComponent(
      theme,
      keybindings,
      ctx,
      title,
      payload,
      options,
      () => tui.requestRender(),
      done,
    );
  });
}

class PermissionPromptComponent implements Component {
  private selected = 0;
  private expanded = false;

  constructor(
    private readonly theme: PromptTheme,
    private readonly keybindings: Pick<KeybindingsManager, "matches">,
    private readonly ctx: ExtensionContext,
    private readonly title: string,
    private readonly payload: PermissionPromptPayload,
    private readonly options: readonly Option[],
    private readonly requestRender: () => void,
    private readonly done: (choice: HumanPromptChoice | null) => void,
  ) {}

  render(width: number): string[] {
    const ask = renderPermissionPrompt(this.payload, width, this.theme, this.expanded);
    const lines = [this.theme.fg("accent", this.title), ...ask.lines, ""];
    for (let index = 0; index < this.options.length; index++) {
      const option = this.options[index];
      if (!option) continue;
      const row = `${index === this.selected ? "▶" : " "} (${option.key}) ${option.label}`;
      lines.push(index === this.selected ? this.theme.fg("accent", row) : row);
    }
    const hint = ["↑/↓ move", "enter select", "esc deny", "one press selects"];
    if (this.expanded) hint.push("ctrl+o collapse");
    else if (ask.elided) hint.push("ctrl+o full request");
    lines.push("", this.theme.fg("muted", hint.join(" · ")));
    return lines;
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "app.tools.expand")) {
      this.ctx.ui.setToolsExpanded(!this.ctx.ui.getToolsExpanded());
      this.expanded = !this.expanded;
      this.requestRender();
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.selected = (this.selected - 1 + this.options.length) % this.options.length;
      this.requestRender();
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.selected = (this.selected + 1) % this.options.length;
      this.requestRender();
      return;
    }
    if (matchesKey(data, "escape")) {
      this.done(null);
      return;
    }
    if (matchesKey(data, "enter")) {
      this.done(this.options[this.selected]?.value ?? null);
      return;
    }
    const option = this.options.find((candidate) => matchesKey(data, candidate.key));
    if (option) this.done(option.value);
  }

  invalidate(): void {}
}
