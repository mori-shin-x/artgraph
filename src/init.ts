import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  DEFAULT_CONFIG,
  type ArtgraphConfig,
  type ArtifactGraph,
  type IntegrateResult,
  type PackageManager,
  type ScanSummary,
  type SddToolInfo,
  type DetectionResult,
  type InitOptions,
} from "./types.js";
import { type AgentId, type AgentDescriptor, findDescriptor } from "./agents/descriptors.js";
import { scan, reconcile } from "./scan.js";
import type { BuildWarning } from "./graph/builder.js";
import { getProviderStatuses, runIntegrate } from "./integrate/index.js";
import { detectPackageManager, execPrefix } from "./package-manager.js";
import { loadConfig } from "./config.js";
import { readSkillSource } from "./agents/source.js";
import {
  distribute,
  DistributionError,
  preflightDistribution,
  type DistributeResult,
} from "./agents/distribute.js";
import {
  writeAgentsMd,
  writeGitAttributes,
  writeWrapper,
  type WriteResult,
} from "./agents/agent-context.js";
import { atomicWriteFile } from "./integrate/atomic-write.js";
import { renderTemplate } from "./template.js";

// `templates/skills/` lives next to `dist/`, so resolve relative to the
// compiled module path (works for both `dist/init.js` and `src/init.ts` via
// ts-node / vitest).
const SKILLS_TEMPLATE_DIR = resolve(import.meta.dirname, "../templates/skills");
const HOOKS_TEMPLATE_PATH = resolve(
  import.meta.dirname,
  "../templates/hooks/settings.json.template",
);

/**
 * Retained for spec 013 source.ts — the new per-agent `distribute()` path uses
 * `DistributionError` for write-time failures, but `readSkillSource()` still
 * throws this class when the canonical templates tree is missing or malformed
 * (a packaging fault). Keeping the class here keeps the import path stable for
 * the existing test suite.
 */
export class SkillsInstallError extends Error {
  readonly partiallyInstalled: string[];
  constructor(message: string, partiallyInstalled: string[] = []) {
    super(message);
    this.name = "SkillsInstallError";
    this.partiallyInstalled = partiallyInstalled;
  }
}

export interface InitResult {
  configPath: string;
  config: ArtgraphConfig;
  sddTools: SddToolInfo[];
  scanSummary?: ScanSummary;
  warnings: BuildWarning[];
  lockPath?: string;
  /**
   * Backward-compat field: relative POSIX paths of every Skill file written
   * into `.claude/skills/` when `claude` is one of the selected agents. The
   * CLI text/JSON formatter still consumes this for the "Installed N Claude
   * Code skills" output. For per-agent detail, see `agentDistributions`.
   *
   * Populated as `[...writtenPaths, ...noopPaths]` so an idempotent re-run
   * still reports the full file list (legacy `installSkills` errored on
   * conflict, so a "noop" result never existed there; we collapse both into
   * one list here to preserve the same surface).
   *
   * Absent when `claude` is not in `options.agents` or when the Skills stage
   * is gated off (`--no-skills`, `--minimal`, etc.).
   */
  skillsInstalled?: string[];
  /**
   * spec 013 (T010) — per-agent distribute() summary. Keyed by `AgentId`, so a
   * `--agents=claude,codex` run gets two entries. Paths are absolute (mirrors
   * `DistributeResult.writtenPaths` / `noopPaths`). Empty `{}` (not undefined)
   * when the Skills stage ran with zero agents (only possible programmatically;
   * the CLI rejects that combination).
   */
  agentDistributions?: Record<string, { writtenPaths: string[]; noopPaths: string[] }>;
  /**
   * spec 013 (T021) — per-file outcome for the agent-context stage. One entry
   * each for AGENTS.md and any wrapper file that ran. `written: false` marks
   * files that were already byte-identical on disk (idempotent re-run).
   */
  agentContextWritten?: { path: string; written: boolean }[];
  /**
   * Per-provider result for the auto-detect integrations run as part of
   * `init` (FR-022/023/024). Empty / undefined when no SDD tool was
   * detected or the integrate stage was gated off.
   *
   * `id` is included alongside the `IntegrateResult` so the formatter can
   * still report providers that were skipped (no IntegrateResult emitted)
   * via the `integrationWarnings` array.
   */
  integrationResults?: IntegrateResult[];
  /**
   * Human-readable warnings emitted while running the auto-detect
   * integrations. These never fail the init itself but are surfaced in the
   * CLI output.
   */
  integrationWarnings?: string[];
  /**
   * Number of integration providers that threw an exception during
   * `runAutoIntegrations`. Only hard provider failures are counted here.
   * The CLI uses this to translate provider
   * failures into a non-zero exit code, per
   * `specs/012-skills-expansion/contracts/cli-flags.md` ("statement step
   * failure" must exit 1).
   */
  integrationFailureCount?: number;
  /**
   * Structured outcome of the Stop-hook install stage (FR-012/013,
   * specs/012-skills-expansion/contracts/settings-merge.md). `installHooks`
   * only returns this data — it never writes to stdout/stderr. Formatting
   * the text/JSON output (success messages, the Case D warning block, exit
   * code translation) is the CLI layer's job so init.ts stays print-free.
   * Undefined when the hooks stage did not run (`--no-hooks` / `--minimal`).
   */
  hooksInstall?: {
    action:
      | "created"
      | "merged-b"
      | "merged-c"
      | "conflict"
      | "invalid-json"
      | "io-error"
      | "skipped-no-pm";
    /** Detail for conflict/error outcomes: rendered command or parse/IO error message. */
    reason?: string;
    /** true → CLI translates this into a non-zero exit code. */
    failure?: boolean;
  };
}

