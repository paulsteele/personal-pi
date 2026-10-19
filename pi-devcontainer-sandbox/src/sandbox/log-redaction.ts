import type { DevcontainerDefinition } from "./definition.ts";

export const REDACTED_VALUE = "<redacted>";

const shortestRedactedValueLength = 4;

export function secretEnvironmentValues(options: {
  definition: DevcontainerDefinition;
  hostEnvironment: readonly string[];
}): string[] {
  const definitionValues = [
    ...Object.values(options.definition.containerEnv ?? {}),
    ...Object.values(options.definition.remoteEnv ?? {}),
  ];
  const importedHostValues = options.hostEnvironment.map((name) => process.env[name]);
  return [...definitionValues, ...importedHostValues].filter(
    (value): value is string =>
      typeof value === "string" && value.length >= shortestRedactedValueLength,
  );
}

function jsonEscaped(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

export function redactSecretValues(text: string, secretValues: readonly string[]): string {
  const spellings = secretValues.flatMap((value) => [value, jsonEscaped(value)]);
  const longestFirst = [...new Set(spellings)].sort((left, right) => right.length - left.length);
  let redacted = text;
  for (const spelling of longestFirst) {
    redacted = redacted.split(spelling).join(REDACTED_VALUE);
  }
  return redacted;
}
