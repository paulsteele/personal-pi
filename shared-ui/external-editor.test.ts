import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { editConfigDraft, openConfigFile } from "./external-editor.js";
import { afterPanelsClose, isPanelOpen } from "./index.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function editorFixture(mode: "save" | "quit" | "fail" | "wait" = "save") {
  const directory = await mkdtemp(join(tmpdir(), "config editor test-"));
  directories.push(directory);
  const script = join(directory, "editor.js");
  const record = join(directory, "invocation.json");
  await writeFile(
    script,
    `
    const fs = require("node:fs");
    const [mode, record, path] = process.argv.slice(2);
    fs.writeFileSync(record, JSON.stringify({
      path, content: fs.readFileSync(path, "utf8"),
      permissions: fs.statSync(path).mode & 0o777, cwd: process.cwd(),
    }));
    if (mode === "save") { fs.writeFileSync(path, '{"enabled":false}\\n'); }
    if (mode === "fail") { process.exit(2); }
    if (mode === "wait") { setInterval(() => {}, 1000); }
  `,
  );
  vi.stubEnv("EDITOR", `"${process.execPath}" "${script}" ${mode} "${record}"`);
  vi.stubEnv("VISUAL", "nonexistent-visual-editor");
  const transitions: string[] = [];
  const ctx = {
    cwd: directory,
    mode: "tui",
    hasUI: true,
    ui: {
      custom(factory: any, options: any) {
        return new Promise((resolve) => {
          const component = factory(
            {
              stop() {
                transitions.push("stop");
              },
              start() {
                transitions.push("start");
              },
              requestRender(force: boolean) {
                transitions.push(`render:${force}`);
              },
              terminal: {
                write(text: string) {
                  transitions.push(text);
                },
              },
            },
            {},
            {},
            resolve,
          );
          options.onHandle({ focus() {} });
          expect(component.render()).toEqual([]);
        });
      },
    },
  } as unknown as ExtensionContext;
  const readEditorInvocation = async () => JSON.parse(await readFile(record, "utf8"));
  return { ctx, directory, record, transitions, invocation: readEditorInvocation };
}

it("hands the terminal to EDITOR with arguments and restores Pi after a private draft is saved", async () => {
  const fixture = await editorFixture();
  expect(await editConfigDraft(fixture.ctx, "Container environment", '{"enabled":true}')).toBe(
    '{"enabled":false}',
  );
  const invocation = await fixture.invocation();
  expect(invocation.content).toBe('{"enabled":true}');
  expect(invocation.permissions).toBe(0o600);
  expect(invocation.cwd).toBe(fixture.directory);
  expect(invocation.path).toMatch(/Container-environment\.json$/);
  await expect(stat(invocation.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(fixture.transitions).toEqual(["stop", "\x1b[2J\x1b[H", "start", "render:true"]);
  expect(isPanelOpen(fixture.ctx)).toBe(false);
});

it("quitting without saving preserves the original draft", async () => {
  const fixture = await editorFixture("quit");
  expect(await editConfigDraft(fixture.ctx, "Tools", '{"tools":[]}')).toBe('{"tools":[]}');
});

it("a failed editor discards the temporary draft and restores the harness", async () => {
  const fixture = await editorFixture("fail");
  expect(await editConfigDraft(fixture.ctx, "Tools", '{"tools":[]}')).toBeUndefined();
  await expect(stat((await fixture.invocation()).path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(fixture.transitions.slice(-2)).toEqual(["start", "render:true"]);
});

it("opens the actual config file and passes shell metacharacters as a literal path", async () => {
  const fixture = await editorFixture();
  const path = join(fixture.directory, "config $(touch injected).json");
  await writeFile(path, '{"enabled":true}');
  await openConfigFile(fixture.ctx, path);
  expect((await fixture.invocation()).path).toBe(path);
  expect(await readFile(path, "utf8")).toBe('{"enabled":false}\n');
  await expect(stat(join(fixture.directory, "injected"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("terminates the editor on cancellation before restoring Pi and releasing panel ownership", async () => {
  const fixture = await editorFixture("wait");
  const controller = new AbortController();
  const pending = editConfigDraft(fixture.ctx, "Tools", "{}", controller.signal);
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(async () => expect(await stat(fixture.record)).toBeDefined());
  const cleanup = vi.fn();
  afterPanelsClose(fixture.ctx, cleanup);
  expect(isPanelOpen(fixture.ctx)).toBe(true);
  expect(cleanup).not.toHaveBeenCalled();
  controller.abort();
  await rejected;
  expect(fixture.transitions.slice(-2)).toEqual(["start", "render:true"]);
  expect(cleanup).toHaveBeenCalledOnce();
  await expect(stat((await fixture.invocation()).path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not launch a terminal editor outside TUI mode", async () => {
  const fixture = await editorFixture();
  fixture.ctx.mode = "rpc";
  await expect(openConfigFile(fixture.ctx, "config.json")).rejects.toThrow("interactive TUI");
  expect(fixture.transitions).toEqual([]);
});