export function detectProject(rootDir: string): DetectionResult {
  const abs = resolve(rootDir);
  const sddTools: SddToolInfo[] = [];
  if (existsSync(resolve(abs, ".specify"))) {
    sddTools.push({ name: "Spec Kit", marker: ".specify" });
  }
  if (existsSync(resolve(abs, ".kiro"))) {
    sddTools.push({ name: "Kiro", marker: ".kiro" });
  }

  // FR-019: share the `detect` / `isInstalled` logic with `integrate` by
  // delegating to the registered providers. `getProviderStatuses` lazily
  // registers built-ins so this works even when the CLI was never imported.
  const integrations = getProviderStatuses(abs);

  return {
    hasSrc: existsSync(resolve(abs, "src")),
    hasSpecs: existsSync(resolve(abs, "specs")),
    hasDocs: existsSync(resolve(abs, "docs")),
    sddTools,
    integrations,
  };
}

export function generateConfig(detection: DetectionResult): ArtgraphConfig {
  const include = detection.hasSrc ? [...DEFAULT_CONFIG.include] : ["**/*.ts", "**/*.tsx"];

  const specDirs: string[] = [];
  if (detection.hasSpecs) specDirs.push("specs");
  if (detection.hasDocs) specDirs.push("docs");
  if (specDirs.length === 0) specDirs.push(...DEFAULT_CONFIG.specDirs);

  return {
    include,
    specDirs,
    testPatterns: [...DEFAULT_CONFIG.testPatterns],
    lockFile: DEFAULT_CONFIG.lockFile,
    // Newly-initialized projects get symbol-grain gate precision out of the
    // box; configs that omit the field keep the "file" default (loadConfig).
    mode: "symbol",
  };
}

/**
 * Decide which stages of `init` to run based on the new flag matrix
 * (spec 012-skills-expansion, contracts/cli-flags.md).
 *
 * Default (no flags) → every stage on. `--minimal` flips every gateable stage
 * off. `--no-*` flags opt out of individual stages in the default mode.
 */
