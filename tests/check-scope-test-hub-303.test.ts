// issue #303 (MEDIUM-1) — `check --diff --gate`'s `buildScope` (union of the
// CURRENT graph's `impact()` scope and the BASELINE graph's `impact()` scope,
// see src/commands/check.ts) must not silently DROP an evidence-only REQ
// (no `implements` edge anywhere) from scope now that traverse.ts restricts
// forward `verifies`/`imports` out of a test-hub node. Rule (a) of the
// #303 fix deliberately LEAVES forward `verifies` open for evidence-only REQ
// targets specifically so this doesn't regress — this test proves it end to
// end through the CLI, the same way tests/check-baseline-diff.test.ts pins
// the #229 union-scope fix.
//
// #361 update — reaching an evidence-only REQ through a restricted hub's
// forward `verifies` now ALSO requires the matching predicate
// (`classifyEdgeTraversal`'s R3a in traverse.ts): REQ-902 must carry its OWN
// `exercises` edge back to the BFS origin (`symbol:src/sample.ts#fnB`), not
// just happen to be `verifies`-tagged by a hub fnB is also imported by. Pre-
// #361 this fixture reached REQ-902 on bare hub-membership alone (a
// `verifies` TAG plus a bare `import` declaration, no execution evidence at
// all) — exactly the imprecise heuristic #361 tightens (the SAME mechanism
// that let HIGH-2/#322's daisy-chain and AXIS2 leaks through elsewhere). A
// hand-written trace shard (mirrors `tests/impact-evidence.test.ts`'s
// CLI-fixture convention) now supplies genuine `exercises` evidence — REQ-902
// really is exercised by fnB's own test — so the test's original guarantee
// (an evidence-only REQ isn't silently dropped from gate scope) is preserved
// under the new, stricter model instead of relying on tag-co-location alone.
//
// Fixture: `fnB` NEVER has an `@impl` tag, in EITHER the baseline commit or
// the working tree — REQ-902 is evidence-only (`acceptExercises`-style, only
// a test `verifies` edge plus real coverage evidence) at both ends of the
// diff. The diff touches ONLY fnB's body (a harmless comment, no tag change)
// so `currentStartIds` AND `baselineStartIds` both resolve to
// `symbol:src/sample.ts#fnB` alone — the test file and spec.md are
// untouched, so neither is itself a startId on EITHER side. This
// deliberately denies both `buildScope` calls any direct edge to REQ-902:
// the ONLY way either side's BFS can reach it is fnB -(reverse imports)->
// test hub -(forward verifies, evidence-only + matching-predicate allowed)->
// REQ-902 — i.e. this pins the #303/#361 hub mechanism itself, not just the
// pre-existing #229 union (a fixture where baseline reaches the REQ via some
// OTHER, un-hubbed edge would mask a regression in the hub path via the
// union alone). The trace shard is written to the WORKING TREE only (after
// the `git commit`, uncommitted) — the CURRENT graph's BFS is what needs to
// reach REQ-902 for it to survive the current∪baseline union; the baseline
// graph has no trace at all (no shard existed at commit time) and does not
// need one for this guarantee to hold.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { runAt, gitInit, gitCommitAll } from "./helpers.js";
import { SCHEMA_VERSION } from "../src/trace/schema.js";

const created: string[] = [];
function track(dir: string): string {
  created.push(dir);
  return dir;
}
afterEach(() => {
  while (created.length) {
    rmSync(created.pop()!, { recursive: true, force: true });
  }
});

function hashOf(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function writeShard(tmp: string, name: string, lines: string[]): void {
  const dir = join(tmp, ".artgraph/trace");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), lines.join("\n"), "utf-8");
}

