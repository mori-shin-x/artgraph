// spec 016 — `artgraph plan-coverage` core handler (US1, two-axis output).
//
// Contracts:
//   - specs/016-impact-plan-symbol-level/contracts/plan-coverage-json.md
//   - specs/016-impact-plan-symbol-level/contracts/sdd-files-parser.md
//   - specs/016-impact-plan-symbol-level/contracts/mention-semantics.md (spec 014, unchanged)
//
// Pipeline (data-model.md §3, FR-016..FR-023):
//   1. extract entries from tasks.md (and plan.md when present) via the
//      sdd-files parser. Stage A returns `SymbolEntry[]` carrying optional
//      symbol attribution; Stage B (regex fallback) returns file-only
//      entries (`symbol: undefined`).
//   2. for each unique `(path, symbol ?? null)` entry:
//        - resolveStartIds → forward-BFS impact() → `impactReqs`
//        - resolveOriginReqs on the **primary** node id (file:<p> for file
//          entries, symbol:<p>#<s> for symbol entries) → `originReqs`.
//          Using the primary id intentionally excludes child-symbol claims
//          when the entry is a file (so file-top `@impl` is reported alone).
//   3. union impactReqs across entries → detectMentions vs the tasks/plan/
//      spec text. Mentioned REQs drop out of every group's impactReqs but
//      stay in `originReqs` (origin is the raw claim view; mention does not
//      negate authorship).
//   4. `--ignore` applies to BOTH axes per FR-022.
//   5. assemble two output axes — by-(sourceFile, sourceSymbol?)
//      (`implicitImpacts`) and by-REQ (`implicitImpactsByReq` with
//      `sourceLocations` that retains symbol attribution). Sort INV-S3/S4.
//   6. `--require-files-section` emits `missingFilesSection` per task block
//      lacking a `Files:` header (unchanged from spec 014).
//   7. unresolvedSymbol diagnostics from the parser are flattened into
//      `diagnostics[]` and their entries are excluded from `implicitImpacts`
//      (FR-021).
//   8. text vs json formatting + exit code.
//
// `impact()` itself stays untouched (R-006). Per-entry impact() runs trade
// extra BFS work for the per-(file,symbol) provenance the schema requires;
// with N typically <= 20 the cost is negligible.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import { loadConfig } from "../config.js";
import { scan } from "../scan.js";
import { readLock } from "../lock.js";
import { impact, resolveStartIds, resolveOriginReqs } from "../graph/traverse.js";
import { extractFiles, type SymbolEntry, type TaskBlock } from "../parsers/sdd-files.js";
import { detectMentions } from "./mention.js";

export interface PlanCoverageOptions {
  /** Absolute repo root (the directory `loadConfig` / `scan` operate on). */
  repoRoot: string;
  /** Resolved spec directory (`.specify/specs/<name>` or `.kiro/specs/<name>`). */
  specDir: string;
  /** Absolute path to tasks.md (required). */
  tasksPath: string;
  /** Absolute path to plan.md if present, otherwise undefined. */
  planPath?: string;
  format: "json" | "text";
  gate: boolean;
  /** Parsed `--ignore` REQ-IDs (one-shot suppression). */
  ignore: string[];
  /** `--require-files-section` or `.artgraph.json` planCoverage override. */
  requireFilesSection: boolean;
}

/**
 * spec 016 (data-model.md §3.1) — element type for `impactReqs` /
 * `originReqs`. spec 014's `AffectedReqEntry` alias is removed; callers
 * use `ReqEntry` exclusively.
 */
export interface ReqEntry {
  reqId: string;
  kind: "req";
}

export interface ImpactGroup {
  /** Repo-relative source path (POSIX) of the entry's file. */
  sourceFile: string;
  /**
   * spec 016 (FR-018) — present iff the entry was a `path:symbol`
   * declaration. Omitted (JSON key absent) for file-unit entries.
   */
  sourceSymbol?: string;
  /**
   * Forward-BFS REQs reached from the entry's startIds, with mentioned
   * and `--ignore` REQs subtracted. Sorted by reqId ascending (INV-S3).
   */
  impactReqs: ReqEntry[];
  /**
   * Raw `@impl` claim union from the entry's PRIMARY node only
   * (`file:<p>` for file entries, `symbol:<p>#<s>` for symbol entries),
   * 1 hop along `implements`. Mention is NOT subtracted — origin is the
   * authorship view, independent from the implicit-impact axis. `[]` when
   * the primary node has no `@impl` tag. Sorted ascending (INV-S5).
   */
  originReqs: ReqEntry[];
}

