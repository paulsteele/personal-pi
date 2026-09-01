import type { PathNormalizer } from "../../path-normalizer.ts";
import { isSafeSystemPath } from "../../safe-system-paths.ts";
import type { AccessPath } from "../access-path.ts";
import { normalizePathPolicyLiteral } from "../path-normalization.ts";
import { ARG_NODE_TYPES, resolveNodeTextAlternatives, SKIP_SUBTREE_TYPES } from "./node-text.ts";
import type { TSNode } from "./parser.ts";
import {
  classifyBareTokenCandidate,
  classifyTokenAsPathCandidate,
  classifyTokenAsRuleCandidate,
} from "./token-classification.ts";
import {
  collectCommandTokens,
  collectPathCandidateTokens,
  collectRedirectTokens,
  extractCommandName,
} from "./token-collection.ts";

// ── Internal types ───────────────────────────────────────────────────────────

/**
 * The working directory in force where a path candidate appears.
 *
 * A `known` base carries an `offset` to be joined with `cwd` at resolution
 * time: a relative-or-absolute path string built by folding the literal targets
 * of current-shell `cd` commands (`""` = `cwd`); an absolute offset (from
 * `cd /abs`) ignores `cwd` at resolution time.
 * An `unknown` base marks a non-literal `cd` target (`cd "$DIR"`, `cd $(…)`,
 * `cd -`, bare `cd`, `cd ~…`) that made the effective directory unresolvable.
 */
type EffectiveBase =
  | { readonly kind: "known"; readonly offset: string }
  | { readonly kind: "unknown" };

/**
 * A path-candidate token paired with the effective working directory projected
 * onto the point in the command stream where it appears.
 */
interface PathCandidate {
  readonly token: string;
  readonly base: EffectiveBase;
}

type ShellBindings = Map<string, readonly string[] | null>;
interface ProjectionState {
  readonly base: EffectiveBase;
  readonly bindings: ShellBindings;
}

// ── Public output types ──────────────────────────────────────────────────────

export interface BashPathRuleCandidate {
  /** Raw path-like token shown in prompts, logs, and session approvals. */
  readonly token: string;
  /** The path's lexical and canonical forms for permission policy matching. */
  readonly path: AccessPath;
}

/**
 * The filesystem paths a bash program references, resolved against the working
 * directory and platform — the two typed slices {@link BashProgram} exposes.
 */
export interface ResolvedBashPaths {
  /** Deduplicated paths resolving outside the working directory (#418). */
  readonly externalPaths: readonly AccessPath[];
  /** Every path-rule token paired with its cd-aware policy values (#393). */
  readonly ruleCandidates: readonly BashPathRuleCandidate[];
  /** A path-shaped access operand still contains unresolved shell expansion. */
  readonly unresolvedPathExpression: boolean;
}

// ── Walk-time constants ──────────────────────────────────────────────────────

/** The working directory in force at the start of a program (`cwd`). */
const CWD_BASE: EffectiveBase = { kind: "known", offset: "" };

/** The effective directory after a non-literal or unresolvable `cd`. */
const UNKNOWN_BASE: EffectiveBase = { kind: "unknown" };

/**
 * Resolves the filesystem paths a parsed bash program references.
 *
 * Holds a {@link PathNormalizer} (platform + cwd baked in) as its primary
 * collaborator and answers all platform/cwd-dependent questions through it —
 * `cd`-base folding (`isAbsolute`/`joinBase`), per-candidate resolution
 * (`forPath`/`forLiteral`/`resolveBase`), and the outside-cwd boundary
 * decision — so no walk step re-reads the platform or threads the cwd.
 *
 * A bare token that fails both shape gates is admitted when the normalizer's
 * existence probe says it names a real filesystem entry (ADR 0009, #645). The
 * resolver consults no ruleset: candidacy is a filesystem question, and the
 * policy decision belongs to the gates downstream.
 *
 * Tell-don't-ask: callers hand it a parsed tree and receive the resolved
 * {@link ResolvedBashPaths} slices in one {@link resolve} call; the AST walk,
 * the `cd`-folding state, and the intermediate path candidates stay private.
 * One instance per parse ({@link BashProgram.parse} constructs it with the
 * session normalizer).
 */
