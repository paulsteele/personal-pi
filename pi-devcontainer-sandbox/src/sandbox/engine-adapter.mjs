#!/usr/bin/env node
import { createConnection } from "node:net";

const socket = process.env.PI_SANDBOX_SOCKET;
const token = process.env.PI_SANDBOX_TOKEN;
if (!socket || !token) {
  process.stderr.write("Sandbox engine adapter requires trusted host authorization\n");
  process.exit(1);
}
const connection = createConnection(socket);
let responseBuffer = "";
let bufferedResponseBytes = 0;
connection.on("connect", () => {
  connection.write(
    `${JSON.stringify({ token, args: process.argv.slice(2), cwd: process.cwd() })}\n`,
  );
  process.stdin.on("data", (chunk) => {
    connection.write(`${JSON.stringify({ stdin: chunk.toString("base64") })}\n`);
  });
  process.stdin.on("end", () => {
    connection.write(`${JSON.stringify({ end: true })}\n`);
  });
});
connection.on("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
connection.on("data", (chunk) => {
  bufferedResponseBytes += chunk.length;
  if (bufferedResponseBytes > 4 * 1024 * 1024) {
    connection.destroy(new Error("Sandbox adapter response exceeds its limit"));
    return;
  }
  responseBuffer += chunk.toString();
  for (;;) {
    const newline = responseBuffer.indexOf("\n");
    if (newline < 0) {
      break;
    }
    const line = responseBuffer.slice(0, newline);
    responseBuffer = responseBuffer.slice(newline + 1);
    bufferedResponseBytes = Buffer.byteLength(responseBuffer);
    try {
      const message = JSON.parse(line);
      if (message.stdout) {
        process.stdout.write(Buffer.from(message.stdout, "base64"));
      }
      if (message.stderr) {
        process.stderr.write(Buffer.from(message.stderr, "base64"));
      }
      if (typeof message.code === "number") {
        process.exitCode = message.code;
        process.stdin.pause();
        process.stdin.destroy();
        connection.end();
      }
    } catch {
      connection.destroy(new Error("Invalid sandbox adapter response"));
      process.exitCode = 1;
    }
  }
});
connection.on("close", () => {
  if (process.exitCode === undefined) {
    process.exitCode = 1;
  }
});
process.on("SIGTERM", () => connection.destroy());
process.on("SIGINT", () => connection.destroy());
