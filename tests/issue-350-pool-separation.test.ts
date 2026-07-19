// issue #350 — `include` and `testPatterns` used to be globbed together as
// ONE merged pool (`codePatterns = [...include, ...testPatterns]`), which
// folded BOTH lists' negative patterns into a single shared `ignore` applied
// to every positive pattern combined. That silently let a `!`-prefixed
// `testPatterns` entry exclude a file from the WHOLE graph — as if it had
// been written under `include` — instead of merely narrowing which files are
// classified as tests. PR #349 added a visible (but non-fixing)
// `"testpatterns-negative-pattern"` warning as a stopgap; this issue is the
// real fix: `include` and `testPatterns` are now two INDEPENDENT glob pools
// (`discoverCodeFiles`, `src/parsers/typescript.ts`), unioned after each is
// globbed on its own. See that function's doc comment for the full
// rationale, and `docs/configuration.md`'s `include` / `testPatterns`
// section for the user-facing behavior.
//
// This file pins the Step 0-pre investigation's confirmed findings:
//   (a) the gate silent-escape regression (verbatim repro from the
//       investigation) — a `testPatterns`-only negative pattern must no
//       longer hide an orphan `@impl` claim from `check --gate`.
//   (b) Check 15 (monotonicity) — pool-separated discovery is always a
//       superset of the old merged-pool discovery, with exact equality when
//       neither list carries a negative pattern (byte-identical baseline).
//   (c) HIGH-1 — `scan` and `rename` agree on file scope, via the shared
//       `discoverCodeFiles` helper.
//   (d) HIGH-2 — `DEFAULT_CONFIG` protects both pools from node_modules
//       ingestion, and a custom config missing one pool's negation gets a
//       remediation message naming the RIGHT config key(s).
//   (e) LOW-2 — a test node that only pool separation newly discovers still
//       participates correctly in the #303 test-hub BFS restriction
//       (traverse.ts).
//   (f) cache warm/cold parity — widening discovery via pool separation on a
//       warm-cached project matches a fully cold rebuild of the same config.
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { join, relative, resolve } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/builder.js";
import { impact } from "../src/graph/traverse.js";
import { globCodeFiles } from "../src/parsers/typescript.js";
import { executeRename } from "../src/rename-executor.js";
import { runAt } from "./helpers.js";
import type { ArtgraphConfig, LockFile } from "../src/types.js";
import { DEFAULT_CONFIG } from "../src/types.js";

