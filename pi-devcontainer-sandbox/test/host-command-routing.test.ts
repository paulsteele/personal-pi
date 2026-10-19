import { afterEach, expect, it, vi } from "vitest";
import { HostCommandBroker, type HostBridgeReply } from "../src/sandbox/host-command-broker.ts";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { selectDefinition, globalDefinitionPath } from "../src/sandbox/definition.ts";
import { resolveProjectLocation } from "@paulsteele/pi-project-locations";
import {
  hostCommandProfilePath,
  hostCommandProfileSchema,
  loadHostCommandProfile,
  resolveHostExecutable,
} from "../src/sandbox/host-command-profile.ts";
import { planHostCommands, rewriteHostCommands } from "../src/sandbox/host-command-plan.ts";
import { createMountGrant } from "../src/sandbox/mounts.ts";
import { runHostRoutedShell } from "../src/sandbox/host-command-runner.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const rules = [{ executable: "dotnet" }, { script: "./build.sh" }];

it("rewrites only host executable names while Bash retains operators, assignments, and redirects", async () => {
  const source =
    'echo café; MODE=Debug dotnet build "App Name.sln" | grep error && ./build.sh > build.log';
  const plan = await planHostCommands(source, rules);
  expect(
    plan.invocations.map(({ command, environmentNames }) => ({ command, environmentNames })),
  ).toEqual([
    { command: "dotnet", environmentNames: ["MODE"] },
    { command: "./build.sh", environmentNames: [] },
  ]);
  expect(rewriteHostCommands(plan, (invocation) => `bridge ${invocation.ruleIndex}`)).toBe(
    'echo café; MODE=Debug bridge 0 build "App Name.sln" | grep error && bridge 1 > build.log',
  );
});

it("rewrites nested substitutions and loop bodies without rewriting ordinary arguments", async () => {
  const source = 'echo dotnet; for mode in Debug Release; do echo "$(dotnet build "$mode")"; done';
  const plan = await planHostCommands(source, rules);
  expect(plan.invocations).toHaveLength(1);
  expect(rewriteHostCommands(plan, () => "bridge")).toBe(
    'echo dotnet; for mode in Debug Release; do echo "$(bridge build "$mode")"; done',
  );
});

it.each(['"dotnet" build', "'dotnet' test", "dotnet test < <(printf data)"])(
  "routes literal commands with supported shell syntax: %s",
  async (source) => {
    expect((await planHostCommands(source, rules)).invocations).toHaveLength(1);
  },
);

it.each([
  '"$TOOL" build',
  "dot\\net build",
  'eval "dotnet build"',
  'bash -c "dotnet build"',
  "command dotnet build",
  "env MODE=Debug dotnet build",
  "dotnet() { dotnet build; echo guest; }; dotnet build",
  "function dotnet() { echo guest; }; dotnet build",
  "function dotnet { echo guest; }; dotnet build",
  "outer() { dotnet() { printf guest; }; }; outer; dotnet build",
  "alias dotnet='echo guest'",
  "source ./build.sh",
])("leaves dynamic, wrapped, and function commands in the guest: %s", async (source) => {
  const plan = await planHostCommands(source, rules);
  expect(plan.invocations).toEqual([]);
  expect(rewriteHostCommands(plan, () => "bridge")).toBe(source);
});

it("routes literal host commands alongside unresolved and opaque guest commands", async () => {
  const source = '"$TOOL" build; bash -c "dotnet build"; dotnet test';
  const plan = await planHostCommands(source, rules);
  expect(plan.invocations.map((invocation) => invocation.command)).toEqual(["dotnet"]);
  expect(rewriteHostCommands(plan, () => "bridge")).toBe(
    '"$TOOL" build; bash -c "dotnet build"; bridge test',
  );
});

it("leaves incomplete syntax to guest Bash without partially routing it", async () => {
  const source = "dotnet build && (";
  expect(await planHostCommands(source, rules)).toEqual({ source, invocations: [] });
});

it.each(["PATH=/other dotnet build", "NODE_OPTIONS=--require=./inject.js dotnet build"])(
  "retains native lookup environment restrictions: %s",
  async (source) => {
    await expect(planHostCommands(source, rules)).rejects.toThrow("lookup environment variables");
  },
);