export function computeStageGates(opts: InitOptions): {
  scan: boolean;
  skills: boolean;
  integrate: boolean;
  hooks: boolean;
  agentContext: boolean;
} {
  if (opts.minimal) {
    return {
      scan: false,
      skills: false,
      integrate: false,
      hooks: false,
      agentContext: false,
    };
  }

  return {
    scan: !opts.noScan,
    skills: !opts.noSkills,
    integrate: !opts.noIntegrate,
    hooks: !opts.noHooks,
    agentContext: !opts.noAgentContext,
  };
}

/**
 * Merge the artgraph Stop hook into `<rootDir>/.claude/settings.json`
 * (Claude Code specific) following the 4-case strategy in
 * specs/012-skills-expansion/contracts/settings-merge.md.
 *
 * Support for other agent environments (Cursor / Windsurf / Kiro Custom
 * Agents) is out of scope for spec 012; when a cross-agent hook spec lands,
 * this function will be renamed to `installClaudeCodeHooks` and a per-agent
 * dispatch layer will be added on top.
 *
 * Never throws: every fs / JSON / template failure is caught and converted
 * into a structured `{ action, reason?, failure? }` result so a Stop-hook
 * install problem never aborts the rest of `init` (config + Skills already
 * landed by the time this runs).
 *
 * `--force` deliberately does not reach this stage — the Case D (conflict)
 * branch always refuses; see contract §--force フラグの扱い ("settings.json
 * is the most sensitive user config; artgraph never overwrites a
 * pre-existing Stop hook, even with --force").
 */
