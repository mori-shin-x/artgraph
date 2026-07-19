import { existsSync, readFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import picomatch from "picomatch";
import {
  DEFAULT_CONFIG,
  type ArtgraphConfig,
  type PackageManager,
  type PlanCoverageConfig,
  type ReqPatternConfig,
  type TaskConventionPreset,
  type TraceConfig,
} from "./types.js";
import { AGENT_IDS, type AgentId } from "./agents/descriptors.js";

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
      throw new Error(`Invalid reqPatterns.${field}: invalid regular expression — ${msg}`);
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
      throw new Error(`Invalid taskConventions: duplicate name "${name}" in user list`);
    }
    if ((BUILTIN_TASK_PRESET_NAMES as readonly string[]).includes(name) && !disabled.has(name)) {
      throw new Error(
        `Invalid taskConventions: name "${name}" collides with a built-in preset. ` +
          `Add "${name}" to "disableBuiltinTaskConventions" to override it, or choose a different name.`,
      );
    }
    seenNames.add(name);

    if (!Array.isArray(fileStems) || fileStems.length === 0) {
      throw new Error(`Invalid taskConventions[${idx}].fileStems: must not be empty`);
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

// issue #216 — `ignoreIdPrefixes` validation. Each entry must be a bare ID
// prefix in the requirement-ID grammar (`[A-Z][A-Za-z]*` — the part before the
// `-<digits>`), e.g. "SC" to exclude Spec Kit Success Criteria. Rejecting
// anything else (empty string, lowercase start, `SC-`, `SC-\d+` regex-ish
// input) up front keeps the builder's prefix matcher trivially regex-safe and
// gives the author an actionable message instead of a silently-ignored entry.
const ID_PREFIX_RE = /^[A-Z][A-Za-z]*$/;

function validateIgnoreIdPrefixes(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("Invalid ignoreIdPrefixes: must be an array of strings");
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry === "") {
      throw new Error("Invalid ignoreIdPrefixes: every entry must be a non-empty string");
    }
    if (!ID_PREFIX_RE.test(entry)) {
      throw new Error(
        `Invalid ignoreIdPrefixes: "${entry}" must be a bare ID prefix matching [A-Z][A-Za-z]* (e.g. "SC", not "SC-" or "SC-\\d+")`,
      );
    }
    out.push(entry);
  }
  return out;
}

// spec 013 follow-up (#158) — `.artgraph.json` `agents` field validation.
// Mirrors `validateIgnoreIdPrefixes`: `undefined` round-trips as `undefined`
// (legacy configs pre-dating this field), everything else must be a
// deduped array of Tier 1 `AgentId` strings. Returned alpha-sorted so the
// persisted array (and every downstream cross-check) has a stable order
// regardless of how `init --agents=<csv>` was invoked.
function validateAgents(value: unknown): AgentId[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("Invalid agents: must be an array of strings");
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || entry === "") {
      throw new Error("Invalid agents: every entry must be a non-empty string");
    }
    if (!(AGENT_IDS as readonly string[]).includes(entry)) {
      throw new Error(
        `Invalid agents: "${entry}" is not a supported agent id (allowed: ${AGENT_IDS.join(", ")})`,
      );
    }
    if (seen.has(entry)) {
      throw new Error(`Invalid agents: duplicate entry "${entry}"`);
    }
    seen.add(entry);
  }
  return [...seen].sort() as AgentId[];
}

// issue #234 — `.artgraph.json` specDirs with a parent/child pair (e.g.
// `["specs", "specs/sub"]`) makes builder.ts's `for (const specDirName of
// config.specDirs)` loop (graph/builder.ts) glob-match the same physical file
// twice with two different `specDirPrefix`es, producing two doc nodes for one
// file (e.g. `doc:sub/x.md` and `doc:x.md`). REQ nodes dedup by ID so this
// silently corrupts the doc-node count without a visible collision. Filter
// descendant entries here, at config-load time, so the builder only ever
// sees non-overlapping specDirs.
//
// Rules: POSIX segment-aware ancestor check (`specs` is an ancestor of
// `specs/sub` but not of `specs2` — plain startsWith would prefix-collide);
// exact duplicates are also deduped. Every drop gets a `console.warn`.
//
// PR #238 adversarial review: raw-string comparison was byte-sensitive, so a
// trailing slash (`"specs/"`) or leading `./` (`"./specs/sub"`) silently
// defeated both the ancestor check AND the exact-duplicate check, letting the
// same ghost-doc corruption from #234 slip back in. `normalizeSpecDir`
// canonicalizes every entry (strip leading `./`, collapse `//`, strip
// trailing `/`) before it's compared OR persisted, so downstream consumers
// (builder.ts) only ever see canonical paths regardless of how the user typed
// them in `.artgraph.json`.
function normalizeSpecDir(dir: string): string {
  let s = dir;
  while (s.startsWith("./")) s = s.slice(2);
  s = s.replace(/\/+/g, "/"); // collapse repeated slashes
  while (s.endsWith("/") && s.length > 1) s = s.slice(0, -1);
  return s;
}

