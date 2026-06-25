import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

function readSkillTemplates(templateDir: string): string[] {
  if (!existsSync(templateDir)) {
    throw new SkillsInstallError(
      `Skills template directory not found at ${templateDir}. This is likely a packaging issue.`,
    );
  }
  const templates = readdirSync(templateDir).filter((f) => f.endsWith(".md"));
  if (templates.length === 0) {
    throw new SkillsInstallError(
      `No skill templates (*.md) found in ${templateDir}. This is likely a packaging issue.`,
    );
  }
  return templates;
}

// `templateDir` is for test injection only; production callers omit it and the
// constant `SKILLS_TEMPLATE_DIR` (resolved relative to dist/) is used.
export interface SkillsInstallOptions {
  force?: boolean;
  templateDir?: string;
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
    const conflicts = templates.filter((f) => existsSync(join(destDir, f)));
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
    const conflicts = templates.filter((f) => existsSync(join(destDir, f)));
    if (conflicts.length > 0) {
      throw new SkillsInstallError(
        `Skill file(s) already exist in ${SKILLS_DEST_SUBDIR}: ${conflicts.join(", ")}. Use --force to overwrite.`,
      );
    }
  }

  mkdirSync(destDir, { recursive: true });
  const installed: string[] = [];
  for (const name of templates) {
    try {
      copyFileSync(join(templateDir, name), join(destDir, name));
      installed.push(join(SKILLS_DEST_SUBDIR, name));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new SkillsInstallError(
        `Failed to copy ${name} into ${SKILLS_DEST_SUBDIR}: ${msg}`,
        installed,
      );
    }
  }
  return installed;
}

export function runInit(rootDir: string, options: InitOptions = {}): InitResult {
  const abs = resolve(rootDir);
  const configPath = resolve(abs, ".artgraph.json");

  if (existsSync(configPath) && !options.force) {
    throw new Error(".artgraph.json already exists. Use --force to overwrite.");
  }

  // Pre-flight: fail before any write if --with-skills cannot proceed cleanly
  // (templates missing, conflicts without --force). Keeps partial-state windows
  // closed: validation failure leaves disk untouched.
  if (options.withSkills) {
    validateSkillsInstall(abs, { force: options.force });
  }

  const detection = detectProject(abs);
  const config = generateConfig(detection);

  if (options.noScan) {
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    const skillsInstalled = options.withSkills
      ? installSkills(abs, { force: options.force })
      : undefined;
    const integration = runRequestedIntegrations(abs, detection, options);
    return {
      configPath,
      config,
      sddTools: detection.sddTools,
      warnings: [],
      skillsInstalled,
      integrationResults: integration.results,
      integrationWarnings: integration.warnings,
    };
  }

  const result = scan(abs, config);
  reconcile(abs, config, result.graph);
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  const skillsInstalled = options.withSkills
    ? installSkills(abs, { force: options.force })
    : undefined;

  const lockPath = resolve(abs, config.lockFile);
  const integration = runRequestedIntegrations(abs, detection, options);

  return {
    configPath,
    config,
    sddTools: detection.sddTools,
    scanSummary: {
      nodeCount: result.nodeCount,
      edgeCount: result.edgeCount,
      reqCount: result.reqCount,
      docCount: result.docCount,
      fileCount: result.fileCount,
      testCount: result.testCount,
    },
    warnings: result.warnings,
    lockPath,
    skillsInstalled,
    integrationResults: integration.results,
    integrationWarnings: integration.warnings,
  };
}

/**
 * Apply `--integrate=<tools>` one-shot integrations after the rest of
 * `runInit` has finished writing `.artgraph.json` (FR-022). Each tool runs
 * via `runIntegrate` so the on-disk effect is identical to the standalone
 * `artgraph integrate <tool>` command (FR-024).
 *
 * Tools that aren't detected are warned about and skipped — the surrounding
 * `init` always exits successfully (FR-022 末尾).
 */
function runRequestedIntegrations(
  rootDir: string,
  detection: DetectionResult,
  options: InitOptions,
): { results?: IntegrateResult[]; warnings?: string[] } {
  if (!options.integrations) return {};

  // Resolve the requested ids. "all" → every detected provider.
  const statuses = detection.integrations ?? [];
  let requested: IntegrationProviderId[];
  if (options.integrations === "all") {
    requested = statuses.filter((s) => s.detected).map((s) => s.providerId);
  } else {
    requested = options.integrations;
  }

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
