import { basename, posix } from "node:path";

export interface GuardPathFact {
  readonly value: string;
  readonly matchValues: readonly string[];
  readonly boundaryValue: string | null;
  readonly mountAliases: readonly string[];
  readonly mountResolutionIncomplete: boolean;
}

export interface GuardCommandFact {
  readonly text: string;
  readonly argv: readonly string[] | null;
  readonly context: string | null;
  readonly wrapperKind: string | null;
  readonly executedUnit: string | null;
}

export interface SafetyContext {
  readonly requestId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly agentName: string | null;
  readonly input: unknown;
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  readonly shell: {
    readonly command: string;
    readonly workdir: string | null;
    readonly commands: readonly GuardCommandFact[];
    readonly parseComplete: boolean;
    readonly unresolvedPathExpression?: boolean;
  } | null;
  readonly paths: readonly GuardPathFact[];
  readonly riskMarkers: readonly string[];
}

export type SafetyDecision =
  | { readonly kind: "continue"; readonly riskMarkers: readonly string[] }
  | {
      readonly kind: "require_human";
      readonly category: string;
      readonly reason: string;
      readonly riskMarkers: readonly string[];
    };

export interface SafetyEnvironment {
  readonly home: string;
  readonly xdgDataHome?: string;
  readonly credentialsDirectory?: string;
}

const SECRET_SUFFIXES = [
  ".key",
  ".pem",
  ".p8",
  ".p12",
  ".pfx",
  ".pkcs8",
  ".pkcs12",
  ".jks",
  ".keystore",
  ".crt",
  ".cer",
  ".der",
] as const;
const HOME_SECRET_DIRS = [".ssh", ".gnupg", ".aws", ".kube", ".docker", ".password-store"] as const;
const SECRET_FILES = new Set([
  ".npmrc",
  ".netrc",
  ".env",
  ".pypirc",
  ".git-credentials",
  "credentials",
  "credentials.json",
  "auth.json",
]);
const COMMON_PRIVATE_KEYS = /^(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?|.*private[-_.]?key)$/i;

function cleanPosix(value: string): string {
  // A backslash is an ordinary filename character on POSIX; never fold it.
  return posix.normalize(value);
}