function write(root: string, relPath: string, content: string): void {
  const abs = join(root, relPath);
  mkdirSync(resolve(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

// ---------------------------------------------------------------------------
// (a) gate silent-escape regression — verbatim Step 0-pre repro
// ---------------------------------------------------------------------------

describe("issue #350 (a) — check --gate no longer silently escapes a testPatterns-only-hidden orphan", () => {
  let tmp: string;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("src/legacy/normal.ts's @impl to a nonexistent REQ is caught by check --gate (pre-#350 this was pass:true, orphans:[], exit 0)", async () => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-350-gate-escape-"));
    write(tmp, "specs/spec.md", "# Spec\n\n- REQ-001: an unrelated requirement\n");
    // No REQ-999 exists anywhere — this @impl is a straightforward orphan.
    write(tmp, "src/legacy/normal.ts", "// @impl REQ-999\nexport function normal() {}\n");
    write(
      tmp,
      ".artgraph.json",
      JSON.stringify({
        include: ["src/**/*.ts"],
        specDirs: ["specs"],
        // The negative pattern lives ONLY in testPatterns — pre-#350 the
        // merged pool would have excluded src/legacy/normal.ts from the
        // WHOLE scan via this entry, even though `include` itself never
        // excludes it.
        testPatterns: ["src/**/*.test.ts", "!src/legacy/**"],
      }),
    );

    const { stdout, exitCode } = await runAt(tmp, ["check", "--gate", "--format", "json"]);
    const result = JSON.parse(stdout) as {
      pass: boolean;
      orphans: string[];
      exitCode?: number;
    };

    // Post-#350: src/legacy/normal.ts survives via the `include` pool
    // (kind:"file"), so its orphan @impl claim is detected.
    expect(result.orphans.some((o) => o.includes("REQ-999"))).toBe(true);
    expect(result.pass).toBe(false);
    expect(exitCode).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// (b) Check 15 — monotonicity: pool-separated discovery >= merged discovery,
//     with equality when neither list has a negative pattern.
// ---------------------------------------------------------------------------

describe("issue #350 (b) — pool-separated discovery is monotonically >= the old merged-pool discovery", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-350-monotonic-"));
    write(tmp, "specs/spec.md", "# Spec\n\n- REQ-001: a requirement\n");
    write(tmp, "src/keep.ts", "// @impl REQ-001\nexport function keep() {}\n");
    write(tmp, "src/legacy/old.ts", "export function old() {}\n");
    write(
      tmp,
      "src/legacy/old.test.ts",
      `describe("[${"REQ-001"}] old", () => { it("x", () => {}); });\n`,
    );
  });

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  function discoveredGraphFiles(config: ArtgraphConfig): string[] {
    const { graph } = buildGraph(tmp, config);
    return [...graph.nodes.values()]
      .filter((n) => n.kind === "file" || n.kind === "test")
      .map((n) => n.filePath)
      .sort();
  }

  function legacyMergedPoolFiles(config: ArtgraphConfig): string[] {
    // Reproduces the EXACT pre-#350 algorithm: one glob over the
    // concatenated pattern list, so its negative patterns share a single
    // `ignore` list. `globCodeFiles` itself is unchanged by #350 — only
    // `graph/builder.ts` / `rename-executor.ts` stopped calling it this way.
    return globCodeFiles(tmp, [...config.include, ...config.testPatterns])
      .map((f) => relative(tmp, f))
      .sort();
  }

  const cases: Array<{ name: string; config: ArtgraphConfig; exactMatch: boolean }> = [
    {
      name: "no negative patterns (baseline — must be BYTE-IDENTICAL, not just a superset)",
      config: {
        include: ["src/**/*.ts"],
        specDirs: ["specs"],
        testPatterns: ["src/**/*.test.ts"],
        lockFile: ".trace.lock",
      },
      exactMatch: true,
    },
    {
      name: "include-only negative pattern",
      config: {
        include: ["src/**/*.ts", "!src/legacy/**"],
        specDirs: ["specs"],
        testPatterns: ["src/**/*.test.ts"],
        lockFile: ".trace.lock",
      },
      exactMatch: false,
    },
    {
      name: "testPatterns-only negative pattern",
      config: {
        include: ["src/**/*.ts"],
        specDirs: ["specs"],
        testPatterns: ["src/**/*.test.ts", "!src/legacy/**"],
        lockFile: ".trace.lock",
      },
      exactMatch: false,
    },
    {
      name: "both pools negative on the same path",
      config: {
        include: ["src/**/*.ts", "!src/legacy/**"],
        specDirs: ["specs"],
        testPatterns: ["src/**/*.test.ts", "!src/legacy/**"],
        lockFile: ".trace.lock",
      },
      exactMatch: true,
    },
  ];

  for (const { name, config, exactMatch } of cases) {
    it(`${name}: pool-separated file set ⊇ merged-pool file set`, () => {
      const merged = legacyMergedPoolFiles(config);
      const separated = discoveredGraphFiles(config);
      for (const f of merged) {
        expect(separated, `expected ${f} (merged-discovered) to survive pool separation`).toContain(
          f,
        );
      }
      if (exactMatch) {
        expect(separated).toEqual(merged);
      }
    });
  }

  it("testPatterns-only negative pattern: src/legacy/old.ts now survives (kind:file) where the merged pool dropped it entirely", () => {
    const config: ArtgraphConfig = {
      include: ["src/**/*.ts"],
      specDirs: ["specs"],
      testPatterns: ["src/**/*.test.ts", "!src/legacy/**"],
      lockFile: ".trace.lock",
    };
    expect(legacyMergedPoolFiles(config)).not.toContain("src/legacy/old.ts");
    const { graph } = buildGraph(tmp, config);
    expect(graph.nodes.get("file:src/legacy/old.ts")?.kind).toBe("file");
    // old.test.ts is ALSO under src/legacy, so testPatterns' own negative
    // pattern excludes it from the testPatterns pool too — it survives only
    // via `include` (no negation there), and therefore classifies as
    // kind:"file", not kind:"test", despite its *.test.ts name.
    expect(graph.nodes.get("file:src/legacy/old.test.ts")?.kind).toBe("file");
  });
});

// ---------------------------------------------------------------------------
// (c) HIGH-1 — scan and rename agree on file scope
// ---------------------------------------------------------------------------

describe("issue #350 (c) — HIGH-1: rename rewrites files reachable only through the include pool under a testPatterns-only negative pattern", () => {
  let tmp: string;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("rename updates src/legacy/old.ts's @impl tag, and a subsequent scan agrees", () => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-350-rename-scope-"));
    write(tmp, "specs/spec.md", "# Spec\n\n- REQ-001: a requirement\n");
    write(tmp, "src/widget.ts", "// @impl REQ-001\nexport function widget() {}\n");
    // Only discoverable via the `include` pool once pools separate —
    // `testPatterns`' own negative pattern excludes it from the testPatterns
    // pool, but that must not remove it from `include`'s pool nor from
    // rename's rewrite scope.
    write(tmp, "src/legacy/old.ts", "// @impl REQ-001\nexport function oldWidget() {}\n");
    const config = {
      include: ["src/**/*.ts"],
      specDirs: ["specs"],
      testPatterns: ["src/**/*.test.ts", "!src/legacy/**"],
    };
    write(tmp, ".artgraph.json", JSON.stringify(config));

    const result = executeRename({
      rootDir: tmp,
      dryRun: false,
      format: "json",
      from: "REQ-001",
      to: "REQ-100",
    });

    const oldTsChange = result.changes.find((c) => c.filePath === "src/legacy/old.ts");
    expect(oldTsChange, "rename must have rewritten src/legacy/old.ts's @impl tag").toBeDefined();

    const rewritten = readFileSync(join(tmp, "src", "legacy", "old.ts"), "utf-8");
    expect(rewritten).toContain("@impl REQ-100");
    expect(rewritten).not.toContain("REQ-001");

    // scan/rename agreement: a fresh buildGraph over the SAME config sees the
    // renamed ID at the same file — no stale REQ-001 reference left behind
    // that a later scan would report as a surprise orphan/uncovered finding.
    const { graph } = buildGraph(tmp, {
      ...config,
      lockFile: ".trace.lock",
    } as ArtgraphConfig);
    const implEdge = graph.edges.find(
      (e) => e.kind === "implements" && e.source === "file:src/legacy/old.ts",
    );
    expect(implEdge?.target).toBe("REQ-100");
  });
});

// ---------------------------------------------------------------------------
// (d) HIGH-2 — node_modules protection on both pools, dynamic remediation
// ---------------------------------------------------------------------------

describe("issue #350 (d) — HIGH-2: node_modules protection is symmetric across both pools", () => {
  let tmp: string;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("DEFAULT_CONFIG (unconfigured project) never ingests node_modules/pkg/foo.test.ts", () => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-350-nm-default-"));
    write(tmp, "specs/spec.md", "# Spec\n\n- REQ-001: a requirement\n");
    write(tmp, "src/widget.ts", "// @impl REQ-001\nexport function widget() {}\n");
    write(tmp, "node_modules/pkg/foo.test.ts", `describe("[${"REQ-001"}] foo", () => {});\n`);

    const config: ArtgraphConfig = { ...DEFAULT_CONFIG, specDirs: ["specs"] };
    const { graph, warnings } = buildGraph(tmp, config);
    expect(graph.nodes.has("file:node_modules/pkg/foo.test.ts")).toBe(false);
    expect(warnings.some((w) => w.type === "node-modules-in-scan")).toBe(false);
  });

  it("custom testPatterns without its own node_modules negation ingests via the testPatterns pool, and the warning points at testPatterns", () => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-350-nm-testpatterns-"));
    write(tmp, "specs/spec.md", "# Spec\n\n- REQ-001: a requirement\n");
    write(tmp, "src/widget.ts", "// @impl REQ-001\nexport function widget() {}\n");
    write(tmp, "node_modules/pkg/foo.test.ts", `describe("[${"REQ-001"}] foo", () => {});\n`);

    const config: ArtgraphConfig = {
      include: ["src/**/*.ts", "!**/node_modules/**"],
      specDirs: ["specs"],
      testPatterns: ["**/*.test.ts"],
      lockFile: ".trace.lock",
    };
    const { graph, warnings } = buildGraph(tmp, config);
    expect(graph.nodes.get("file:node_modules/pkg/foo.test.ts")?.kind).toBe("test");
    const w = warnings.find((x) => x.type === "node-modules-in-scan");
    expect(w).toBeDefined();
    expect(w?.message).toContain("testPatterns");
    expect(w?.message).not.toContain('"include"');
  });

  it("custom include without its own node_modules negation ingests via the include pool, and the warning points at include", () => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-350-nm-include-"));
    write(tmp, "specs/spec.md", "# Spec\n\n- REQ-001: a requirement\n");
    write(tmp, "src/widget.ts", "// @impl REQ-001\nexport function widget() {}\n");
    write(tmp, "node_modules/pkg/plain.ts", "export const x = 1;\n");

    const config: ArtgraphConfig = {
      include: ["src/**/*.ts", "**/*.ts"],
      specDirs: ["specs"],
      testPatterns: ["**/*.test.ts", "!**/node_modules/**"],
      lockFile: ".trace.lock",
    };
    const { graph, warnings } = buildGraph(tmp, config);
    expect(graph.nodes.get("file:node_modules/pkg/plain.ts")?.kind).toBe("file");
    const w = warnings.find((x) => x.type === "node-modules-in-scan");
    expect(w).toBeDefined();
    expect(w?.message).toContain('"include"');
    expect(w?.message).not.toContain("testPatterns");
  });

  it("a file matched by BOTH pools (neither negated) points the remediation at both config keys", () => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-350-nm-both-"));
    write(tmp, "specs/spec.md", "# Spec\n\n- REQ-001: a requirement\n");
    write(tmp, "src/widget.ts", "// @impl REQ-001\nexport function widget() {}\n");
    // Matched by include's own `**/*.ts` AND testPatterns' own
    // `**/*.test.ts` — neither pool negates node_modules.
    write(tmp, "node_modules/pkg/foo.test.ts", `describe("[${"REQ-001"}] foo", () => {});\n`);

    const config: ArtgraphConfig = {
      include: ["src/**/*.ts", "**/*.ts"],
      specDirs: ["specs"],
      testPatterns: ["**/*.test.ts"],
      lockFile: ".trace.lock",
    };
    const { warnings } = buildGraph(tmp, config);
    const w = warnings.find((x) => x.type === "node-modules-in-scan");
    expect(w).toBeDefined();
    expect(w?.message).toContain('"include"');
    expect(w?.message).toContain("testPatterns");
  });
});