it.each(["NODE_PATH", "PYTHONUSERBASE"])(
  "rejects lookup environment variable assignment %s",
  async (name) => {
    await expect(planHostCommands(`${name}=/untrusted dotnet build`, rules)).rejects.toThrow(
      "lookup environment variables",
    );
  },
);

it.each([
  { command: "./构建.sh", script: "构建.sh" },
  { command: "'./build@v2.sh'", script: "build@v2.sh" },
])(
  "accepts the literal script name $command without confusing it with expansion",
  async ({ command, script }) => {
    expect((await planHostCommands(command, [{ script }])).invocations).toHaveLength(1);
    expect((await planHostCommands(command, [{ executable: "unrelated" }])).invocations).toEqual(
      [],
    );
  },
);

it("leaves arbitrary shell syntax unchanged when the project has no host rules", async () => {
  const source = 'bash -c "echo guest"';
  expect(await planHostCommands(source, [])).toEqual({ source, invocations: [] });
});

it.each([
  { hostCommands: [{ script: "../build.sh" }] },
  { hostCommands: [{ script: "/host/build.sh" }] },
  { hostCommands: [{ executable: "dotnet;sh" }] },
  { hostCommands: [{ executable: "dotnet", script: "build.sh" }] },
])("rejects invalid private rule shapes: %j", (profile) => {
  expect(hostCommandProfileSchema.safeParse(profile).success).toBe(false);
});

async function routingFixture(guestRoot?: string) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "host-command-routing-")));
  directories.push(directory);
  const root = join(directory, "project");
  const agentDir = join(directory, "agent");
  await mkdir(root);
  await mkdir(agentDir);
  const project = { kind: "projects" as const, id: "a".repeat(64), root };
  const profilePath = hostCommandProfilePath(agentDir, project);
  await mkdir(join(agentDir, "extensions/pi-devcontainer-sandbox"), { recursive: true });
  await mkdir(dirname(profilePath), { recursive: true });
  const executable = join(root, "build.sh");
  await writeFile(
    executable,
    '#!/bin/bash\nprintf "host:%s:%s:%s\\n" "$PWD" "${PI_ROUTING_TEST_MODE:-default}" "$*"\n',
  );
  await chmod(executable, 0o755);
  await writeFile(
    profilePath,
    JSON.stringify({
      hostCommands: [{ script: "./build.sh" }, { executable: "native", path: executable }],
    }),
  );
  const mount = await createMountGrant({
    path: root,
    destination: guestRoot,
    access: "rw",
    privateStorage: join(agentDir, "extensions/pi-devcontainer-sandbox"),
  });
  const profile = await loadHostCommandProfile(agentDir, project);
  const [clientScript, relayScript] = await Promise.all([
    readFile(new URL("../src/sandbox/host-command-client.py", import.meta.url), "utf8"),
    readFile(new URL("../src/sandbox/host-command-relay.py", import.meta.url), "utf8"),
  ]);
  const session = {
    options: { agentDir, resolved: { project } },
    mounts: [mount],
    filesystem: {
      canonical: async (requestedPath: string) => {
        if (!guestRoot) {
          return realpath(requestedPath);
        }
        if (requestedPath === root || requestedPath.startsWith(`${root}/`)) {
          const canonicalHostPath = await realpath(requestedPath);
          return posix.join(guestRoot, posix.relative(root, canonicalHostPath));
        }
        const correspondingHostPath = posix.join(root, posix.relative(guestRoot, requestedPath));
        await realpath(correspondingHostPath);
        return requestedPath;
      },
    },
    execute: async () => ({ code: 0, output: Buffer.alloc(0), stderr: "" }),
  };
  const run = async (source: string, signal = new AbortController().signal) =>
    runHostRoutedShell({
      session: session as never,
      options: { command: source },
      profile,
      plan: await planHostCommands(source, profile.rules),
      clientScript,
      relayScript,
      signal,
      terminateGuest: async (socketPath) => {
        await rm(socketPath, { force: true });
      },
      launch: {
        command: "python3",
        args: ["-u", "-c", "import os,sys; os.execvp(sys.argv[1],sys.argv[1:])"],
        env: { ...process.env, PI_ROUTING_TEST_MODE: "guest-only" },
        cwd: root,
      },
    });
  return { root, agentDir, project, profilePath, profile, executable, run };
}

