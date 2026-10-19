import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSandboxPublisher } from "../pi-devcontainer-sandbox/src/sandbox/events.ts";

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
  "./pi-devcontainer-sandbox/src/index.ts",
  "./code-quality/index.ts",
  "./progress-observer/index.ts",
  "./pr-review/index.ts",
  "./pi-sidebar/extensions/index.ts",
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
      "project-locations",
      "shared-ui",
      "claude-skills",
      "code-blocks",
      "desktop-notifications",
      "pi-devcontainer-sandbox",
      "code-quality",
      "progress-observer",
      "pr-review",
      "pi-sidebar",
    ]);
    expect(manifest.pi.extensions.indexOf("./pi-devcontainer-sandbox/src/index.ts")).toBeLessThan(
      manifest.pi.extensions.indexOf("./pi-sidebar/extensions/index.ts"),
    );
    expect(manifest.pi.extensions.indexOf("./progress-observer/index.ts")).toBeLessThan(
      manifest.pi.extensions.indexOf("./pi-sidebar/extensions/index.ts"),
    );
  });

  test("development resources mirror the global manifest without duplicate owners", () => {
    const settings = JSON.parse(readFileSync(resolve(root, ".pi/settings.json"), "utf8"));
    expect(settings.extensions).toEqual(expectedExtensions.map((entry) => `.${entry}`));
    const installedExtensionExclusions = expectedExtensions.map((entry) => `-${entry.slice(2)}`);
    installedExtensionExclusions.splice(installedExtensionExclusions.indexOf("-pi-sidebar/extensions/index.ts"), 0, "-pi-atelier/extensions/index.ts");
    expect(settings.packages[0].extensions).toEqual(installedExtensionExclusions);
    const review = readFileSync(resolve(root, "pr-review/index.ts"), "utf8");
    expect(review).toContain('pi.registerCommand("pr"');
    expect(review).toContain('name: "pr_review"');
    expect(review).toContain('name: "pr_review_result"');
    expect(review).not.toContain('registerCommand("pr-refresh"');
  });

  test("lockfile workspace metadata matches manifests without changing package resolutions", () => {
    const lock = JSON.parse(readFileSync(resolve(root, "bun.lock"), "utf8").replace(/,(\s*[}\]])/g, "$1"));
    for (const workspace of ["", ...manifest.workspaces]) {
      const pkg = JSON.parse(readFileSync(resolve(root, workspace, "package.json"), "utf8"));
      expect(lock.workspaces[workspace].name).toBe(pkg.name);
      for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
        expect(lock.workspaces[workspace][field] ?? {}).toEqual(pkg[field] ?? {});
      }
      if (workspace) expect(lock.workspaces[workspace].version).toBe(pkg.version);
    }
    expect(lock.packages["@paulsteele/pi-pr-review"]).toEqual(["@paulsteele/pi-pr-review@workspace:pr-review"]);
  });

  test("uses host-provided peers and pins Pi development packages to 1.3.0", () => {
    const hostPackages = [
      "@earendil-works/pi-agent-core",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-tui",
      "typebox",
    ];
    for (const workspace of ["", ...manifest.workspaces]) {
      const pkg = JSON.parse(readFileSync(resolve(root, workspace, "package.json"), "utf8"));
      for (const name of hostPackages) {
        expect(pkg.dependencies?.[name]).toBeUndefined();
        if (name in (pkg.peerDependencies ?? {})) {
          expect(pkg.peerDependencies[name]).toBe("*");
        }
        if (name !== "typebox" && name in (pkg.devDependencies ?? {})) {
          expect(pkg.devDependencies[name]).toBe("1.3.0");
        }
      }
    }
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

  test("replays sandbox state when the later-loaded Sidebar discovers it", () => {
    const events = eventBus();
    const publisher = createSandboxPublisher(events);
    const snapshot = {
      sessionId: "session",
      phase: "ready" as const,
      definitionPath: "/private/devcontainer.json",
      mounts: [],
      ports: [],
    };
    publisher.update(snapshot);
    const received: unknown[] = [];
    const unsubscribe = events.on("sandbox:state:v1", (event) => received.push(event));
    expect(events.count("sandbox:discover:v1")).toBe(1);
    events.emit("sandbox:discover:v1", {});
    expect(received).toEqual([{ ...snapshot, version: 1, revision: 1 }]);
    unsubscribe();
    publisher.dispose();
    expect(events.count("sandbox:discover:v1")).toBe(0);
  });

  test("loads the independent progress observer before its Sidebar consumer", () => {
    const observerSource = readFileSync(resolve(root, "progress-observer/index.ts"), "utf8");
    const sidebarSource = readFileSync(resolve(root, "pi-sidebar/extensions/index.ts"), "utf8");
    expect(observerSource).toContain('pi.on("turn_end"');
    expect(observerSource).toContain('pi.registerCommand("observer"');
    expect(sidebarSource).toContain('pi.events.on("progress-observer:state"');
    expect(sidebarSource).not.toContain("modelRegistry.complete");
  });

  test("keeps desktop notifications separate from Sidebar", () => {
    const desktopSource = readFileSync(resolve(root, "desktop-notifications/index.ts"), "utf8");
    const sidebarSource = readFileSync(resolve(root, "pi-sidebar/extensions/index.ts"), "utf8");
    expect(desktopSource).toContain('pi.registerCommand("notify-test"');
    expect(sidebarSource).not.toContain('pi.registerCommand("notify-test"');
    expect(sidebarSource).not.toContain("completion-notifier");
  });
});