// ---------------------------------------------------------------------------
// (e) LOW-2 — a pool-separation-only test node still respects the #303
//     test-hub BFS restriction.
// ---------------------------------------------------------------------------

describe("issue #350 (e) — LOW-2: a test node newly discoverable ONLY via pool separation still triggers the #303 hub restriction", () => {
  let tmp: string;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("src/legacy/sample.test.ts is undiscoverable under the old merged pool but appears (kind:test) post-#350, and the hub restriction still excludes the sibling REQ", () => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-350-low2-hub-"));
    write(
      tmp,
      "specs/spec.md",
      "# Spec\n\n- REQ-901: sibling requirement\n- REQ-902: target requirement\n",
    );
    write(
      tmp,
      "src/sample.ts",
      "// @impl REQ-901\nexport function fnA() {}\n\n// @impl REQ-902\nexport function fnB() {}\n",
    );
    // `include` excludes src/legacy entirely; `testPatterns` has no
    // exclusion at all and matches this file directly — pre-#350 the shared
    // ignore list (built from include's `!src/legacy/**`) would have
    // excluded this file from the WHOLE merged-pool scan, so it never
    // existed in the graph at all. Post-#350 it survives via the
    // testPatterns pool alone, as kind:"test".
    write(
      tmp,
      "src/legacy/sample.test.ts",
      'import { fnA, fnB } from "../sample.js";\n\n' +
        `describe("[${"REQ-901"}] sample", () => {\n` +
        '  it("uses fnA and fnB", () => {\n' +
        "    fnA();\n" +
        "    fnB();\n" +
        "  });\n" +
        "});\n",
    );
    const config: ArtgraphConfig = {
      include: ["src/**/*.ts", "!src/legacy/**"],
      specDirs: ["specs"],
      testPatterns: ["src/legacy/**/*.test.ts"],
      lockFile: ".trace.lock",
      mode: "symbol",
    };

    // Confirm the premise: the old merged-pool algorithm would never have
    // discovered this file at all.
    const merged = globCodeFiles(tmp, [...config.include, ...config.testPatterns]).map((f) =>
      relative(tmp, f),
    );
    expect(merged).not.toContain("src/legacy/sample.test.ts");

    const { graph } = buildGraph(tmp, config);
    const testNode = graph.nodes.get("file:src/legacy/sample.test.ts");
    expect(testNode?.kind).toBe("test");

    // #303 pass-through-hub shape: fnB implements REQ-902 directly; the test
    // hub also imports fnB and verifies REQ-901. Without the test-kind-gated
    // BFS restriction, REQ-901 would leak into fnB's blast radius via
    // rev-imports -> test hub -> fwd-verifies.
    const result = impact(graph, ["symbol:src/sample.ts#fnB"], {} as LockFile);
    expect(result.impactReqs).toContain("REQ-902");
    expect(result.impactReqs).not.toContain("REQ-901");
  });
});