export interface ImplicitImpactByReq {
  reqId: string;
  /**
   * spec 016 (FR-020, INV-S4) — origin locations for this REQ. `file` is
   * always present; `symbol` is present when at least one symbol-unit
   * entry reached the REQ. Sort: file ascending, then symbol ascending
   * with `undefined` first (so the file-unit row precedes symbol rows on
   * the same file).
   */
  sourceLocations: Array<{ file: string; symbol?: string }>;
}

export type PlanCoverageDiagnostic =
  | { kind: "missingFilesSection"; taskId: string; line: number }
  | { kind: "unresolvedFilePath"; sourceFile: string; line: number }
  | {
      /**
       * spec 016 (FR-021) — flattened from the parser's
       * `Diagnostic.unresolvedSymbol`. Emitted when the entry's path
       * resolves but the symbol is not registered in the graph. The
       * entry is dropped from `implicitImpacts` per contract §4.2.
       */
      kind: "unresolvedSymbol";
      sourceFile: string;
      symbol: string;
      line: number;
    }
  | { kind: "emptyExtraction" };

export interface PlanCoverageSummary {
  totalAffected: number;
  mentioned: number;
  implicit: number;
  ignored: number;
}

export interface PlanCoverageResult {
  implicitImpacts: ImpactGroup[];
  implicitImpactsByReq: ImplicitImpactByReq[];
  summary: PlanCoverageSummary;
  diagnostics: PlanCoverageDiagnostic[];
  ignored: string[];
}

