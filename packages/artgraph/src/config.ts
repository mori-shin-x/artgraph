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

// Heuristic ReDoS detector. Reject any pattern containing a group `(X)` whose
// body X has an inner quantifier / alternation AND whose outer is itself
// quantified to an unbounded or growing range. Covers all the documented
// bypasses of the older one-liner heuristic:
//   - `(a+)+`, `(a*)*`, `(.+)+`         (inner +/* under outer +/*)
//   - `(a|a)+`, `(?:a|aa)+`             (alternation overlap)
//   - `(a{1,5})+`                       (braced inner under outer +/*)
//   - `((a+))+`, `((x)*)+`              (double-nested, missed by the old regex)
//   - `(X+){2,}` and `(X){2,5}`         (outer braced ranges)
// Best-effort: this is a static heuristic, not a full state-machine analysis,
// so users hand-writing pinpoint patterns may see false positives. The built-in
// presets are NOT routed through this check.
function detectReDoSRisk(pattern: string): boolean {
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "[") {
      // Skip character class — `(` / `)` inside are literal.
      i++;
      while (i < pattern.length && pattern[i] !== "]") {
        if (pattern[i] === "\\") i += 2;
        else i++;
      }
      i++;
      continue;
    }
    if (c !== "(") {
      i++;
      continue;
    }
    // Found a group. Find the matching `)`.
    let depth = 1;
    let j = i + 1;
    while (j < pattern.length && depth > 0) {
      const ch = pattern[j];
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === "[") {
        j++;
        while (j < pattern.length && pattern[j] !== "]") {
          if (pattern[j] === "\\") j += 2;
          else j++;
        }
        j++;
        continue;
      }
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      }
      j++;
    }
    if (depth !== 0) {
      // Unmatched paren — let `new RegExp` complain downstream.
      return false;
    }
    const body = pattern.slice(i + 1, j);
    const after = j + 1;
    if (after < pattern.length && isOuterRisky(pattern, after) && bodyHasInnerRisk(body)) {
      return true;
    }
    // Recurse into nested groups by stepping past the `(` and continuing.
    i++;
  }
  return false;
}

// Is the character (or `{n,m}` cluster) at `pos` an unbounded/growing quantifier?
function isOuterRisky(pattern: string, pos: number): boolean {
  const ch = pattern[pos];
  if (ch === "+" || ch === "*") return true;
  if (ch === "{") {
    const close = pattern.indexOf("}", pos);
    if (close <= pos) return false;
    const inside = pattern.slice(pos + 1, close);
    if (!inside.includes(",")) return false; // {n} is bounded
    const [lo, hi] = inside.split(",");
    if (hi === "") return true; // {n,} unbounded
    const ln = Number(lo);
    const hn = Number(hi);
    if (!Number.isFinite(ln) || !Number.isFinite(hn)) return false;
    return hn > ln;
  }
  return false;
}

