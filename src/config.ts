import { existsSync, readFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { DEFAULT_CONFIG, type SpectraceConfig, type ReqPatternConfig } from "./types.js";

const CONFIG_FILE = ".spectrace.json";

// Upper bound on a user-supplied pattern's length. Patterns are matched against
// every line of every spec file, so an over-long pattern combined with nested
// quantifiers is a cheap way to trigger catastrophic backtracking (ReDoS).
const MAX_PATTERN_LENGTH = 200;

// Heuristic for nested quantifiers such as (a+)+, (a*)*, (a+)*, ((a)+)+ which are
// the classic source of exponential backtracking. We reject a quantifier that is
// applied to a group whose contents already end in a quantifier. This is a
// best-effort static guard, not a complete ReDoS analysis.
const NESTED_QUANTIFIER_RE = /\([^)]*[+*]\)[+*]/;

// Count the number of capturing groups in a pattern by letting the regex engine
// itself parse it: `new RegExp(src + "|")` always matches the empty string, and
// the resulting match array has one slot per capturing group (plus index 0).
// This correctly handles escaped parens, character classes and named groups —
// cases a regex-on-regex heuristic gets wrong.
function countCaptureGroups(pattern: string): number {
  return new RegExp(pattern + "|").exec("")!.length - 1;
}

function validateReqPatterns(patterns: ReqPatternConfig): void {
  for (const field of ["listItem", "heading", "codeId"] as const) {
    const pattern = patterns[field];
    if (pattern === undefined) continue;

    if (pattern === "") {
      throw new Error(`Invalid reqPatterns.${field}: pattern must not be empty`);
    }

    if (pattern.length > MAX_PATTERN_LENGTH) {
      throw new Error(
        `Invalid reqPatterns.${field}: pattern must not exceed ${MAX_PATTERN_LENGTH} characters`,
      );
    }

    if (NESTED_QUANTIFIER_RE.test(pattern)) {
      throw new Error(
        `Invalid reqPatterns.${field}: nested quantifiers (e.g. "(a+)+") are rejected to prevent catastrophic backtracking`,
      );
    }

    try {
      new RegExp(pattern);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Invalid reqPatterns.${field}: invalid regular expression — ${msg}`,
      );
    }

    // listItem/heading extract the ID from capture group 1, so they must have
    // one. codeId uses whole-match semantics, so a capture group is optional.
    if (field !== "codeId" && countCaptureGroups(pattern) < 1) {
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
