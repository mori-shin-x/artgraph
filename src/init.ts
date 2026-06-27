import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
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
import { scan, reconcile } from "./scan.js";
import type { BuildWarning } from "./graph/builder.js";
import { getProviderStatuses, runIntegrate } from "./integrate/index.js";

const SKILLS_TEMPLATE_DIR = resolve(import.meta.dirname, "../templates/skills");
const SKILLS_DEST_SUBDIR = join(".claude", "skills");

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
  skillsInstalled?: string[];
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

interface SkillTemplate {
  /** Top-level entry name under templates/skills (e.g. "_shared" or "artgraph-impact"). */
  topLevel: string;
  /** All files belonging to this entry, as paths relative to templates/skills. */
  files: string[];
}

function walkDir(root: string, current: string, out: string[]): void {
  for (const entry of readdirSync(current)) {
    const full = join(current, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkDir(root, full, out);
    } else if (stat.isFile()) {
      out.push(relative(root, full));
    }
  }
}

function readSkillTemplates(templateDir: string): SkillTemplate[] {
  if (!existsSync(templateDir)) {
    throw new SkillsInstallError(
      `Skills template directory not found at ${templateDir}. This is likely a packaging issue.`,
    );
  }
  const topEntries = readdirSync(templateDir).filter(
    (name) => !name.startsWith(".") && statSync(join(templateDir, name)).isDirectory(),
  );
  if (topEntries.length === 0) {
    throw new SkillsInstallError(
      `No skill template directories found in ${templateDir}. Expected templates/skills/<name>/SKILL.md or templates/skills/_shared/. This is likely a packaging issue.`,
    );
  }
  const templates: SkillTemplate[] = [];
  for (const topLevel of topEntries) {
    const files: string[] = [];
    walkDir(templateDir, join(templateDir, topLevel), files);
    if (topLevel !== "_shared") {
      // Every skill directory MUST contain SKILL.md (Claude Code Skills contract).
      const hasSkillMd = files.some((f) => f === join(topLevel, "SKILL.md"));
      if (!hasSkillMd) {
        throw new SkillsInstallError(
          `Skill directory ${topLevel}/ is missing SKILL.md. This is likely a packaging issue.`,
        );
      }
    }
    templates.push({ topLevel, files });
  }
  return templates;
}

// `templateDir` is for test injection only; production callers omit it and the
// constant `SKILLS_TEMPLATE_DIR` (resolved relative to dist/) is used.
export interface SkillsInstallOptions {
  force?: boolean;
  templateDir?: string;
}

function findConflicts(destDir: string, templates: SkillTemplate[]): string[] {
  const conflicts: string[] = [];
  for (const t of templates) {
    for (const rel of t.files) {
      if (existsSync(join(destDir, rel))) conflicts.push(rel);
    }
  }
  return conflicts;
}

// Throws if installation cannot proceed cleanly. Mirrors installSkills's
// validation (templates available, no conflicts unless --force) without writing.
// Use this as a pre-flight check before any other side effects.
export function validateSkillsInstall(rootDir: string, options: SkillsInstallOptions = {}): void {
  const abs = resolve(rootDir);
  const destDir = resolve(abs, SKILLS_DEST_SUBDIR);
  const templateDir = options.templateDir ?? SKILLS_TEMPLATE_DIR;
  const templates = readSkillTemplates(templateDir);

  if (!options.force) {
    const conflicts = findConflicts(destDir, templates);
    if (conflicts.length > 0) {
      throw new SkillsInstallError(
        `Skill file(s) already exist in ${SKILLS_DEST_SUBDIR}: ${conflicts.join(", ")}. Use --force to overwrite.`,
      );
    }
  }
}

