import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_CONFIG,
  type ArtgraphConfig,
  type IntegrateResult,
  type IntegrationProviderId,
  type ScanSummary,
  type SddToolInfo,
  type DetectionResult,
  type InitOptions,
} from "./types.js";
import {
  type AgentId,
  type AgentDescriptor,
  findDescriptor,
} from "./agents/descriptors.js";
import { scan, reconcile } from "./scan.js";
import type { BuildWarning } from "./graph/builder.js";
import { getProviderStatuses, runIntegrate } from "./integrate/index.js";
import { detectPackageManager } from "./package-manager.js";
import { loadConfig } from "./config.js";
import { readSkillSource } from "./agents/source.js";
import {
  distribute,
  DistributionError,
  type DistributeResult,
} from "./agents/distribute.js";
import { writeAgentsMd, writeWrapper, type WriteResult } from "./agents/agent-context.js";

// `templates/skills/` lives next to `dist/`, so resolve relative to the
// compiled module path (works for both `dist/init.js` and `src/init.ts` via
// ts-node / vitest).
const SKILLS_TEMPLATE_DIR = resolve(import.meta.dirname, "../templates/skills");

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
   * Per-provider result for any one-shot integrations triggered by
   * `--integrate=<tools>` (FR-022/023/024). Empty / undefined when the
   * caller did not request any integration.
   *
   * `id` is included alongside the `IntegrateResult` so the formatter can
   * still report providers that were skipped (no IntegrateResult emitted)
   * via the `integrationWarnings` array.
   */
  integrationResults?: IntegrateResult[];
  /**
   * Human-readable warnings emitted while running `--integrate=<tools>`
   * (e.g. "kiro not detected, skipping integration"). These never fail the
   * init itself but are surfaced in the CLI output.
   */
  integrationWarnings?: string[];
  /**
   * Number of integration providers that threw an exception during
   * `runRequestedIntegrations`. This is distinct from `integrationWarnings`
   * (which also covers "not detected, skipping" no-ops); only hard provider
   * failures are counted here. The CLI uses this to translate provider
   * failures into a non-zero exit code, per
   * `specs/012-skills-expansion/contracts/cli-flags.md` ("statement step
   * failure" must exit 1).
   */
  integrationFailureCount?: number;
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
  };
}

/**
 * Decide which stages of `init` to run based on the new flag matrix
 * (spec 012-skills-expansion, contracts/cli-flags.md).
 *
 * Default (no flags) → every stage on. `--minimal` flips every gateable stage
 * off; `--with-*` flags re-enable individual stages on top of `--minimal`.
 * `--no-*` flags opt out of individual stages in the default mode.
 * Explicit `integrations` (non-empty) also acts as an opt-in under `--minimal`.
 */
export function computeStageGates(opts: InitOptions): {
  scan: boolean;
  skills: boolean;
  integrate: boolean;
  hooks: boolean;
  agentContext: boolean;
} {
  const explicitIntegrations =
    opts.integrations !== undefined &&
    (Array.isArray(opts.integrations) ? opts.integrations.length > 0 : true);

  if (opts.minimal) {
    return {
      scan: false,
      skills: opts.withSkills === true,
      integrate: opts.withIntegrate === true || explicitIntegrations,
      hooks: opts.withHooks === true,
      agentContext: opts.withAgentContext === true,
    };
  }

  return {
    scan: !opts.noScan,
    // withSkills is a redundant opt-in under default mode but preserved so
    // callers passing it explicitly behave the same as before.
    skills: !opts.noSkills,
    integrate: !opts.noIntegrate,
    hooks: !opts.noHooks,
    agentContext: !opts.noAgentContext,
  };
}

/**
 * Stop-hook installation. P1 will replace this stub with the real merger
 * defined in specs/012-skills-expansion/contracts/settings-merge.md (T026).
 * In P0 the stage is wired but does nothing observable.
 */