// ---------------------------------------------------------------------------
// (f) parse-cache warm/cold parity across a pool-separation-widening config
//     change (mirrors tests/issue-323-parse-cache-kind-guard.test.ts's style)
// ---------------------------------------------------------------------------

describe("issue #350 (f) — warm-cache discovery widening (testPatterns negative pattern removed) matches a cold rebuild", () => {
  let tmp: string;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("widening testPatterns (dropping its negative pattern) on a warm-cached project matches an ARTGRAPH_CACHE=0 cold rebuild of the same final config", () => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-350-cache-parity-"));
    mkdirSync(join(tmp, "node_modules"), { recursive: true }); // opt into the cache
    write(tmp, "specs/spec.md", "# Spec\n\n- REQ-001: a requirement\n");
    write(tmp, "src/widget.ts", "// @impl REQ-001\nexport function widget() {}\n");
    write(
      tmp,
      "src/legacy/old.test.ts",
      `describe("[${"REQ-001"}] old", () => {\n  it("works", () => {});\n});\n`,
    );

    const narrowConfig: ArtgraphConfig = {
      include: ["src/**/*.ts"],
      specDirs: ["specs"],
      testPatterns: ["src/**/*.test.ts", "!src/legacy/**"],
      lockFile: ".trace.lock",
    };
    // Build 1: warm the cache. old.test.ts survives via `include` only
    // (kind:"file"), since testPatterns' own negation excludes it from the
    // testPatterns pool.
    const first = buildGraph(tmp, narrowConfig);
    expect(first.graph.nodes.get("file:src/legacy/old.test.ts")?.kind).toBe("file");

    const widenedConfig: ArtgraphConfig = {
      ...narrowConfig,
      testPatterns: ["src/**/*.test.ts"],
    };
    // Build 2: SAME tmp dir (warm cache), testPatterns' negative pattern
    // dropped — old.test.ts now ALSO matches the testPatterns pool, so it
    // must flip to kind:"test" and gain its verifies edge.
    const warmWidened = buildGraph(tmp, widenedConfig);
    expect(warmWidened.graph.nodes.get("file:src/legacy/old.test.ts")?.kind).toBe("test");
    expect(
      warmWidened.graph.edges.some(
        (e) =>
          e.kind === "verifies" &&
          e.source === "file:src/legacy/old.test.ts" &&
          e.target === "REQ-001",
      ),
    ).toBe(true);

    // Cross-check against a cache-disabled cold build of the SAME (widened) config.
    process.env.ARTGRAPH_CACHE = "0";
    let cold;
    try {
      cold = buildGraph(tmp, widenedConfig);
    } finally {
      delete process.env.ARTGRAPH_CACHE;
    }
    expect([...warmWidened.graph.nodes.keys()].sort()).toEqual([...cold.graph.nodes.keys()].sort());
    expect(warmWidened.graph.nodes.get("file:src/legacy/old.test.ts")?.kind).toBe(
      cold.graph.nodes.get("file:src/legacy/old.test.ts")?.kind,
    );
    expect(warmWidened.graph.edges.length).toBe(cold.graph.edges.length);
  });
});