export function installSkills(rootDir: string, options: SkillsInstallOptions = {}): string[] {
  const abs = resolve(rootDir);
  const destDir = resolve(abs, SKILLS_DEST_SUBDIR);
  const templateDir = options.templateDir ?? SKILLS_TEMPLATE_DIR;
  const templates = readSkillTemplates(templateDir);

  if (!options.force) {
    const conflicts = findConflicts(destDir, templates);
    if (conflicts.length > 0) {
      throw new SkillsInstallError(
        `Skill file(s) already exist in ${SKILLS_DEST_SUBDIR}: ${conflicts.join(", ")}. Use --force to overwrite.`,
      );
    }
  }

  mkdirSync(destDir, { recursive: true });
  const installed: string[] = [];
  for (const t of templates) {
    for (const rel of t.files) {
      const src = join(templateDir, rel);
      const dst = join(destDir, rel);
      try {
        mkdirSync(join(dst, ".."), { recursive: true });
        copyFileSync(src, dst);
        installed.push(join(SKILLS_DEST_SUBDIR, rel));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new SkillsInstallError(
          `Failed to copy ${rel} into ${SKILLS_DEST_SUBDIR}: ${msg}`,
          installed,
        );
      }
    }
  }
  return installed;
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
function computeStageGates(opts: InitOptions): {
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

/**
 * Agent-context snippet injection. P1 (T027) replaces this stub.
 */
function installAgentContext(_rootDir: string, _options: { force?: boolean } = {}): void {
  // P1 (T027): inject the CLAUDE.md / AGENTS.md snippet between the
  // <!-- artgraph: BEGIN agent context --> markers.
}

export function runInit(rootDir: string, options: InitOptions = {}): InitResult {
  const abs = resolve(rootDir);
  const configPath = resolve(abs, ".artgraph.json");

  if (existsSync(configPath) && !options.force) {
    throw new Error(".artgraph.json already exists. Use --force to overwrite.");
  }

  const stages = computeStageGates(options);

  // Pre-flight: fail before any write if the Skills stage cannot proceed
  // cleanly (templates missing, conflicts without --force). Keeps partial
  // -state windows closed: validation failure leaves disk untouched.
  if (stages.skills) {
    validateSkillsInstall(abs, { force: options.force });
  }

  const detection = detectProject(abs);
  const config = generateConfig(detection);

  let scanSummary: ScanSummary | undefined;
  let warnings: BuildWarning[] = [];
  let lockPath: string | undefined;

  if (stages.scan) {
    const scanResult = scan(abs, config);
    reconcile(abs, config, scanResult.graph);
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
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
  } else {
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  }

  const skillsInstalled = stages.skills
    ? installSkills(abs, { force: options.force })
    : undefined;

  const integration = stages.integrate
    ? runRequestedIntegrations(abs, detection, options)
    : {};

  if (stages.hooks) {
    installHooks(abs, { force: options.force });
  }
  if (stages.agentContext) {
    installAgentContext(abs, { force: options.force });
  }

  return {
    configPath,
    config,
    sddTools: detection.sddTools,
    scanSummary,
    warnings,
    lockPath,
    skillsInstalled,
    integrationResults: integration.results,
    integrationWarnings: integration.warnings,
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
): { results?: IntegrateResult[]; warnings?: string[] } {
  // Resolve the requested ids. Empty array also triggers auto-mode.
  const statuses = detection.integrations ?? [];
  let requested: IntegrationProviderId[];
  if (Array.isArray(options.integrations) && options.integrations.length > 0) {
    requested = options.integrations;
  } else {
    // Auto-detect (default behavior). "all" sentinel also lands here.
    requested = statuses.filter((s) => s.detected).map((s) => s.providerId);
  }
  if (requested.length === 0) return {};

  const results: IntegrateResult[] = [];
  const warnings: string[] = [];

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
      // Surface as a warning instead of failing the init.
      const msg = e instanceof Error ? e.message : String(e);
      warnings.push(`WARNING: ${id} integration failed: ${msg}`);
    }
  }

  return {
    results: results.length > 0 ? results : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}
