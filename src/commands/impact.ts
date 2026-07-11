// `artgraph impact` — extracted verbatim from `src/cli.ts` (issue #162).

import { Command } from "commander";
import type { SymbolEntry } from "../types.js";
import { pathsToEntries, TRACE_NO_SHARDS_GUIDANCE } from "./shared.js";
import { printImpactText } from "./presenters/impact.js";

// spec 014 (FR-001 / FR-003): REQ-ID inputs are no longer accepted here.
// The supported start sources are listed in this error so the user is
// pushed onto the right tool for their actual intent. Kept as a const at
// module scope so the wording stays in sync with the contract file and the
// CLI tests can assert against a single canonical string.
const IMPACT_REQ_ID_REJECTION = [
  "error: REQ-ID inputs are not accepted by `artgraph impact`.",
  "use one of the following start sources:",
  "  artgraph impact <file>...          # explicit file paths",
  "  artgraph impact --diff             # use git diff",
  "for tasks.md / plan.md analysis, use `artgraph plan-coverage`.",
].join("\n");

// `doc:` prefix is also rejected (FR-001 / FR-002). Surface the same
// start sources so the user has a complete menu — the underlying mental
// model is identical: `impact` is now file-only.
const IMPACT_DOC_PREFIX_REJECTION = [
  "error: `doc:` prefix inputs are not accepted by `artgraph impact`.",
  "use one of the following start sources:",
  "  artgraph impact <file>...          # explicit file paths",
  "  artgraph impact --diff             # use git diff",
  "for tasks.md / plan.md analysis, use `artgraph plan-coverage`.",
].join("\n");

// spec 014 (UX-1): Broaden REQ-ID input detection so the navigational error
// fires for every REQ-ID shape the artgraph ecosystem documents (README §
// "valid REQ-ID grammar"). Without this widening, Kiro `Requirement-3` and
// scoped `auth/FR-2` inputs slip past the early reject and hit the generic
// "No matching nodes found" path with no migration hint.
//
// Matches:
//   - REQ-001 / FR-032 / AUTH-001  (all-uppercase prefix + numeric tail)
//   - Requirement-3                (Pascal-case Kiro-style prefix)
//   - auth/FR-2 / auth-2fa/REQ-1   (scoped: <scope>/<base>)
//   - REQ-1.2 / Requirement-1.1    (dotted numeric tail for hierarchical IDs)
//
// We deliberately *under*-match: only inputs that look like a REQ-ID get
// routed to the 4-path navigational error; everything else (file path,
// non-conforming string) continues to the file-resolution path so the
// existing "No matching nodes found" message still fires.
const REQ_ID_INPUT_RE = /^(?:[A-Za-z][\w-]*\/)?[A-Z][A-Za-z]*-\d+(?:\.\d+)*$/;

