import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEFAULT_CONFIG,
  type ArtgraphConfig,
  type ScanSummary,
  type SddToolInfo,
  type DetectionResult,
  type InitOptions,
} from "./types.js";
import { scan, reconcile } from "./scan.js";
import type { BuildWarning } from "./graph/builder.js";

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

  return {
    hasSrc: existsSync(resolve(abs, "src")),
    hasSpecs: existsSync(resolve(abs, "specs")),
    hasDocs: existsSync(resolve(abs, "docs")),
    sddTools,
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
    return { configPath, config, sddTools: detection.sddTools, warnings: [], skillsInstalled };
  }

  const result = scan(abs, config);
  reconcile(abs, config, result.graph);
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  const skillsInstalled = options.withSkills
    ? installSkills(abs, { force: options.force })
    : undefined;

  const lockPath = resolve(abs, config.lockFile);

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
  };
}
