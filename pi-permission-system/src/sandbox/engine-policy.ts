import { isAbsolute, resolve } from "node:path";
import { type MountGrant, mountArgument, validateMountTopology } from "./mounts.ts";
import {
  toolImageMountsSchema,
  toolImageMountArgument,
  type ToolImageMount,
} from "./tool-image-mounts.ts";

export interface EngineAuthority {
  label: string;
  containerName: string;
  containerLabels: Record<string, string>;
  containers: string[];
  images: string[];
  imageNames: string[];
  contexts: string[];
  containerfiles: string[];
  mounts: MountGrant[];
  volumes: string[];
  toolImageMounts?: ToolImageMount[];
  ports: number[];
  environment: Record<string, string>;
  users: string[];
}

function optionValue(
  args: string[],
  index: number,
): { name: string; value: string; consumed: number } {
  const argument = args[index];
  const separator = argument.indexOf("=");
  if (separator !== -1) {
    return {
      name: argument.slice(0, separator),
      value: argument.slice(separator + 1),
      consumed: 1,
    };
  }
  const value = args[index + 1];
  if (value === undefined) {
    throw new Error(`Missing engine option value: ${argument}`);
  }
  return { name: argument, value, consumed: 2 };
}

function requireOwnedObject(value: string, allowed: readonly string[], kind: string): void {
  if (!allowed.includes(value)) {
    throw new Error(`Engine ${kind} is outside the approved sandbox scope: ${value}`);
  }
}

function validateRunArguments(args: string[], authority: EngineAuthority): string[] {
  let index = 1;
  validateMountTopology(authority.mounts);
  const toolMounts = toolImageMountsSchema.parse(authority.toolImageMounts ?? []);
  const approvedMounts = new Set([...authority.mounts.map(mountArgument), ...authority.volumes]);
  const seenDestinations = new Set<string>();
  for (; index < args.length && args[index].startsWith("-"); ) {
    const argument = args[index];
    if (["--sig-proxy=false", "--init", "-d", "--detach"].includes(argument)) {
      index++;
      continue;
    }
    const option = optionValue(args, index);
    if (option.name === "--mount") {
      const normalized = option.value.replace(/,consistency=(?:cached|delegated|consistent)/g, "");
      if (!approvedMounts.has(normalized)) {
        throw new Error(`Unapproved engine mount: ${option.value}`);
      }
      const destination = /(?:target|dst|destination)=([^,]+)/.exec(normalized)?.[1];
      if (!destination || seenDestinations.has(destination)) {
        throw new Error("Duplicate or missing engine mount destination");
      }
      seenDestinations.add(destination);
    } else if (option.name === "-l" || option.name === "--label") {
      const approvedIdentityLabel = Object.entries(authority.containerLabels).some(
        ([name, value]) => option.value === `${name}=${value}`,
      );
      if (
        !option.value.startsWith("devcontainer.") &&
        option.value !== authority.label &&
        !approvedIdentityLabel
      ) {
        throw new Error(`Unapproved container label: ${option.value}`);
      }
    } else if (option.name === "-a" || option.name === "--attach") {
      if (!["STDOUT", "STDERR", "stdout", "stderr"].includes(option.value)) {
        throw new Error("Unsupported engine attach stream");
      }
    } else if (option.name === "--entrypoint") {
      if (option.value !== "/bin/sh") {
        throw new Error("Only the reference CLI entrypoint is supported");
      }
    } else if (option.name === "-u" || option.name === "--user") {
      requireOwnedObject(option.value, authority.users, "container user");
    } else if (option.name === "-e" || option.name === "--env") {
      const separator = option.value.indexOf("=");
      const name = option.value.slice(0, separator);
      const value = option.value.slice(separator + 1);
      if (
        separator < 1 ||
        !Object.hasOwn(authority.environment, name) ||
        authority.environment[name] !== value
      ) {
        throw new Error("Container environment differs from its approved configuration");
      }
    } else if (option.name === "-p" || option.name === "--publish") {
      const port = /^127\.0\.0\.1:(\d+):(\d+)$/.exec(option.value);
      if (!port || port[1] !== port[2] || !authority.ports.includes(Number(port[2]))) {
        throw new Error(`Only approved loopback ports may be published: ${option.value}`);
      }
    } else {
      throw new Error(`Unsupported or unsafe engine runtime option: ${argument}`);
    }
    index += option.consumed;
  }
  requireOwnedObject(args[index], [...authority.images, ...authority.imageNames], "image");
  const options = args.slice(1, index);
  return [
    args[0],
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--network=bridge",
    "--no-hosts",
    "--name",
    authority.containerName,
    ...containerLabelArguments(authority.containerLabels),
    "--label",
    authority.label,
    ...options,
    ...toolMounts.flatMap((mount) => ["--mount", toolImageMountArgument(mount)]),
    ...args.slice(index),
  ];
}