function installHooks(_rootDir: string, _options: { force?: boolean } = {}): void {
  // P1 (T026): merge templates/hooks/settings.json.template into
  // <rootDir>/.claude/settings.json with the 4-case strategy.
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
  const config: ArtgraphConfig = hasExistingConfig
    ? loadConfig(abs)
    : generateConfig(detection);

  // Record the detected package manager so downstream tooling (hooks /
  // agent-context / plugin templating in #109/#110/#111) can build exec
  // commands without re-sniffing lockfiles. `detectPackageManager` warns to
  // stderr and returns null when nothing is detectable; in that case we leave
  // the existing `packageManager` value alone (preserving any prior detection
  // recorded in the file) instead of clobbering it with undefined (FR-008).
  const detectedPm = detectPackageManager(abs);
  if (detectedPm) {
    config.packageManager = detectedPm;
  }

  // Partial-state guard: distribute Skills BEFORE writing `.artgraph.json`
  // so a mid-loop copy failure (which `distribute()` already rolls back)
  // never leaves an orphan config file on disk. The order is:
  //   1. read canonical Skills source (no write)
  //   2. distribute() per agent (writes to <agent.skillsPath>/, self-rollback)
  //   3. scan + reconcile (writes .trace.lock)
  //   4. write .artgraph.json (final, only reached if everything above
  //      succeeded)
  //   5. one-shot integrations (`--integrations=<list>` / auto-detect)
  //   6. agent-context (AGENTS.md + wrappers)
  let agentDistributions: Record<string, { writtenPaths: string[]; noopPaths: string[] }> | undefined;
  let skillsInstalled: string[] | undefined;
  if (skillsStageActive && skillSource && skillDescriptors) {
    agentDistributions = {};
    for (const descriptor of skillDescriptors) {
      const result: DistributeResult = distribute(descriptor, skillSource, {
        rootDir: abs,
        force: options.force ?? false,
      });
      agentDistributions[descriptor.id] = {
        writtenPaths: result.writtenPaths,
        noopPaths: result.noopPaths,
      };
      // Backward-compat: surface the Claude paths as POSIX-relative entries so
      // the legacy `skillsInstalled` field still works for existing CLI text
      // / JSON consumers (cli.ts H6 split, `tests/cli.test.ts` assertions).
      if (descriptor.id === "claude") {
        skillsInstalled = result.targets.map((t) =>
          toPosixRel(abs, t.dstAbsPath),
        );
      }
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
    };
    warnings = scanResult.warnings;
    lockPath = resolve(abs, config.lockFile);
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

  const integration = stages.integrate
    ? runRequestedIntegrations(abs, detection, options)
    : { failureCount: 0 };

  if (stages.hooks) {
    installHooks(abs, { force: options.force });
  }

  // spec 013 T021 — agent-context stage. AGENTS.md is canonical (always
  // written when any agent is selected); wrappers are emitted only for the
  // agents that need one (claude / copilot per descriptor table).
  let agentContextWritten: { path: string; written: boolean }[] | undefined;
  if (agentContextStageActive) {
    agentContextWritten = [];
    const ag: WriteResult = writeAgentsMd(abs);
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
  };
}

/**
 * Apply integrate-auto for `init` (P0 redesign, contracts/cli-flags.md).
 *
 * Resolution order:
 *   1. Explicit array `options.integrations` → exactly those providers.
 *   2. `options.integrations === "all"` OR no `integrations` set → every
 *      detected provider (auto mode, the new default).
 *
 * Each provider runs via `runIntegrate` so the on-disk effect is identical
 * to the standalone `artgraph integrate <tool>` command. Tools that aren't
 * detected are warned about and skipped — `init` always exits 0.
 */
function runRequestedIntegrations(
  rootDir: string,
  detection: DetectionResult,
  options: InitOptions,
): { results?: IntegrateResult[]; warnings?: string[]; failureCount: number } {
  // Resolve the requested ids. Empty array also triggers auto-mode.
  const statuses = detection.integrations ?? [];
  let requested: IntegrationProviderId[];
  if (Array.isArray(options.integrations) && options.integrations.length > 0) {
    requested = options.integrations;
  } else {
    // Auto-detect (default behavior). "all" sentinel also lands here.
    requested = statuses.filter((s) => s.detected).map((s) => s.providerId);
  }
  if (requested.length === 0) return { failureCount: 0 };

  const results: IntegrateResult[] = [];
  const warnings: string[] = [];
  // Count only hard exceptions thrown by providers — NOT "not detected"
  // warnings, which are an expected no-op. The CLI converts a non-zero
  // failure count into a non-zero exit code per contracts/cli-flags.md.
  let failureCount = 0;

  for (const id of requested) {
    const status = statuses.find((s) => s.providerId === id);
    if (!status) {
      warnings.push(`unknown integration provider: ${id}`);
      continue;
    }
    if (!status.detected) {
      warnings.push(`WARNING: ${status.displayName} not detected, skipping integration`);
      continue;
    }
    try {
      const r = runIntegrate(rootDir, id, {
        // Only speckit consumes `gate`; other providers ignore unknown opts.
        gate: options.integrateGate,
        // FR-024: --force on `init` must reach the integration provider so
        // that drifted extension/steering files are regenerated alongside
        // the rest of the project. Previously this was dropped silently,
        // which made `init --integrate=<tool> --force` indistinguishable
        // from `init --integrate=<tool>` once any user edit existed.
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
  const stripped = abs.startsWith(rootAbs + "/") || abs.startsWith(rootAbs + "\\")
    ? abs.slice(rootAbs.length + 1)
    : abs;
  return stripped.split(/\\|\//).filter((s) => s.length > 0).join("/");
}

