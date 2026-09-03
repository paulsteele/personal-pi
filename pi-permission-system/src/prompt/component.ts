import type { ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { PermissionPromptPayload } from "./payload.ts";
import { renderPermissionPrompt } from "./renderer.ts";

export type HumanPromptChoice =
  | "approve"
  | "approve_directory"
  | "approve_note"
  | "deny"
  | "deny_note";

interface Option {
  key: "y" | "p" | "a" | "n" | "d";
  label: string;
  value: HumanPromptChoice;
}

const STANDARD_OPTIONS: readonly Option[] = [
  { key: "y", label: "Approve once", value: "approve" },
  { key: "n", label: "Deny", value: "deny" },
];
const CLASSIFIER_OPTIONS: readonly Option[] = [
  { key: "y", label: "Approve once", value: "approve" },
  { key: "a", label: "Approve + classifier note", value: "approve_note" },
  { key: "n", label: "Deny", value: "deny" },
  { key: "d", label: "Deny + classifier note", value: "deny_note" },
];
const DIRECTORY_OPTION: Option = {
  key: "p",
  label: "Allow directory for session",
  value: "approve_directory",
};

export async function presentPermissionPrompt(
  ctx: ExtensionContext,
  title: string,
  payload: PermissionPromptPayload,
  classifierFeedback: boolean,
  allowDirectory = false,
): Promise<HumanPromptChoice | null> {
  const baseOptions = classifierFeedback ? CLASSIFIER_OPTIONS : STANDARD_OPTIONS;
  const options = allowDirectory
    ? [baseOptions[0] ?? STANDARD_OPTIONS[0], DIRECTORY_OPTION, ...baseOptions.slice(1)]
    : baseOptions;
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
    return new HumanDecisionComponent(theme, keybindings, options, () => tui.requestRender(), done);
  });
}

/** Compact controls only; request details live durably in the transcript. */
class HumanDecisionComponent implements Component {
  private selected = 0;

  constructor(
    private readonly theme: { fg(color: string, text: string): string },
    private readonly keybindings: Pick<KeybindingsManager, "matches">,
    private readonly options: readonly Option[],
    private readonly requestRender: () => void,
    private readonly done: (choice: HumanPromptChoice | null) => void,
  ) {}

  render(width: number): string[] {
    const options = this.options.map((option, index) => {
      const text = `${index === this.selected ? "▶" : " "} (${option.key}) ${option.label}`;
      return index === this.selected ? this.theme.fg("accent", text) : text;
    });
    return [
      this.theme.fg("syntaxType", "󰀄 Human decision"),
      ...options,
      this.theme.fg("muted", "↑/↓ select · enter choose · esc deny · thread remains scrollable"),
    ].map((line) => truncateToWidth(line, Math.max(0, width)));
  }

  handleInput(data: string): void {
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
    if (this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, "escape")) {
      this.done(null);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, "enter")) {
      this.done(this.options[this.selected]?.value ?? null);
      return;
    }
    const option = this.options.find((candidate) => matchesKey(data, candidate.key));
    if (option) this.done(option.value);
  }

  invalidate(): void {}
}