function within(root: string, value: string): boolean {
  const normalizedRoot = cleanPosix(root).replace(/\/$/, "") || "/";
  const normalized = cleanPosix(value);
  return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`);
}

function pathAliases(path: GuardPathFact): readonly string[] {
  return [
    ...new Set(
      [path.value, ...path.matchValues, path.boundaryValue ?? "", ...path.mountAliases].filter(
        Boolean,
      ),
    ),
  ];
}

function sensitivePathReason(
  value: string,
  platform: NodeJS.Platform,
  environment: SafetyEnvironment,
): string | null {
  const normalized = cleanPosix(value);
  const leaf = basename(normalized).toLowerCase();
  if (SECRET_SUFFIXES.some((suffix) => leaf.endsWith(suffix)))
    return "private key or certificate file";
  if (SECRET_FILES.has(leaf) || /^\.env(?:\..+)?$/i.test(leaf) || COMMON_PRIVATE_KEYS.test(leaf))
    return "credential file";

  for (const directory of HOME_SECRET_DIRS) {
    if (within(posix.join(environment.home, directory), normalized))
      return `credential directory ${directory}`;
  }
  if (platform === "darwin") {
    if (
      within(posix.join(environment.home, "Library/Keychains"), normalized) ||
      within("/Library/Keychains", normalized) ||
      within("/System/Library/Keychains", normalized)
    )
      return "macOS keychain data";
  }
  if (platform === "linux") {
    const xdg = environment.xdgDataHome || posix.join(environment.home, ".local/share");
    const roots = [
      posix.join(xdg, "keyrings"),
      "/run/credentials",
      "/run/secrets",
      "/var/run/secrets",
      "/etc/ssl/private",
      "/etc/pki/private",
    ];
    if (environment.credentialsDirectory) roots.push(environment.credentialsDirectory);
    if (roots.some((root) => within(root, normalized))) return "Linux credential or secret root";
    if (
      [
        "/etc/shadow",
        "/etc/gshadow",
        "/var/lib/systemd/credential.secret",
        "/proc/kcore",
        "/proc/keys",
        "/dev/mem",
        "/dev/kmem",
      ].includes(normalized)
    ) {
      return "Linux system secret source";
    }
    if (/^\/etc\/ssh\/ssh_host_[^/]+_key$/.test(normalized)) return "host private key";
    if (/^\/proc\/(?:self|thread-self|\d+)\/(?:environ|mem)$/.test(normalized))
      return "process secret source";
  }
  return null;
}

function executable(argv: readonly string[]): string {
  return basename(argv[0] ?? "").toLowerCase();
}
function has(argv: readonly string[], ...flags: string[]): boolean {
  return flags.some((flag) => argv.includes(flag));
}
function subcommand(argv: readonly string[]): string {
  return argv.find((arg, index) => index > 0 && !arg.startsWith("-"))?.toLowerCase() ?? "";
}
function guardedCommand(argv: readonly string[], platform: NodeJS.Platform): string | null {
  if (argv.length === 0 || argv[0]?.includes("$") || argv[0]?.includes("`")) return null;
  const cmd = executable(argv);
  const sub = subcommand(argv);

  if (["sudo", "doas", "su", "runuser", "pkexec"].includes(cmd)) return "privilege escalation";
  if (["chown", "chgrp", "setfacl", "setcap"].includes(cmd))
    return "ownership or security mutation";
  if (
    cmd === "chmod" &&
    argv.some((arg) => /(?:^|[,=+])(?:[0-7]*[46-7][0-7]*|[ugo]*\+[stwx])/.test(arg))
  )
    return "permission mutation";

  if (cmd === "git") {
    if (sub === "push") return "VCS remote mutation";
    if (sub === "clean" && has(argv, "-f", "-fd", "-df", "-ff", "--force"))
      return "destructive VCS cleanup";
    if (sub === "reset" && has(argv, "--hard", "--merge", "--keep")) return "destructive VCS reset";
    if (
      ["checkout", "restore"].includes(sub) &&
      has(argv, "-f", "--force", "--worktree", "--source")
    )
      return "destructive VCS checkout";
    if (
      sub === "credential" &&
      argv.some((arg) => ["fill", "approve", "reject"].includes(arg.toLowerCase()))
    )
      return "credential helper access";
  }
  if (
    ["npm", "pnpm", "yarn", "bun", "cargo"].includes(cmd) &&
    sub === "publish" &&
    !has(argv, "--dry-run")
  )
    return "package publication";
  if (cmd === "gem" && sub === "push") return "package publication";
  if (cmd === "twine" && sub === "upload") return "package publication";
  if (cmd === "dotnet" && argv.some((arg, i) => arg === "push" && argv[i - 1] === "nuget"))
    return "package publication";
  if (
    ["mvn", "mvnw", "gradle", "gradlew"].includes(cmd) &&
    argv.some((arg) => /^(?:deploy|publish)/i.test(arg))
  )
    return "artifact publication";
  if (["docker", "podman", "nerdctl"].includes(cmd)) {
    const containerWords = argv.slice(1).map((arg) => arg.toLowerCase());
    if (
      ["push", "login", "prune"].includes(sub) ||
      containerWords.includes("prune") ||
      (sub === "rm" && has(argv, "-f", "--force")) ||
      has(argv, "--privileged")
    )
      return "container or registry mutation";
  }
  if (
    ["kubectl", "oc"].includes(cmd) &&
    [
      "apply",
      "create",
      "delete",
      "edit",
      "patch",
      "replace",
      "rollout",
      "scale",
      "set",
      "taint",
      "cordon",
      "drain",
    ].includes(sub)
  )
    return "cluster mutation";
  if (cmd === "helm" && ["install", "upgrade", "uninstall", "rollback"].includes(sub))
    return "cluster release mutation";
  if (
    ["terraform", "tofu"].includes(cmd) &&
    ["apply", "destroy", "import", "taint", "untaint", "force-unlock"].includes(sub)
  )
    return "infrastructure mutation";
  if (cmd === "pulumi" && ["up", "destroy", "import", "state"].includes(sub))
    return "infrastructure mutation";
  if (["aws", "gcloud", "az", "doctl", "heroku", "flyctl", "vercel", "netlify"].includes(cmd)) {
    const words = argv.slice(1).map((arg) => arg.toLowerCase());
    if (
      words.some((arg) =>
        /^(?:(?:create|delete|remove|terminate|update|deploy|release|promote|publish)(?:-.+)?|login|.*-token|.*-credentials)$/.test(
          arg,
        ),
      )
    )
      return "cloud or deployment mutation";
  }
  if (["deploy", "release", "promote"].includes(cmd)) return "deployment mutation";

  if (
    cmd === "rm" &&
    (has(argv, "-r", "-rf", "-fr", "--recursive", "-f", "--force") ||
      argv.some((arg) => /^(?:\/|~\/)$/.test(arg)))
  )
    return "destructive filesystem removal";
  if (["shred", "wipefs", "blkdiscard"].includes(cmd) || cmd.startsWith("mkfs"))
    return "destructive filesystem or block-device operation";
  if (cmd === "dd" && argv.some((arg) => /^of=\/dev\/(?!null|stdout|stderr)/.test(arg)))
    return "destructive block-device write";
  if (["dropdb", "mysqladmin"].includes(cmd) && (cmd === "dropdb" || argv.includes("drop")))
    return "database destruction";
  if (
    ["psql", "mysql", "sqlite3"].includes(cmd) &&
    argv.some((arg) => /\bdrop\s+(?:database|schema|table)\b/i.test(arg))
  )
    return "database destruction";
  if (["lvremove", "vgremove", "pvremove"].includes(cmd)) return "volume destruction";
  if (cmd === "zfs" && sub === "destroy") return "filesystem destruction";
  if (
    cmd === "btrfs" &&
    argv.some((arg, index) => arg === "delete" && argv[index - 1] === "subvolume")
  )
    return "filesystem destruction";

  if (platform === "darwin" && cmd === "security") return "macOS keychain access";
  if (
    [
      "secret-tool",
      "kwallet-query",
      "pass",
      "gopass",
      "op",
      "bw",
      "keepassxc-cli",
      "systemd-creds",
      "ssh-add",
    ].includes(cmd)
  )
    return "credential-store access";
  if (
    ["gpg", "gpg2"].includes(cmd) &&
    argv.some((arg) => ["--export-secret-keys", "--export-secret-subkeys"].includes(arg))
  )
    return "secret-key export";
  if (cmd === "keyctl" && !["show", "list", "describe"].includes(sub))
    return "kernel-keyring access";

  if (platform === "linux") {
    if (
      ["systemctl", "service"].includes(cmd) &&
      !["status", "show", "is-active", "is-enabled", "list-units", "list-unit-files"].includes(sub)
    )
      return "service mutation";
    if (
      [
        "useradd",
        "userdel",
        "usermod",
        "groupadd",
        "groupdel",
        "groupmod",
        "passwd",
        "chpasswd",
      ].includes(cmd)
    )
      return "account mutation";
    if (
      ["apt", "apt-get", "dnf", "yum", "pacman", "zypper", "apk", "rpm", "dpkg"].includes(cmd) &&
      ["install", "remove", "purge", "upgrade", "dist-upgrade", "erase"].some((word) =>
        argv.includes(word),
      )
    )
      return "system package mutation";
    if (
      [
        "iptables",
        "ip6tables",
        "nft",
        "firewall-cmd",
        "ufw",
        "modprobe",
        "insmod",
        "rmmod",
        "mount",
        "umount",
        "swapon",
        "swapoff",
        "unshare",
        "nsenter",
      ].includes(cmd)
    )
      return "Linux system mutation";
    if (
      cmd === "sysctl" &&
      (has(argv, "-w", "--write") || argv.slice(1).some((arg) => arg.includes("=")))
    )
      return "kernel setting mutation";
  }
  return null;
}

