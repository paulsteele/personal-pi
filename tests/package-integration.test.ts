import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAutoPublisher } from "../pi-permission-system/src/auto/events.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  version: string;
  workspaces: string[];
  pi: { extensions: string[] };
};

const expectedExtensions = [
  "./claude-skills/index.ts",
  "./code-blocks/index.ts",
  "./desktop-notifications/index.ts",
  "./pi-permission-system/src/index.ts",
  "./pi-atelier/extensions/index.ts",
];

const packageForEntry = (entry: string): string => entry.split("/")[1] ?? "";

type EventHandler = (data: unknown) => void;

function eventBus() {
  const handlers = new Map<string, Set<EventHandler>>();
  return {
    on(channel: string, handler: EventHandler) {
      const subscribers = handlers.get(channel) ?? new Set<EventHandler>();
      subscribers.add(handler);
      handlers.set(channel, subscribers);
      return () => subscribers.delete(handler);
    },
    emit(channel: string, data: unknown) {
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
    count(channel: string) {
      return handlers.get(channel)?.size ?? 0;
    },
  };
}

describe("Pi package integration", () => {
  afterEach(() => {
    delete process.env.PI_CODING_AGENT_DIR;
  });

  test("exposes each workspace exactly once in deliberate load order", () => {
    expect(manifest.pi.extensions).toEqual(expectedExtensions);
    expect(new Set(manifest.pi.extensions).size).toBe(expectedExtensions.length);
    expect(manifest.workspaces).toEqual([
      "claude-skills",
      "code-blocks",
      "desktop-notifications",
      "pi-permission-system",
      "pi-atelier",
    ]);
    expect(manifest.pi.extensions.indexOf("./pi-permission-system/src/index.ts")).toBeLessThan(
      manifest.pi.extensions.indexOf("./pi-atelier/extensions/index.ts"),
    );
  });

  test("keeps every extension independently packaged at the repository version", () => {
    for (const entry of manifest.pi.extensions) {
      const workspace = packageForEntry(entry);
      const packageManifest = JSON.parse(
        readFileSync(resolve(root, workspace, "package.json"), "utf8"),
      ) as { version: string; private: boolean; pi: { extensions: string[] } };
      expect(packageManifest.private).toBe(true);
      expect(packageManifest.version).toBe(manifest.version);
      expect(packageManifest.pi.extensions).toHaveLength(1);
    }
  });

  test("replays Permission System state when a later-loaded consumer discovers it", () => {
    const events = eventBus();
    const publisher = createAutoPublisher(events);
    const snapshot = {
      enabled: true,
      usable: true,
      provider: "test",
      modelId: "model",
      allowed: 3,
      asked: 1,
    };
    publisher.update(snapshot);

    const received: unknown[] = [];
    const unsubscribe = events.on("auto-mode:state", (event) => received.push(event));
    expect(events.count("auto-mode:discover")).toBe(1);
    events.emit("auto-mode:discover", {});
    expect(received).toEqual([snapshot]);

    unsubscribe();
    publisher.dispose();
    expect(events.count("auto-mode:discover")).toBe(0);
  });

  test("keeps desktop notifications separate from Atelier", () => {
    const desktopSource = readFileSync(resolve(root, "desktop-notifications/index.ts"), "utf8");
    const atelierSource = readFileSync(resolve(root, "pi-atelier/extensions/index.ts"), "utf8");
    expect(desktopSource).toContain('pi.registerCommand("notify-test"');
    expect(atelierSource).not.toContain('pi.registerCommand("notify-test"');
    expect(atelierSource).not.toContain("completion-notifier");
  });
});
