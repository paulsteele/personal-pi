import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, unlink } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { cliHostEnvironment } from "./devcontainer-cli.ts";
import { authorizeEngineArguments, type EngineAuthority } from "./engine-policy.ts";
import { validateMountIdentity } from "./mounts.ts";

export interface EngineAdapterServer {
  environment: { PI_SANDBOX_SOCKET: string; PI_SANDBOX_TOKEN: string };
  close(): Promise<void>;
}

export async function startEngineAdapter(options: {
  socketPath: string;
  authority: EngineAuthority;
  beforeRun?: (image: string) => Promise<void>;
  authorizeContainerInspection?: (id: string) => Promise<void>;
  authorizeBuildRecipe?: (args: string[], cwd: string) => Promise<void>;
  afterOperation?: (args: string[], output: string) => Promise<void>;
  executable?: string;
}): Promise<EngineAdapterServer> {
  const token = randomBytes(32).toString("hex");
  const connections = new Set<Socket>();
  const children = new Set<ReturnType<typeof spawn>>();
  const server = createServer((socket) => {
    connections.add(socket);
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    let authorized = false;
    let pendingStdin: Buffer[] = [];
    let stdinEnded = false;
    let child: ReturnType<typeof spawn> | undefined;
    let pendingBytes = 0;
    const send = (message: object) => {
      if (!socket.destroyed) {
        socket.write(`${JSON.stringify(message)}\n`);
      }
    };
    socket.on("data", (chunk) => {
      pendingBytes += chunk.length;
      if (pendingBytes > 2 * 1024 * 1024) {
        socket.destroy();
      }
      const lastNewline = chunk.lastIndexOf(10);
      if (lastNewline >= 0) {
        pendingBytes = chunk.length - lastNewline - 1;
      }
    });
    socket.on("error", () => {});
    lines.on("error", () => socket.destroy());
    function forwardStdin(message: { stdin?: string; end?: boolean }): void {
      if (typeof message.stdin === "string") {
        const data = Buffer.from(message.stdin, "base64");
        if (child) {
          child.stdin?.write(data);
        } else {
          pendingStdin.push(data);
        }
      }
      if (message.end) {
        stdinEnded = true;
        child?.stdin?.end();
      }
    }

    async function startAuthorizedOperation(message: {
      args: string[];
      cwd: string;
    }): Promise<void> {
      if (message.args[0] === "build") {
        await options.authorizeBuildRecipe?.(message.args, message.cwd);
      }
      const isContainerInspection =
        message.args[0] === "inspect" &&
        message.args[1] === "--type" &&
        message.args[2] === "container";
      if (isContainerInspection) {
        for (const id of message.args.slice(3)) {
          await options.authorizeContainerInspection?.(id);
        }
      }
      const args = authorizeEngineArguments(message.args, message.cwd, options.authority);
      if (message.args[0] === "run" || message.args[0] === "create") {
        for (const mount of options.authority.mounts) {
          await validateMountIdentity(mount);
        }
        const image = message.args.find(
          (arg) =>
            options.authority.images.includes(arg) || options.authority.imageNames.includes(arg),
        );
        await options.beforeRun?.(image ?? "");
      }
      if (socket.destroyed) {
        return;
      }
      child = spawn(options.executable ?? "podman", args, {
        cwd: message.cwd,
        env: cliHostEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
      children.add(child);
      const isProcessListCommand = message.args[0] === "ps";
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-2 * 1024 * 1024);
        if (!isProcessListCommand) {
          send({ stdout: chunk.toString("base64") });
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => send({ stderr: chunk.toString("base64") }));
      child.stdin?.on("error", () => {});
      for (const data of pendingStdin) {
        child.stdin?.write(data);
      }
      pendingStdin = [];
      if (stdinEnded) {
        child.stdin?.end();
      }
      child.once("error", (error) =>
        send({ stderr: Buffer.from(error.message).toString("base64"), code: 1 }),
      );
      child.once("close", (code) => {
        children.delete(child!);
        void Promise.resolve(options.afterOperation?.(message.args, output))
          .then(() => {
            if (isProcessListCommand && output) {
              send({ stdout: Buffer.from(output).toString("base64") });
            }
            send({ code: code ?? 1 });
          })
          .catch((error) =>
            send({ stderr: Buffer.from(String(error)).toString("base64"), code: 1 }),
          );
      });
    }
    async function handleMessage(line: string): Promise<void> {
      const message = JSON.parse(line) as {
        token?: string;
        args?: string[];
        cwd?: string;
        stdin?: string;
        end?: boolean;
      };
      if (authorized) {
        forwardStdin(message);
        return;
      }
      if (
        message.token !== token ||
        !Array.isArray(message.args) ||
        !message.args.every((arg) => typeof arg === "string") ||
        typeof message.cwd !== "string"
      ) {
        throw new Error("Invalid sandbox engine authorization");
      }
      authorized = true;
      await startAuthorizedOperation({ args: message.args, cwd: message.cwd });
    }
    lines.on("line", (line) => {
      void handleMessage(line).catch((error) =>
        send({ stderr: Buffer.from(String(error)).toString("base64"), code: 1 }),
      );
    });
    socket.once("close", () => {
      lines.close();
      connections.delete(socket);
      if (child?.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, resolve);
  });
  await chmod(options.socketPath, 0o600);
  return {
    environment: { PI_SANDBOX_SOCKET: options.socketPath, PI_SANDBOX_TOKEN: token },
    async close() {
      for (const socket of connections) {
        socket.destroy();
      }
      for (const child of children) {
        child.kill("SIGKILL");
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(options.socketPath).catch(() => {});
    },
  };
}