it.each([
  { scenario: "dynamic command", command: 'TOOL=printf; "$TOOL" guest-output' },
  { scenario: "escaped command", command: "pr\\intf guest-output" },
  { scenario: "opaque shell", command: 'bash -c "printf guest-output"' },
  { scenario: "eval", command: 'eval "printf guest-output"' },
  { scenario: "prefix wrapper", command: "env MODE=Debug printf guest-output" },
  {
    scenario: "function shadowing a host executable",
    command: "native() { printf guest-output; }; native",
  },
  {
    scenario: "nested function shadowing a host executable",
    command: "outer() { native() { printf guest-output; }; }; outer; native",
  },
  {
    scenario: "function containing a host script name",
    command: "build() { ./build.sh guest-output; }; build",
  },
])("executes $scenario in the guest alongside a routed host command", async ({ command }) => {
  const fixture = await routingFixture();
  const result = await fixture.run(`${command}; ./build.sh native-output`);
  expect(result.code).toBe(0);
  expect(result.output.toString()).toContain("guest-output");
  expect(result.output.toString()).toContain(`host:${fixture.root}:default:native-output`);
  expect(result.stderr.match(/\[HOST\]/g)).toEqual(["[HOST]"]);
});

it("streams host output into a guest pipeline and preserves short-circuiting and argv quoting", async () => {
  const fixture = await routingFixture();
  const result = await fixture.run(
    'PI_ROUTING_TEST_MODE=Debug ./build.sh "two words" "$(printf three)" | grep host && printf guest',
  );
  expect(result.code).toBe(0);
  expect(result.output.toString()).toContain(`host:${fixture.root}:Debug:two words three`);
  expect(result.output.toString()).toContain("guest");
  expect(result.stderr).toContain("[HOST] ./build.sh");
});

it("keeps redirects in the guest shell and does not forward its ambient environment", async () => {
  const fixture = await routingFixture();
  const result = await fixture.run("native one > output.log && cat output.log");
  expect(result.code).toBe(0);
  expect(await readFile(join(fixture.root, "output.log"), "utf8")).toBe(
    `host:${fixture.root}:default:one\n`,
  );
});

it("forwards pipeline stdin to the native command", async () => {
  const fixture = await routingFixture();
  await writeFile(fixture.executable, "#!/bin/bash\ncat\n");
  const result = await fixture.run('printf "input data" | ./build.sh');
  expect(result.code).toBe(0);
  expect(result.output.toString()).toContain("input data");
});

it("preserves a failing host exit code and runs only the appropriate shell branch", async () => {
  const fixture = await routingFixture();
  await writeFile(fixture.executable, "#!/bin/bash\nexit 7\n");
  const failed = await fixture.run("./build.sh && printf should-not-run");
  expect(failed.code).toBe(7);
  expect(failed.output.toString()).not.toContain("should-not-run");
  const recovered = await fixture.run("./build.sh || printf recovered");
  expect(recovered.code).toBe(0);
  expect(recovered.output.toString()).toContain("recovered");
});

it("refuses host execution after the private profile changes", async () => {
  const fixture = await routingFixture();
  await writeFile(fixture.profilePath, JSON.stringify({ hostCommands: [] }));
  const result = await fixture.run("./build.sh");
  expect(result.code).toBe(125);
  expect(result.stderr).toContain("Host command rules changed");
  expect(result.output.toString()).not.toContain("host:");
});

it("authorizes only the exact configured script, including when a sibling has the same basename", async () => {
  const fixture = await routingFixture();
  await mkdir(join(fixture.root, "app"));
  await writeFile(join(fixture.root, "app/build.sh"), "#!/bin/bash\nprintf wrong-script\n");
  await chmod(join(fixture.root, "app/build.sh"), 0o755);
  const result = await fixture.run("cd app && ./build.sh");
  expect(result.code).toBe(125);
  expect(result.stderr).toContain("does not match the configured project path");
  expect(result.output.toString()).not.toContain("wrong-script");
});