export class BashPathResolver {
  private unresolvedPathExpression = false;

  constructor(
    private readonly normalizer: PathNormalizer,
    private readonly workdir?: string,
  ) {}

  /**
   * Resolve a parsed bash program's path references into its external-path and
   * rule-candidate slices, walking the AST exactly once.
   *
   * When a `workdir` is set (an aliased shell tool's working directory, #574),
   * it seeds the initial effective base — as if the program were prefixed with
   * `cd <workdir>` — so relative tokens resolve against it, and the `workdir`
   * itself is added to the external paths when it resolves outside the cwd.
   * Containment is always measured against the session cwd baked into the
   * normalizer, so a `workdir` outside the cwd does not widen the sandbox.
   */
  resolve(rootNode: TSNode): ResolvedBashPaths {
    this.unresolvedPathExpression = false;
    const initialBase =
      this.workdir === undefined ? CWD_BASE : this.deriveBaseFromCdTarget(CWD_BASE, this.workdir);
    // Keep the mature cd/pipeline-aware stateless projection and augment it
    // with local-binding/control-flow candidates. Final projection deduplicates
    // overlap between the two passes.
    const candidates = [
      ...this.collectPathCandidates(rootNode, initialBase),
      ...this.collectStatefulCandidates(rootNode, initialBase),
    ];
    return {
      externalPaths: this.withWorkdirExternal(this.projectExternalPaths(candidates)),
      ruleCandidates: this.projectRuleCandidates(candidates),
      unresolvedPathExpression:
        this.unresolvedPathExpression ||
        candidates.some(({ token }) => /[$`]/.test(token) && /(?:\/|\\)/.test(token)),
    };
  }

  /**
   * Prepend the `workdir`'s own {@link AccessPath} to the external paths when it
   * resolves outside the cwd. A real `cd /etc` flags `/etc` via its argument
   * token; the seeded base carries no such token, so it is added explicitly and
   * deduplicated against the command's own external tokens (#574).
   */
  private withWorkdirExternal(tokenExternals: readonly AccessPath[]): AccessPath[] {
    if (this.workdir === undefined) return [...tokenExternals];
    const wdPath = this.normalizer.forBashToken(this.workdir);
    const canonical = wdPath.boundaryValue();
    const isExternal = canonical
      ? this.normalizer.isBoundaryOutsideWorkingDirectory(canonical)
      : true;
    if (!isExternal) return [...tokenExternals];
    const key = canonical || wdPath.value();
    const alreadyPresent = tokenExternals.some((p) => (p.boundaryValue() || p.value()) === key);
    return alreadyPresent ? [...tokenExternals] : [wdPath, ...tokenExternals];
  }

  // ── AST walk — collect PathCandidates ──────────────────────────────────

  /**
   * Walk the AST once, collecting every path-candidate token tagged with the
   * effective working directory projected onto its position.
   *
   * The effective directory is stateful: it starts at `cwd` and each
   * current-shell `cd <literal>` (joined by `&&`, `||`, `;`, or a newline)
   * folds into it for subsequent commands.
   * A `cd` inside a pipeline or a backgrounded command runs in a subshell and
   * does not update the running directory; subshell and brace-group interiors
   * inherit the enclosing base without folding their own `cd`s (a conservative
   * first tier).
   */
  private collectPathCandidates(rootNode: TSNode, initialBase: EffectiveBase): PathCandidate[] {
    const out: PathCandidate[] = [];
    this.walkForCandidates(rootNode, initialBase, out);
    return out;
  }

  /**
   * A second, execution-aware pass for shell constructs whose operands depend
   * on local scalar state. The original pass remains the broad stateless
   * collector; projection deduplication makes overlap harmless.
   */
  private collectStatefulCandidates(rootNode: TSNode, initialBase: EffectiveBase): PathCandidate[] {
    const out: PathCandidate[] = [];
    this.walkStateful(rootNode, { base: initialBase, bindings: new Map() }, out);
    return out;
  }

  private walkStateful(
    node: TSNode,
    state: ProjectionState,
    out: PathCandidate[],
  ): ProjectionState {
    const resolver = (name: string): readonly string[] | null | undefined =>
      state.bindings.get(name);
    switch (node.type) {
      case "program":
      case "list":
      case "do_group":
      case "compound_statement":
        return this.walkStatefulSequence(node, state, out);
      case "variable_assignment":
        return { ...state, bindings: updateAssignment(node, state.bindings) };
      case "variable_assignments":
      case "declaration_command": {
        let bindings = new Map(state.bindings);
        forEachNamedChild(node, (child) => {
          if (child.type === "variable_assignment") bindings = updateAssignment(child, bindings);
        });
        return { ...state, bindings };
      }
      case "unset_command": {
        const bindings = new Map(state.bindings);
        forEachNamedChild(node, (child) => {
          if (child.type === "variable_name") bindings.set(child.text, null);
        });
        return { ...state, bindings };
      }
      case "command": {
        const tokens = collectCommandTokens(node, resolver);
        if (hasUnresolvedPathToken(tokens)) this.unresolvedPathExpression = true;
        tagTokens(tokens, state.base, out);
        return { ...state, base: this.foldCd(node, state.base) };
      }
      case "file_redirect":
        tagTokens(collectRedirectTokens(node, resolver), state.base, out);
        return state;
      case "heredoc_redirect":
      case "herestring_redirect":
      case "heredoc_body":
        tagTokens(collectPathCandidateTokens(node, resolver), state.base, out);
        return state;
      case "redirected_statement":
        return this.walkStatefulSequence(node, state, out);
      case "for_statement":
        return this.walkForStatement(node, state, out);
      case "if_statement":
      case "while_statement":
      case "case_statement":
        return this.walkBranchingStatement(node, state, out);
      case "c_style_for_statement":
        return this.walkBranchingStatement(node, state, out);
      case "test_command":
        tagTokens(collectFilesystemTestTokens(node, resolver), state.base, out);
        return state;
      case "subshell":
      case "pipeline":
      case "function_definition":
        this.walkStatefulChildren(node, cloneState(state), out);
        return state;
      default:
        this.walkStatefulChildren(node, state, out);
        return state;
    }
  }

  private walkStatefulSequence(
    node: TSNode,
    state: ProjectionState,
    out: PathCandidate[],
  ): ProjectionState {
    let current = state;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child?.isNamed || SKIP_SUBTREE_TYPES.has(child.type)) continue;
      const after = this.walkStateful(child, current, out);
      current = isBackgrounded(node, i) ? current : after;
    }
    return current;
  }

  private walkStatefulChildren(
    node: TSNode,
    state: ProjectionState,
    out: PathCandidate[],
  ): ProjectionState {
    let current = state;
    forEachNamedChild(node, (child) => {
      if (!SKIP_SUBTREE_TYPES.has(child.type)) current = this.walkStateful(child, current, out);
    });
    return current;
  }

  private walkForStatement(
    node: TSNode,
    state: ProjectionState,
    out: PathCandidate[],
  ): ProjectionState {
    const resolver = (name: string): readonly string[] | null | undefined =>
      state.bindings.get(name);
    let variable: string | null = null;
    const values: string[] = [];
    let body: TSNode | null = null;
    forEachNamedChild(node, (child) => {
      if (child.type === "variable_name" && variable === null) variable = child.text;
      else if (child.type === "do_group") body = child;
      else if (ARG_NODE_TYPES.has(child.type)) {
        const resolved = resolveNodeTextAlternatives(child, resolver);
        const alternatives = resolved ?? [child.text];
        values.push(...alternatives);
        // Expanding a glob to form the iteration list reads that directory;
        // a non-glob literal is only data until the loop body uses it.
        if (/[*?[]/.test(child.text)) tagTokens(alternatives, state.base, out);
      }
    });
    if (!body || !variable) return state;
    const loopBindings = new Map(state.bindings);
    loopBindings.set(
      variable,
      values.length > 0 && values.length <= 16 ? [...new Set(values)] : null,
    );
    const after = this.walkStateful(body, { ...state, bindings: loopBindings }, out);
    return { ...state, bindings: mergeBindings([state.bindings, after.bindings]) };
  }

  private walkBranchingStatement(
    node: TSNode,
    state: ProjectionState,
    out: PathCandidate[],
  ): ProjectionState {
    // Thread one conservative execution through all executable children so an
    // assignment followed by an access in the same arm/body is visible. Merge
    // that outcome with the entry state because a branch/loop may not execute.
    let current = cloneState(state);
    forEachNamedChild(node, (child) => {
      // Case subjects/pattern values and arithmetic expressions are data, not
      // filesystem access. Executable statement containers are still walked.
      if (ARG_NODE_TYPES.has(child.type) || child.type === "variable_name") return;
      current = this.walkStateful(child, current, out);
    });
    return { ...state, bindings: mergeBindings([state.bindings, current.bindings]) };
  }

  /**
   * Collect a single node's candidates tagged with `base`, returning the
   * effective base in force *after* the node (the input base unless the node is
   * a current-shell `cd <literal>` that folds the running directory).
   */
  private walkForCandidates(
    node: TSNode,
    base: EffectiveBase,
    out: PathCandidate[],
  ): EffectiveBase {
    switch (node.type) {
      case "program":
      case "list":
      case "redirected_statement":
        return this.walkCurrentShellSequence(node, base, out);
      case "command":
        tagTokens(collectCommandTokens(node), base, out);
        return this.foldCd(node, base);
      case "pipeline":
        // tree-sitter-bash mis-groups a redirect-bearing `&&`/`;` list as the
        // first stage of a pipeline (`cd a && pnpm x 2>&1 | tail` parses as
        // `(cd a && pnpm x 2>&1) | tail`), burying a current-shell `cd` inside
        // a node the `default` case treats as non-folding. Recover bash operator
        // precedence (`|` binds tighter than `&&`/`||`/`;`): fold the first
        // stage's leading current-shell commands while keeping its terminal
        // command and every downstream stage as non-folding subshells (#454).
        return this.walkPipeline(node, base, out);
      case "subshell":
        // A subshell runs in a child shell: its interior `cd`s fold within the
        // subshell but reset on exit, so the folded base is discarded.
        this.walkCurrentShellSequence(node, base, out);
        return base;
      case "compound_statement":
        // A `{ … }` brace group runs in the current shell, so its `cd`s persist
        // to following commands — thread and return the folded base.
        return this.walkCurrentShellSequence(node, base, out);
      default:
        // Pipelines, control-flow bodies, redirect targets, and command/process
        // substitution interiors: collect every candidate in the subtree tagged
        // with the enclosing base and do not fold their internal `cd`s. (Folding
        // inside substitutions is deferred — conservative, never under-flags.)
        tagTokens(collectPathCandidateTokens(node), base, out);
        return base;
    }
  }

  /**
   * Fold a current-shell sequence (`program` / `list` / `redirected_statement`):
   * thread the effective base left-to-right through the children so a `cd`
   * updates the base for following siblings.
   * A statement immediately followed by the background operator (`&`) runs in a
   * subshell, so its folded base is discarded.
   */
  private walkCurrentShellSequence(
    seqNode: TSNode,
    base: EffectiveBase,
    out: PathCandidate[],
  ): EffectiveBase {
    let current = base;
    for (let i = 0; i < seqNode.childCount; i++) {
      const child = seqNode.child(i);
      if (!child?.isNamed) continue;
      if (SKIP_SUBTREE_TYPES.has(child.type)) continue;
      const after = this.walkForCandidates(child, current, out);
      current = isBackgrounded(seqNode, i) ? current : after;
    }
    return current;
  }

  /**
   * Walk a `pipeline` node, returning the effective base in force after it.
   *
   * Each stage of a true pipeline (`A | B | C`) runs in a subshell, so a `cd`
   * inside any stage must not leak — the base normally passes through unchanged.
   * The exception is the first stage: tree-sitter-bash wraps a redirect-bearing
   * current-shell `&&`/`;` list (`cd a && pnpm x 2>&1 | tail`) as that stage,
   * and bash precedence makes the list's leading commands current-shell, so they
   * fold and the folded base persists past the pipeline to following siblings.
   *
   * The terminal command of the first stage is the real pipe stage (a subshell)
   * and must not fold; every stage after a `|` is a downstream subshell stage
   * and collects tokens against the folded base without folding (#454).
   */
  private walkPipeline(node: TSNode, base: EffectiveBase, out: PathCandidate[]): EffectiveBase {
    let current = base;
    let first = true;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child?.isNamed) continue;
      if (SKIP_SUBTREE_TYPES.has(child.type)) continue;
      if (first) {
        current = this.foldPipelineFirstStage(child, current, out);
        first = false;
        continue;
      }
      // Downstream stage (after a `|`): subshell — collect against the folded
      // base, do not fold.
      tagTokens(collectPathCandidateTokens(child), current, out);
    }
    return current;
  }

  /**
   * Collect the first pipe stage's candidates, folding its leading current-shell
   * `cd` commands when tree-sitter wrapped a `list` or `redirected_statement`
   * around them.
   * The terminal command of that container is the real pipe stage (a subshell)
   * and is collected without folding.
   * A bare `command` first stage (a true pipeline first stage such as
   * `cd nested | cat ../b`) is a subshell: it collects against the input base
   * and does not fold.
   */
  private foldPipelineFirstStage(
    node: TSNode,
    base: EffectiveBase,
    out: PathCandidate[],
  ): EffectiveBase {
    if (node.type === "list") return this.foldListExceptTerminal(node, base, out);
    if (node.type === "redirected_statement") {
      let current = base;
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child?.isNamed) continue;
        if (child.type === "file_redirect") {
          // Redirect destinations are part of the piped stage; collect them
          // against the folded base without folding.
          tagTokens(collectRedirectTokens(child), current, out);
          continue;
        }
        // The inner statement is the `list`/`command` being redirected; fold its
        // leading current-shell commands via the terminal-excluding walk.
        current = this.foldPipelineFirstStage(child, current, out);
      }
      return current;
    }
    // Bare `command` or any other shape: a true subshell first stage.
    tagTokens(collectPathCandidateTokens(node), base, out);
    return base;
  }

  /**
   * Fold every named, non-skip child of a `list` except the last, threading the
   * effective base left-to-right through the leading current-shell commands; the
   * terminal child is the real pipe stage and is collected without folding.
   */
  private foldListExceptTerminal(
    node: TSNode,
    base: EffectiveBase,
    out: PathCandidate[],
  ): EffectiveBase {
    const namedChildren: TSNode[] = [];
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.isNamed && !SKIP_SUBTREE_TYPES.has(child.type)) {
        namedChildren.push(child);
      }
    }
    let current = base;
    for (let i = 0; i < namedChildren.length; i++) {
      const child = namedChildren[i];
      if (i < namedChildren.length - 1) {
        current = this.walkForCandidates(child, current, out);
      } else {
        // Terminal child = the real pipe stage; collect without folding.
        tagTokens(collectPathCandidateTokens(child), current, out);
      }
    }
    return current;
  }

  /**
   * Compute the effective base after a command runs.
   * Returns `base` unchanged unless the command is `cd`:
   *
   * - `cd /abs` (absolute literal) → a fresh known base, recovering from an
   *   earlier unknown base.
   * - `cd rel` (relative literal) → fold into a known base, or stay unknown if
   *   the base was already unknown.
   * - `cd "$DIR"` / `cd $(…)` / `cd -` / bare `cd` / `cd ~…` (non-literal) →
   *   unknown.
   *
   * POSIX normalization is delegated to {@link PathNormalizer}; this method
   * owns only the base-folding state.
   */
  private foldCd(commandNode: TSNode, base: EffectiveBase): EffectiveBase {
    if (extractCommandName(commandNode) !== "cd") return base;
    const target = cdLiteralTarget(commandNode);
    if (target === null) return UNKNOWN_BASE;
    return this.deriveBaseFromCdTarget(base, target);
  }

  /**
   * Fold a literal `cd`/working-directory target string into the effective
   * base, delegating POSIX normalization to {@link PathNormalizer}. Owns only
   * the base-folding state:
   *
   * - `absolute` → a fresh known base (recovers from an earlier unknown base).
   * - `unknown` → the base becomes conservatively unknown.
   * - `relative` → join into a known base, or stay unknown if already unknown.
   *
   * Shared by {@link foldCd} (inline `cd` commands) and the initial-base seed
   * (an aliased shell tool's `workdir`, an implicit leading `cd <workdir>`).
   */
  private deriveBaseFromCdTarget(base: EffectiveBase, target: string): EffectiveBase {
    const interpreted = this.normalizer.interpretBashCdTarget(target);
    switch (interpreted.kind) {
      case "absolute":
        return { kind: "known", offset: interpreted.value };
      case "unknown":
        return UNKNOWN_BASE;
      case "relative":
        if (base.kind === "unknown") return UNKNOWN_BASE;
        return {
          kind: "known",
          offset: this.normalizer.joinBase(base.offset, target),
        };
    }
  }

  // ── Projection ─────────────────────────────────────────────────────────

  /**
   * Project the collected candidates into deduplicated external paths.
   *
   * Filters candidates through the strict path classifier
   * (`classifyTokenAsPathCandidate`), resolves each against its effective working
   * directory base, and returns only paths that resolve outside the baked cwd in
   * their lexical (as-typed, normalized but not symlink-resolved) form.
   *
   * The outside-cwd decision and the dedup identity use the canonical
   * (symlink-resolved) form so `external_directory` config patterns match the
   * path as the user typed it (#418).
   */
  private projectExternalPaths(candidates: readonly PathCandidate[]): AccessPath[] {
    const seen = new Set<string>();
    const externalPaths: AccessPath[] = [];

    for (const { token, base } of candidates) {
      const candidate = classifyTokenAsPathCandidate(token);
      if (!candidate) {
        // A bare token the strict shape gate rejects can still escape the tree
        // through a symlink, so probe it and apply the ordinary boundary
        // decision to whatever it resolves to (#645).
        const probed = this.probeBareToken(token, base);
        if (probed) this.collectIfExternal(probed.path, seen, externalPaths);
        continue;
      }

      // Unknown effective directory: a relative candidate could resolve
      // anywhere, so flag it conservatively (resolved against the baked cwd
      // only for a display path). Absolute / `~` candidates are base-independent
      // below.
      if (base.kind === "unknown" && this.isRelativeCandidate(candidate)) {
        const accessPath = this.normalizer.forPath(candidate);
        const canonical = accessPath.boundaryValue();
        if (canonical && !isSafeSystemPath(canonical) && !seen.has(canonical)) {
          seen.add(canonical);
          externalPaths.push(accessPath);
        }
        continue;
      }

      const resolveBase =
        base.kind === "known" ? this.normalizer.resolveBase(base.offset) : undefined;
      this.collectIfExternal(
        this.normalizer.forBashToken(candidate, { resolveBase }),
        seen,
        externalPaths,
      );
    }

    return externalPaths;
  }

  /**
   * Record `accessPath` when it resolves outside the working directory and has
   * not already been collected.
   *
   * The boundary decision and dedup identity use the canonical
   * (symlink-resolved) form the {@link AccessPath} already derived, while the
   * stored value keeps the lexical form so config patterns match the path as
   * the user typed it (#418). A literal-only path has no canonical form, so its
   * lexical value remains the dedup identity.
   */
  private collectIfExternal(accessPath: AccessPath, seen: Set<string>, out: AccessPath[]): void {
    const lexical = accessPath.value();
    if (!lexical) return;
    const canonical = accessPath.boundaryValue();
    const isExternal = canonical
      ? this.normalizer.isBoundaryOutsideWorkingDirectory(canonical)
      : true;
    const dedupKey = canonical || lexical;
    if (isExternal && !seen.has(dedupKey)) {
      seen.add(dedupKey);
      out.push(accessPath);
    }
  }

  /**
   * Project the collected candidates into rule candidates with their cd-aware
   * policy lookup values.
   *
   * Filters candidates through the broad path classifier
   * (`classifyTokenAsRuleCandidate`), falling back to {@link probeBareToken}
   * for a bare token the broad classifier rejects for shape — admitted only
   * when it names an existing filesystem entry (#645). On POSIX `\` is a legal
   * filename character, so it remains a bare token. Pairs each qualifying token
   * with its set of policy values (absolute +
   * project-relative + raw).
   * A token after a non-literal `cd` keeps only its literal value so no
   * spurious absolute rule can match (#393).
   */
  private projectRuleCandidates(candidates: readonly PathCandidate[]): BashPathRuleCandidate[] {
    const seen = new Set<string>();
    const result: BashPathRuleCandidate[] = [];

    for (const { token, base } of candidates) {
      const shaped = classifyTokenAsRuleCandidate(token);
      const candidate =
        shaped === null
          ? this.probeBareToken(token, base)
          : { token: shaped, path: this.buildRuleCandidatePath(shaped, base) };
      if (!candidate) continue;

      const matchValues = candidate.path.matchValues();
      if (matchValues.length === 0) continue;

      const key = matchValues.join("\0");
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(candidate);
    }

    return result;
  }

  /**
   * Promote a bare token the shape gates rejected, when it names an existing
   * filesystem entry — the existence probe (ADR 0009, #645).
   *
   * Most bash argument tokens are not paths (`status`, `build`, `main`), so a
   * bare token is admitted only when the filesystem confirms it names something
   * real. Candidacy therefore comes from the filesystem and never from the
   * ruleset, which keeps the classifiers pure and lets a symlink be matched by
   * rules naming its *target* — the case raw-token matching could not see.
   *
   * Returns `null` when the token's shape rules out a path, when the effective
   * base is unknown (no concrete directory to resolve against, so the token
   * stays unpromoted per #393 conservatism), or when nothing exists at the
   * resolved location.
   *
   * Shared by both projections so a promoted token is identical whether it is
   * being matched against `path` rules or tested against the cwd boundary.
   */
  private probeBareToken(token: string, base: EffectiveBase): BashPathRuleCandidate | null {
    const bare = classifyBareTokenCandidate(token);
    if (bare === null) return null;
    if (base.kind !== "known") return null;

    const path = this.normalizer.forBashToken(bare, {
      resolveBase: this.normalizer.resolveBase(base.offset),
    });
    const lexical = path.value();
    if (!lexical || !this.normalizer.entryExists(lexical)) return null;
    return { token: bare, path };
  }

  private buildRuleCandidatePath(candidate: string, base: EffectiveBase): AccessPath {
    // An unknown base + relative candidate stays literal-only: a resolved
    // absolute or canonical alias would resolve against the wrong directory and
    // could spuriously match a rule (#393).
    if (base.kind === "unknown" && this.isRelativeCandidate(candidate)) {
      return this.normalizer.forLiteral(normalizePathPolicyLiteral(candidate));
    }

    return base.kind === "known"
      ? this.normalizer.forBashToken(candidate, {
          resolveBase: this.normalizer.resolveBase(base.offset),
        })
      : this.normalizer.forBashToken(candidate);
  }

  /**
   * True when a path candidate is relative (resolved against the effective
   * directory) rather than absolute or home-relative (`~…`), which are
   * base-independent.
   *
   * Delegates the absoluteness decision to the POSIX `PathNormalizer` rather
   * than duplicating its normalization rules.
   */
  private isRelativeCandidate(candidate: string): boolean {
    return !this.normalizer.isAbsolute(candidate) && !candidate.startsWith("~");
  }
}

// ── Pure AST/string helpers ──────────────────────────────────────────────────

/**
 * True when the statement at `index` is immediately followed by the background
 * operator (`&`) — distinct from the `&&` / `||` / `;` current-shell
 * separators.
 */
function cloneState(state: ProjectionState): ProjectionState {
  return { base: state.base, bindings: new Map(state.bindings) };
}

function forEachNamedChild(node: TSNode, visit: (child: TSNode) => void): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.isNamed) visit(child);
  }
}

function updateAssignment(node: TSNode, source: ShellBindings): ShellBindings {
  const bindings = new Map(source);
  let name: string | null = null;
  let value: TSNode | null = null;
  forEachNamedChild(node, (child) => {
    if (child.type === "variable_name" && name === null) name = child.text;
    else if (value === null) value = child;
  });
  if (!name) return bindings;
  const values = value
    ? resolveNodeTextAlternatives(value, (variable) => bindings.get(variable))
    : null;
  bindings.set(name, values && values.length <= 16 ? [...new Set(values)] : null);
  return bindings;
}

function mergeBindings(branches: readonly ShellBindings[]): ShellBindings {
  const names = new Set(branches.flatMap((branch) => [...branch.keys()]));
  const merged: ShellBindings = new Map();
  for (const name of names) {
    const values: string[] = [];
    let unknown = false;
    for (const branch of branches) {
      const branchValues = branch.get(name);
      if (!branchValues) {
        unknown = true;
        break;
      }
      values.push(...branchValues);
    }
    const unique = [...new Set(values)];
    merged.set(name, unknown || unique.length > 16 ? null : unique);
  }
  return merged;
}

function hasUnresolvedPathToken(tokens: readonly string[]): boolean {
  // Command-aware collection has already removed command names, pattern/script
  // positionals, and consumed non-file option values. A surviving expansion is
  // therefore an access-bearing operand whose value remains opaque.
  return tokens.some((token) => /[$`]/.test(token));
}

const FILE_UNARY_TESTS = new Set([
  "-a",
  "-b",
  "-c",
  "-d",
  "-e",
  "-f",
  "-g",
  "-h",
  "-k",
  "-L",
  "-N",
  "-O",
  "-p",
  "-r",
  "-s",
  "-S",
  "-u",
  "-w",
  "-x",
]);
const FILE_BINARY_TESTS = new Set(["-ef", "-nt", "-ot"]);

function collectFilesystemTestTokens(
  node: TSNode,
  resolveLocal: (name: string) => readonly string[] | null | undefined,
): string[] {
  const tokens: string[] = [];
  const walk = (current: TSNode): void => {
    if (current.type === "unary_expression") {
      const children = namedChildren(current);
      const operator = children.find((child) => child.type === "test_operator")?.text;
      if (operator && FILE_UNARY_TESTS.has(operator)) {
        const operand = children.find((child) => ARG_NODE_TYPES.has(child.type));
        const values = operand && resolveNodeTextAlternatives(operand, resolveLocal);
        if (values) tokens.push(...values);
      }
    } else if (current.type === "binary_expression") {
      const children = namedChildren(current);
      const operator = children.find((child) => child.type === "test_operator")?.text;
      if (operator && FILE_BINARY_TESTS.has(operator)) {
        for (const operand of children.filter((child) => ARG_NODE_TYPES.has(child.type))) {
          const values = resolveNodeTextAlternatives(operand, resolveLocal);
          if (values) tokens.push(...values);
        }
      }
    }
    forEachNamedChild(current, walk);
  };
  walk(node);
  return tokens;
}

function namedChildren(node: TSNode): TSNode[] {
  const result: TSNode[] = [];
  forEachNamedChild(node, (child) => result.push(child));
  return result;
}

function isBackgrounded(seqNode: TSNode, index: number): boolean {
  const next = seqNode.child(index + 1);
  if (!next || next.isNamed) return false;
  return next.type === "&";
}

function tagTokens(tokens: readonly string[], base: EffectiveBase, out: PathCandidate[]): void {
  for (const token of tokens) out.push({ token, base });
}

/**
 * Resolve the literal target of a `cd` command, or `null` when the first
 * argument is not a static literal (contains an expansion or command
 * substitution) or cannot be resolved against the working directory (`cd -`,
 * `cd ~…`, bare `cd`).
 */
function cdLiteralTarget(commandNode: TSNode): string | null {
  for (let i = 0; i < commandNode.childCount; i++) {
    const child = commandNode.child(i);
    if (!child) continue;
    if (child.type === "command_name" || child.type === "variable_assignment") continue;
    if (!child.isNamed) continue;
    // Skip the `--` end-of-flags marker; the next argument is the target.
    if (child.type === "word" && child.text === "--") continue;
    if (!ARG_NODE_TYPES.has(child.type)) return null;
    return literalTextOf(child);
  }
  return null;
}

/**
 * The literal string value of an argument node, or `null` when it contains a
 * variable expansion / command substitution or is a non-resolvable `cd`
 * destination (`-`, `~…`).
 */
function literalTextOf(node: TSNode): string | null {
  switch (node.type) {
    case "word": {
      const text = node.text;
      if (text === "-" || text.startsWith("~")) return null;
      return text;
    }
    case "raw_string": {
      const text = node.text;
      return text.length >= 2 && text.startsWith("'") && text.endsWith("'")
        ? text.slice(1, -1)
        : text;
    }
    case "concatenation": {
      let result = "";
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child) continue;
        const part = literalTextOf(child);
        if (part === null) return null;
        result += part;
      }
      return result;
    }
    case "string": {
      let result = "";
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child) continue;
        if (child.type === '"') continue;
        if (child.type !== "string_content") return null;
        result += child.text;
      }
      return result;
    }
    default:
      return null;
  }
}
