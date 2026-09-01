import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BashProgram } from "#src/access-intent/bash/program.ts";
import { PathNormalizer } from "#src/path-normalizer.ts";

const normalizer = new PathNormalizer("/repo");
const ssh = (suffix: string) => join(homedir(), ".ssh", suffix);
const tokens = async (command: string) =>
  (await BashProgram.parse(command, normalizer)).pathRuleCandidates().map(({ token }) => token);

describe("BashProgram compound safety projection", () => {
  it("keeps direct HOME path projection", async () => {
    expect(await tokens('cat "$HOME"/.ssh/*.pub')).toContain(ssh("*.pub"));
  });

  it("projects for/select iterables and their loop bindings", async () => {
    for (const keyword of ["for", "select"]) {
      const command = `${keyword} key in "$HOME"/.ssh/*.pub; do cat "$key"; done`;
      expect(await tokens(command)).toContain(ssh("*.pub"));
    }
  });

  it("projects filesystem operands in bracket conditions", async () => {
    for (const command of [
      'if [ -f "$HOME"/.ssh/id ]; then :; fi',
      'until [[ -f "$HOME"/.ssh/id ]]; do :; done',
    ]) {
      expect(await tokens(command)).toContain(ssh("id"));
    }
  });

  it("propagates statically known scalar assignments and declarations", async () => {
    for (const command of [
      'key="$HOME"/.ssh/id; cat "$key"',
      'export key="$HOME"/.ssh; cat "$key"/*.pub',
    ]) {
      expect(await tokens(command)).toContain(command.includes("*.pub") ? ssh("*.pub") : ssh("id"));
    }
  });

  it("handles branch alternatives without dropping a possible sensitive binding", async () => {
    const command = 'key=/tmp/x; if true; then key="$HOME"/.ssh/id; fi; cat "$key"';
    expect(await tokens(command)).toContain(ssh("id"));
  });

  it("does not project assignment-only values, plain loop data, or case patterns as access", async () => {
    expect(await tokens('key="$HOME"/.ssh/id')).not.toContain(ssh("id"));
    expect(await tokens('for key in "$HOME"/.ssh/id; do :; done')).not.toContain(ssh("id"));
    expect(await tokens('case x in "$HOME"/.ssh/*) :;; esac')).not.toContain(ssh("*"));
  });

  it("projects an assignment consumed later in the same branch body", async () => {
    expect(await tokens('if true; then key="$HOME"/.ssh/id; cat "$key"; fi')).toContain(ssh("id"));
  });

  it("does not leak subshell bindings into the parent shell", async () => {
    const command = 'key=/tmp/x; (key="$HOME"/.ssh/id); cat "$key"';
    expect(await tokens(command)).not.toContain(ssh("id"));
  });

  it("invalidates unset and unknown assignments", async () => {
    for (const command of [
      'key="$HOME"/.ssh/id; unset key; cat "$key"',
      'key=$unknown; cat "$key"',
    ]) {
      const program = await BashProgram.parse(command, normalizer);
      expect(program.pathRuleCandidates().map(({ token }) => token)).not.toContain(ssh("id"));
      expect(program.hasUnresolvedPathExpression()).toBe(true);
    }
  });

  it("does not turn command-prefix environment values into accesses", async () => {
    expect(await tokens('KEY="$HOME"/.ssh/id env')).not.toContain(ssh("id"));
  });

  it("bounds local alternatives and marks an over-wide access unresolved", async () => {
    const choices = Array.from({ length: 17 }, (_, index) => `/tmp/${index}`).join(" ");
    const program = await BashProgram.parse(
      `for key in ${choices}; do cat "$key"; done`,
      normalizer,
    );
    expect(program.hasUnresolvedPathExpression()).toBe(true);
  });

  it("retains outer compound units and enumerates guarded inner commands", async () => {
    for (const command of [
      "if true; then git push; fi",
      "while false; do git push; done",
      "until false; do git push; done",
      "case x in x) git push;; esac",
      "{ git push; }",
      "f() { git push; }; f",
    ]) {
      const guards = (await BashProgram.parse(command, normalizer)).guardCommands();
      expect(guards[0]?.argv).toBeUndefined();
      expect(guards).toEqual(
        expect.arrayContaining([expect.objectContaining({ argv: ["git", "push"] })]),
      );
    }
  });
});
