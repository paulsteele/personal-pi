import { resolve } from "node:path";
import type { DevcontainerDefinition } from "./definition.ts";

export interface DeclaredBind {
  kind: "bind";
  path: string;
  destination: string;
  access: "ro" | "rw";
}

export interface DeclaredVolume {
  kind: "volume";
  destination: string;
  access: "ro" | "rw";
}

export type DeclaredMount = DeclaredBind | DeclaredVolume;

interface NormalizedMountDeclaration {
  mountType: unknown;
  declaredSource: unknown;
  declaredDestination: unknown;
  readOnly: boolean;
}

function extractMountFieldsFromString(value: string): NormalizedMountDeclaration {
  const fields = new Map(
    value.split(",").map((field) => {
      const separator = field.indexOf("=");
      return separator < 0 ? [field, ""] : [field.slice(0, separator), field.slice(separator + 1)];
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
  const firstPresent = (names: string[]) =>
    names.map((name) => fields.get(name)).find((field) => field !== undefined);
  return {
    mountType: fields.get("type"),
    declaredSource: firstPresent(sourceFields),
    declaredDestination: firstPresent(destinationFields),
    readOnly: readOnlyFields.some((field) => fields.has(field)),
  };
}

function extractMountFieldsFromObject(value: object): NormalizedMountDeclaration {
  const fields = value as {
    type?: unknown;
    source?: unknown;
    target?: unknown;
    readOnly?: unknown;
  };
  return {
    mountType: fields.type,
    declaredSource: fields.source,
    declaredDestination: fields.target,
    readOnly: fields.readOnly === true,
  };
}

function describeDeclaration(value: string | object): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function declaredMount(value: string | object, base: string): DeclaredMount {
  const { mountType, declaredSource, declaredDestination, readOnly } =
    typeof value === "string"
      ? extractMountFieldsFromString(value)
      : extractMountFieldsFromObject(value);
  const access = readOnly ? "ro" : "rw";
  if (typeof declaredDestination !== "string" || declaredDestination === "") {
    throw new Error(`Mount declaration requires a target: ${describeDeclaration(value)}`);
  }
  if (mountType === "volume") {
    return { kind: "volume", destination: declaredDestination, access };
  }
  if (mountType !== "bind" || typeof declaredSource !== "string") {
    throw new Error(
      `Mount declarations must be binds with an explicit source or named volumes: ${describeDeclaration(value)}`,
    );
  }
  return {
    kind: "bind",
    path: resolve(base, declaredSource),
    destination: declaredDestination,
    access,
  };
}

export function declaredBindMount(value: string | object, base: string): DeclaredBind {
  const mount = declaredMount(value, base);
  if (mount.kind !== "bind") {
    throw new Error(`Expected a bind mount declaration: ${describeDeclaration(value)}`);
  }
  return mount;
}

export function declaredWorkspaceMount(
  definition: DevcontainerDefinition,
  startupDirectory: string,
): DeclaredBind {
  if (definition.workspaceMount) {
    return declaredBindMount(definition.workspaceMount, startupDirectory);
  }
  return {
    kind: "bind",
    path: startupDirectory,
    destination: definition.workspaceFolder ?? startupDirectory,
    access: "rw",
  };
}