export interface PlanCoverageRunResult {
  json: PlanCoverageResult;
  exitCode: 0 | 1;
  text: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeRead(path: string | undefined): string | undefined {
  if (path === undefined || path === "") return undefined;
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf-8");
}

function sortStrings(arr: string[]): string[] {
  return [...arr].sort((a, b) => a.localeCompare(b));
}

function toReqEntries(reqIds: string[]): ReqEntry[] {
  return reqIds.map((reqId) => ({ reqId, kind: "req" as const }));
}

// Mirror `normalizeForLookup` from src/graph/traverse.ts so the per-entry
// origin-node id we build below uses the same canonical key the graph
// builder registers under. Kept private so the two stay in lockstep.
function normalizeForLookup(input: string): string {
  if (isAbsolute(input)) return input;
  const root = "/__artgraph__";
  const abs = resolvePath(root, input);
  const rel = relative(root, abs);
  if (rel.length === 0 || rel === ".." || rel.startsWith(`..${sep}`)) return input;
  return rel.split(sep).join("/");
}

/**
 * Primary origin node id for an entry — used for `originReqs` resolution
 * so a file-unit entry does NOT inherit its children symbols' `@impl`
 * claims (data-model.md §3.2). `resolveStartIds` deliberately expands
 * file-unit entries to include same-file symbols for BFS reach; that
 * expansion is the WRONG basis for origin attribution.
 */
function entryOriginIds(entry: SymbolEntry): string[] {
  const path = normalizeForLookup(entry.path);
  if (entry.symbol !== undefined) return [`symbol:${path}#${entry.symbol}`];
  return [`file:${path}`];
}

// Dedup key for ImpactGroup ordering / aggregation (INV-S3). Newline
// guarantees the two pieces never collide for path/symbol pairs that
// share characters (`a:b` vs `a` + `:b`).
function dedupKey(path: string, symbol: string | undefined): string {
  return `${path}\n${symbol ?? ""}`;
}

interface GroupDraft {
  sourceFile: string;
  sourceSymbol?: string;
  impactReqs: Set<string>;
  originReqs: Set<string>;
}

// INV-S3 / S4 sort: file ascending → symbol ascending with `undefined`
// preceding any string. Kept inline so the two output axes share one
// canonical compare definition.
function compareLocations(
  a: { file: string; symbol?: string },
  b: { file: string; symbol?: string },
): number {
  const fileCmp = a.file.localeCompare(b.file);
  if (fileCmp !== 0) return fileCmp;
  if (a.symbol === b.symbol) return 0;
  if (a.symbol === undefined) return -1;
  if (b.symbol === undefined) return 1;
  return a.symbol.localeCompare(b.symbol);
}

function buildImpactGroups(
  drafts: GroupDraft[],
  excludedFromImpact: Set<string>,
  ignoreSet: Set<string>,
): ImpactGroup[] {
  // Sort drafts by (file, symbol) so output order matches contract.
  const sorted = [...drafts].sort((a, b) =>
    compareLocations(
      { file: a.sourceFile, symbol: a.sourceSymbol },
      { file: b.sourceFile, symbol: b.sourceSymbol },
    ),
  );
  const groups: ImpactGroup[] = [];
  for (const d of sorted) {
    // `impactReqs` view: subtract BOTH mentioned (the implicit semantics)
    // and --ignore (one-shot suppression, FR-022).
    const visibleImpact = sortStrings([...d.impactReqs].filter((r) => !excludedFromImpact.has(r)));
    // `originReqs` view: raw authorship — only --ignore strips entries
    // here (FR-022 says ignore applies to BOTH axes, but mention is the
    // implicit-impact axis only; per data-model §3.2 originReqs is the
    // unfiltered claim set).
    const visibleOrigin = sortStrings([...d.originReqs].filter((r) => !ignoreSet.has(r)));
    // Group inclusion follows the implicit-impact axis: a group surfaces
    // ONLY when `impactReqs` (post mention + ignore subtraction) is
    // non-empty — that is the user-attention axis. `originReqs` rides
    // along as contextual claim data and may be empty (file-unit with no
    // file-top `@impl`, contract §2.1) or non-empty. Per data-model.md
    // §2.4 either axis empty is a valid shape, but a group whose
    // impactReqs collapsed to [] under mention subtraction is "covered"
    // and shouldn't pollute the implicit list.
    if (visibleImpact.length === 0) continue;
    const group: ImpactGroup = {
      sourceFile: d.sourceFile,
      impactReqs: toReqEntries(visibleImpact),
      originReqs: toReqEntries(visibleOrigin),
    };
    // Only attach `sourceSymbol` when the entry was a symbol-unit declaration
    // — file entries must serialize WITHOUT the key (contracts/plan-coverage-
    // json.md §2.1).
    if (d.sourceSymbol !== undefined) group.sourceSymbol = d.sourceSymbol;
    groups.push(group);
  }
  return groups;
}

function buildByReqGroups(groups: ImpactGroup[]): ImplicitImpactByReq[] {
  // For the by-REQ axis we invert only `impactReqs` — `originReqs` is the
  // authorship view per group and does not roll up to the REQ index.
  const reqToLocs = new Map<string, Array<{ file: string; symbol?: string }>>();
  for (const g of groups) {
    for (const r of g.impactReqs) {
      let bucket = reqToLocs.get(r.reqId);
      if (!bucket) {
        bucket = [];
        reqToLocs.set(r.reqId, bucket);
      }
      const loc: { file: string; symbol?: string } = { file: g.sourceFile };
      if (g.sourceSymbol !== undefined) loc.symbol = g.sourceSymbol;
      bucket.push(loc);
    }
  }
  return sortStrings([...reqToLocs.keys()]).map((reqId) => {
    const bucket = reqToLocs.get(reqId)!;
    // Groups are already dedup'd by (file, symbol?), but the same group
    // can contribute the same location once. Dedup defensively (cheap)
    // before sorting so a future caller change can't introduce dups.
    const seen = new Set<string>();
    const unique: Array<{ file: string; symbol?: string }> = [];
    for (const loc of bucket) {
      const k = dedupKey(loc.file, loc.symbol);
      if (seen.has(k)) continue;
      seen.add(k);
      unique.push(loc);
    }
    return { reqId, sourceLocations: unique.sort(compareLocations) };
  });
}

// Pretty-print a location for text output. Symbol entries collapse to
// `path#symbol` (`#` chosen over `:` so the rendering does not look like
// an additional path component).
function formatLocation(loc: { file: string; symbol?: string }): string {
  return loc.symbol !== undefined ? `${loc.file}#${loc.symbol}` : loc.file;
}

interface FormatTextOptions {
  requireFilesSection: boolean;
}

function formatText(
  result: PlanCoverageResult,
  ignore: string[],
  formatOptions: FormatTextOptions,
): string {
  const lines: string[] = [];
  const totalImplicit = result.implicitImpactsByReq.length;
  if (totalImplicit === 0 && result.implicitImpacts.length === 0) {
    lines.push("No implicit impacts.");
  } else {
    lines.push(`Implicit impacts (${totalImplicit} REQ(s) impacted but not mentioned):`);
    lines.push("");
    lines.push("  By source file:");
    for (const g of result.implicitImpacts) {
      const header = formatLocation({ file: g.sourceFile, symbol: g.sourceSymbol });
      lines.push(`    ${header}`);
      lines.push(`      Impact reqs:`);
      if (g.impactReqs.length === 0) lines.push(`        (none)`);
      else for (const r of g.impactReqs) lines.push(`        ${r.reqId}  (${r.kind})`);
      lines.push(`      Origin reqs (@impl claims):`);
      if (g.originReqs.length === 0) lines.push(`        (none)`);
      else for (const r of g.originReqs) lines.push(`        ${r.reqId}  (${r.kind})`);
      // Drift candidates = impactReqs \ originReqs. Per FR-015 / quickstart D
      // we OMIT the section entirely when the diff is empty (no drift).
      const originSet = new Set(g.originReqs.map((r) => r.reqId));
      const drift = g.impactReqs.filter((r) => !originSet.has(r.reqId));
      if (drift.length > 0) {
        lines.push(`      Drift candidates (impact \\ origin):`);
        for (const r of drift) lines.push(`        ${r.reqId}  (${r.kind})`);
      }
    }
    if (totalImplicit > 0) {
      lines.push("");
      lines.push("  By requirement:");
      for (const r of result.implicitImpactsByReq) {
        const locs = r.sourceLocations.map(formatLocation).join(", ");
        lines.push(`    ${r.reqId}  <- ${locs}`);
      }
    }
  }

  if (result.diagnostics.length > 0) {
    lines.push("");
    lines.push(`Diagnostics: ${result.diagnostics.length}`);
    for (const d of result.diagnostics) {
      switch (d.kind) {
        case "missingFilesSection":
          lines.push(`  [missingFilesSection] ${d.taskId} (line ${d.line})`);
          break;
        case "unresolvedFilePath":
          lines.push(`  [unresolvedFilePath] ${d.sourceFile} (line ${d.line})`);
          break;
        case "unresolvedSymbol":
          lines.push(`  [unresolvedSymbol] ${d.sourceFile}#${d.symbol} (line ${d.line})`);
          break;
        case "emptyExtraction":
          lines.push(`  [emptyExtraction]`);
          break;
      }
    }
  }

  if (ignore.length > 0) {
    lines.push("");
    lines.push(`Ignored (one-shot): ${ignore.join(", ")}`);
  }

  // Hints (spec 014 UX-4): silent-green report needs a nudge so the user
  // understands why the report came back empty / whether `--require-files-
  // section` is in effect.
  const hints: string[] = [];
  if (!formatOptions.requireFilesSection) {
    hints.push(
      "Hint: --require-files-section is OFF; tasks without a `Files:` section are not flagged. " +
        "Enable in .artgraph.json (planCoverage.requireFilesSection: true) or pass " +
        "--require-files-section to catch missing Files: sections.",
    );
  }
  if (result.diagnostics.some((d) => d.kind === "emptyExtraction")) {
    hints.push(
      "Hint: no files extracted from tasks.md. Add a `Files: <path>` section or check that " +
        "referenced paths exist.",
    );
  }
  if (hints.length > 0) {
    lines.push("");
    for (const h of hints) lines.push(h);
  }

  lines.push("");
  lines.push(
    `Summary: ${result.summary.totalAffected} affected | ${result.summary.mentioned} mentioned | ${result.summary.implicit} implicit | ${result.summary.ignored} ignored`,
  );
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function runPlanCoverage(options: PlanCoverageOptions): PlanCoverageRunResult {
  const { repoRoot, tasksPath, planPath, specDir, format, gate, ignore, requireFilesSection } =
    options;

  // Load graph + lock once.
  const config = loadConfig(repoRoot);
  const { graph } = scan(repoRoot, config);
  const lock = readLock(repoRoot, config.lockFile);

  // Read source texts. tasks.md is the spine; plan.md / spec.md are
  // optional (per FR-015 they only contribute to mention detection).
  const tasksContent = safeRead(tasksPath);
  if (tasksContent === undefined) {
    // The CLI layer should have already failed with a clearer error, but
    // be defensive — return an emptyExtraction shaped result so callers
    // don't have to special-case missing-file errors here.
    const empty: PlanCoverageResult = {
      implicitImpacts: [],
      implicitImpactsByReq: [],
      summary: { totalAffected: 0, mentioned: 0, implicit: 0, ignored: 0 },
      diagnostics: [{ kind: "emptyExtraction" }],
      ignored: [...ignore],
    };
    return {
      json: empty,
      exitCode: gate ? 1 : 0,
      text: formatText(empty, ignore, { requireFilesSection }),
    };
  }

  const planContent = safeRead(planPath);
  const specPath = resolvePath(specDir, "spec.md");
  const specContent = safeRead(specPath);

  // Stage A/B extraction. tasks.md is the structured source; plan.md
  // contributes additional file seeds when present.
  const tasksExtract = extractFiles(tasksContent, { graph, repoRoot });
  const planExtract =
    planContent !== undefined ? extractFiles(planContent, { graph, repoRoot }) : undefined;

  // Dedup entries across (tasks, plan) preserving first-seen order so
  // groups appear in the order the author declared them (before the
  // INV-S3 sort by file/symbol below).
  const seenEntryKey = new Set<string>();
  const entries: SymbolEntry[] = [];
  for (const e of tasksExtract.entries) {
    const k = dedupKey(e.path, e.symbol);
    if (seenEntryKey.has(k)) continue;
    seenEntryKey.add(k);
    entries.push(e);
  }
  if (planExtract) {
    for (const e of planExtract.entries) {
      const k = dedupKey(e.path, e.symbol);
      if (seenEntryKey.has(k)) continue;
      seenEntryKey.add(k);
      entries.push(e);
    }
  }

  const diagnostics: PlanCoverageDiagnostic[] = [];

  // Flatten parser diagnostics into the shared diagnostics[]. Both
  // unresolvedFilePath and unresolvedSymbol travel here so the consumer
  // sees a unified surface. INV-S1 (per-entry exclusivity) is preserved
  // because the parser already enforces it upstream.
  const flattenParserDiagnostics = (extract: typeof tasksExtract): void => {
    for (const d of extract.diagnostics) {
      if (d.kind === "unresolvedFilePath") {
        diagnostics.push({
          kind: "unresolvedFilePath",
          sourceFile: d.path,
          line: d.line,
        });
      } else if (d.kind === "unresolvedSymbol") {
        diagnostics.push({
          kind: "unresolvedSymbol",
          sourceFile: d.sourceFile,
          symbol: d.symbol,
          line: d.line,
        });
      }
    }
  };
  flattenParserDiagnostics(tasksExtract);
  if (planExtract) flattenParserDiagnostics(planExtract);

  // --require-files-section: emit `missingFilesSection` for every task
  // block in tasks.md (heading-delimited) that lacks a `Files:` header.
  if (requireFilesSection && tasksExtract.taskBlocks) {
    const missing = tasksExtract.taskBlocks.filter((b: TaskBlock) => !b.hasFilesSection);
    for (const b of missing) {
      diagnostics.push({
        kind: "missingFilesSection",
        taskId: b.taskId,
        line: b.line,
      });
    }
  }

  // No entries extracted from either stream — short-circuit with the
  // emptyExtraction diagnostic. `--gate` still trips because the
  // diagnostic is non-empty.
  if (entries.length === 0) {
    diagnostics.push({ kind: "emptyExtraction" });
    const result: PlanCoverageResult = {
      implicitImpacts: [],
      implicitImpactsByReq: [],
      summary: { totalAffected: 0, mentioned: 0, implicit: 0, ignored: 0 },
      diagnostics,
      ignored: [...ignore],
    };
    return {
      json: result,
      exitCode: gate && diagnostics.length > 0 ? 1 : 0,
      text: formatText(result, ignore, { requireFilesSection }),
    };
  }

  // Per-entry impact + origin computation. Each entry yields at most one
  // GroupDraft; entries that fail to resolve (unresolvedSymbol surfaced
  // upstream, unresolvedFilePath with no graph match) are dropped here so
  // they don't pollute the groups but their diagnostics are still surfaced.
  const drafts: GroupDraft[] = [];
  const totalAffectedSet = new Set<string>();
  for (const entry of entries) {
    const { startIds } = resolveStartIds(graph, [entry]);
    if (startIds.length === 0) {
      // Either the symbol was unresolved (parser already emitted the
      // diagnostic; FR-021 says drop the entry from implicitImpacts) or
      // the file path was unresolved (unresolvedFilePath already in
      // diagnostics). Either way, no impact() to compute.
      continue;
    }
    const impactResult = impact(graph, startIds, lock);
    const originReqs = resolveOriginReqs(graph, entryOriginIds(entry));
    drafts.push({
      sourceFile: entry.path,
      sourceSymbol: entry.symbol,
      impactReqs: new Set(impactResult.impactReqs),
      originReqs: new Set(originReqs),
    });
    for (const r of impactResult.impactReqs) totalAffectedSet.add(r);
  }

  // Mention detection on the unique affected set. The detector is set-
  // based and label-agnostic; see mention.ts for the boundary rules.
  const affectedReqIds = [...totalAffectedSet];
  const { mentioned } = detectMentions(affectedReqIds, {
    tasks: tasksContent,
    plan: planContent,
    spec: specContent,
  });

  // REQs to hide from `impactReqs`: mentioned ∪ --ignore. Per FR-022 the
  // --ignore set ALSO applies to `originReqs` (origins the user explicitly
  // suppressed should not surface in either axis).
  const ignoreSet = new Set(ignore);
  const excludedFromImplicit = new Set<string>([...mentioned, ...ignoreSet]);

  const implicitImpacts = buildImpactGroups(drafts, excludedFromImplicit, ignoreSet);
  const implicitImpactsByReq = buildByReqGroups(implicitImpacts);

  // Summary counters. `ignored` only counts REQs that would otherwise
  // have appeared as implicit (i.e. they were actually in the affected
  // set). An `--ignore` ID that points at a REQ no one would have
  // flagged anyway contributes 0 to the summary but still appears in
  // `ignored[]` for transparency.
  const ignoredCount = [...ignoreSet].filter(
    (id) => totalAffectedSet.has(id) && !mentioned.has(id),
  ).length;
  const summary: PlanCoverageSummary = {
    totalAffected: totalAffectedSet.size,
    mentioned: mentioned.size,
    implicit: implicitImpactsByReq.length,
    ignored: ignoredCount,
  };

  const json: PlanCoverageResult = {
    implicitImpacts,
    implicitImpactsByReq,
    summary,
    diagnostics,
    ignored: [...ignore],
  };

  // Exit code: --gate flips a noisy report into a hard failure. Empty
  // implicit + empty diagnostics = clean even with --gate.
  const tripGate = gate && (implicitImpacts.length > 0 || diagnostics.length > 0);
  const exitCode: 0 | 1 = tripGate ? 1 : 0;

  const text = format === "text" ? formatText(json, ignore, { requireFilesSection }) : "";
  return { json, exitCode, text };
}
