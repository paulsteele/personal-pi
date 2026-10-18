import {
  createBashToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
  createGrepToolDefinition,
  truncateHead,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { posix } from "node:path";
import { readFile } from "node:fs/promises";
import { SandboxArtifacts } from "./artifacts.ts";
import { HOST_READ_TOOLS, hostReadablePath } from "./host-read-roots.ts";
import type { SandboxSession } from "./session.ts";

export function registerSandboxTools(
  pi: ExtensionAPI,
  getSession: () => SandboxSession,
  isHostMode: () => boolean = () => false,
  agentDir?: string,
): void {
  const cwd = process.cwd();
  const filesystem = () => getSession().filesystem;
  const shouldRunPiResourceReadOnHost = async (toolName: string, input: unknown) => {
    if (!agentDir || !HOST_READ_TOOLS.has(toolName)) {
      return false;
    }
    const requestedPath = (input as { path?: unknown } | undefined)?.path;
    const isHostReadablePath = (await hostReadablePath(requestedPath, agentDir)) !== undefined;
    return isHostReadablePath;
  };
  const registerWithHostFallback = <TParams extends TSchema, TDetails, TState>(
    guest: ToolDefinition<TParams, TDetails, TState>,
    host: ToolDefinition<TParams, TDetails, TState>,
  ) => {
    pi.registerTool({
      ...guest,
      execute: async (...args) => {
        const runsOnHost =
          isHostMode() || (await shouldRunPiResourceReadOnHost(guest.name, args[1]));
        return (runsOnHost ? host : guest).execute(...args);
      },
    });
  };
  registerWithHostFallback(
    createReadToolDefinition(cwd, {
      operations: {
        readFile: (path) => filesystem().read(path),
        access: (path) => filesystem().access(path),
        detectImageMimeType: async (path) => {
          const mime = await filesystem().mime(path);
          return mime &&
            ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"].includes(mime)
            ? mime
            : null;
        },
      },
    }),
    createReadToolDefinition(cwd),
  );
  registerWithHostFallback(
    createWriteToolDefinition(cwd, {
      operations: {
        writeFile: (path, content) => filesystem().write(path, content),
        mkdir: (path) => filesystem().mkdir(path),
      },
    }),
    createWriteToolDefinition(cwd),
  );
  registerWithHostFallback(
    createEditToolDefinition(cwd, {
      operations: {
        readFile: (path) => filesystem().read(path),
        writeFile: (path, content) => filesystem().write(path, content),
        access: (path) => filesystem().access(path),
      },
    }),
    createEditToolDefinition(cwd),
  );
  registerWithHostFallback(
    createLsToolDefinition(cwd, {
      operations: {
        exists: async (path) => {
          try {
            await filesystem().stat(path);
            return true;
          } catch {
            return false;
          }
        },
        stat: async (path) => {
          const metadata = await filesystem().stat(path);
          return {
            isDirectory: () => metadata.directory,
            isFile: () => metadata.file,
            isSymbolicLink: () => false,
            size: metadata.size,
          };
        },
        readdir: (path) => filesystem().list(path),
      },
    }),
    createLsToolDefinition(cwd),
  );
  registerWithHostFallback(
    createFindToolDefinition(cwd, {
      operations: {
        exists: async (path) => {
          try {
            await filesystem().stat(path);
            return true;
          } catch {
            return false;
          }
        },
        glob: async (pattern, path, options) =>
          (await filesystem().glob(pattern, path, options.limit)).map((match) =>
            posix.join(path, match),
          ),
      },
    }),
    createFindToolDefinition(cwd),
  );
  const hostGrep = createGrepToolDefinition(cwd);
  registerWithHostFallback(
    {
      ...hostGrep,
      async execute(_id, input, signal) {
        const path = await filesystem().canonical(input.path ?? ".", signal);
        const args = ["rg", "--json", "--color=never", "--hidden"];
        if (input.ignoreCase) {
          args.push("--ignore-case");
        }
        if (input.literal) {
          args.push("--fixed-strings");
        }
        if (input.glob) {
          args.push("--glob", input.glob);
        }
        if (input.context) {
          args.push("--context", String(input.context));
        }
        args.push("--", input.pattern, path);
        const previewScript = await readFile(new URL("./grep-preview.py", import.meta.url), "utf8");
        const execution = await getSession().execute({
          command: ["python3", "-c", previewScript],
          input: Buffer.from(JSON.stringify({ arguments: args, limit: input.limit ?? 100 })),
          signal,
        });
        if (execution.code !== 0) {
          throw new Error(execution.stderr);
        }
        interface GrepPreviewResult {
          output: string;
          stderr: string;
          code: number;
          truncated: boolean;
        }
        const grepPreview = JSON.parse(execution.output.toString()) as GrepPreviewResult;
        if (grepPreview.code > 1) {
          throw new Error(grepPreview.stderr);
        }
        const truncated = truncateHead(grepPreview.output);
        return {
          content: [{ type: "text", text: truncated.content || "No matches found" }],
          details:
            truncated.truncated || grepPreview.truncated
              ? { truncation: truncated, resultLimitReached: grepPreview.truncated }
              : undefined,
        };
      },
    },
    hostGrep,
  );
  const bash = createBashToolDefinition(cwd, {
    exposeSessionEnvironment: false,
    spawnHook: (context) => ({ ...context, cwd: getSession().environment.workspace, env: {} }),
    operations: {
      exec: async (command, _cwd, options) => {
        const result = await getSession().executeShell({
          command,
          signal: options.signal,
          timeoutMs: options.timeout ? options.timeout * 1000 : undefined,
          onData: options.onData,
        });
        return { exitCode: result.code };
      },
    },
  });
  const hostBash = createBashToolDefinition(cwd);
  registerWithHostFallback(
    {
      ...bash,
      async execute(id, input, signal, onUpdate, ctx) {
        const artifacts = new SandboxArtifacts(filesystem());
        const result = await bash.execute(
          id,
          input,
          signal,
          (update) => {
            const content = update.content.map((part) => {
              if (part.type !== "text") {
                return part;
              }
              return {
                ...part,
                text: part.text.replace(
                  /Full output: [^\n]+/g,
                  "Full output: available at completion",
                ),
              };
            });
            onUpdate?.({ ...update, content, details: undefined });
          },
          ctx,
        );
        const hostPath = result.details?.fullOutputPath;
        if (hostPath) {
          artifacts.registerProducedPath(hostPath);
          const guestPath = await artifacts.transferProducedPath(hostPath, signal);
          result.content = result.content.map((part) =>
            part.type === "text"
              ? { ...part, text: part.text.replaceAll(hostPath, guestPath) }
              : part,
          );
          result.details = { ...result.details, fullOutputPath: guestPath };
          if (result.structuredContent && typeof result.structuredContent === "object") {
            result.structuredContent = { ...result.structuredContent, full_output_path: guestPath };
          }
        }
        onUpdate?.(result);
        return result;
      },
    },
    hostBash,
  );
  pi.on("user_bash", () =>
    isHostMode()
      ? undefined
      : {
          operations: {
            exec: async (command, _cwd, options) => {
              const result = await getSession().executeShell({
                command,
                signal: options.signal,
                timeoutMs: options.timeout ? options.timeout * 1000 : undefined,
                onData: options.onData,
              });
              return { exitCode: result.code };
            },
          },
        },
  );
}

export async function guestToolPath(
  session: SandboxSession,
  input: Record<string, unknown>,
  ctx: ExtensionContext,
): Promise<void> {
  if (typeof input.path === "string") {
    input.path = await session.filesystem.canonical(input.path, ctx.signal);
  }
}
