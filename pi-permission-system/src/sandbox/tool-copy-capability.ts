import { join } from "node:path";
import { buildContentKey, withBuildLock } from "./tool-cache.ts";
import { readPrivateText, publishPrivateText } from "./storage.ts";
import type { ToolBuildPorts } from "./tool-provisioning.ts";
import type { ToolEngineOutput } from "./tool-build-runtime.ts";

export async function resolveToolCopyMode(options: {
  directory: string;
  builderImageId: string;
  ports: ToolBuildPorts;
  run: ToolEngineOutput;
  signal?: AbortSignal;
  report?: (text: string) => void;
}): Promise<"linked" | "ordinary"> {
  const version = await options.run(["version", "--format", "json"], options.signal);
  const key = buildContentKey({ version, builder: options.builderImageId, probe: "linked-copy-v1" });
  const path = join(options.directory, "capabilities", `${key}.json`);
  return withBuildLock(`${path}.build.lock`, options.signal, async () => {
    const stored = await readPrivateText(path);
    if (stored) {
      const result = JSON.parse(stored.text) as { mode?: unknown };
      if (result.mode === "linked" || result.mode === "ordinary") {
        return result.mode;
      }
      throw new Error("Invalid tool copy capability record");
    }
    const source = await options.ports.build(
      {
        containerfile: "FROM scratch\nCOPY payload.txt /opt/pi-copy-probe/payload.txt\n",
        files: { "payload.txt": "immutable tooling probe\n" },
      },
      `localhost/pi-copy-probe:${key}-source`,
      options.signal,
    );
    const copyInstruction = `COPY --link --from=${source} /opt/pi-copy-probe/ /opt/pi-copy-probe/`;
    const firstProbeImage = await options.ports.build(
      { containerfile: `FROM ${options.builderImageId}\n${copyInstruction}\n`, files: {} },
      `localhost/pi-copy-probe:${key}-first`,
      options.signal,
    ).catch((error) => {
      options.signal?.throwIfAborted();
      if (/unknown flag.*link|unsupported.*link|unrecognized.*link/i.test(String(error))) {
        return undefined;
      }
      throw error;
    });
    let mode: "linked" | "ordinary" = "ordinary";
    if (firstProbeImage) {
      const secondProbeImage = await options.ports.build(
        {
          containerfile: `FROM ${options.builderImageId}\nUSER root\nRUN printf changed > /tmp/pi-copy-parent\n${copyInstruction}\n`,
          files: {},
        },
        `localhost/pi-copy-probe:${key}-second`,
        options.signal,
      );
      const images = JSON.parse(await options.run(
        ["inspect", "--type", "image", firstProbeImage, secondProbeImage], options.signal,
      )) as { RootFS?: { Layers?: string[] } }[];
      const firstLayer = images[0]?.RootFS?.Layers?.at(-1);
      const secondLayer = images[1]?.RootFS?.Layers?.at(-1);
      if (firstLayer && firstLayer === secondLayer) {
        mode = "linked";
      }
    }
    options.report?.(`Tool assembly copy mode: ${mode}`);
    await publishPrivateText(path, JSON.stringify({ mode }), undefined, options.signal);
    return mode;
  });
}