function nonShellOperation(context: SafetyContext): string | null {
  if (context.shell) return null;
  const record =
    typeof context.input === "object" && context.input !== null
      ? (context.input as Record<string, unknown>)
      : {};
  const nested =
    typeof record.arguments === "object" && record.arguments !== null
      ? (record.arguments as Record<string, unknown>)
      : {};
  const action = [
    record.action,
    record.operation,
    record.method,
    nested.action,
    nested.operation,
  ].find((value) => typeof value === "string");
  if (typeof action !== "string") return null;
  const verb = action.toLowerCase().replace(/[_\s]+/g, "-");
  const identity = context.toolName.toLowerCase();
  // Do not assign a special policy identity to MCP tools. Any structured tool
  // action can still be a positively identified irreversible operation.
  if (!identity) return null;
  return /(?:^|-)(?:delete|destroy|drop|publish|push|deploy|apply|promote|release|rotate|revoke|create|update|patch|write|login)(?:-|$)/.test(
    verb,
  )
    ? "high-impact tool operation"
    : null;
}

export function evaluateSafety(
  context: SafetyContext,
  autoEnabled: boolean,
  environment: SafetyEnvironment,
): SafetyDecision {
  const risks = new Set(context.riskMarkers);
  for (const path of context.paths) {
    if (path.mountResolutionIncomplete) risks.add("linux-mount-alias-unresolved");
    for (const alias of pathAliases(path)) {
      const reason = sensitivePathReason(alias, context.platform, environment);
      if (reason) {
        return {
          kind: "require_human",
          category: "sensitive_path",
          reason: `Access to a ${reason} requires fresh human approval${autoEnabled ? " while auto mode is armed" : ""}.`,
          riskMarkers: [...risks],
        };
      }
    }
  }
  if (context.shell?.unresolvedPathExpression) risks.add("unresolved-path-expression");
  for (const command of context.shell?.commands ?? []) {
    if (!command.argv) {
      risks.add("unstructured-command-unit");
      continue;
    }
    const category = guardedCommand(command.argv, context.platform);
    if (category) {
      return {
        kind: "require_human",
        category: category.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
        reason: `${category} requires fresh human approval.`,
        riskMarkers: [...risks],
      };
    }
  }
  const direct = nonShellOperation(context);
  if (direct)
    return {
      kind: "require_human",
      category: "high_impact_tool",
      reason: `${direct} requires fresh human approval.`,
      riskMarkers: [...risks],
    };
  return { kind: "continue", riskMarkers: [...risks] };
}