function makeRepo(): string {
  const tmp = track(mkdtempSync(join(tmpdir(), "artgraph-303-scope-")));
  const files: Record<string, string> = {
    "src/sample.ts": [
      "export function fnA() {",
      "  // @impl REQ-901",
      "  return 1;",
      "}",
      "",
      // fnB deliberately carries NO @impl tag, ever — REQ-902 is
      // evidence-only in both the baseline commit and the working tree.
      "export function fnB() {",
      "  return 2;",
      "}",
      "",
    ].join("\n"),
    "tests/sample.test.ts": [
      'import { fnA, fnB } from "../src/sample";',
      "",
      'it("[REQ-901] fnA works, side-checks fnB", () => {',
      "  fnA();",
      "  fnB();",
      "});",
      "",
      'it("[REQ-902] fnB works", () => {',
      "  fnB();",
      "});",
      "",
    ].join("\n"),
    "specs/spec.md": [
      "# Fixture",
      "",
      "- REQ-901: fnA does a thing.",
      "- REQ-902: fnB does a thing.",
      "",
    ].join("\n"),
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(tmp, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf-8");
  }
  writeFileSync(
    join(tmp, ".artgraph.json"),
    JSON.stringify({
      include: ["src/**/*.ts"],
      specDirs: ["specs"],
      testPatterns: ["tests/**/*.ts"],
      mode: "symbol",
    }),
    "utf-8",
  );
  return tmp;
}

describe("check --diff --gate scope (issue #303 MEDIUM-1): evidence-only REQ is not dropped from buildScope's union by the new test-hub restriction", () => {
  it("touching only fnB's body (no tag change) still surfaces pre-existing evidence-only REQ-902 in the scoped `uncovered` list", async () => {
    const dir = makeRepo();
    gitInit(dir);
    gitCommitAll(dir, "init");

    // Working-tree edit: a harmless comment inside fnB — no `@impl` tag is
    // touched anywhere, so REQ-902's edge set (a `verifies` edge plus real
    // exercises evidence, below) is identical in shape in the baseline and
    // current graphs. The only startId on either side is
    // symbol:src/sample.ts#fnB.
    const samplePath = join(dir, "src", "sample.ts");
    const before = readFileSync(samplePath, "utf-8");
    const after = before.replace("  return 2;\n", "  // touched\n  return 2;\n");
    expect(after).not.toEqual(before);
    writeFileSync(samplePath, after);

    // #361 matching predicate — REQ-902 needs its OWN `exercises` evidence
    // reaching the BFS origin (fnB) to be collected through the restricted
    // hub's forward `verifies` (see the file-header comment). Written to the
    // WORKING TREE only, after the commit above, so only the CURRENT graph's
    // BFS sees it — sufficient for the current∪baseline union this test
    // pins.
    writeShard(dir, "w1.jsonl", [
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        kind: "meta",
        runToken: "run-1",
        pool: "forks",
        vitest: "4.1.10",
        startedAt: "2026-07-19T00:00:00Z",
      }),
      JSON.stringify({
        kind: "test",
        testName: "[REQ-902] fnB works",
        suitePath: [],
        testFile: "tests/sample.test.ts",
        passed: true,
        hits: [{ file: "src/sample.ts", fn: "fnB" }],
        hashes: { "src/sample.ts": hashOf(after) },
      }),
    ]);

    const { stdout, exitCode } = await runAt(dir, [
      "check",
      "--diff",
      "--gate",
      "--format",
      "json",
    ]);
    const json = JSON.parse(stdout);

    // REQ-902 has no `implements` edge anywhere in either graph — the ONLY
    // path the current graph's `buildScope` call has to it is through the
    // test hub (reverse imports -> hub -> forward verifies, evidence-only +
    // matching-predicate allowed, #303/#361). It must still show up in the
    // scoped `uncovered` list.
    expect(json.uncovered).toContain("REQ-902");
    // Pre-existing on both sides of the diff, so it is NOT a "new" issue —
    // confirming scope retention alone, without conflating it with the
    // baseline-diff newness axis #229/#237 already cover.
    expect(json.newIssues.uncovered).not.toContain("REQ-902");
    expect(exitCode).toBe(0);
    expect(json.pass).toBe(true);

    // Negative control: REQ-901 (declared, covered) must not spuriously
    // appear as uncovered.
    expect(json.uncovered).not.toContain("REQ-901");
  });
});