function installHooks(
  rootDir: string,
  detectedPm: PackageManager | null,
): NonNullable<InitResult["hooksInstall"]> {
  if (detectedPm === null) {
    return { action: "skipped-no-pm", failure: false };
  }

  // Narrow the parsed template shape so downstream lookups (Case D reason,
  // Case B/C merge) work off a single typed handle rather than repeated
  // `unknown` casts.
  type RenderedTemplate = {
    hooks: {
      Stop: Array<{ hooks: Array<{ type: string; command: string }> }>;
    };
  };
  let rendered: RenderedTemplate;
  try {
    const raw = readFileSync(HOOKS_TEMPLATE_PATH, "utf-8");
    const substituted = renderTemplate(raw, { ARTGRAPH_EXEC: execPrefix(detectedPm) });
    rendered = JSON.parse(substituted) as RenderedTemplate;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { action: "io-error", reason: msg, failure: true };
  }

  const settingsPath = resolve(rootDir, ".claude", "settings.json");

  // D1: `lstatSync({ throwIfNoEntry: false })` only suppresses ENOENT — EACCES
  // / EPERM / ELOOP still throw and would escape the JSDoc "never throws"
  // contract without this try/catch. Convert any lstat failure into an
  // `io-error` result so the caller sees the same structured outcome as
  // every other fs failure in this function.
  let existingStat: ReturnType<typeof lstatSync> | undefined;
  try {
    existingStat = lstatSync(settingsPath, { throwIfNoEntry: false });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { action: "io-error", reason: msg, failure: true };
  }
  // Refuse to follow/overwrite anything that isn't a regular file (symlink,
  // directory, socket, ...). Mirrors installSkills' symlink refusal — never
  // override even with --force, since that could clobber a file outside the
  // .claude/ tree via a malicious or accidental symlink.
  if (existingStat && !existingStat.isFile()) {
    return { action: "io-error", reason: "settings.json is not a regular file", failure: true };
  }

  // B1+B2: single atomic-write helper with symmetric cleanup on failure.
  // Pre-clears any stale `.tmp` (which may itself be a symlink planted by an
  // attacker) — `unlinkSync` removes the symlink itself, not the target, so
  // the subsequent `writeFileSync` lands on a fresh regular file.
  const writeAtomic = (data: unknown): void => {
    const tmpPath = `${settingsPath}.tmp`;
    try {
      unlinkSync(tmpPath);
    } catch {
      // no stale tmp file — expected happy path
    }
    try {
      writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
      renameSync(tmpPath, settingsPath);
    } catch (e) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // best-effort cleanup — nothing to remove or a lower-level failure
      }
      throw e;
    }
  };

  // Case A: no existing settings.json — write the template verbatim.
  // `.tmp` cleanup is handled inside writeAtomic itself, so this branch is
  // now free of a redundant unlinkSync.
  if (!existingStat) {
    try {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeAtomic(rendered);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { action: "io-error", reason: msg, failure: true };
    }
    return { action: "created", failure: false };
  }

  let raw: string;
  try {
    raw = readFileSync(settingsPath, "utf-8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { action: "io-error", reason: msg, failure: true };
  }
  // Strip a leading UTF-8 BOM before parsing (same treatment as
  // package-manager.ts's packageManager-field reader).
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

  let existing: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("settings.json root must be a JSON object");
    }
    existing = parsed as Record<string, unknown>;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { action: "invalid-json", reason: msg, failure: true };
  }

  // H9: an ARRAY `hooks` field would otherwise slip past the object check
  // (`typeof [] === "object"`) — its `.Stop` is undefined, so Case D would
  // not fire and Case B/C would overwrite the array wholesale, silently
  // destroying whatever the user had encoded. Reject it up front so nothing
  // is lost.
  if (Array.isArray(existing.hooks)) {
    return {
      action: "invalid-json",
      reason: "settings.json 'hooks' field must be an object, not an array",
      failure: true,
    };
  }

  const existingHooks =
    existing.hooks && typeof existing.hooks === "object"
      ? (existing.hooks as Record<string, unknown>)
      : undefined;

  // Case D: a populated hooks.Stop array already exists — never overwrite,
  // even with --force (contract §--force フラグの扱い). Non-array / empty-
  // array / null hooks.Stop are NOT conflicts and fall through to Case B/C.
  if (Array.isArray(existingHooks?.Stop) && existingHooks.Stop.length > 0) {
    // A3: derive the reason string from the SAME `rendered` object we would
    // have written on the merge path. Duplicating the command literal here
    // was drifting silently whenever the template changed (e.g. the
    // `--mode symbol` suffix in spec 012 G1).
    const conflictCmd = rendered.hooks.Stop[0]?.hooks[0]?.command ?? "";
    return {
      action: "conflict",
      reason: conflictCmd,
      failure: true,
    };
  }

  // Case B/C: merge Stop into (possibly absent/non-object) hooks, preserving
  // any other top-level fields and any other hook keys (e.g. PreToolUse).
  // Extension point: if the template ever grows beyond Stop, spread
  // rendered.hooks here instead of setting Stop alone.
  //
  // The array-hooks case was already rejected above (H9), so at this point
  // `existing.hooks` is either undefined or a plain object.
  const originalHooks = existingHooks ?? {};
  // C1: distinguish "user had a genuine sibling hook" (→ merged-c) from
  // "user had `{hooks: {Stop: []}}`" (→ merged-b). Counting Stop itself
  // would tag the latter as "other hooks preserved" — technically true,
  // but only of a placeholder Stop that we're about to overwrite.
  const hadOtherHookKeys = Object.keys(originalHooks).some((k) => k !== "Stop");
  existing.hooks = { ...originalHooks, Stop: rendered.hooks.Stop };

  try {
    writeAtomic(existing);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { action: "io-error", reason: msg, failure: true };
  }

  return { action: hadOtherHookKeys ? "merged-c" : "merged-b", failure: false };
}

/**
 * Review A3 (issue #122 follow-up): detect a dangling `@impl`/`@verifies`
 * code tag — an `implements`/`verifies` edge sourced from an inline code tag
 * (`provenances` includes `"code-tag"`) whose target REQ/doc node isn't in
 * the graph. `buildGraph`'s existing "orphan-edge" warning only fires for
 * `annotation` provenance (spec-authored `(implements: FR-001)` relations),
 * so a stray `@impl FR-001` left in code with no matching spec is otherwise
 * silent. `init`'s brownfield closing hint uses this to avoid claiming "no
 * @impl claims detected yet" when the repo actually has one, just unmatched.
 */
