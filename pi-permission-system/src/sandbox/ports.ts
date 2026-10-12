import { spawn } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { z } from "zod";
import { cliHostEnvironment } from "./devcontainer-cli.ts";

export const forwardedPortSchema = z.number().int().min(1).max(65535);

export function devcontainerPorts(values: readonly (number | string)[]): number[] {
  return [
    ...new Set(
      values.map((value) => {
        const port = typeof value === "number" ? value : Number(value.replace(/^localhost:/, ""));
        return forwardedPortSchema.parse(port);
      }),
    ),
  ];
}

const forwardingScript = `import os
import socket
import sys
import threading

socket_connection = socket.create_connection(("127.0.0.1", int(sys.argv[1])))

def receive_from_socket():
    while True:
        data = socket_connection.recv(65536)
        if not data:
            break
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
    sys.stdout.close()
    os._exit(0)

receiver = threading.Thread(target=receive_from_socket, daemon=True)
receiver.start()

while True:
    data = sys.stdin.buffer.read1(65536)
    if not data:
        break
    socket_connection.sendall(data)

socket_connection.shutdown(socket.SHUT_WR)
receiver.join()
socket_connection.close()`;

export async function startLoopbackForwarders(options: {
  container: string;
  user: string;
  ports: readonly number[];
  executable?: string;
}): Promise<{ close(): Promise<void> }> {
  const servers: Server[] = [];
  const connections = new Set<Socket>();
  const close = async () => {
    for (const socket of connections) {
      socket.destroy();
    }
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  };
  try {
    for (const requestedPort of options.ports) {
      const port = forwardedPortSchema.parse(requestedPort);
      const server = createServer((socket) => {
        connections.add(socket);
        const child = spawn(
          options.executable ?? "podman",
          [
            "exec",
            "-i",
            "--user",
            options.user,
            options.container,
            "python3",
            "-u",
            "-c",
            forwardingScript,
            String(port),
          ],
          {
            env: cliHostEnvironment(),
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        socket.pipe(child.stdin);
        child.stdout.pipe(socket);
        child.stderr.resume();
        child.stdin.on("error", () => socket.destroy());
        child.on("error", () => socket.destroy());
        child.on("close", () => socket.destroy());
        socket.on("error", () => {});
        socket.on("close", () => {
          connections.delete(socket);
          child.kill("SIGKILL");
        });
      });
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
    }
    return { close };
  } catch (error) {
    await close();
    throw error;
  }
}