export function registerImpactCommand(program: Command): void {
  program
    .command("impact")
    .description(
      "Show forward impact from file paths or symbol entries (spec 016: file or `path:symbol`)",
    )
    .argument(
      "[targets...]",
      "File paths or `path:symbol` entries — REQ-IDs and `doc:` prefix are rejected",
    )
    .option("--diff", "Use git diff to detect changed files")
    .option(
      "--tests",
      "List tagged tests of REQs whose exercises evidence reaches the resolved nodes (requires a trace, FR-018)",
    )
    .option("--format <format>", "Output format: json | text", "text")
    .action(async (targets: string[], opts) => {
      const rootDir = process.cwd();

      // spec 016 T026 / contracts/cli-flags.md §2 — validation order:
      //   1. REQ-ID rejection
      //   2. doc: prefix rejection
      //   3. Mutually exclusive source check
      //   4. (symbol syntax detection happens implicitly inside pathsToEntries)
      //   5. graph scan + resolve start ids
      //   6. scan-mode mismatch (R-010)
      //   7. impact BFS

      // ----- Input validation: reject REQ-ID / doc: prefix BEFORE we touch
      // the filesystem so the user gets the 4-path navigational error even on
      // a repo without `.artgraph.json`. FR-012.
      for (const t of targets) {
        if (REQ_ID_INPUT_RE.test(t)) {
          console.error(IMPACT_REQ_ID_REJECTION);
          process.exit(1);
        }
        if (t.startsWith("doc:")) {
          console.error(IMPACT_DOC_PREFIX_REJECTION);
          process.exit(1);
        }
      }

      // ----- Mutually exclusive start sources. `targets[]` and `--diff` each
      // count as a single channel; contracts/cli-flags.md requires exactly one
      // to be present.
      if (targets.length > 0 && opts.diff) {
        console.error(
          "error: start sources are mutually exclusive (specify only one): targets, --diff",
        );
        process.exit(1);
      }
      if (targets.length === 0 && !opts.diff) {
        console.error("error: no start source specified. pass file paths or --diff.");
        process.exit(1);
      }

      const { loadConfig } = await import("../config.js");
      const { scan } = await import("../scan.js");
      const { readLock } = await import("../lock.js");
      const { entryOriginIds, impact, resolveStartIds, resolveOriginReqs } =
        await import("../graph/traverse.js");
      const config = loadConfig(rootDir);

      // spec 020 (FR-018, contracts/cli-surface.md §5) — `--tests` requires
      // trace evidence to exist at all; exit 1 with the SAME guidance string
      // `trace report` uses (FR-018's explicit "同文言" requirement) before
      // any graph/git work happens.
      const { hasTraceShards, ingestTrace } = await import("../trace/ingest.js");
      const hasTrace = hasTraceShards(config, rootDir);
      if (opts.tests && !hasTrace) {
        console.error(TRACE_NO_SHARDS_GUIDANCE);
        process.exit(1);
      }

      const { graph } = scan(rootDir, config);
      const lock = readLock(rootDir, config.lockFile);

      // spec 020 (FR-017) — load evidence once, resolve the staleness
      // exclusion set (only when `trace.staleness === "exclude"`) so both the
      // BFS traversal below AND `--tests`'s testsToRun use the exact same
      // "what counts as evidence right now" trace snapshot.
      let ingestedTrace: import("../trace/ingest.js").IngestedTrace | undefined;
      let excludeStaleExercises: Set<string> | undefined;
      if (hasTrace) {
        ingestedTrace = ingestTrace(config, rootDir);
        if ((config.trace?.staleness ?? "warn") === "exclude") {
          const { computeStaleNodeIds } = await import("../trace/report.js");
          excludeStaleExercises = computeStaleNodeIds(graph, ingestedTrace);
        }
      }

      // ----- Build SymbolEntry[] from the chosen channel:
      //   * --diff → file-unit only (contracts/cli-flags.md §1.3; git diff has
      //     no symbol resolution).
      //   * positional targets → CLI_PATH_SYMBOL_RE lift in `pathsToEntries`
      //     (T027). Symbol detection is a SIDE EFFECT of building the entries,
      //     so it happens after #1-#3 above per the validation order.
      let entries: SymbolEntry[];
      let inputDisplayLabels: string[]; // for "No matching nodes found" message
      if (opts.diff) {
        const { getGitDiffFiles } = await import("../diff.js");
        const diffFiles = getGitDiffFiles(rootDir);
        if (diffFiles.length === 0) {
          // E4: this used to always print plain text + exit 0, ignoring
          // `--format json`. A JSON consumer (e.g. a CI script piping into
          // `jq`) would get invalid JSON on the common "no changes" case.
          // Emit the same shape as the normal `impact` JSON output
          // (`ImpactResult`), just all-empty, plus a `message` field so a
          // JSON consumer can still tell the no-diff case apart from a real
          // (but empty) blast radius.
          if (opts.format === "json") {
            console.log(
              JSON.stringify({
                affectedFiles: [],
                affectedDocs: [],
                impactReqs: [],
                affectedTasks: [],
                drifted: [],
                originReqs: [],
                summary: { docs: 0, reqs: 0, files: 0, tasks: 0 },
                message: "No changes detected in git diff.",
              }),
            );
          } else {
            console.log("No changes detected in git diff.");
          }
          process.exit(0);
        }
        entries = diffFiles.map((p) => ({ path: p, line: 1 }));
        inputDisplayLabels = diffFiles.slice();
      } else {
        entries = pathsToEntries(targets);
        inputDisplayLabels = targets.slice();
      }

      const hasSymbolInput = entries.some((e) => e.symbol !== undefined);

      const { startIds, unresolvedSymbols } = resolveStartIds(graph, entries);

      // T029 / R-010 / contracts/cli-flags.md §4.2 — scan-mode mismatch.
      // When the input includes any symbol entry but the current graph has zero
      // `symbol` nodes, that's a global "you didn't scan in symbol mode" miss
      // — every entry would otherwise pile up as `unresolvedSymbol`. Emit the
      // dedicated global error so the user knows to flip `.artgraph.json`'s
      // mode rather than going hunting for typos.
      if (hasSymbolInput) {
        let hasSymbolNode = false;
        for (const node of graph.nodes.values()) {
          if (node.kind === "symbol") {
            hasSymbolNode = true;
            break;
          }
        }
        if (!hasSymbolNode) {
          console.error(
            [
              "ERROR: symbol-level input requires a symbol-mode graph.",
              '       Set `mode: "symbol"` in `.artgraph.json` and re-run `artgraph scan`',
              "       to enable symbol-mode lookup.",
            ].join("\n"),
          );
          process.exit(1);
        }
      }

      // T030 / R-009 / contracts/cli-flags.md §4.1 — per-entry symbol miss.
      // Symbol nodes exist but this specific `path:symbol` isn't registered —
      // typo, export rename, or a stale graph. Surface one line per entry so
      // the user can target the fix.
      if (unresolvedSymbols.length > 0) {
        for (const u of unresolvedSymbols) {
          const label = `${u.path}:${u.symbol}`;
          console.error(`ERROR: No matching symbol found for: ${label}`);
          console.error(
            `  hint: check the export name with \`grep "export.*${u.symbol}" ${u.path}\``,
          );
          console.error(
            `        or verify that \`mode: "symbol"\` is set in \`.artgraph.json\` and re-scan.`,
          );
        }
        process.exit(1);
      }

      if (startIds.length === 0) {
        console.error(`No matching nodes found for: ${inputDisplayLabels.join(", ")}`);
        process.exit(1);
      }

      const result = impact(
        graph,
        startIds,
        lock,
        undefined,
        excludeStaleExercises ? { excludeStaleExercises } : undefined,
      );

      // T031 / FR-014 / INV-S6 — populate `originReqs` axis. `impact()` itself
      // stays purely forward-BFS; the origin axis takes the resolved startIds
      // (file entries here already include same-file symbol children via
      // `resolveStartIds`'s file-expansion, so children's `@impl` claims still
      // count — spec 014 Case 6 test) and additionally, for symbol entries,
      // walks `imports` edges transitively so a barrel-symbol input reaches
      // the origin's `@impl` claim through however many hops separate them
      // (issue #191 asymmetry: `plan-coverage` already did this via
      // `entryOriginIds`; without the parallel expansion here, `artgraph
      // impact src/index.ts:validateToken` still reported false-positive
      // drift for barrel entries).
      const originStartIds = new Set<string>(startIds);
      for (const entry of entries) {
        if (entry.symbol === undefined) continue;
        for (const id of entryOriginIds(entry, graph)) originStartIds.add(id);
      }
      result.originReqs = resolveOriginReqs(graph, [...originStartIds]);

      // spec 020 (FR-018, contracts/cli-surface.md §5) — `--tests`: union,
      // over every startId, the REQs whose (staleness-filtered) exercises
      // evidence directly reaches that node, then list each such REQ's full
      // tagged-test set (the trace only tracks test membership at REQ grain,
      // not per-node — see `IngestedTrace.perReq[reqId].tests`'s doc).
      if (opts.tests && ingestedTrace) {
        const { excludeStaleEvidence, ownerFilePath } = await import("../trace/report.js");
        const effectiveTrace = excludeStaleExercises
          ? excludeStaleEvidence(ingestedTrace, excludeStaleExercises)
          : ingestedTrace;

        // Grain-aware startId <-> evidence join (file-mode fix, T021a2
        // regression). `reqsByNode` is keyed at whatever grain INGEST
        // resolved each hit to (symbol when the name join succeeded, file
        // on FR-007 fallback) — independent of `.artgraph.json`'s `mode` —
        // while `startIds` follow the GRAPH's grain (`file:` only in file
        // mode; `symbol:` + `file:` in symbol mode). Exact node-id equality
        // therefore structurally never matches in a file-mode project. The
        // join rules, mirroring `reqExercises`' both-grains philosophy in
        // `src/trace/report.ts` (FR-007 fail-safe symmetry: compare at
        // whatever grain the evidence actually landed at):
        //   1. exact node id match (symbol-mode fast path, unchanged), or
        //   2. a `file:` startId matches ANY evidence node owned by that
        //      file (file-unit start covers its members — same semantics as
        //      `resolveStartIds`' file->symbols expansion), or
        //   3. a `file:` evidence node (FR-007 fallback) matches any
        //      startId owned by that file (degraded evidence must still
        //      reach the REQ, SC-006 — fail-safe, not fail-open).
        // A symbol-grain startId never matches a DIFFERENT symbol in the
        // same file (rules 2/3 both require a `file:` grain on one side),
        // preserving US3-1's symbol-mode precision.
        const startIdSet = new Set(startIds);
        const startFilePaths = new Set<string>();
        const startOwnerPaths = new Set<string>();
        for (const id of startIds) {
          const owner = ownerFilePath(id);
          if (owner === undefined) continue;
          startOwnerPaths.add(owner);
          if (id.startsWith("file:")) startFilePaths.add(owner);
        }

        const reachingReqIds = new Set<string>();
        for (const [node, reqIds] of effectiveTrace.reqsByNode) {
          const owner = ownerFilePath(node);
          const matches =
            startIdSet.has(node) ||
            (owner !== undefined && startFilePaths.has(owner)) ||
            (node.startsWith("file:") && owner !== undefined && startOwnerPaths.has(owner));
          if (!matches) continue;
          for (const reqId of reqIds) reachingReqIds.add(reqId);
        }

        const seen = new Set<string>();
        const testsToRun: Array<{ testFile: string; testName: string; reqId: string }> = [];
        for (const reqId of [...reachingReqIds].sort()) {
          const coverage = effectiveTrace.perReq.get(reqId);
          if (!coverage) continue;
          for (const t of coverage.tests) {
            const key = `${reqId} ${t.testFile} ${t.testName}`;
            if (seen.has(key)) continue;
            seen.add(key);
            testsToRun.push({ testFile: t.testFile, testName: t.testName, reqId });
          }
        }
        result.testsToRun = testsToRun;
      }

      if (opts.format === "json") {
        console.log(JSON.stringify(result));
      } else {
        printImpactText(result);
      }
    });
}
