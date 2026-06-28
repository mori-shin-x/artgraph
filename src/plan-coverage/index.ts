// spec 014 — `artgraph plan-coverage` core handler.
//
// Contracts:
//   - specs/014-reinvent-impact-cli/contracts/plan-coverage-json.md
//   - specs/014-reinvent-impact-cli/contracts/cli-flags.md
//   - specs/014-reinvent-impact-cli/contracts/mention-semantics.md
//
// Pipeline (FR-015):
//   1. extract files from tasks.md (and plan.md if present) via the spec 014
//      sdd-files parser — Stage A (`Files:` section) preferred, Stage B
//      (regex fallback) only when Stage A is empty.
//   2. for each unique source file run `impact(graph, [fileStartId], lock)`
//      so we preserve the file→reqs mapping (a single union impact() loses
//      that information).
//   3. union all affected REQs → run `detectMentions` against the union of
//      tasks/plan/spec text. Mentioned REQs drop out; the remainder is the
//      raw implicit set.
//   4. `--ignore` filter: subtract one-shot IDs (recorded in `ignored[]` for
//      transparency).
//   5. assemble two output axes — by-sourceFile (`implicitImpacts`) and
//      by-FR (`implicitImpactsByReq`, an inversion of #4). Both are sorted
//      lexicographic per the contract.
//   6. `--require-files-section`: emit a `missingFilesSection` diagnostic
//      for every task block in tasks.md that lacks a `Files:` header.
//   7. text vs json formatting + exit code calculation.
//
// `impact()` itself stays untouched (FR-008). The N×impact() pattern on the
// by-sourceFile axis trades extra BFS work for the file→reqs provenance the
// schema requires; with N typically <= 20 the cost is negligible.

import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { loadConfig } from "../config.js";
import { scan } from "../scan.js";
import { readLock } from "../lock.js";
import { impact, resolveFileStartIds } from "../graph/traverse.js";
import { extractFiles, type TaskBlock } from "../parsers/sdd-files.js";
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

export interface AffectedReqEntry {
  reqId: string;
  kind: "req";
}

export interface ImpactGroup {
  sourceFile: string;
  reqs: AffectedReqEntry[];
}

export interface ImplicitImpactByReq {
  reqId: string;
  sourceFiles: string[];
}

export type PlanCoverageDiagnostic =
  | { kind: "missingFilesSection"; taskId: string; line: number }
  | { kind: "unresolvedFilePath"; sourceFile: string; line?: number }
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

function buildSourceFileGroups(
  sourceFileToReqs: Map<string, Set<string>>,
  excluded: Set<string>,
): ImpactGroup[] {
  const groups: ImpactGroup[] = [];
  for (const sourceFile of sortStrings([...sourceFileToReqs.keys()])) {
    const reqs = sourceFileToReqs.get(sourceFile)!;
    const visible = sortStrings(
      [...reqs].filter((r) => !excluded.has(r)),
    );
    if (visible.length === 0) continue;
    groups.push({
      sourceFile,
      reqs: visible.map((reqId) => ({ reqId, kind: "req" as const })),
    });
  }
  return groups;
}

function buildByReqGroups(groups: ImpactGroup[]): ImplicitImpactByReq[] {
  const reqToFiles = new Map<string, Set<string>>();
  for (const g of groups) {
    for (const r of g.reqs) {
      let bucket = reqToFiles.get(r.reqId);
      if (!bucket) {
        bucket = new Set();
        reqToFiles.set(r.reqId, bucket);
      }
      bucket.add(g.sourceFile);
    }
  }
  return sortStrings([...reqToFiles.keys()]).map((reqId) => ({
    reqId,
    sourceFiles: sortStrings([...reqToFiles.get(reqId)!]),
  }));
}

