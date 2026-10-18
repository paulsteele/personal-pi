import { afterEach, expect, it } from "vitest";
import {
  REDACTED_VALUE,
  redactSecretValues,
  secretEnvironmentValues,
} from "../src/sandbox/log-redaction.ts";

afterEach(() => {
  delete process.env.PI_REDACTION_TEST_TOKEN;
});

it("collects container, remote, and approved host environment values", () => {
  process.env.PI_REDACTION_TEST_TOKEN = "host-token-value";
  const values = secretEnvironmentValues({
    definition: {
      containerEnv: { API_KEY: "container-secret" },
      remoteEnv: { REMOTE_KEY: "remote-secret", UNSET: null },
    } as never,
    hostEnvironment: ["PI_REDACTION_TEST_TOKEN", "PI_REDACTION_MISSING"],
  });
  expect(values).toEqual(["container-secret", "remote-secret", "host-token-value"]);
});

it("ignores values too short to redact without mangling unrelated output", () => {
  const values = secretEnvironmentValues({
    definition: { containerEnv: { DEBUG: "1", MODE: "dev", TOKEN: "abcd" } } as never,
    hostEnvironment: [],
  });
  expect(values).toEqual(["abcd"]);
});

it("redacts raw and JSON-escaped secret values in log text", () => {
  const secret = 'pa"ss\\word';
  const text = `lifecycle printed ${secret}\nmerged config: ${JSON.stringify({ TOKEN: secret })}`;
  expect(redactSecretValues(text, [secret])).toBe(
    `lifecycle printed ${REDACTED_VALUE}\nmerged config: {"TOKEN":"${REDACTED_VALUE}"}`,
  );
});

it("redacts a longer secret before a shorter secret it contains", () => {
  expect(redactSecretValues("value=prefix-secret", ["prefix", "prefix-secret"])).toBe(
    `value=${REDACTED_VALUE}`,
  );
});