function isAncestorOf(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return false;
  // The `\\` branch is dead on POSIX (this project targets WSL2, not native
  // Windows — see .github/workflows/ci.yml) but is kept as cheap defensive
  // belt-and-braces for a stray mixed-slash input like `spec\sub`.
  return descendant.startsWith(ancestor + "/") || descendant.startsWith(ancestor + "\\");
}

function validateSpecDirs(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    // Lenient posture, matching validatePackageManager: a wholly malformed
    // field (not even an array) silently drops to the DEFAULT_CONFIG.specDirs
    // fallback in loadConfig rather than throwing.
    return undefined;
  }
  // Shape check is strict, though: a single non-string entry must not
  // silently discard the user's other, valid entries by falling all the way
  // back to DEFAULT_CONFIG.specDirs. Match the sibling validators
  // (validateIgnoreIdPrefixes et al.) and throw with an actionable message.
  for (const [i, v] of value.entries()) {
    if (typeof v !== "string") {
      throw new Error(
        `Invalid specDirs[${i}]: expected string, got ${typeof v} (${JSON.stringify(v)})`,
      );
    }
  }

  const dirs = value as string[];

  const kept: string[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const normalized = normalizeSpecDir(dir);
    if (seen.has(normalized)) {
      console.warn(`WARNING: specDirs contains duplicate entry "${dir}"; ignoring the duplicate.`);
      continue;
    }
    seen.add(normalized);
    // Cite the SHORTEST matching ancestor: with e.g. `["a/x", "a", "a/x/y"]`,
    // multiple prior entries can be ancestors of `a/x/y`, but only the
    // shortest one (`"a"`) is guaranteed to survive filtering itself (a
    // longer ancestor like `"a/x"` may get dropped as a descendant of `"a"`
    // in the same pass). Citing a dropped ancestor in the warning would
    // mislead the user about which specDirs entry actually remains.
    const ancestor = dirs
      .map(normalizeSpecDir)
      .filter((other) => isAncestorOf(other, normalized))
      .sort((a, b) => a.length - b.length)[0];
    if (ancestor !== undefined) {
      console.warn(
        `WARNING: specDirs entry "${dir}" is a descendant of "${ancestor}" and is redundant; ignoring "${dir}". See issue #234.`,
      );
      continue;
    }
    kept.push(normalized);
  }

  return kept;
}

// spec 014 — `.artgraph.json` `planCoverage` section validation. Currently
// only `requireFilesSection: boolean` is recognised; unknown fields are
// silently dropped (no warning) so the schema can grow without breaking
// existing configs that pre-load a future field.
// `packageManager` is recorded by `init` for downstream exec-command building.
// Be lenient on read: accept only the 4 known values, silently drop anything
// else (unknown string / wrong type) so a hand-edited config never crashes the
// CLI. Mirrors the lenient posture of the other optional fields.
function validatePackageManager(value: unknown): PackageManager | undefined {
  if (value === "npm" || value === "pnpm" || value === "bun" || value === "deno") {
    return value;
  }
  // Yarn is the one unsupported value we expect users to actually try (it was a
  // first-class PM until spec 015 dropped it). Surface a warning so the silent
  // drop doesn't surprise anyone debugging "why is my packageManager gone?".
  // Other unknown values (typos like "npmm") stay silent — warning on every
  // typo would be noise.
  if (value === "yarn") {
    console.warn("WARNING: Yarn is not supported; ignoring `.artgraph.json` packageManager field");
    return undefined;
  }
  return undefined;
}

