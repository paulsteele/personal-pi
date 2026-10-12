import { resolve } from "node:path";
import type { DevcontainerDefinition } from "./definition.ts";

export interface DeclaredBind {
  path: string;
  destination: string;
  access: "ro" | "rw";
}

export function declaredBindMount(value: string | object, base: string): DeclaredBind {
  let type: unknown;
  let source: unknown;
  let destination: unknown;
  let readOnly = false;
  if (typeof value === "string") {
    const fields = new Map(
      value.split(",").map((field) => {
        const separator = field.indexOf("=");
        return separator < 0
          ? [field, ""]
          : [field.slice(0, separator), field.slice(separator + 1)];
      }),
    );
    const sourceFields = ["source", "src"];
    const destinationFields = ["target", "dst", "destination"];
    const readOnlyFields = ["readonly", "ro"];
    const supportedFields = [
      "type",
      ...sourceFields,
      ...destinationFields,
      ...readOnlyFields,
      "consistency",
    ];
    if ([...fields.keys()].some((field) => !supportedFields.includes(field))) {
      throw new Error("Unsupported devcontainer mount option");
    }
    type = fields.get("type");
    source = sourceFields.map((field) => fields.get(field)).find((value) => value !== undefined);
    destination = destinationFields
      .map((field) => fields.get(field))
      .find((value) => value !== undefined);
    readOnly = readOnlyFields.some((field) => fields.has(field));
  } else {
    const fields = value as {
      type?: unknown;
      source?: unknown;
      target?: unknown;
      readOnly?: unknown;
    };
    type = fields.type;
    source = fields.source;
    destination = fields.target;
    readOnly = fields.readOnly === true;
  }
  if (type !== "bind" || typeof source !== "string" || typeof destination !== "string") {
    throw new Error("V1 mount declarations require explicit bind sources and destinations");
  }
  return { path: resolve(base, source), destination, access: readOnly ? "ro" : "rw" };
}

export function declaredWorkspaceMount(
  definition: DevcontainerDefinition,
  startupDirectory: string,
): DeclaredBind {
  if (definition.workspaceMount) {
    return declaredBindMount(definition.workspaceMount, startupDirectory);
  }
  return {
    path: startupDirectory,
    destination: definition.workspaceFolder ?? startupDirectory,
    access: "rw",
  };
}
