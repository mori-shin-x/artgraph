// issue #323 — `isTest` (node kind "test"/"file", and whether `[REQ-x]`
// test-title tags are extracted at all) is now DERIVED from `testPatterns`
// instead of a hardcoded `/\.(test|spec)\.(ts|tsx)$/` regex. Pre-fix, a file
// matched by a custom `testPatterns` entry that did not ALSO look like
// `*.test.ts`/`*.spec.ts` (e.g. `__tests__/foo.ts`) was discovered (globbed
// via `codePatterns = [...include, ...testPatterns]`) but its `verifies`
// edges silently never materialized — `parseTSFile`'s `isTest` stayed false
// regardless of `testPatterns`.
//
// These tests pin the issue's own acceptance criteria:
//   (a) a custom `testPatterns` glob that does NOT look like `*.test.ts`
//       still produces a `verifies` edge from `[REQ-x]` in its content.
//   (b) the same file gets node kind `"test"`, and the #303 test-hub BFS
//       restriction (traverse.ts) — keyed off `kind === "test"` — actually
//       applies to it (mirroring tests/impact-test-hub-303.test.ts's style,
//       but built from a REAL parsed graph instead of a hand-built one, so
//       this test also exercises the derivation itself).
//   (c) `DEFAULT_CONFIG.testPatterns`'s `foo.spec.tsx` addition (the
//       default-symmetry fix) actually takes effect: an UNCONFIGURED project
//       classifies a `*.spec.tsx` file as a test node.
import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/builder.js";
import { impact } from "../src/graph/traverse.js";
import type { ArtgraphConfig, LockFile } from "../src/types.js";
import { DEFAULT_CONFIG } from "../src/types.js";

describe("issue #323 — testPatterns-derived isTest (AC a/b): __tests__/foo.ts (non *.test.ts name)", () => {
  let tmp: string;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  function setup(): { tmp: string; config: ArtgraphConfig } {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-323-hub-"));
    mkdirSync(join(tmp, "specs", "feat"), { recursive: true });
    mkdirSync(join(tmp, "src"), { recursive: true });
    mkdirSync(join(tmp, "__tests__"), { recursive: true });
    writeFileSync(
      join(tmp, "specs", "feat", "spec.md"),
      "# Feat\n\n- REQ-901: first requirement\n- REQ-902: second requirement\n",
    );
    writeFileSync(
      join(tmp, "src", "sample.ts"),
      "// @impl REQ-901\nexport function fnA() {}\n\n// @impl REQ-902\nexport function fnB() {}\n",
    );
    // Deliberately NOT named `*.test.ts`/`*.spec.ts` — only a custom
    // `testPatterns` glob (`__tests__/**/*.ts`) matches it. The old hardcoded
    // regex would have missed this entirely.
    writeFileSync(
      join(tmp, "__tests__", "foo.ts"),
      'import { fnA, fnB } from "../src/sample.js";\n\n' +
        'describe("[REQ-901] fnA", () => {\n' +
        '  it("uses fnA and fnB", () => {\n' +
        "    fnA();\n" +
        "    fnB();\n" +
        "  });\n" +
        "});\n",
    );
    const config: ArtgraphConfig = {
      include: ["src/**/*.ts"],
      specDirs: ["specs"],
      testPatterns: ["__tests__/**/*.ts"],
      lockFile: ".trace.lock",
      mode: "symbol",
    };
    return { tmp, config };
  }

  it("(a) produces a verifies edge from [REQ-901] in the custom-testPatterns file", () => {
    const { tmp: root, config } = setup();
    const { graph } = buildGraph(root, config);
    const verifyEdge = graph.edges.find(
      (e) =>
        e.kind === "verifies" && e.source === "file:__tests__/foo.ts" && e.target === "REQ-901",
    );
    expect(verifyEdge).toBeDefined();
  });

  it('(b) node kind is "test" and the #303 test-hub restriction excludes the sibling REQ', () => {
    const { tmp: root, config } = setup();
    const { graph } = buildGraph(root, config);

    const testNode = graph.nodes.get("file:__tests__/foo.ts");
    expect(testNode?.kind).toBe("test");

    // fnB implements REQ-902 directly; the test hub also (a) imports fnB and
    // (b) verifies REQ-901 — the #303 pass-through-hub shape. Without the
    // test-kind-gated restriction, REQ-901 would leak into fnB's blast
    // radius via rev-imports -> test hub -> fwd-verifies.
    const result = impact(graph, ["symbol:src/sample.ts#fnB"], {} as LockFile);
    expect(result.impactReqs).toContain("REQ-902");
    expect(result.impactReqs).not.toContain("REQ-901");
  });
});

describe("issue #323 — testPatterns-derived isTest (AC c): DEFAULT_CONFIG.testPatterns spec.tsx symmetry", () => {
  let tmp: string;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("an UNCONFIGURED (default testPatterns) project classifies *.spec.tsx as a test node", () => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-323-spec-tsx-"));
    mkdirSync(join(tmp, "specs"), { recursive: true });
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(
      join(tmp, "src", "widget.spec.tsx"),
      'describe("[REQ-001] widget", () => {\n  it("works", () => {});\n});\n',
    );
    const config: ArtgraphConfig = {
      ...DEFAULT_CONFIG,
      specDirs: ["specs"],
      lockFile: ".trace.lock",
    };
    const { graph } = buildGraph(tmp, config);
    const node = graph.nodes.get("file:src/widget.spec.tsx");
    expect(node?.kind).toBe("test");
  });
});

// PR #349 (H1 mitigation) added a `"testpatterns-negative-pattern"` warning
// here for the merged-pool surprise this file used to document (a
// `!`-prefixed `testPatterns` entry silently dropping files from the whole
// scan). Issue #350 replaced the merged pool with real pool separation
// (`discoverCodeFiles` in `src/parsers/typescript.ts`) — a negative
// `testPatterns` pattern now narrows test *classification* only, never the
// whole graph, so the warning's premise no longer exists and it (along with
// its three pinning tests) was removed. See `tests/issue-350-pool-separation
// .test.ts` for the pool-separation regression coverage that replaces it,
// including the exact silent-`check --gate`-escape scenario this warning
// used to be a stopgap for.