// Does the group body contain an unescaped inner quantifier (`+`, `*`, `{...}`)
// or alternation (`|`)? `?:` / `?=` / `?!` / `?<name>` / `?<=` / `?<!` group
// prefixes are stripped before scanning so they don't trip the check.
function bodyHasInnerRisk(rawBody: string): boolean {
  let body = rawBody;
  if (body.startsWith("?:") || body.startsWith("?=") || body.startsWith("?!")) {
    body = body.slice(2);
  } else if (body.startsWith("?<=") || body.startsWith("?<!")) {
    body = body.slice(3);
  } else if (body.startsWith("?<")) {
    const close = body.indexOf(">");
    if (close > 0) body = body.slice(close + 1);
  }
  let k = 0;
  while (k < body.length) {
    const c = body[k];
    if (c === "\\") {
      k += 2;
      continue;
    }
    if (c === "[") {
      // skip character class — `|` / `+` inside are literal
      k++;
      while (k < body.length && body[k] !== "]") {
        if (body[k] === "\\") k += 2;
        else k++;
      }
      k++;
      continue;
    }
    if (c === "+" || c === "*" || c === "|" || c === "{") return true;
    k++;
  }
  return false;
}

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

    if (detectReDoSRisk(pattern)) {
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

// Names reserved by built-in task convention presets. Users can normally not
// reuse these in their `.artgraph.json` because doing so would silently override
// (or duplicate) the built-in entry. Listing a name under
// `disableBuiltinTaskConventions` opts the built-in OUT and frees its name for
// a user-defined replacement. The actual built-in definitions live in
// parsers/markdown.ts.
const BUILTIN_TASK_PRESET_NAMES = ["spec-kit", "kiro"] as const;

function validateDisableBuiltins(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("Invalid disableBuiltinTaskConventions: must be an array of strings");
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry === "") {
      throw new Error(
        `Invalid disableBuiltinTaskConventions: every entry must be a non-empty string`,
      );
    }
    if (!(BUILTIN_TASK_PRESET_NAMES as readonly string[]).includes(entry)) {
      throw new Error(
        `Invalid disableBuiltinTaskConventions: "${entry}" is not a built-in (allowed: ${BUILTIN_TASK_PRESET_NAMES.join(", ")})`,
      );
    }
    out.push(entry);
  }
  return out;
}

function validateTaskConventions(value: unknown, disabled: Set<string>): void {
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

    if (seenNames.has(name)) {
      throw new Error(
        `Invalid taskConventions: duplicate name "${name}" in user list`,
      );
    }
    if (
      (BUILTIN_TASK_PRESET_NAMES as readonly string[]).includes(name) &&
      !disabled.has(name)
    ) {
      throw new Error(
        `Invalid taskConventions: name "${name}" collides with a built-in preset. ` +
          `Add "${name}" to "disableBuiltinTaskConventions" to override it, or choose a different name.`,
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

    validateTaskRegexField(idx, "taskIdRe", taskIdRe, /* required */ true);
    validateTaskRegexField(
      idx,
      "implementsTagRe",
      (preset as { implementsTagRe?: unknown }).implementsTagRe,
      /* required */ false,
    );
    validateTaskRegexField(
      idx,
      "verifiesTagRe",
      (preset as { verifiesTagRe?: unknown }).verifiesTagRe,
      /* required */ false,
    );
  }
}

// Shared regex-shape validator for `taskIdRe` / `implementsTagRe` / `verifiesTagRe`.
// `required = false` means `undefined` is accepted (the SDD tool doesn't use that
// edge kind). Empty string is rejected in both modes — explicit-but-empty is a typo.
function validateTaskRegexField(
  idx: number,
  field: "taskIdRe" | "implementsTagRe" | "verifiesTagRe",
  value: unknown,
  required: boolean,
): void {
  if (value === undefined) {
    if (required) {
      throw new Error(`Invalid taskConventions[${idx}].${field}: must not be empty`);
    }
    return;
  }
  if (typeof value !== "string" || value === "") {
    throw new Error(`Invalid taskConventions[${idx}].${field}: must not be empty`);
  }
  if (value.length > MAX_PATTERN_LENGTH) {
    throw new Error(
      `Invalid taskConventions[${idx}].${field}: pattern must not exceed ${MAX_PATTERN_LENGTH} characters`,
    );
  }
  if (detectReDoSRisk(value)) {
    throw new Error(
      `Invalid taskConventions[${idx}].${field}: nested quantifiers (e.g. "(a+)+") are rejected to prevent catastrophic backtracking`,
    );
  }
  try {
    new RegExp(value);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Invalid taskConventions[${idx}].${field}: invalid regular expression — ${msg}`,
    );
  }
  if (countCaptureGroups(value) < 1) {
    throw new Error(
      `Invalid taskConventions[${idx}].${field}: regex must contain at least one capture group (group 1 is used as the target ID)`,
    );
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

  const disabledBuiltins = validateDisableBuiltins(raw.disableBuiltinTaskConventions);
  validateTaskConventions(raw.taskConventions, new Set(disabledBuiltins ?? []));

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
    disableBuiltinTaskConventions: disabledBuiltins,
  };
}
