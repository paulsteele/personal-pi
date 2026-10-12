import { expect, it } from "vitest";
import { containerIdentity } from "../src/sandbox/container-identity.ts";

it("names containers for the checkout with distinct session and generation suffixes", () => {
  const projectRoot = "/projects/pi-extensions";
  const nestedStartupDirectory = `${projectRoot}/src`;
  const firstSessionIdentity = containerIdentity({
    projectRoot,
    startupDirectory: nestedStartupDirectory,
    sessionId: "session-a",
    generation: 1,
  });
  const otherSessionIdentity = containerIdentity({
    projectRoot,
    startupDirectory: projectRoot,
    sessionId: "session-b",
    generation: 1,
  });
  const replacementGenerationIdentity = containerIdentity({
    projectRoot,
    startupDirectory: nestedStartupDirectory,
    sessionId: "session-a",
    generation: 2,
  });
  expect(firstSessionIdentity.name).toMatch(/^pi-pi-extensions-[a-f0-9]{10}-g1$/);
  expect(firstSessionIdentity.labels).toEqual({
    "pi.sandbox.project": "pi-extensions",
    "pi.sandbox.project-root": "/projects/pi-extensions",
    "pi.sandbox.startup-directory": "/projects/pi-extensions/src",
    "pi.sandbox.session": "session-a",
    "pi.sandbox.generation": "1",
  });
  expect(otherSessionIdentity.name).not.toBe(firstSessionIdentity.name);
  expect(replacementGenerationIdentity.name).toBe(firstSessionIdentity.name.replace(/g1$/, "g2"));
});

it("normalizes project names into valid Podman names while retaining exact path labels", () => {
  const projectRootWithSpecialCharacters = "/projects/My Project (test)";
  const normalizedProjectIdentity = containerIdentity({
    projectRoot: projectRootWithSpecialCharacters,
    startupDirectory: projectRootWithSpecialCharacters,
    sessionId: "a",
    generation: 1,
  });
  expect(normalizedProjectIdentity.name).toMatch(/^pi-my-project-test-[a-f0-9]{10}-g1$/);
  expect(normalizedProjectIdentity.labels["pi.sandbox.project-root"]).toBe(
    projectRootWithSpecialCharacters,
  );
});
