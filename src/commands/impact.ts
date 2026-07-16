// `artgraph impact` — extracted verbatim from `src/cli.ts` (issue #162).

import { Command, Option } from "commander";
import type { SymbolEntry } from "../types.js";
import {
  nonOptionValue,
  pathsToEntries,
  reportGraphWarnings,
  TRACE_NO_SHARDS_GUIDANCE,
} from "./shared.js";
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
    // spec 024 (FR-001, issue #305) — CI test selection: widen `--diff`'s
    // changed-file set with the committed merge-base(<ref>, HEAD)..HEAD range
    // (spec 023 D1 semantics: never <ref>'s tip). `--base` is a MODIFIER of
    // `--diff`, not a start source — it appears in neither the start-source
    // exclusivity check nor the rejection menus (FR-003: every --base-less
    // path stays byte-identical; the rejection constants above are unchanged).
    //
    // The <ref> value is validated at PARSE time, fail-closed (spec 023
    // F1/F2 accident class, via the shared `nonOptionValue` guard): an empty
    // CI base-ref variable would otherwise make `--base --tests` swallow
    // `--tests` (test selection silently becomes a plain impact run) and
    // `--base ""` skip every opts.base branch (silent no-base degradation —
    // in CI's clean tree that is an empty selection at exit 0).
    // @impl 024-impact-base-ref/FR-001
    // @impl 024-impact-base-ref/FR-003
    .addOption(
      new Option(
        "--base <ref>",
        "Widen the git diff with the merge-base(<ref>, HEAD)..HEAD commit range (requires --diff; for CI use --base origin/<default-branch>)",
      ).argParser(
        nonOptionValue("--base", {
          hint: 'use the full refs/... spelling for a ref that really starts with "-"',
        }),
      ),
    )
    // spec 024 (FR-010) — the issue #306 F7 residue: this was the last raw
    // `--format` among the gate-adjacent commands. `.choices()` (the check/doctor/
    // rename/plan-coverage/integrate convention) rejects both a swallowed
    // flag (`--format --diff` eating the start source) and a bogus value
    // (previously a SILENT fall-through to text — a JSON-expecting CI pipe
    // then failed two hops away), exit 1. This is the single declared
    // exception to FR-003's byte-identical rule, pinned by its own tests.
    // @impl 024-impact-base-ref/FR-010
    .addOption(
      new Option("--format <format>", "Output format").choices(["json", "text"]).default("text"),
    )
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

      // spec 024 (FR-002, D-3) — `--base` without `--diff` is a fail-closed
      // usage error (mirrors check FR-002: `--base` only re-bases the `--diff`
      // changed-file set, so without `--diff` there is nothing for it to act
      // on; silently continuing would let a CI YAML typo run a different
      // command that still exits green). Positioned AFTER the REQ-ID/`doc:`
      // rejections (input-kind navigation keeps priority) and BEFORE the
      // exclusivity check below: with `impact src/a.ts --base x` the user's
      // mistake is "forgot --diff", not "two start sources" — an exclusivity
      // error would steer them to delete the targets instead of adding
      // `--diff`. No JSON is emitted even under `--format json` — a usage
      // error is not a verdict.
      // @impl 024-impact-base-ref/FR-002
      if (opts.base && !opts.diff) {
        console.error(
          "error: --base requires --diff (--base sets the base point of the git diff; without --diff there is nothing to compare).",
        );
        console.error("run: artgraph impact --diff --base <ref> [--tests]");
        process.exit(1);
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
      const { readLockWithMeta, warnIfNewerLockSchema } = await import("../lock.js");
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

      // spec 024 (FR-004/FR-005, D-2/D-6) — validate the base ref and resolve
      // the merge-base exactly ONCE, BEFORE scan(): unlike check (which
      // resolves inside the post-scan `--diff` branch so failures can merge
      // into the display-only `baselineStatus:"unavailable"` mode), impact
      // has no non-gate mode to fall back to — a `--base` failure is an
      // unconditional exit 1, so there is no reason to pay the graph-build
      // cost first (same "validate environment preconditions early" placement
      // as the `--tests` shard guard above). Fail-closed on both stages:
      // stderr + exit 1, NO JSON even under `--format json` (an environment
      // failure is not a verdict — a `testsToRun: []` payload would invite an
      // exit-code-blind `jq` pipe to read "selection = empty" and run
      // nothing), and no fallback to a working-tree-only diff (in CI's clean
      // tree that would be an empty selection at exit 0 — fail-open). The
      // stdout-silent exit 1 is the consumer's fallback-to-full-suite signal
      // (FR-009). A named ref that fails to resolve is always classified
      // "error", never "unborn" (`isUnbornHead`'s non-HEAD early return) —
      // an unfetched `--base origin/main` can never masquerade as clean.
      // `baseSha`'s ONLY consumer is `getGitDiffFiles(rootDir, baseSha)`
      // below — impact deliberately has no rename map, no tracked-path probe
      // and no baseline worktree (D-1/D-8, see the comment at the `--diff`
      // branch).
      // @impl 024-impact-base-ref/FR-004
      // @impl 024-impact-base-ref/FR-005
      let baseSha: string | undefined;
      if (opts.base) {
        const { classifyBaseRef, resolveMergeBase, FETCH_DEPTH_HINT } =
          await import("../baseline.js");
        const baseRef = opts.base as string;
        if (classifyBaseRef(rootDir, baseRef) !== "resolved") {
          console.error(`error: base ref "${baseRef}" does not resolve\n${FETCH_DEPTH_HINT}`);
          process.exit(1);
        }
        const mergeBase = resolveMergeBase(rootDir, baseRef);
        if ("error" in mergeBase) {
          // The diagnostic already carries the fetch-depth hint (spec 023
          // SSOT, contract §5.2) — print it verbatim: no re-wording, no
          // prefix, no second hint.
          console.error(mergeBase.error);
          process.exit(1);
        }
        baseSha = mergeBase.sha;
      }

      // issue #265 — `warnings` used to be discarded here, so a
      // `pathological-bracket-nesting` / `class-member-collision` build
      // warning was invisible via `artgraph impact`. Threaded through to the
      // `--diff` "no changes" early-exit JSON payload below (mirrors
      // `check --diff`'s equivalent branch) and to the final output at the
      // bottom of this action.
      const { graph, warnings } = scan(rootDir, config);
      // issue #243 — read-only w.r.t. the lock: warn on a newer schema and
      // keep going (see commands/check.ts's identical comment).
      const { lock, schemaVersion } = readLockWithMeta(rootDir, config.lockFile);
      warnIfNewerLockSchema(schemaVersion, config.lockFile);

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

      // spec 024 (FR-012, D-9) — `--tests` × `--base` × staleness "exclude"
      // inverts the feature's purpose: in CI the shards are necessarily from
      // a PRE-change run (base-branch cache), so the changed code's evidence
      // is stale BY CONSTRUCTION and "exclude" drops exactly the tests most
      // related to the change. That is a legal configuration ("don't trust
      // old evidence" is an explicit choice), so warn — non-fatally, once,
      // on stderr only — instead of erroring or auto-disabling; exit code and
      // stdout (JSON included) are unchanged. Requires ALL THREE conditions:
      // a --base-less local `--tests` run usually has fresh shards, and
      // warning there would be permanent noise (SC-006).
      // @impl 024-impact-base-ref/FR-012
      if (opts.tests && opts.base && (config.trace?.staleness ?? "warn") === "exclude") {
        console.error(
          'WARNING: --tests with --base under trace.staleness "exclude": the changed code\'s ' +
            "evidence is stale by construction and its tests may be dropped from the selection. " +
            'Use staleness "warn" for CI test selection, or fall back to the full suite.',
        );
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
        // spec 024 (FR-006/FR-007/FR-011/FR-013) — the merged diff is the
        // SAME function check `--base` uses (`getGitDiffFiles(rootDir,
        // baseSha)`): three-way working-tree union (staged ∪ unstaged ∪
        // untracked — `--base` ADDS the commit range, it never shrinks the
        // local diff, US2) ∪ committed baseSha..HEAD range. Sharing the one
        // implementation IS agreement (i) (FR-013): impact and check can
        // never disagree on what changed. An empty merged diff falls through
        // to the existing "No changes detected" early exit below unchanged —
        // with `--base` that is a legitimately clean verdict (the commit
        // range WAS compared), same E4 payload, no new field.
        //
        // startId resolution stays CURRENT-GRAPH-ONLY (FR-007, D-1): a file
        // deleted by a commit in base..HEAD appears in the merged diff but
        // exists in neither the working tree nor the current graph, so it
        // resolves no startId and contributes nothing — silently, exactly
        // like any graph-untracked changed file (README, config, ...) always
        // has under `--diff`. This is a DECLARED selection limitation, not a
        // bug: `impact --tests` is an optimization layer (consumer rule,
        // FR-009 — fall back to the full suite on exit 1 or when unsure);
        // the correctness gate for committed deletions is `check --diff
        // --base --gate`'s baseline union (spec 023 SC-003), which is why
        // check-scope ⊇ impact-reach (agreement (ii)) is legitimately a
        // strict superset on deleted edges. For the same reason impact takes
        // NO rename map (FR-011, D-8): `-M` folds a base-range rename to its
        // NEW path, which is precisely the right input for a current-graph
        // query — `getGitRenameMap` exists only to translate old paths for a
        // BASELINE graph, and impact has no baseline to translate for. Do
        // not "fix" the missing rename map by adding one; it would be dead
        // code implying a baseline that doesn't exist.
        // @impl 024-impact-base-ref/FR-006
        // @impl 024-impact-base-ref/FR-007
        // @impl 024-impact-base-ref/FR-009
        // @impl 024-impact-base-ref/FR-011
        // @impl 024-impact-base-ref/FR-013
        const diffFiles = getGitDiffFiles(rootDir, baseSha);
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
                warnings,
                message: "No changes detected in git diff.",
              }),
            );
          } else {
            console.log("No changes detected in git diff.");
            // review F1 — the json branch above already folds `warnings` into
            // the payload; this text branch was the asymmetric gap (PR
            // discussion said "and to the final output" but only actually
            // wired the json side here).
            reportGraphWarnings(warnings, opts.format);
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
          // review F1 — this hard error exits before any JSON payload is ever
          // produced, so warnings would otherwise be silently lost regardless
          // of `--format`. Print unconditionally (no `format` arg) rather
          // than gating on `opts.format`.
          reportGraphWarnings(warnings);
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
          // spec 021 (T018, US3-2, issue #218): a `ClassName.memberName`
          // symbol is never itself preceded by `export` (only the class
          // declaration is), so the old `grep "export.*<symbol>"` hint
          // silently mismatched every class-member miss.
          //
          // PR #242 review E1 — a dot alone is NOT evidence of a class
          // member: string-literal export names (`export { x as "a.b" }`)
          // are dotted too, and a trailing-dot typo (`Sample.`) has an
          // empty member name (the pre-fix hint then emitted a useless
          // `grep -n ""`). Only use the class-member wording when the
          // dot-prefix actually resolves to a symbol in THIS graph (the
          // class exists, so the member name is what missed) AND the member
          // name is non-empty; everything else falls back to the generic
          // export-name hint.
          const dotIdx = u.symbol?.lastIndexOf(".") ?? -1;
          const prefix = dotIdx > 0 ? u.symbol!.slice(0, dotIdx) : undefined;
          const memberName = dotIdx >= 0 ? u.symbol!.slice(dotIdx + 1) : "";
          if (
            prefix !== undefined &&
            memberName.length > 0 &&
            graph.nodes.has(`symbol:${u.path}#${prefix}`)
          ) {
            console.error(
              `  hint: "${prefix}" has no member "${memberName}" — check the spelling, ` +
                `or try \`grep -n "${memberName}" ${u.path}\``,
            );
          } else {
            console.error(
              `  hint: check the export name with \`grep "export.*${u.symbol}" ${u.path}\``,
            );
          }
          console.error(
            `        or verify that \`mode: "symbol"\` is set in \`.artgraph.json\` and re-scan.`,
          );
        }
        // review F1 — same rationale as the scan-mode-mismatch exit above:
        // no JSON payload is produced on this path, so print unconditionally.
        reportGraphWarnings(warnings);
        process.exit(1);
      }

      if (startIds.length === 0) {
        // spec 024 (FR-008, D-4) — a merged diff whose every path is
        // unresolved (deletion-only / graph-external-only base range) lands
        // HERE, on the exact same exit-1 path and wording as a --base-less
        // run: `--base` widens the input set but adds no new early exit, no
        // new message, no new exit code. CI consumers therefore need only
        // the two-valued rule "exit 0 → use the selection, exit 1 → full
        // suite" (FR-009), never a per-message dispatch.
        // @impl 024-impact-base-ref/FR-008
        console.error(`No matching nodes found for: ${inputDisplayLabels.join(", ")}`);
        // review F1 — ditto: hard error, no JSON payload produced.
        reportGraphWarnings(warnings);
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
        console.log(JSON.stringify({ ...result, warnings }));
      } else {
        printImpactText(result);
        reportGraphWarnings(warnings, opts.format);
      }
    });
}
