import { existsSync, readFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import {
  DEFAULT_CONFIG,
  type ArtgraphConfig,
  type ReqPatternConfig,
  type TaskConventionPreset,
} from "./types.js";

const CONFIG_FILE = ".artgraph.json";

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

// Names reserved by built-in task convention presets. Users can't reuse these in
// their `.artgraph.json` because doing so would silently override (or duplicate)
// the built-in entry. The actual built-in definitions live in parsers/markdown.ts.
const BUILTIN_TASK_PRESET_NAMES = ["spec-kit", "kiro"] as const;

function validateTaskConventions(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new Error("Invalid taskConventions: must be an array");
  }

  const seenNames = new Set<string>();

  for (let idx = 0; idx < value.length; idx++) {
    const preset = value[idx] as Partial<TaskConventionPreset> | undefined;
    if (!preset || typeof preset !== "object") {
      throw new Error(`Invalid taskConventions[${idx}]: must be an object`);
    }

    const { name, fileStems, taskIdRe } = preset;

    if (typeof name !== "string" || name === "") {
      throw new Error(`Invalid taskConventions[${idx}].name: must not be empty`);
    }

    if (
      (BUILTIN_TASK_PRESET_NAMES as readonly string[]).includes(name) ||
      seenNames.has(name)
    ) {
      throw new Error(
        `Invalid taskConventions: duplicate name "${name}". Built-in presets are "spec-kit", "kiro" — choose another name.`,
      );
    }
    seenNames.add(name);

    if (!Array.isArray(fileStems) || fileStems.length === 0) {
      throw new Error(
        `Invalid taskConventions[${idx}].fileStems: must not be empty`,
      );
    }
    for (const stem of fileStems) {
      if (typeof stem !== "string" || stem === "") {
        throw new Error(
          `Invalid taskConventions[${idx}].fileStems: every entry must be a non-empty string`,
        );
      }
    }

    if (typeof taskIdRe !== "string" || taskIdRe === "") {
      throw new Error(
        `Invalid taskConventions[${idx}].taskIdRe: must not be empty`,
      );
    }
    if (taskIdRe.length > MAX_PATTERN_LENGTH) {
      throw new Error(
        `Invalid taskConventions[${idx}].taskIdRe: pattern must not exceed ${MAX_PATTERN_LENGTH} characters`,
      );
    }
    if (NESTED_QUANTIFIER_RE.test(taskIdRe)) {
      throw new Error(
        `Invalid taskConventions[${idx}].taskIdRe: nested quantifiers (e.g. "(a+)+") are rejected to prevent catastrophic backtracking`,
      );
    }
    try {
      new RegExp(taskIdRe);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Invalid taskConventions[${idx}].taskIdRe: invalid regular expression — ${msg}`,
      );
    }
    if (countCaptureGroups(taskIdRe) < 1) {
      throw new Error(
        `Invalid taskConventions[${idx}].taskIdRe: regex must contain at least one capture group (group 1 is used as the task ID)`,
      );
    }
  }
}

// `testResultPaths` is fed straight into glob, so a non-string element (e.g.
// `[123]`) would crash deep inside globSync with an opaque error. Validate the
// shape up front and fail with a clear, actionable message instead.
function validateTestResultPaths(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new Error("Invalid testResultPaths: must be an array of strings");
  }
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error(
        `Invalid testResultPaths: every entry must be a string (got ${typeof entry})`,
      );
    }
  }
}

export function loadConfig(rootDir: string): ArtgraphConfig {
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

  validateTaskConventions(raw.taskConventions);

  validateTestResultPaths(raw.testResultPaths);

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
    testResultPaths: raw.testResultPaths,
    taskConventions: raw.taskConventions,
  };
}
