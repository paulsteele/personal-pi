import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { configPath, DEFAULT_CONFIG } from "../src/config.ts";
import {
  loadSandboxSettings,
  parseSandboxSettings,
  saveSandboxSettings,
  sandboxDisclosureRevision,
} from "../src/sandbox/settings.ts";
import { publishApprovedSetupDraft, validateSetupDraft } from "../src/sandbox/setup.ts";
import { readPrivateText, publishPrivateText } from "../src/sandbox/storage.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
  directories.length = 0;
});
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "sandbox-setup-")));
  directories.push(directory);
  const target = join(directory, "devcontainer.json");
  return { directory, target };
}
const imageDraft = {
  definition: { image: "debian:bookworm" },
  files: {},
  explanation: "A development shell",
};

it("loads new settings without an off switch or permission classifier", async () => {
  const { directory } = await fixture();
  expect(await loadSandboxSettings(directory)).toEqual({
    settings: {
      permission: {},
      sandbox: {
        hostEnvironment: [],
        startupTimeoutMs: 120_000,
        buildTimeoutMs: 1_800_000,
      },
    },
    needsMigration: false,
  });
  expect(() => parseSandboxSettings({ sandbox: { enabled: false } })).toThrow();
});

it.each([true, false])(
  "loads the retired setup toggle %s without migration and omits it on save",
  async (modelAssistedSetup) => {
    const { directory } = await fixture();
    const path = configPath(directory);
    const settings = {
      permission: { bash: "deny" },
      sandbox: {
        modelAssistedSetup,
        hostEnvironment: ["HTTPS_PROXY"],
        startupTimeoutMs: 60_000,
        buildTimeoutMs: 900_000,
      },
    };
    await publishPrivateText(path, JSON.stringify(settings), undefined);
    const loaded = await loadSandboxSettings(directory);
    expect(loaded.needsMigration).toBe(false);
    expect(loaded.settings).toEqual({
      permission: { bash: "deny" },
      sandbox: {
        hostEnvironment: ["HTTPS_PROXY"],
        startupTimeoutMs: 60_000,
        buildTimeoutMs: 900_000,
      },
    });
    expect(() => sandboxDisclosureRevision(directory, "container-authority")).not.toThrow();
    await saveSandboxSettings(directory, loaded.settings, loaded.revision);
    expect(JSON.parse((await readPrivateText(path))!.text)).toEqual(loaded.settings);
  },
);

it("requires explicit migration while preserving legacy policy and dropping classifier settings", async () => {
  const { directory } = await fixture();
  await publishPrivateText(configPath(directory), JSON.stringify(DEFAULT_CONFIG), undefined);
  const loaded = await loadSandboxSettings(directory);
  expect(loaded.needsMigration).toBe(true);
  expect(loaded.settings.permission).toEqual(DEFAULT_CONFIG.permission);
  expect(loaded.settings).not.toHaveProperty("auto");
  expect(JSON.parse((await readPrivateText(configPath(directory)))!.text)).toHaveProperty("auto");
  await saveSandboxSettings(directory, loaded.settings, loaded.revision);
  expect((await loadSandboxSettings(directory)).needsMigration).toBe(false);
});

it("changes disclosure revisions for live permission edits without changing container authority", async () => {
  const { directory } = await fixture();
  const first = sandboxDisclosureRevision(directory, "container-authority");
  await saveSandboxSettings(
    directory,
    parseSandboxSettings({ permission: { read: "deny" } }),
    undefined,
  );
  const second = sandboxDisclosureRevision(directory, "container-authority");
  expect(second).not.toBe(first);
  expect(sandboxDisclosureRevision(directory, "replacement-container")).not.toBe(second);
});

it("does not publish manual setup drafts before approval", async () => {
  const { target } = await fixture();
  await expect(
    publishApprovedSetupDraft({ target, draft: imageDraft, confirm: async () => false }),
  ).rejects.toThrow("cancelled");
  expect(await readPrivateText(target)).toBeUndefined();
});

it("publishes approved companion files before exposing their definition", async () => {
  const { target } = await fixture();
  const draft = {
    definition: { build: { dockerfile: "Containerfile" } },
    files: { Containerfile: "FROM debian:bookworm\nRUN apt-get update\n" },
    explanation: "Install development tools in the image",
  };
  await publishApprovedSetupDraft({ target, draft, confirm: async () => true });
  const published = JSON.parse((await readPrivateText(target))!.text);
  expect(published.build.dockerfile).toMatch(/^files-[a-f0-9-]+\/Containerfile$/);
  expect((await readPrivateText(join(dirname(target), published.build.dockerfile)))!.text).toBe(
    draft.files.Containerfile,
  );
});

it("refuses stale approved drafts without overwriting a newer definition", async () => {
  const { target } = await fixture();
  await expect(
    publishApprovedSetupDraft({
      target,
      draft: imageDraft,
      confirm: async () => {
        await publishPrivateText(target, '{"image":"newer"}', undefined);
        return true;
      },
    }),
  ).rejects.toThrow("changed");
  expect((await readPrivateText(target))!.text).toBe('{"image":"newer"}');
});

it("refuses a cancelled setup draft before publication", async () => {
  const { target } = await fixture();
  const controller = new AbortController();
  await expect(
    publishApprovedSetupDraft({
      target,
      draft: imageDraft,
      signal: controller.signal,
      confirm: async () => {
        controller.abort(new Error("Cancelled setup"));
        return true;
      },
    }),
  ).rejects.toThrow("Cancelled setup");
  expect(await readPrivateText(target)).toBeUndefined();
});

it.each(["../outside", "/outside", "a\\b", "devcontainer.json"])(
  "rejects a setup companion path %j",
  (path) => {
    expect(() => validateSetupDraft({ ...imageDraft, files: { [path]: "content" } })).toThrow(
      "companion-file",
    );
  },
);
