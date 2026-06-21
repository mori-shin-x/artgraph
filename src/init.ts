import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_CONFIG,
  type SpectraceConfig,
  type ScanSummary,
  type SddToolInfo,
  type DetectionResult,
  type InitOptions,
} from "./types.js";
import { scan, reconcile } from "./scan.js";
import type { BuildWarning } from "./graph/builder.js";

export interface InitResult {
  configPath: string;
  config: SpectraceConfig;
  sddTools: SddToolInfo[];
  scanSummary?: ScanSummary;
  warnings: BuildWarning[];
  lockPath?: string;
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

export function generateConfig(detection: DetectionResult): SpectraceConfig {
  const include = detection.hasSrc
    ? [...DEFAULT_CONFIG.include]
    : ["**/*.ts", "**/*.tsx"];

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

export function runInit(rootDir: string, options: InitOptions = {}): InitResult {
  const abs = resolve(rootDir);
  const configPath = resolve(abs, ".spectrace.json");

  if (existsSync(configPath) && !options.force) {
    throw new Error(".spectrace.json already exists. Use --force to overwrite.");
  }

  const detection = detectProject(abs);
  const config = generateConfig(detection);

  if (options.noScan) {
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    return { configPath, config, sddTools: detection.sddTools, warnings: [] };
  }

  const result = scan(abs, config);
  reconcile(abs, config, result.graph);
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

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
  };
}
