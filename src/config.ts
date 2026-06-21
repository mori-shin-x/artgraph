import { existsSync, readFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { DEFAULT_CONFIG, type SpectraceConfig, type ReqPatternConfig } from "./types.js";

const CONFIG_FILE = ".spectrace.json";
const CAPTURE_GROUP_RE = /(?:^|[^\\])\((?!\?)/;

function validateReqPatterns(patterns: ReqPatternConfig): void {
  for (const field of ["listItem", "heading"] as const) {
    const pattern = patterns[field];
    if (pattern === undefined) continue;

    if (pattern === "") {
      throw new Error(`Invalid reqPatterns.${field}: pattern must not be empty`);
    }

    try {
      new RegExp(pattern);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Invalid reqPatterns.${field}: invalid regular expression — ${msg}`,
      );
    }

    if (!CAPTURE_GROUP_RE.test(pattern)) {
      throw new Error(
        `Invalid reqPatterns.${field}: pattern must contain at least one capture group`,
      );
    }
  }
}

export function loadConfig(rootDir: string): SpectraceConfig {
  const configPath = resolve(rootDir, CONFIG_FILE);
  if (!existsSync(configPath)) return { ...DEFAULT_CONFIG };

  let raw: any;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to parse ${configPath}: ${msg}`);
  }

  if (raw.reqPatterns) {
    validateReqPatterns(raw.reqPatterns);
  }

  const lockFile = raw.lockFile ?? DEFAULT_CONFIG.lockFile;
  const resolvedLock = resolve(rootDir, lockFile);
  const relFromRoot = relative(rootDir, resolvedLock);
  if (relFromRoot.startsWith("..") || isAbsolute(relFromRoot)) {
    throw new Error(
      `Invalid lockFile path "${lockFile}": must resolve within the project root`,
    );
  }

  return {
    include: raw.include ?? DEFAULT_CONFIG.include,
    specDirs: raw.specDirs ?? DEFAULT_CONFIG.specDirs,
    testPatterns: raw.testPatterns ?? DEFAULT_CONFIG.testPatterns,
    lockFile,
    reqPatterns: raw.reqPatterns,
    docGraph: raw.docGraph,
    mode: raw.mode === "symbol" ? "symbol" : "file",
  };
}
