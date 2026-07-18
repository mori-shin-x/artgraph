import { describe, it, expect, afterEach } from "vitest";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { buildGraph } from "../src/graph/builder.js";
import { buildLockFromGraph } from "../src/lock.js";
import { check } from "../src/check.js";
import { uncoveredKey } from "../src/baseline.js";
import { printCheckText } from "../src/commands/presenters/check.js";
import type { ArtgraphConfig, LockFile, TestResultMap, ArtifactGraph } from "../src/types.js";

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures");

const config: ArtgraphConfig = {
  include: ["src/**/*.ts"],
  specDirs: ["specs"],
  testPatterns: ["tests/**/*.ts"],
  lockFile: ".trace.lock",
};

describe("check", () => {
  it("should pass when lock matches current state and all REQs are covered", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);

    // Cover all req nodes with fake @impl edges
    for (const [id, node] of graph.nodes) {
      if (node.kind !== "req") continue;
      const hasImpl = graph.edges.some((e) => e.kind === "implements" && e.target === id);
      if (!hasImpl) {
        graph.edges.push({
          source: "file:fake-impl.ts",
          target: id,
          kind: "implements",
          provenances: ["code-tag"],
        });
      }
    }

    // Lock all req and doc nodes
    const lock: LockFile = {};
    for (const [id, node] of graph.nodes) {
      if (node.kind === "req" || node.kind === "doc") {
        lock[id] = {
          contentHash: node.contentHash,
          lastReconciled: "2025-01-01T00:00:00Z",
        };
      }
    }

    const result = check(graph, lock);
    expect(result.pass).toBe(true);
    expect(result.drifted).toHaveLength(0);
    expect(result.orphans).toHaveLength(0);
  });

  it("should detect drift when spec content changed", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);

    const lock: LockFile = {
      "AUTH-001": {
        contentHash: "old_hash_value_x",
        lastReconciled: "2025-01-01T00:00:00Z",
      },
    };

    const result = check(graph, lock);
    expect(result.pass).toBe(false);
    expect(result.drifted.length).toBeGreaterThanOrEqual(1);
    expect(result.drifted[0].nodeId).toBe("AUTH-001");
  });

  it("should detect orphan @impl tags", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);
    graph.edges.push({
      source: "file:src/auth/login.ts",
      target: "FAKE-9999",
      kind: "implements",
      provenances: ["code-tag"],
    });

    const result = check(graph, {});
    expect(result.orphans.length).toBeGreaterThanOrEqual(1);
    expect(result.orphans.some((o) => o.includes("FAKE-9999"))).toBe(true);
  });

  it("should report uncovered REQs", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);
    const result = check(graph, {});

    expect(result.uncovered).toContain("AUTH-003");
  });

  it("should fail when there are any issues", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);
    const result = check(graph, {});

    expect(result.pass).toBe(false);
  });

  // A minimal, fully-covered graph: one REQ with both an implements and a
  // verifies edge, locked so drift/orphans/uncovered are all clean. This
  // isolates the gate's reaction to test pass/fail.
  function coveredGraph(reqId = "REQ-100"): { graph: ArtifactGraph; lock: LockFile } {
    const graph: ArtifactGraph = {
      nodes: new Map([
        [reqId, { id: reqId, kind: "req", filePath: "specs/x.md", contentHash: "h1" }],
      ]),
      edges: [
        { source: "file:impl.ts", target: reqId, kind: "implements", provenances: ["code-tag"] },
        { source: "file:impl.test.ts", target: reqId, kind: "verifies", provenances: ["code-tag"] },
      ],
    };
    const lock: LockFile = {
      [reqId]: { contentHash: "h1", lastReconciled: "2025-01-01T00:00:00Z" },
    };
    return { graph, lock };
  }

  it("should fail the gate when a covered REQ's test fails", () => {
    const reqId = "REQ-100";

    // Passing results: gate clean.
    const { graph, lock } = coveredGraph(reqId);
    const passing: TestResultMap = new Map([[reqId, [{ reqId, testName: "t", passed: true }]]]);
    const passed = check(graph, lock, undefined, passing);
    expect(passed.pass).toBe(true);
    expect(passed.testFailures).toEqual([]);

    // Failing results: gate fails and the REQ is listed under testFailures.
    const failing: TestResultMap = new Map([[reqId, [{ reqId, testName: "t", passed: false }]]]);
    const failed = check(graph, lock, undefined, failing);
    expect(failed.pass).toBe(false);
    expect(failed.testFailures).toContain(reqId);
  });

  it("should leave testFailures empty (and pass) when no test results are supplied", () => {
    const { graph, lock } = coveredGraph();
    const result = check(graph, lock);
    expect(result.testFailures).toEqual([]);
    expect(result.pass).toBe(true);
  });

  // spec 017 (T029) — legacy `check(graph, lock, ...)` calls with no `baseline`
  // stay back-compatible: with an empty key set every scoped issue is "new",
  // so `pass` still means "all scoped issues clear". spec 017 (Critical fix
  // B6/D2, issue #182 review) — a call with no `diffRequested` flag is a
  // plain (non-`--diff`) check, so `baselineStatus` is now reported as
  // "not_applicable" (the baseline-diff concept itself doesn't apply — this
  // used to be conflated with "skipped", which is reserved for a `--diff`
  // lazy-eval run whose scope was already clean).
  it("omitting the baseline argument treats every scoped issue as new (back-compat)", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);
    const result = check(graph, {});
    expect(result.baselineStatus).toBe("not_applicable");
    // uncovered AUTH-003 is scoped and, without a baseline, also new.
    expect(result.uncovered).toContain("AUTH-003");
    expect(result.newIssues.uncovered).toEqual(result.uncovered);
    expect(result.pass).toBe(false);
  });

  // spec 017 (Critical fix B6/D2, issue #182 review) — the SAME "no baseline
  // supplied" input resolves to two different `baselineStatus` values
  // depending on the new `diffRequested` argument: a plain check (omitted /
  // false) → "not_applicable"; a `--diff` run whose lazy-eval (R6) has not
  // built a baseline yet (true) → "skipped". This is exactly the distinction
  // the old unconditional `status ?? "skipped"` fallback collapsed.
  it("diffRequested distinguishes not_applicable (plain check) from skipped (--diff lazy-eval)", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);
    const plain = check(graph, {});
    expect(plain.baselineStatus).toBe("not_applicable");

    const diffLazy = check(graph, {}, undefined, undefined, undefined, true);
    expect(diffLazy.baselineStatus).toBe("skipped");

    // diffRequested only changes the reported label — the new-issue
    // determination and pass verdict are computed identically either way.
    expect(diffLazy.newIssues).toEqual(plain.newIssues);
    expect(diffLazy.pass).toBe(plain.pass);
  });

  // spec 017 (T029) — a supplied baseline subtracts pre-existing issues, so a
  // scoped issue whose identity key is in the baseline is NOT counted as new.
  it("a baseline key set suppresses matching scoped issues from newIssues", () => {
    const { graph } = buildGraph(FIXTURE_DIR, config);
    // AUTH-003 is uncovered in the fixture. Put its key in the baseline → it
    // becomes pre-existing (suppressed), so the gate passes on it.
    const baseline = {
      keys: new Set([uncoveredKey("AUTH-003")]),
      status: "computed" as const,
    };
    const result = check(graph, {}, undefined, undefined, baseline);
    expect(result.uncovered).toContain("AUTH-003"); // still in scoped output
    expect(result.newIssues.uncovered).not.toContain("AUTH-003"); // but not new
    expect(result.suppressedCount).toBeGreaterThanOrEqual(1);
    expect(result.baselineStatus).toBe("computed");
  });

  // SC-006: annotation churn (added/removed `(depends_on: …)` notes) must not
  // affect drift judgement because drift is computed from `contentHash` only.
  // See specs/011-edge-provenance/contracts/lock-schema-v2.md §CLI.
  //
  // Reviewer D1 remediation (PR#94): the original SC-006 test fixed
  // `contentHash: "h-stable"` by hand, which proves nothing about the actual
  // strip-annotations code path. The end-to-end version below writes two
  // versions of the same `.md` file to a tmp dir (annotation absent / present),
  // verifies that `buildGraph` produces the SAME `contentHash` for the req,
  // then builds a lock from the no-annotation graph and checks the
  // with-annotation graph against it — drift must be empty.
  describe("SC-006 end-to-end (D1 / E3): annotation churn does not flip drift", () => {
    const TMP = resolve(import.meta.dirname, "fixtures/_sc006-tmp");
    afterEach(() => rmSync(TMP, { recursive: true, force: true }));

    const sc006Config: ArtgraphConfig = {
      include: [],
      specDirs: ["specs"],
      testPatterns: [],
      lockFile: ".trace.lock",
    };

    function writeSpec(annotated: boolean) {
      rmSync(TMP, { recursive: true, force: true });
      mkdirSync(resolve(TMP, "specs"), { recursive: true });
      const body = annotated
        ? [
            "# Spec",
            "",
            "- REQ-201: dependency target",
            "- REQ-200: feature (depends_on: REQ-201)",
            "",
          ].join("\n")
        : ["# Spec", "", "- REQ-201: dependency target", "- REQ-200: feature", ""].join("\n");
      writeFileSync(resolve(TMP, "specs/x.md"), body, "utf-8");
    }

    it("D1: stripAnnotations holds — REQ-200 contentHash is identical with vs without `(depends_on: …)`", () => {
      writeSpec(false);
      const { graph: gNo } = buildGraph(TMP, sc006Config);
      writeSpec(true);
      const { graph: gYes } = buildGraph(TMP, sc006Config);
      // The annotation MUST be observable (it landed as an edge)…
      const annEdges = gYes.edges.filter((e) => e.provenances.includes("annotation"));
      expect(annEdges).toHaveLength(1);
      expect(annEdges[0].source).toBe("REQ-200");
      expect(annEdges[0].target).toBe("REQ-201");
      // …yet the contentHash MUST be byte-identical: this is the
      // contract that lets drift survive annotation churn.
      const hNo = gNo.nodes.get("REQ-200")!.contentHash;
      const hYes = gYes.nodes.get("REQ-200")!.contentHash;
      expect(hYes).toBe(hNo);
    });

    it("SC-006 forward: annotation ADDED to graph, but lock built from no-annotation version → no REQ-level drift", () => {
      // Step 1: spec without annotation → lock baseline
      writeSpec(false);
      const { graph: noAnn } = buildGraph(TMP, sc006Config);
      const lock = buildLockFromGraph(noAnn);

      // Step 2: spec WITH annotation → new graph
      writeSpec(true);
      const { graph: withAnn } = buildGraph(TMP, sc006Config);

      // Step 3: gate must accept the REQ-level drift channel — the annotation
      // does not change req hashes. The doc node `doc:x.md` does hash the
      // entire file body (which includes the annotation), so it WILL drift
      // here. That is a doc-level concern, not the req-level SC-006 claim, so
      // we filter by kind: only req entries are the subject of SC-006.
      const result = check(withAnn, lock);
      const reqDrift = result.drifted.filter((d) => d.kind === "req");
      expect(reqDrift).toEqual([]);
    });

    // E3: SC-006 reverse — annotation REMOVED from graph but the OLD lock
    // still carries `dependsOn` from the previous scan. The lock's stale
    // dependsOn must NOT trip drift on the req channel; only contentHash
    // matters and the req hash is annotation-invariant.
    it("SC-006 reverse: annotation REMOVED from graph but lock still carries dependsOn → no REQ-level drift", () => {
      // Step 1: spec WITH annotation → lock baseline carries dependsOn
      writeSpec(true);
      const { graph: withAnn } = buildGraph(TMP, sc006Config);
      const lockWithDep = buildLockFromGraph(withAnn);
      expect(lockWithDep["REQ-200"]?.dependsOn).toEqual([
        { id: "REQ-201", provenances: ["annotation"] },
      ]);

      // Step 2: spec without annotation → no annotation edge in graph
      writeSpec(false);
      const { graph: noAnn } = buildGraph(TMP, sc006Config);
      const annEdges = noAnn.edges.filter((e) => e.provenances.includes("annotation"));
      expect(annEdges).toEqual([]);

      // Step 3: check the new (no-annotation) graph against the OLD lock that
      // still contains dependsOn. drift on the req channel must be empty —
      // the stale `dependsOn` is structural metadata, not a hash input.
      const result = check(noAnn, lockWithDep);
      const reqDrift = result.drifted.filter((d) => d.kind === "req");
      expect(reqDrift).toEqual([]);
    });
  });
});

