import { getParser, type TSNode } from "../access-intent/bash/parser.ts";
import { matchesHostCommand, type HostCommandRule } from "./host-command-profile.ts";

export interface HostInvocation {
  ruleIndex: number;
  command: string;
  environmentNames: string[];
  startIndex: number;
  endIndex: number;
}
export interface HostCommandPlan {
  source: string;
  invocations: HostInvocation[];
}

function children(node: TSNode): TSNode[] {
  const result: TSNode[] = [];
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index);
    if (child) {
      result.push(child);
    }
  }
  return result;
}

function literalCommand(node: TSNode): string | undefined {
  const text = node.text;
  if (/^[^\s'"\\$`*?\[\]{}<>|&;()]+$/u.test(text)) {
    return text;
  }
  if (/^'[^']*'$/u.test(text)) {
    return text.slice(1, -1);
  }
  if (/^"[^"\\$`]*"$/u.test(text)) {
    return text.slice(1, -1);
  }
  return undefined;
}

const opaqueCommands = new Set([
  "eval",
  "source",
  ".",
  "bash",
  "sh",
  "zsh",
  "env",
  "sudo",
  "command",
  "exec",
  "alias",
]);
const protectedEnvironmentNames =
  /^(PATH|HOME|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|PYTHONUSERBASE|LD_.*|DYLD_.*)$/;

export async function planHostCommands(
  source: string,
  rules: HostCommandRule[],
): Promise<HostCommandPlan> {
  if (!rules.length) {
    return { source, invocations: [] };
  }
  const parser = await getParser();
  const tree = parser.parse(source);
  if (!tree || tree.rootNode.hasError) {
    tree?.delete();
    throw new Error("Host routing requires complete Bash syntax");
  }
  const invocations: HostInvocation[] = [];
  try {
    const visit = (node: TSNode): void => {
      if (node.type === "function_definition") {
        throw new Error("Shell functions are unsupported with host routing; use separate calls");
      }
      if (node.type === "command") {
        const parts = children(node);
        const name = parts.find((child) => child.type === "command_name");
        if (name) {
          const command = literalCommand(name);
          if (!command) {
            throw new Error("Dynamic executable names are unsupported with host routing");
          }
          if (opaqueCommands.has(command)) {
            throw new Error(`Opaque shell execution is unsupported with host routing: ${command}`);
          }
          const ruleIndex = rules.findIndex((rule) => matchesHostCommand(rule, command));
          if (ruleIndex !== -1) {
            const environmentNames = parts
              .filter((child) => child.type === "variable_assignment")
              .map((assignment) => assignment.text.split("=", 1)[0]!);
            if (
              environmentNames.some(
                (name) =>
                  !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || protectedEnvironmentNames.test(name),
              )
            ) {
              throw new Error(
                "Host commands cannot override shell/runtime lookup environment variables",
              );
            }
            invocations.push({
              ruleIndex,
              command,
              environmentNames,
              startIndex: name.startIndex,
              endIndex: name.startIndex + name.text.length,
            });
          }
        }
      }
      for (const child of children(node)) {
        visit(child);
      }
    };
    visit(tree.rootNode);
    return { source, invocations };
  } finally {
    tree.delete();
  }
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function rewriteHostCommands(
  plan: HostCommandPlan,
  bridgeCommand: (invocation: HostInvocation) => string,
): string {
  let source = plan.source;
  for (const invocation of [...plan.invocations].sort(
    (left, right) => right.startIndex - left.startIndex,
  )) {
    source =
      source.slice(0, invocation.startIndex) +
      bridgeCommand(invocation) +
      source.slice(invocation.endIndex);
  }
  return source;
}