function containerLabelArguments(labels: Record<string, string>): string[] {
  return Object.entries(labels).flatMap(([name, value]) => ["--label", `${name}=${value}`]);
}

function validateBuildArguments(args: string[], cwd: string, authority: EngineAuthority): void {
  let index = 1;
  for (; index < args.length - 1; ) {
    const argument = args[index];
    if (["--no-cache", "--pull", "--layers"].includes(argument)) {
      index++;
      continue;
    }
    const option = optionValue(args, index);
    if (["-f", "--file"].includes(option.name)) {
      requireOwnedObject(resolve(cwd, option.value), authority.containerfiles, "Containerfile");
    } else if (["-t", "--tag"].includes(option.name)) {
      requireOwnedObject(option.value, authority.imageNames, "build tag");
    } else if (["--build-arg", "--target", "--label", "--platform"].includes(option.name)) {
      if (option.value.includes("\0")) {
        throw new Error("Invalid build option");
      }
    } else {
      throw new Error(`Unsupported or unsafe engine build option: ${argument}`);
    }
    index += option.consumed;
  }
  const context = args[index];
  if (!context || !isAbsolute(resolve(cwd, context))) {
    throw new Error("Missing build context");
  }
  requireOwnedObject(resolve(cwd, context), authority.contexts, "build context");
}

export function authorizeEngineArguments(
  args: string[],
  cwd: string,
  authority: EngineAuthority,
): string[] {
  if (args.some((argument) => argument.includes("\0"))) {
    throw new Error("Invalid engine argument");
  }
  const command = args[0];
  if (command === "-v" && args.length === 1) {
    return args;
  }
  if (["version", "info"].includes(command) && args.length <= 3) {
    return args;
  }
  if (command === "ps" || command === "events") {
    if (
      args.some(
        (argument) =>
          ![
            "--all",
            "-a",
            "-q",
            "--quiet",
            "--format",
            "json",
            "--filter",
            "--since",
            "--until",
            "--stream=false",
            "--format=json",
            "{{json .}}",
          ].includes(argument) &&
          !argument.startsWith("label=") &&
          !argument.startsWith("event=") &&
          !/^\d/.test(argument) &&
          argument !== command,
      )
    ) {
      throw new Error("Unsupported engine discovery options");
    }
    return [...args, "--filter", `label=${authority.label}`];
  }
  if (command === "pull" && args.length === 2) {
    requireOwnedObject(args[1], authority.imageNames, "pull reference");
    return args;
  }
  if (command === "inspect") {
    const targets = args
      .slice(1)
      .filter((argument) => argument !== "--type" && !["container", "image"].includes(argument));
    for (const target of targets) {
      requireOwnedObject(
        target,
        [...authority.containers, ...authority.images, ...authority.imageNames],
        "inspection target",
      );
    }
    return args;
  }
  if (command === "build") {
    validateBuildArguments(args, cwd, authority);
    if (args.includes("--layers")) {
      return args;
    }
    const buildArgumentsWithLayers = [args[0], "--layers", ...args.slice(1)];
    return buildArgumentsWithLayers;
  }
  if (command === "run" || command === "create") {
    return validateRunArguments(args, authority);
  }
  if (command === "start" && args.length === 2) {
    requireOwnedObject(args[1], authority.containers, "container");
    return args;
  }
  if (command === "exec") {
    let index = 1;
    for (; index < args.length && args[index].startsWith("-"); ) {
      if (["-i", "-t", "-it"].includes(args[index])) {
        index++;
        continue;
      }
      const option = optionValue(args, index);
      if (!["-u", "--user", "-e", "--env", "-w", "--workdir"].includes(option.name)) {
        throw new Error("Unsupported engine exec option");
      }
      if (/^PI_SANDBOX_(?:SOCKET|TOKEN)=/.test(option.value)) {
        throw new Error("Cannot expose broker authentication to guest execution");
      }
      index += option.consumed;
    }
    requireOwnedObject(args[index], authority.containers, "execution container");
    return args;
  }
  throw new Error(`Unsupported engine command: ${command}`);
}