it("rejects a configured script symlink that points outside the project", async () => {
  const fixture = await routingFixture();
  const outside = join(fixture.root, "../outside.sh");
  await writeFile(outside, "#!/bin/bash\necho outside\n");
  await chmod(outside, 0o755);
  await rm(fixture.executable);
  await symlink(outside, fixture.executable);
  await expect(
    resolveHostExecutable({ script: "build.sh" }, fixture.root, fixture.root, "./build.sh"),
  ).rejects.toThrow("does not match");
});

it("runs a configured script symlink whose canonical target remains inside the project", async () => {
  const fixture = await routingFixture();
  const scripts = join(fixture.root, "scripts");
  await mkdir(scripts);
  await writeFile(join(scripts, "build.sh"), "#!/bin/bash\nprintf symlink-native\n");
  await chmod(join(scripts, "build.sh"), 0o755);
  await rm(fixture.executable);
  await symlink("scripts/build.sh", fixture.executable);
  const result = await fixture.run("./build.sh");
  expect(result.code).toBe(0);
  expect(result.output.toString()).toContain("symlink-native");
});

it("maps an absolute guest script path to its configured host script", async () => {
  const fixture = await routingFixture("/workspace");
  const result = await fixture.run("/workspace/build.sh mapped");
  expect(result.code).toBe(0);
  expect(result.output.toString()).toContain(`host:${fixture.root}:default:mapped`);
});

it("selects the correct authorized script when several share a basename", async () => {
  const fixture = await routingFixture();
  await mkdir(join(fixture.root, "app"));
  await writeFile(join(fixture.root, "app/build.sh"), "#!/bin/bash\nprintf nested-host\n");
  await chmod(join(fixture.root, "app/build.sh"), 0o755);
  await writeFile(
    fixture.profilePath,
    JSON.stringify({ hostCommands: [{ script: "build.sh" }, { script: "app/build.sh" }] }),
  );
  const freshProfile = await loadHostCommandProfile(fixture.agentDir, fixture.project);
  fixture.profile.revision = freshProfile.revision;
  fixture.profile.rules = freshProfile.rules;
  const result = await fixture.run("cd app && ./build.sh");
  expect(result.code).toBe(0);
  expect(result.output.toString()).toContain("nested-host");
});

it("preserves native output inside a command substitution", async () => {
  const fixture = await routingFixture();
  await writeFile(fixture.executable, "#!/bin/bash\nprintf native-version\n");
  const result = await fixture.run('printf "version=%s" "$(./build.sh)"');
  expect(result.code).toBe(0);
  expect(result.output.toString()).toContain("version=native-version");
});

it("streams large pipeline input without overflowing startup buffers", async () => {
  const fixture = await routingFixture();
  await writeFile(fixture.executable, "#!/bin/bash\nwc -c\n");
  const result = await fixture.run("head -c 1048576 /dev/zero | ./build.sh");
  expect(result.code).toBe(0);
  expect(result.output.toString()).toContain("1048576");
});

it("finishes a guest producer when the native command closes its stdin early", async () => {
  const fixture = await routingFixture();
  await writeFile(fixture.executable, "#!/bin/bash\nhead -c 1\n");
  const result = await fixture.run("yes x | ./build.sh", AbortSignal.timeout(3000));
  expect(result.code).toBe(0);
  expect(result.output.toString()).toContain("x");
}, 5000);

it("terminates inherited-pipe descendants when the native leader exits", async () => {
  const fixture = await routingFixture();
  await writeFile(fixture.executable, "#!/bin/bash\nsleep 30 &\nprintf leader-finished\nexit 0\n");
  const result = await fixture.run("./build.sh", AbortSignal.timeout(3000));
  expect(result.code).toBe(0);
  expect(result.output.toString()).toContain("leader-finished");
}, 5000);

it("stops a guest producer while a native command stays alive with stdin closed", async () => {
  const fixture = await routingFixture();
  await writeFile(
    fixture.executable,
    "#!/bin/bash\nexec 0<&-\nsleep 0.3\nprintf native-finished\n",
  );
  const result = await fixture.run(
    "yes x | ./build.sh; printf producer-exit:%s ${PIPESTATUS[0]}",
    AbortSignal.timeout(3000),
  );
  expect(result.code).toBe(0);
  expect(result.output.toString()).toContain("native-finished");
  expect(result.output.toString()).toContain("producer-exit:141");
}, 5000);