// issue #244 — a lock entry whose id has no matching node in the CURRENT
// graph (rename/refactor left the old id behind) was previously silently
// `continue`d past by the drift loop: invisible from drift AND orphans,
// resolved only by an unrelated `reconcile` run. `staleLockEntries` surfaces
// these ids directly.
describe("check: staleLockEntries (issue #244)", () => {
  // One real node ("REQ-100", locked, in sync) plus two lock-only ids with
  // no corresponding graph node — simulating a rename that changed
  // "OLD-symbol-a" -> "REQ-100" and left "OLD-symbol-a" / "OLD-symbol-b"
  // behind in the lock.
  function graphWithStaleLock(): { graph: ArtifactGraph; lock: LockFile } {
    const graph: ArtifactGraph = {
      nodes: new Map([
        ["REQ-100", { id: "REQ-100", kind: "req", filePath: "specs/x.md", contentHash: "h1" }],
      ]),
      edges: [],
    };
    const lock: LockFile = {
      "REQ-100": { contentHash: "h1", lastReconciled: "2025-01-01T00:00:00Z" },
      "OLD-symbol-b": { contentHash: "hb", lastReconciled: "2025-01-01T00:00:00Z" },
      "OLD-symbol-a": { contentHash: "ha", lastReconciled: "2025-01-01T00:00:00Z" },
    };
    return { graph, lock };
  }

  it("lists lock ids absent from the graph, ascending-sorted", () => {
    const { graph, lock } = graphWithStaleLock();
    const result = check(graph, lock);
    expect(result.staleLockEntries).toEqual(["OLD-symbol-a", "OLD-symbol-b"]);
  });

  it("omits the key entirely (not []) when every lock id resolves to a graph node", () => {
    const { graph, lock } = graphWithStaleLock();
    delete lock["OLD-symbol-a"];
    delete lock["OLD-symbol-b"];
    const result = check(graph, lock);
    expect(Object.prototype.hasOwnProperty.call(result, "staleLockEntries")).toBe(false);
  });

  it("is scope-independent: staleLockEntries ignores `scope` entirely and always surfaces every stale id", () => {
    const { graph, lock } = graphWithStaleLock();
    // `scope` here is built from CURRENT-graph-reachable ids only, exactly
    // as `buildScope` on the current graph would produce. Note that the
    // real CLI caller (`src/commands/check.ts`) unions this with a BASELINE-
    // graph BFS, so in practice `scope` CAN contain a renamed-away old id —
    // staleLockEntries deliberately never consults `scope` at all (see the
    // comment on `staleLockEntriesSet` above), so this test's narrower scope
    // still exercises the intended behavior: the full lock is scanned
    // regardless of what `scope` does or doesn't contain.
    const scope = new Set(["REQ-100"]);
    const result = check(graph, lock, scope);
    expect(result.staleLockEntries).toEqual(["OLD-symbol-a", "OLD-symbol-b"]);
    // Scope still applies normally to drift: REQ-100 is in sync so no drift.
    expect(result.drifted).toEqual([]);
  });

  // --format text: STALE LOCK ENTRIES: heading (H3 review fix) — mirrors
  // check-evidence.test.ts's "--format text: ... STALE EVIDENCE: headings"
  // pattern, but at the printCheckText unit level since this file already
  // exercises `check()` directly rather than through the CLI.
  it("--format text: STALE LOCK ENTRIES: heading lists the stale ids", () => {
    const { graph, lock } = graphWithStaleLock();
    const result = check(graph, lock);
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.join(" "));
    };
    try {
      printCheckText(result);
    } finally {
      console.log = origLog;
    }
    const output = lines.join("\n");
    expect(output).toContain(
      "STALE LOCK ENTRIES (in .trace.lock but no longer in the graph — run `artgraph reconcile`):",
    );
    expect(output).toContain("OLD-symbol-a");
    expect(output).toContain("OLD-symbol-b");
  });
});
