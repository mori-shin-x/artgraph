import { describe, it, expect, afterEach } from "vitest";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { buildGraph } from "../src/graph/builder.js";
import { buildLockFromGraph } from "../src/lock.js";
import { check } from "../src/check.js";
import type {
  ArtgraphConfig,
  LockFile,
  TestResultMap,
  ArtifactGraph,
} from "../src/types.js";

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
    const passing: TestResultMap = new Map([
      [reqId, [{ reqId, testName: "t", passed: true }]],
    ]);
    const passed = check(graph, lock, undefined, passing);
    expect(passed.pass).toBe(true);
    expect(passed.testFailures).toEqual([]);

    // Failing results: gate fails and the REQ is listed under testFailures.
    const failing: TestResultMap = new Map([
      [reqId, [{ reqId, testName: "t", passed: false }]],
    ]);
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
        : [
            "# Spec",
            "",
            "- REQ-201: dependency target",
            "- REQ-200: feature",
            "",
          ].join("\n");
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