function graphHasDanglingCodeTag(graph: ArtifactGraph): boolean {
  for (const edge of graph.edges) {
    if (
      (edge.kind === "implements" || edge.kind === "verifies") &&
      edge.provenances.includes("code-tag") &&
      !graph.nodes.has(edge.target)
    ) {
      return true;
    }
  }
  return false;
}

export function runInit(rootDir: string, options: InitOptions = {}): InitResult {
  const abs = resolve(rootDir);
  const configPath = resolve(abs, ".artgraph.json");

  const hasExistingConfig = existsSync(configPath);
  if (hasExistingConfig && !options.force) {
    throw new Error(".artgraph.json already exists. Use --force to overwrite.");
  }

  const stages = computeStageGates(options);

  // spec 013 (FR-002 / FR-013) — the Skills and agent-context stages both key
  // on `options.agents`. The CLI layer (`src/cli.ts`) enforces "agents
  // required when these stages run" before calling us, so by the time we get
  // here either:
  //   - agents is undefined or empty → both stages no-op (programmatic caller
  //     that opted out, or CLI under --minimal / --no-skills --no-agent-context)
  //   - agents is non-empty → both stages iterate over the list
  const agentsList: AgentId[] = options.agents ?? [];
  const skillsStageActive = stages.skills && agentsList.length > 0;
  const agentContextStageActive = stages.agentContext && agentsList.length > 0;

  // Pre-flight: stage the Skills source + per-agent descriptor table BEFORE
  // any write so a missing template or broken descriptor fails fast (no
  // partial `.artgraph.json` left behind). `readSkillSource()` throws
  // `SkillsInstallError` on packaging faults.
  let skillSource: ReturnType<typeof readSkillSource> | undefined;
  let skillDescriptors: AgentDescriptor[] | undefined;
  if (skillsStageActive) {
    skillSource = readSkillSource(SKILLS_TEMPLATE_DIR);
    skillDescriptors = agentsList.map((id) => {
      const d = findDescriptor(id);
      if (!d) {
        // Defensive: parse-agents.ts already validates this, but a programmatic
        // caller could bypass it. Fail loudly rather than silently dropping the
        // agent.
        throw new Error(`unknown agent id passed to runInit: ${id}`);
      }
      return d;
    });
  }

  const detection = detectProject(abs);

  // On `--force` over an existing config, MERGE the user's customizations
  // (reqPatterns / taskConventions / planCoverage / docGraph / mode / lockFile
  // / include / etc.) instead of nuking them. Only the detection-driven
  // `packageManager` field is refreshed below. Initial inits (no existing
  // config) keep the generateConfig path so detection-derived defaults
  // (include, specDirs) are still applied.
  const config: ArtgraphConfig = hasExistingConfig ? loadConfig(abs) : generateConfig(detection);

  // Record the detected package manager so downstream tooling (hooks /
  // agent-context / plugin templating in #109/#110/#111) can build exec
  // commands without re-sniffing lockfiles. `detectPackageManager` returns
  // null when nothing is detectable; in that case we leave the existing
  // `packageManager` value alone (preserving any prior detection recorded in
  // the file) instead of clobbering it with undefined (FR-008).
  //
  // F3-caller: pass `quiet: true` so the low-level `ERROR:` message is
  // suppressed here — the CLI's `skipped-no-pm` branch emits its own
  // user-facing `WARNING:` line, and having both fire produced a confusing
  // ERROR + WARNING pair for the same event.
  const detectedPm = detectPackageManager(abs, { quiet: true });
  if (detectedPm) {
    config.packageManager = detectedPm;
  }

  // @impl 013-cross-agent-extensions/FR-008
  // Partial-state guard: run every writeable stage BEFORE the final atomic
  // `.artgraph.json` write so any mid-stage failure never leaves an orphan
  // config file on disk. Post-B7 order is (Skills + gitattributes) →
  // scan/reconcile → integrate → hooks → agent-context → config. If any
  // step throws, the config is not written and the whole init exits 1 via
  // the CLI catch block, matching what the user's next `artgraph init`
  // will produce when they fix the conflict (idempotent re-run).
  //
  //   1. read canonical Skills source (no write) — done above pre-flight
  //   2. multi-agent PRE-FLIGHT (B2) — every agent's target set is scanned
  //      for conflicts (drift w/o --force, symlink ancestor / leaf, non-regular
  //      leaf). If ANY agent would throw, we throw NOW, before any write.
  //   3. distribute() per agent (writes to <agent.skillsPath>/, self-rollback)
  //      + writeGitAttributes() per agent (`.gitattributes` pinning LF eol
  //      inside the Skills dist tree — OPS-2 partial mitigation).
  //      Cross-agent rollback (B2): if agent N fails after agents 1..N-1
  //      succeeded, we unlink every file agents 1..N-1 wrote (and rmdir
  //      newly-empty parents best-effort) before re-throwing.
  //      - FR-008: Kiro descriptor's `skillsPath` is `.kiro/skills/` only;
  //        `.kiro/steering/artgraph.md` is the integrate stage / KiroProvider's
  //        responsibility, NOT this distribute() call.
  //   4. scan + reconcile (writes .trace.lock)
  //   5. auto-detect SDD-tool integrations
  //   6. hooks stub
  //   7. agent-context (AGENTS.md + wrappers) — before config (B7), so a
  //      wrapper write failure does NOT leave `.artgraph.json` on disk.
  //      Note (OPS-14): agent-context writes are NOT rolled back on a
  //      later failure — the writer is marker-bounded and idempotent, so
  //      the block is refreshed on the next successful init. Any partial
  //      state is reported to the user via
  //      `DistributionError.partiallyWritten` when applicable.
  //   8. write .artgraph.json (atomic via `atomicWriteFile`, B3) — the last
  //      observable write, so its success signals the whole init succeeded.
  let agentDistributions:
    | Record<string, { writtenPaths: string[]; noopPaths: string[] }>
    | undefined;
  let skillsInstalled: string[] | undefined;
  if (skillsStageActive && skillSource && skillDescriptors) {
    // B2 pre-flight: every agent must classify cleanly before ANY write.
    for (const descriptor of skillDescriptors) {
      preflightDistribution(descriptor, skillSource, {
        rootDir: abs,
        force: options.force ?? false,
      });
    }

    agentDistributions = {};
    // Track files written across ALL agents (Skill copies + .gitattributes).
    // Used ONLY by the cross-agent catch block below to undo prior-agent
    // writes when a later agent throws. Empty on the success path.
    const crossAgentWritten: string[] = [];

    try {
      for (const descriptor of skillDescriptors) {
        const result: DistributeResult = distribute(descriptor, skillSource, {
          rootDir: abs,
          force: options.force ?? false,
        });
        // Bookkeep before writing .gitattributes so a gitattributes failure
        // still rolls back the Skill files we just wrote for this agent.
        crossAgentWritten.push(...result.writtenPaths);
        agentDistributions[descriptor.id] = {
          writtenPaths: result.writtenPaths,
          noopPaths: result.noopPaths,
        };

        // OPS-2 partial mitigation — pin the Skills dist tree to LF so
        // Windows `core.autocrlf=true` does not re-encode SKILL.md and
        // silently `skill-file-drift` FAIL every doctor run.
        const attrs = writeGitAttributes(abs, descriptor);
        if (attrs.written) {
          crossAgentWritten.push(attrs.path);
        }

        // Backward-compat: surface the Claude paths as POSIX-relative entries
        // so the legacy `skillsInstalled` field still works for existing CLI
        // text / JSON consumers (cli.ts H6 split, `tests/cli.test.ts`).
        if (descriptor.id === "claude") {
          skillsInstalled = result.targets.map((t) => toPosixRel(abs, t.dstAbsPath));
        }
      }
    } catch (e) {
      // B2 cross-agent rollback. `distribute()` already rolled back the
      // failing agent's own writes (per-agent try/catch inside distribute).
      // We only need to undo files that prior successful agents left on
      // disk, plus any `.gitattributes` files we wrote after their
      // distribute() calls succeeded.
      const survivors: string[] = [];
      // Unlink leaf files first so newly-empty parents become rmdir-able.
      for (const p of [...crossAgentWritten].reverse()) {
        try {
          unlinkSync(p);
        } catch (err) {
          const errno = (err as NodeJS.ErrnoException).code;
          if (errno !== "ENOENT") survivors.push(p);
        }
      }
      // Best-effort leaf-first rmdir of every parent chain that held one
      // of the unlinked files, bounded at the repo root. `rmdirSync` fails
      // on non-empty dirs, which is exactly the right behaviour: any user
      // content that shared the tree stays put.
      const dirsSeen = new Set<string>();
      for (const p of crossAgentWritten) {
        let dir = dirname(p);
        while (dir !== abs && dir.length > abs.length && !dirsSeen.has(dir)) {
          dirsSeen.add(dir);
          dir = dirname(dir);
        }
      }
      // Deepest paths first so the whole chain collapses cleanly.
      const dirsSorted = [...dirsSeen].sort((a, b) => b.length - a.length);
      for (const d of dirsSorted) {
        try {
          rmdirSync(d);
        } catch {
          /* best-effort — leave non-empty dirs (user content) alone */
        }
      }

      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof DistributionError) {
        // Preserve the failing agent's own partiallyWritten (per-agent
        // rollback survivors) and merge with cross-agent survivors so the
        // CLI can list every path that still needs manual cleanup (B6).
        throw new DistributionError(
          `distribution rolled back after failure: ${msg}`,
          e.conflictPaths,
          [...e.partiallyWritten, ...survivors],
        );
      }
      throw e;
    }
  }

  let scanSummary: ScanSummary | undefined;
  let warnings: BuildWarning[] = [];
  let lockPath: string | undefined;

  if (stages.scan) {
    const scanResult = scan(abs, config);
    reconcile(abs, config, scanResult.graph);
    scanSummary = {
      nodeCount: scanResult.nodeCount,
      edgeCount: scanResult.edgeCount,
      reqCount: scanResult.reqCount,
      docCount: scanResult.docCount,
      fileCount: scanResult.fileCount,
      testCount: scanResult.testCount,
      taskCount: scanResult.taskCount,
      hasDanglingCodeTag: graphHasDanglingCodeTag(scanResult.graph),
    };
    warnings = scanResult.warnings;
    lockPath = resolve(abs, config.lockFile);
  }

  const integration = stages.integrate
    ? runAutoIntegrations(abs, detection, options)
    : { failureCount: 0 };

  // PM resolution priority shared by the hooks and agent-context stages
  // (contract §PM 検出優先度): (1) live detection this run, (2) the value
  // already recorded in .artgraph.json (covers repos where lockfiles were
  // removed/rotated after the initial init), (3) null → graceful skip for
  // hooks, bare-`artgraph` command examples for agent-context (#110).
  const resolvedPm = detectedPm ?? config.packageManager ?? null;
  const hooksInstall = stages.hooks ? installHooks(abs, resolvedPm) : undefined;

  // spec 013 T021 — agent-context stage. AGENTS.md is canonical (always
  // written when any agent is selected); wrappers are emitted only for the
  // agents that need one (claude / copilot per descriptor table).
  //
  // B7: this stage runs BEFORE the `.artgraph.json` write below so a
  // wrapper failure (e.g. `.github/copilot-instructions.md` write EACCES)
  // does not leave a config file on disk unaccompanied by its AGENTS.md.
  let agentContextWritten: { path: string; written: boolean }[] | undefined;
  if (agentContextStageActive) {
    agentContextWritten = [];
    const ag: WriteResult = writeAgentsMd(abs, resolvedPm);
    agentContextWritten.push({ path: ag.path, written: ag.written });
    if (agentsList.includes("claude")) {
      const w = writeWrapper(abs, "claude");
      agentContextWritten.push({ path: w.path, written: w.written });
    }
    if (agentsList.includes("copilot")) {
      const w = writeWrapper(abs, "copilot");
      agentContextWritten.push({ path: w.path, written: w.written });
    }
  }

  // B3 — atomic write. Previously a raw `writeFileSync` on `.artgraph.json`
  // could leave a truncated/empty JSON on SIGKILL / ENOSPC mid-write, and
  // the next `runInit` would throw on `loadConfig`. `atomicWriteFile` stages
  // to a sibling tmp and renames onto the target so the on-disk config is
  // either the previous bytes or the full new bytes — never a half-written
  // string.
  atomicWriteFile(configPath, JSON.stringify(config, null, 2) + "\n");

  return {
    configPath,
    config,
    sddTools: detection.sddTools,
    scanSummary,
    warnings,
    lockPath,
    skillsInstalled,
    agentDistributions,
    agentContextWritten,
    integrationResults: integration.results,
    integrationWarnings: integration.warnings,
    integrationFailureCount: integration.failureCount > 0 ? integration.failureCount : undefined,
    hooksInstall,
  };
}