it("keeps another native pipeline flowing while a consumer blocks on large output", async () => {
  const fixture = await routingFixture();
  await writeFile(
    fixture.executable,
    '#!/bin/bash\nif [ "$1" = flood ]; then\n  head -c 4194304 /dev/zero\nelse\n  printf independent-output\nfi\n',
  );
  const result = await fixture.run(
    "./build.sh flood | { sleep 0.2; wc -c; } & ./build.sh small; wait",
    AbortSignal.timeout(4000),
  );
  expect(result.code).toBe(0);
  expect(result.output.toString()).toContain("independent-output");
  expect(result.output.toString()).toContain("4194304");
}, 5000);

it("preserves explicit host command denies at dispatch", async () => {
  const fixture = await routingFixture();
  await writeFile(
    join(fixture.agentDir, "extensions/pi-devcontainer-sandbox/config.json"),
    JSON.stringify({ permission: { bash: "deny" } }),
  );
  const result = await fixture.run("./build.sh");
  expect(result.code).toBe(125);
  expect(result.stderr).toContain("denied by explicit policy");
});

it("denies a native argument by its canonical symlink target after guest expansion", async () => {
  const fixture = await routingFixture();
  const target = join(fixture.root, "protected.txt");
  await writeFile(target, "private source");
  await symlink("protected.txt", join(fixture.root, "public"));
  await writeFile(fixture.executable, '#!/bin/bash\ncat "$1"\n');
  await writeFile(
    join(fixture.agentDir, "extensions/pi-devcontainer-sandbox/config.json"),
    JSON.stringify({
      permission: { path: { [target]: "deny" } },
    }),
  );
  const result = await fixture.run('FILE=public; native "$FILE"');
  expect(result.code).toBe(125);
  expect(result.stderr).toContain("Host argument path denied");
  expect(result.output.toString()).not.toContain("private source");
});

it("runs an authorized native command with a sensitive symlink operand without another approval", async () => {
  const fixture = await routingFixture();
  await writeFile(join(fixture.root, ".env"), "private credential");
  await symlink(".env", join(fixture.root, "public"));
  await writeFile(fixture.executable, '#!/bin/bash\ncat "$1"\n');
  const result = await fixture.run("native public");
  expect(result.code).toBe(0);
  expect(result.output.toString()).toContain("private credential");
  expect(result.stderr).toContain("[HOST] native");
});

it("runs an authorized native command with an expanded remote-mutation subcommand without another approval", async () => {
  const fixture = await routingFixture();
  await writeFile(fixture.executable, '#!/bin/bash\nprintf "native-subcommand:%s" "$1"\n');
  await writeFile(
    fixture.profilePath,
    JSON.stringify({ hostCommands: [{ executable: "git", path: fixture.executable }] }),
  );
  const updatedProfile = await loadHostCommandProfile(fixture.agentDir, fixture.project);
  fixture.profile.rules = updatedProfile.rules;
  fixture.profile.revision = updatedProfile.revision;
  const result = await fixture.run('ACTION=push; git "$ACTION"');
  expect(result.code).toBe(0);
  expect(result.output.toString()).toContain("native-subcommand:push");
  expect(result.stderr).toContain("[HOST] git");
});

it("a private host profile selects the parent project for non-Git descendants", async () => {
  const fixture = await routingFixture();
  const project = await resolveProjectLocation(fixture.root);
  const profilePath = hostCommandProfilePath(fixture.agentDir, project);
  await mkdir(dirname(profilePath), { recursive: true });
  await writeFile(profilePath, JSON.stringify({ hostCommands: [{ script: "./build.sh" }] }));
  const global = globalDefinitionPath(fixture.agentDir);
  await mkdir(dirname(global), { recursive: true });
  await writeFile(global, '{"image":"debian"}');
  const nested = join(fixture.root, "app");
  await mkdir(nested);
  expect((await selectDefinition({ cwd: nested, agentDir: fixture.agentDir })).project).toEqual(
    project,
  );
});