function formatText(
  result: PlanCoverageResult,
  ignore: string[],
): string {
  const lines: string[] = [];
  const totalImplicit = result.implicitImpactsByReq.length;
  if (totalImplicit === 0) {
    lines.push("No implicit impacts.");
  } else {
    lines.push(`Implicit impacts (${totalImplicit} REQ(s) impacted but not mentioned):`);
    lines.push("");
    lines.push("  By source file:");
    for (const g of result.implicitImpacts) {
      lines.push(`    ${g.sourceFile}`);
      for (const r of g.reqs) {
        lines.push(`      ${r.reqId}  (${r.kind})`);
      }
    }
    lines.push("");
    lines.push("  By requirement:");
    for (const r of result.implicitImpactsByReq) {
      lines.push(`    ${r.reqId}  <- ${r.sourceFiles.join(", ")}`);
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
          lines.push(`  [unresolvedFilePath] ${d.sourceFile}`);
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
  const {
    repoRoot,
    tasksPath,
    planPath,
    specDir,
    format,
    gate,
    ignore,
    requireFilesSection,
  } = options;

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
      text: formatText(empty, ignore),
    };
  }

  const planContent = safeRead(planPath);
  const specPath = resolvePath(specDir, "spec.md");
  const specContent = safeRead(specPath);

  // Stage A/B extraction. tasks.md is the structured source; plan.md
  // contributes additional file seeds when present. Diagnostics from both
  // are flattened into the output.
  const tasksExtract = extractFiles(tasksContent, { graph, repoRoot });
  const planExtract = planContent !== undefined
    ? extractFiles(planContent, { graph, repoRoot })
    : undefined;

  // Union of file seeds (dedup, sort for deterministic output downstream).
  const fileSet = new Set<string>(tasksExtract.files);
  if (planExtract) {
    for (const f of planExtract.files) fileSet.add(f);
  }
  const sourceFiles = sortStrings([...fileSet]);

  const diagnostics: PlanCoverageDiagnostic[] = [];

  // Flatten Stage A's unresolvedFilePath diagnostics into the shared
  // diagnostics[] (renaming the field to `sourceFile` to match the
  // top-level contract).
  for (const d of tasksExtract.diagnostics) {
    if (d.kind === "unresolvedFilePath") {
      diagnostics.push({ kind: "unresolvedFilePath", sourceFile: d.path });
    }
  }
  if (planExtract) {
    for (const d of planExtract.diagnostics) {
      if (d.kind === "unresolvedFilePath") {
        diagnostics.push({ kind: "unresolvedFilePath", sourceFile: d.path });
      }
    }
  }

  // --require-files-section: emit `missingFilesSection` for every task
  // block in tasks.md (heading-delimited) that lacks a `Files:` header.
  // Sourced from the parser's `taskBlocks` extension so the heading
  // boundaries match Stage A scope rules.
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

  // No files extracted from either stream — short-circuit with the
  // emptyExtraction diagnostic. `--gate` still trips because the
  // diagnostic is non-empty.
  if (sourceFiles.length === 0) {
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
      text: formatText(result, ignore),
    };
  }

  // ----- by-sourceFile axis: one impact() per file so we keep the
  // file→reqs mapping. A single union impact() would lose that.
  const sourceFileToReqs = new Map<string, Set<string>>();
  const totalAffectedSet = new Set<string>();
  for (const sourceFile of sourceFiles) {
    const startIds = resolveFileStartIds(graph, [sourceFile]);
    if (startIds.length === 0) {
      // file not in graph and not a registered node — record (silently)
      // and skip; the unresolvedFilePath warning above already covers it
      // for Stage A.
      sourceFileToReqs.set(sourceFile, new Set());
      continue;
    }
    const impactResult = impact(graph, startIds, lock);
    const reqs = new Set(impactResult.affectedReqs);
    sourceFileToReqs.set(sourceFile, reqs);
    for (const r of reqs) totalAffectedSet.add(r);
  }

  // Mention detection on the unique affected set. The detector is set-
  // based and label-agnostic; see mention.ts for the boundary rules.
  const affectedReqIds = [...totalAffectedSet];
  const { mentioned } = detectMentions(affectedReqIds, {
    tasks: tasksContent,
    plan: planContent,
    spec: specContent,
  });

  // The set of REQs we want to hide from `implicitImpacts`: mentioned
  // ∪ --ignore. Ignored REQs are not mentioned in the contract sense,
  // but the user asked to suppress them this round.
  const ignoreSet = new Set(ignore);
  const excludedFromImplicit = new Set<string>([...mentioned, ...ignoreSet]);

  // Build the two output axes. The by-FR axis is the inversion of the
  // by-sourceFile axis; we derive it from `implicitImpacts` so the two
  // are guaranteed to agree.
  const implicitImpacts = buildSourceFileGroups(
    sourceFileToReqs,
    excludedFromImplicit,
  );
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

  // Exit code: --gate is the only thing that turns a "noisy report" into
  // a hard failure. Empty implicit + empty diagnostics = clean even with
  // --gate. --ignore that drains the implicit list also clears the gate.
  const tripGate = gate && (implicitImpacts.length > 0 || diagnostics.length > 0);
  const exitCode: 0 | 1 = tripGate ? 1 : 0;

  const text = format === "text" ? formatText(json, ignore) : "";
  return { json, exitCode, text };
}