/**
 * Apply integrate-auto for `init` (P0 redesign, contracts/cli-flags.md):
 * every detected provider is integrated. Each provider runs via
 * `runIntegrate` so the on-disk effect is identical to the standalone
 * `artgraph integrate <tool>` command. Explicit tool selection and gate
 * control live in `artgraph integrate <tool> [--gate|--no-gate]`.
 */
function runAutoIntegrations(
  rootDir: string,
  detection: DetectionResult,
  options: InitOptions,
): { results?: IntegrateResult[]; warnings?: string[]; failureCount: number } {
  const statuses = detection.integrations ?? [];
  const requested = statuses.filter((s) => s.detected).map((s) => s.providerId);
  if (requested.length === 0) return { failureCount: 0 };

  const results: IntegrateResult[] = [];
  const warnings: string[] = [];
  // Count only hard exceptions thrown by providers. The CLI converts a
  // non-zero failure count into a non-zero exit code per
  // contracts/cli-flags.md.
  let failureCount = 0;

  for (const id of requested) {
    try {
      const r = runIntegrate(rootDir, id, {
        // Only speckit consumes `gate`; other providers ignore unknown opts.
        // Issue #217: auto-integrate deliberately does NOT pass `gate: true`
        // anymore. The blocking `before_implement` gate (`artgraph check
        // --gate`) is a guaranteed exit 2 right before the FIRST
        // `/speckit-implement` of a new spec (every REQ is still uncovered),
        // so wiring it by default trained users to ignore the gate. With
        // `gate` left undefined the provider wires a non-blocking
        // `check --diff` preview instead; `artgraph integrate speckit
        // --gate` remains the explicit opt-in for the blocking gate.
        // FR-024: --force on `init` must reach the integration provider so
        // that drifted extension/steering files are regenerated alongside
        // the rest of the project.
        force: options.force,
      });
      results.push(r);
    } catch (e) {
      // Record as a warning (for human-readable output) AND increment the
      // failure counter so the CLI can exit non-zero. Without this, a
      // crashing provider was indistinguishable from a successful run.
      const msg = e instanceof Error ? e.message : String(e);
      warnings.push(`WARNING: ${id} integration failed: ${msg}`);
      failureCount += 1;
    }
  }

  return {
    results: results.length > 0 ? results : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
    failureCount,
  };
}

// Convert an absolute path to a repo-root-relative POSIX path
// (`/abs/.claude/skills/x` → `.claude/skills/x`). Mirrors the format the
// legacy `installSkills` returned so the CLI output stays stable.
function toPosixRel(rootAbs: string, abs: string): string {
  // Normalise Windows backslashes for downstream POSIX consumers (CLI text +
  // JSON assertions in tests are POSIX-typed).
  const stripped =
    abs.startsWith(rootAbs + "/") || abs.startsWith(rootAbs + "\\")
      ? abs.slice(rootAbs.length + 1)
      : abs;
  return stripped
    .split(/\\|\//)
    .filter((s) => s.length > 0)
    .join("/");
}