it.each([
  { label: "wrong token", token: "wrong", invocation: 0, cwd: "project" },
  { label: "unknown invocation", token: "test-token", invocation: 999, cwd: "project" },
  { label: "unmapped cwd", token: "test-token", invocation: 0, cwd: "outside" },
])("rejects bridge requests outside the call's authority: $label", async (scenario) => {
  const fixture = await routingFixture();
  const replies: HostBridgeReply[] = [];
  const mountGrant = await createMountGrant({
    path: fixture.root,
    access: "rw",
    privateStorage: join(fixture.agentDir, "extensions/pi-devcontainer-sandbox"),
  });
  let complete!: () => void;
  const finished = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const broker = new HostCommandBroker({
    agentDir: fixture.agentDir,
    project: fixture.project,
    profile: fixture.profile,
    plan: await planHostCommands("./build.sh", fixture.profile.rules),
    token: "test-token",
    mounts: [mountGrant],
    canonicalGuestPath: (path) => realpath(path),
    signal: new AbortController().signal,
    send(_id, message) {
      replies.push(message);
      if (message.type === "exit") {
        complete();
      }
    },
  });
  try {
    const cwd = scenario.cwd === "project" ? fixture.root : tmpdir();
    const request = {
      type: "start" as const,
      token: scenario.token,
      invocation: scenario.invocation,
      command: "./build.sh",
      args: [],
      environment: {},
      cwd,
    };
    broker.receive(1, request);
    await finished;
    expect(replies.at(-1)).toEqual({ type: "exit", code: 125 });
    expect(replies.filter((message) => message.type === "stdout")).toEqual([]);
    await broker.close();
    broker.receive(1, { type: "stdin", data: Buffer.from("late input").toString("base64") });
    expect(replies.at(-1)).toEqual({ type: "stdin_closed" });
    broker.receive(1, { type: "stdin_end" });
    expect(replies.at(-1)).toEqual({ type: "stdin_closed" });
  } finally {
    await broker.close();
  }
});

it("does not signal completed native process identities on late disconnect or broker close", async () => {
  const fixture = await routingFixture();
  await writeFile(fixture.executable, "#!/bin/bash\nexit 0\n");
  const mount = await createMountGrant({
    path: fixture.root,
    access: "rw",
    privateStorage: join(fixture.agentDir, "extensions/pi-devcontainer-sandbox"),
  });
  let finishInvocation!: () => void;
  const broker = new HostCommandBroker({
    agentDir: fixture.agentDir,
    project: fixture.project,
    profile: fixture.profile,
    plan: await planHostCommands("./build.sh", fixture.profile.rules),
    token: "fixture",
    mounts: [mount],
    canonicalGuestPath: (path) => realpath(path),
    signal: new AbortController().signal,
    send(_id, message) {
      if (message.type === "exit") {
        finishInvocation();
      }
    },
  });
  const kill = vi.spyOn(process, "kill");
  try {
    const completedConnectionIds = [1, 2, 3];
    for (const connectionId of completedConnectionIds) {
      const completed = new Promise<void>((resolve) => {
        finishInvocation = resolve;
      });
      broker.receive(connectionId, {
        type: "start",
        token: "fixture",
        invocation: 0,
        command: "./build.sh",
        args: [],
        cwd: fixture.root,
        environment: {},
      });
      await completed;
      await broker.close();
    }
    kill.mockClear();
    for (const connectionId of completedConnectionIds) {
      broker.disconnect(connectionId);
    }
    await broker.close();
    expect(kill).not.toHaveBeenCalled();
  } finally {
    kill.mockRestore();
    await broker.close();
  }
});

it("refuses executable lookup failure rather than trying a guest or host shell fallback", async () => {
  const fixture = await routingFixture();
  const executable = { executable: "missing", path: "/nonexistent/pi-native-tool" };
  const workingDirectory = fixture.root;
  await expect(
    resolveHostExecutable(executable, fixture.root, workingDirectory, "missing"),
  ).rejects.toThrow("unavailable");
});

it("cancels a running native process instead of waiting for its sleep to finish", async () => {
  const fixture = await routingFixture();
  await writeFile(fixture.executable, "#!/bin/bash\nsleep 30\n");
  const signal = AbortSignal.timeout(300);
  await expect(fixture.run("./build.sh", signal)).rejects.toThrow();
}, 5000);