function validatePlanCoverage(value: unknown): PlanCoverageConfig | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid planCoverage: must be an object");
  }
  const out: PlanCoverageConfig = {};
  if ("requireFilesSection" in value) {
    const v = (value as { requireFilesSection: unknown }).requireFilesSection;
    if (typeof v !== "boolean") {
      throw new Error("Invalid planCoverage.requireFilesSection: must be a boolean");
    }
    out.requireFilesSection = v;
  }
  return out;
}

// spec 020 (contracts/cli-surface.md §7, data-model.md §8) — `.artgraph.json`
// `trace` section validation. Mirrors `validatePlanCoverage`: `undefined`
// round-trips as `undefined` (both the section itself and every unspecified
// field), unknown-shaped values are rejected up front, and each present
// field is validated independently so a typo in one field doesn't mask a
// valid sibling.
const TRACE_STALENESS_VALUES = ["warn", "exclude", "gate"] as const;

function validateTraceConfig(value: unknown): TraceConfig | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid trace: must be an object");
  }
  const raw = value as Record<string, unknown>;
  const out: TraceConfig = {};

  if ("artifacts" in raw) {
    const artifacts = raw.artifacts;
    if (!Array.isArray(artifacts)) {
      throw new Error("Invalid trace.artifacts: must be an array of strings");
    }
    for (const entry of artifacts) {
      if (typeof entry !== "string") {
        throw new Error(
          `Invalid trace.artifacts: every entry must be a string (got ${typeof entry})`,
        );
      }
    }
    out.artifacts = artifacts;
  }

  if ("acceptExercises" in raw) {
    const acceptExercises = raw.acceptExercises;
    if (typeof acceptExercises !== "boolean") {
      throw new Error("Invalid trace.acceptExercises: must be a boolean");
    }
    out.acceptExercises = acceptExercises;
  }

  if ("staleness" in raw) {
    const staleness = raw.staleness;
    if (!(TRACE_STALENESS_VALUES as readonly unknown[]).includes(staleness)) {
      throw new Error(
        `Invalid trace.staleness: must be one of "warn", "exclude", "gate" (got ${JSON.stringify(staleness)})`,
      );
    }
    out.staleness = staleness as (typeof TRACE_STALENESS_VALUES)[number];
  }

  if ("sharedThreshold" in raw) {
    const sharedThreshold = raw.sharedThreshold;
    if (
      typeof sharedThreshold !== "number" ||
      !Number.isInteger(sharedThreshold) ||
      sharedThreshold < 1
    ) {
      throw new Error("Invalid trace.sharedThreshold: must be a positive integer (>= 1)");
    }
    out.sharedThreshold = sharedThreshold;
  }

  return out;
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

// PR #359 review (H1) — `include` / `testPatterns` are read as glob PATTERN
// LISTS by both `discoverCodeFiles` (parsers/typescript.ts, fed straight
// into `fastGlob.sync`) and `missingNodeModulesProtection` (below, whose
// `.some()` / picomatch calls require a real string array). Before this
// check, `raw.include ?? DEFAULT_CONFIG.include` only guarded `undefined` —
// a hand-edited `.artgraph.json` with a bare string (`"include":
// "src/**/*.ts"`) or a mixed-type array (`["src/**", 42]`) sailed straight
// through to those call sites and crashed deep inside them with an opaque,
// non-actionable error (e.g. `patterns.some is not a function`), rather than
// failing closed with a message that says what's actually wrong. Mirrors
// `validateTestResultPaths` above (strict shape, not `validateSpecDirs`'s
// lenient array-or-undefined posture): a config field that is consumed as a
// glob pattern LIST must actually BE one — there is no sensible partial
// fallback for "half the entries are strings, half aren't" the way there is
// for, say, an optional boolean flag.
function validateGlobPatternList(value: unknown, field: "include" | "testPatterns"): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new Error(
      `Invalid "${field}" in .artgraph.json: expected an array of glob pattern strings, got ${typeof value}`,
    );
  }
  for (const [i, entry] of value.entries()) {
    if (typeof entry !== "string") {
      throw new Error(
        `Invalid "${field}[${i}]" in .artgraph.json: expected a glob pattern string, got ${typeof entry} (${JSON.stringify(entry)})`,
      );
    }
  }
}

