import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configPath, DEFAULT_CONFIG } from "../src/config.ts";
import {
  loadSandboxSettings,
  parseSandboxSettings,
  saveSandboxSettings,
  sandboxDisclosureRevision,
} from "../src/sandbox/settings.ts";
import {
  publishApprovedProposal,
  validateProposal,
  proposeDevcontainer,
} from "../src/sandbox/setup.ts";
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
const imageProposal = {
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
        modelAssistedSetup: false,
        hostEnvironment: [],
        startupTimeoutMs: 120_000,
        buildTimeoutMs: 1_800_000,
      },
    },
    needsMigration: false,
  });
  expect(() => parseSandboxSettings({ sandbox: { enabled: false } })).toThrow();
});

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
  await saveSandboxSettings(directory, parseSandboxSettings({ permission: { read: "deny" } }), undefined);
  const second = sandboxDisclosureRevision(directory, "container-authority");
  expect(second).not.toBe(first);
  expect(sandboxDisclosureRevision(directory, "replacement-container")).not.toBe(second);
});

it("does not publish model proposals before approval", async () => {
  const { target } = await fixture();
  await expect(
    publishApprovedProposal({ target, proposal: imageProposal, confirm: async () => false }),
  ).rejects.toThrow("cancelled");
  expect(await readPrivateText(target)).toBeUndefined();
});

it("publishes approved companion files before exposing their definition", async () => {
  const { target } = await fixture();
  const proposal = {
    definition: { build: { dockerfile: "Containerfile" } },
    files: { Containerfile: "FROM debian:bookworm\nRUN apt-get update\n" },
    explanation: "Install development tools in the image",
  };
  await publishApprovedProposal({ target, proposal, confirm: async () => true });
  const published = JSON.parse((await readPrivateText(target))!.text);
  expect(published.build.dockerfile).toMatch(/^files-[a-f0-9-]+\/Containerfile$/);
  const { dirname } = await import("node:path");
  expect((await readPrivateText(join(dirname(target), published.build.dockerfile)))!.text).toBe(
    proposal.files.Containerfile,
  );
});

it("refuses stale approved proposals without overwriting a newer definition", async () => {
  const { target } = await fixture();
  await expect(
    publishApprovedProposal({
      target,
      proposal: imageProposal,
      confirm: async () => {
        await publishPrivateText(target, '{"image":"newer"}', undefined);
        return true;
      },
    }),
  ).rejects.toThrow("changed");
  expect((await readPrivateText(target))!.text).toBe('{"image":"newer"}');
});

it("refuses a cancelled proposal before publication", async () => {
  const { target } = await fixture();
  const controller = new AbortController();
  await expect(
    publishApprovedProposal({
      target,
      proposal: imageProposal,
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
  "rejects a proposed companion path %j",
  (path) => {
    expect(() => validateProposal({ ...imageProposal, files: { [path]: "content" } })).toThrow(
      "companion-file",
    );
  },
);

it("uses the current model without providing tools or installing anything", async () => {
  const calls: unknown[] = [];
  const model = { provider: "test", id: "current" };
  const ctx = {
    model,
    modelRegistry: {
      hasConfiguredAuth: () => true,
      streamSimple: (...args: unknown[]) => {
        calls.push(args);
        return {
          result: async () => ({
            stopReason: "stop",
            content: [{ type: "text", text: JSON.stringify(imageProposal) }],
          }),
        };
      },
    },
  };
  const result = await proposeDevcontainer({ ctx: ctx as never, evidence: "TypeScript project" });
  expect(result).toEqual(imageProposal);
  const [selectedModel, context] = calls[0] as [unknown, { tools?: unknown; messages: unknown[] }];
  expect(selectedModel).toBe(model);
  expect(context.tools).toBeUndefined();
  expect(context.messages).toHaveLength(1);
});

it("withholds project evidence when final disclosure authorization rejects it", async () => {
  const streamSimple = vi.fn();
  const ctx = {
    model: { provider: "test", id: "current" },
    modelRegistry: { hasConfiguredAuth: () => true, streamSimple },
  };
  const rejectDisclosure = async () => {
    throw new Error("Source permissions changed");
  };
  await expect(proposeDevcontainer({
    ctx: ctx as never, evidence: "private project", authorizeEvidence: rejectDisclosure,
  })).rejects.toThrow("Source permissions changed");
  expect(streamSimple).not.toHaveBeenCalled();
});

it("rechecks evidence after authentication before the provider receives the request", async () => {
  const { promise: authenticationWait, resolve: finishAuthentication } = Promise.withResolvers<void>();
  const providerDispatch = vi.fn();
  const authorizeEvidence = vi.fn(async () => {});
  const ctx = {
    model: { provider: "test", id: "current" },
    modelRegistry: {
      hasConfiguredAuth: () => true,
      streamSimple: (_model: unknown, _context: unknown, options: {
        transformHeaders(headers: Record<string, string>): Promise<Record<string, string>>;
      }) => ({
        result: async () => {
          await authenticationWait;
          await options.transformHeaders({ authorization: "fixture" });
          providerDispatch();
          return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify(imageProposal) }] };
        },
      }),
    },
  };
  const pending = proposeDevcontainer({ ctx: ctx as never, evidence: "private project", authorizeEvidence });
  const rejection = expect(pending).rejects.toThrow("Source revoked during authentication");
  await vi.waitFor(() => expect(authorizeEvidence).toHaveBeenCalledOnce());
  authorizeEvidence.mockRejectedValueOnce(new Error("Source revoked during authentication"));
  finishAuthentication();
  await rejection;
  expect(authorizeEvidence).toHaveBeenCalledTimes(2);
  expect(providerDispatch).not.toHaveBeenCalled();
});

it("keeps manual setup available when the current model is unavailable", async () => {
  await expect(proposeDevcontainer({ ctx: {} as never, evidence: "project" })).rejects.toThrow(
    "unavailable",
  );
});
