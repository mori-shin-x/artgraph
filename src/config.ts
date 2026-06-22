import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_CONFIG, type SpectraceConfig } from "./types.js";

const CONFIG_FILE = ".spectrace.json";

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

  return {
    include: raw.include ?? DEFAULT_CONFIG.include,
    specDirs: raw.specDirs ?? DEFAULT_CONFIG.specDirs,
    testPatterns: raw.testPatterns ?? DEFAULT_CONFIG.testPatterns,
    lockFile: raw.lockFile ?? DEFAULT_CONFIG.lockFile,
    reqPatterns: raw.reqPatterns,
    docGraph: raw.docGraph,
    mode: raw.mode === "symbol" ? "symbol" : "file",
    testResultPaths: Array.isArray(raw.testResultPaths) ? raw.testResultPaths : undefined,
  };
}