// issue #356 — `include` and `testPatterns` are two independent glob pools
// (see `discoverCodeFiles` in `parsers/typescript.ts`, and `DEFAULT_CONFIG`'s
// own doc comment in `types.ts`): each pool needs its OWN
// `"!**/node_modules/**"`-style negative pattern to stay protected from
// node_modules ingestion (issue #350's HIGH-2 widened this from a single
// shared negation to two). `missingNodeModulesProtection` (below) is the
// single shared judge — called by both the silent
// `config-pool-protection-asymmetry` scan warning (`graph/builder.ts`) and
// the `artgraph doctor` advisory finding of the same name (`doctor.ts`), so
// the two surfaces can never disagree — and `formatPoolProtectionMessage`
// (further below) is the single shared message generator both surfaces
// render through, so their wording can never drift apart either (PR #359
// review M2).
//
// PR #359 review (H2) — a plain string/path-segment check ("does a negative
// pattern contain a `node_modules` segment anywhere") cannot actually judge
// PROTECTION: measured false positive — `!node_modules/**` (no `**/`
// prefix) contains the segment but only ever excludes a REPO-ROOT
// `node_modules/`, leaving `packages/foo/node_modules/**` completely
// unprotected; measured false negative — `!**/*node_modules*/**` protects
// every nesting depth via a wildcard segment but the old segment-equality
// check doesn't recognize `*node_modules*` as containing the exact literal
// `node_modules` and misjudged it as unprotected, silently swallowing a
// genuine leak into an advisory that never fires. `isMatcherProtected`
// below replaces the heuristic with real glob semantics (picomatch) evaluated
// against representative synthetic paths — still purely structural
// (Constitution Principle V: no filesystem access, fully deterministic), just
// backed by the actual matching engine instead of a string proxy for it.
const SYNTHETIC_NODE_MODULES_PATHS = [
  "node_modules/x.ts",
  "a/node_modules/x.ts",
  "a/b/node_modules/x.ts",
] as const;

// picomatch options mirroring fast-glob's OWN ignore-pattern evaluation,
// verified by reading fast-glob's and micromatch's source (both vendored
// under node_modules at the pinned versions this project actually installs):
//
//   - fast-glob's `utils.pattern.makeRe` (fast-glob/out/utils/pattern.js)
//     calls `micromatch.makeRe(pattern, options)`.
//   - micromatch's own `makeRe` (micromatch/index.js) is defined as
//     `(...args) => picomatch.makeRe(...args)` — a bare passthrough, not a
//     wrapper that re-derives or renames options. So whatever options
//     fast-glob's `Provider._getMicromatchOptions()`
//     (fast-glob/out/providers/provider.js) builds land in picomatch
//     completely unchanged — there is no micromatch-specific option
//     translation layer to account for.
//   - fast-glob's entry filter (fast-glob/out/providers/filters/entry.js)
//     ALWAYS evaluates negative/ignore patterns with `dot: true` forced,
//     regardless of the scan-wide `dot` setting (which this project pins to
//     `false` for POSITIVE patterns — see glob-utils.ts). We exclusively
//     evaluate negative (post-`!`) patterns here, so we mirror that forced
//     value rather than the scan-wide default. (None of the synthetic paths
//     above contain a dot-segment, so in practice this is inert for this
//     matcher today — pinned anyway so the option set is an honest,
//     verifiable mirror of fast-glob's real evaluation, not a convenient
//     subset that happens to work for the current fixtures.)
//   - `matchBase: false`, `nobrace: false`, `nocase: false`, `noext: false`,
//     `noglobstar: false` are direct negations of fast-glob's own
//     `baseNameMatch` (false) / `braceExpansion` (true) /
//     `caseSensitiveMatch` (true) / `extglob` (true) / `globstar` (true)
//     defaults; `posix: true` / `strictSlashes: false` are fast-glob's own
//     hardcoded values, not settings-derived.
//
// `picomatch(patterns, options)` compiled with an ARRAY of patterns already
// matches a candidate string against every pattern with OR semantics
// (picomatch/lib/picomatch.js), matching fast-glob's own "any negative
// pattern excludes the entry" ignore behavior.
const FAST_GLOB_IGNORE_OPTIONS: picomatch.PicomatchOptions = {
  dot: true,
  matchBase: false,
  nobrace: false,
  nocase: false,
  noext: false,
  noglobstar: false,
  posix: true,
  strictSlashes: false,
};

// A pool is "protected" iff EVERY representative synthetic path is matched
// by at least one of the pool's negative patterns (stripped of their leading
// `!`) — i.e. no nesting depth is left uncovered. Empty input (no negative
// patterns at all) is trivially unprotected; `picomatch([])` would otherwise
// build a matcher over zero patterns, which never matches anything anyway,
// but the early return avoids depending on that incidental behavior.
function isMatcherProtected(strippedNegativePatterns: string[]): boolean {
  if (strippedNegativePatterns.length === 0) return false;
  const isMatch = picomatch(strippedNegativePatterns, FAST_GLOB_IGNORE_OPTIONS);
  return SYNTHETIC_NODE_MODULES_PATHS.every((p) => isMatch(p));
}

// The OLD string/path-segment heuristic, KEPT (not replaced) — it is no
// longer the protection judge (`isMatcherProtected` above owns that now),
// but it is still exactly the right signal for "did the user clearly INTEND
// to exclude node_modules here", which is what the new "broken exclusion"
// category (below) needs: a pattern that mentions `node_modules` as a
// literal path segment but, per the real matcher, doesn't actually cover
// every nesting depth (e.g. `!node_modules/**` with no `**/` prefix).
// Mirrors the segment-based (not substring) node_modules detection already
// used for the `node-modules-in-scan` warning in `buildGraph`.
function mentionsNodeModules(patterns: string[]): boolean {
  return patterns.some(
    (p) => p.startsWith("!") && p.slice(1).split(/[\\/]/).includes("node_modules"),
  );
}

// PR #359 review (M1, issue #266) — a pool with no positive pattern at all
// (empty array, or every entry negated) can never match a single file, so it
// structurally cannot ingest node_modules regardless of what its negative
// patterns do or don't cover. Judging such a pool's "protection" would be
// reporting on a hypothetical that cannot happen — exclude it from EVERY
// check below entirely (neither "protected" nor "unprotected": simply out of
// scope for both the asymmetry and the broken-exclusion category).
function hasPositivePattern(patterns: string[]): boolean {
  return patterns.some((p) => !p.startsWith("!"));
}

function strippedNegatives(patterns: string[]): string[] {
  return patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
}

export type PoolKey = "include" | "testPatterns";
export type PoolProtectionReason = "unprotected" | "broken-exclusion";

export interface PoolProtectionIssue {
  pool: PoolKey;
  reason: PoolProtectionReason;
}

// Single shared judge (see the block comment above this section for the
// full rationale). Evaluated per pool:
//   - a degenerate pool (M1, no positive pattern) is skipped entirely;
//   - "broken exclusion" (H2's third category) fires when the pool clearly
//     MENTIONS node_modules but the real matcher says it isn't actually
//     protected — reported regardless of the other pool's state, since a
//     broken exclusion attempt is never a deliberate symmetric choice (there
//     is no ambiguity to preserve, unlike the both-silent case below);
//   - "unprotected" (the original asymmetry category) fires when both pools
//     are eligible, their matcher-protected verdicts disagree, and the
//     unprotected side isn't already reported as a broken exclusion.
// Both-eligible-and-both-unprotected-with-no-mention stays silent, same as
// before H2 — indistinguishable from a deliberate, symmetric choice to scan
// node_modules on purpose (e.g. checked-in vendored code — see
// docs/configuration.md's node_modules section).
export function missingNodeModulesProtection(
  config: Pick<ArtgraphConfig, "include" | "testPatterns">,
): PoolProtectionIssue[] {
  const pools: Record<PoolKey, string[]> = {
    include: config.include,
    testPatterns: config.testPatterns,
  };
  const eligible: Record<PoolKey, boolean> = {
    include: hasPositivePattern(pools.include),
    testPatterns: hasPositivePattern(pools.testPatterns),
  };
  const protectedFlag: Record<PoolKey, boolean> = {
    include: eligible.include && isMatcherProtected(strippedNegatives(pools.include)),
    testPatterns:
      eligible.testPatterns && isMatcherProtected(strippedNegatives(pools.testPatterns)),
  };
  const broken: Record<PoolKey, boolean> = {
    include: eligible.include && mentionsNodeModules(pools.include) && !protectedFlag.include,
    testPatterns:
      eligible.testPatterns &&
      mentionsNodeModules(pools.testPatterns) &&
      !protectedFlag.testPatterns,
  };
  const asymmetricUnprotected: PoolKey | null =
    eligible.include &&
    eligible.testPatterns &&
    protectedFlag.include !== protectedFlag.testPatterns
      ? protectedFlag.include
        ? "testPatterns"
        : "include"
      : null;

  const issues: PoolProtectionIssue[] = [];
  for (const pool of ["include", "testPatterns"] as const) {
    if (!eligible[pool]) continue;
    if (broken[pool]) {
      issues.push({ pool, reason: "broken-exclusion" });
    } else if (pool === asymmetricUnprotected) {
      issues.push({ pool, reason: "unprotected" });
    }
  }
  return issues;
}

// PR #359 review (M2) — single shared message-generation function so
// `graph/builder.ts`'s silent `config-pool-protection-asymmetry` scan
// warning and `doctor.ts`'s advisory finding of the same name can never say
// different things about the identical underlying issue. Remediation is
// always the canonical `"!**/node_modules/**"` form (protects every nesting
// depth) — never a narrower, pool-specific variant — so the fix it points at
// is always correct regardless of which category triggered it.
export function formatPoolProtectionMessage(issue: PoolProtectionIssue): string {
  if (issue.reason === "broken-exclusion") {
    return (
      `"${issue.pool}" has a node_modules-excluding pattern that does not cover every nesting ` +
      `depth — replace it with "!**/node_modules/**" in .artgraph.json's "${issue.pool}" to ` +
      `actually protect it.`
    );
  }
  const protectedKey: PoolKey = issue.pool === "include" ? "testPatterns" : "include";
  return (
    `"${protectedKey}" excludes node_modules (has a "!**/node_modules/**"-style negative ` +
    `pattern) but "${issue.pool}" does not — add "!**/node_modules/**" to "${issue.pool}" in ` +
    `.artgraph.json to protect that pool too, or remove it from "${protectedKey}" if scanning ` +
    `node_modules via "${issue.pool}" is intentional.`
  );
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

  // Hand-edited configs that accidentally produce a JSON array / number / null
  // / string would otherwise sail through field-by-field validation (every
  // `raw.<field>` is just `undefined`) and silently fall back to defaults.
  // Reject the wrong top-level shape up front with an actionable message.
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("`.artgraph.json` must be a JSON object");
  }

  if (raw.reqPatterns) {
    validateReqPatterns(raw.reqPatterns);
  }

  const ignoreIdPrefixes = validateIgnoreIdPrefixes(raw.ignoreIdPrefixes);

  const disabledBuiltins = validateDisableBuiltins(raw.disableBuiltinTaskConventions);
  validateTaskConventions(raw.taskConventions, new Set(disabledBuiltins ?? []));

  validateTestResultPaths(raw.testResultPaths);

  // PR #359 review (H1) — see `validateGlobPatternList`'s own doc comment.
  // `undefined` round-trips as `undefined` (the `?? DEFAULT_CONFIG.*`
  // fallback below still applies); anything else must actually be a glob
  // pattern string array.
  validateGlobPatternList(raw.include, "include");
  validateGlobPatternList(raw.testPatterns, "testPatterns");

  const planCoverage = validatePlanCoverage(raw.planCoverage);

  const agents = validateAgents(raw.agents);

  const trace = validateTraceConfig(raw.trace);

  const lockFile = raw.lockFile ?? DEFAULT_CONFIG.lockFile;
  const resolvedLock = resolve(rootDir, lockFile);
  const relFromRoot = relative(rootDir, resolvedLock);
  if (relFromRoot.startsWith("..") || isAbsolute(relFromRoot)) {
    throw new Error(`Invalid lockFile path "${lockFile}": must resolve within the project root`);
  }

  return {
    include: raw.include ?? DEFAULT_CONFIG.include,
    specDirs: validateSpecDirs(raw.specDirs) ?? DEFAULT_CONFIG.specDirs,
    testPatterns: raw.testPatterns ?? DEFAULT_CONFIG.testPatterns,
    lockFile,
    packageManager: validatePackageManager(raw.packageManager),
    reqPatterns: raw.reqPatterns,
    ignoreIdPrefixes,
    docGraph: raw.docGraph,
    mode: raw.mode === "symbol" ? "symbol" : "file",
    testResultPaths: raw.testResultPaths,
    taskConventions: raw.taskConventions,
    disableBuiltinTaskConventions: disabledBuiltins,
    planCoverage,
    agents,
    trace,
  };
}
