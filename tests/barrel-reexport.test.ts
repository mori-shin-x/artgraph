// Issue #177 — symbol-mode fail-open fix.
//
// Two independent defects made symbol-mode `impact` / `check --gate` miss REQs
// reached through named imports:
//   (a) a `// @impl REQ` written on the line ABOVE `export …` (the idiomatic
//       placement `bootstrap` emits) bound to the FILE, not the symbol, so a
//       named-import edge targeting `symbol:x#name` dead-ended;
//   (b) a barrel `export { x } from "./origin"` discarded the name and never
//       materialized `symbol:barrel#x`, leaving the consumer's import edge
//       pointing at a phantom node.
//
// This suite pins both fixes end-to-end: leading-comment attribution, per-
// symbol barrel materialization (named / aliased / default / type / multi-
// level), the file-grain fail-safe for `export *`, and INV-L4 determinism of
// the new nodes.
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseTSFilePaths, hash } from "../src/parsers/typescript.js";
import { buildGraph } from "../src/graph/builder.js";
import { impact, resolveStartIds } from "../src/graph/traverse.js";
import { loadConfig } from "../src/config.js";
import type { ParsedTS } from "../src/parsers/typescript.js";

let tmp: string;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function makeRepo(files: Record<string, string>, mode: "file" | "symbol" = "symbol"): string {
  tmp = mkdtempSync(join(tmpdir(), "artgraph-177-"));
  // Create node_modules so parse-cache's cacheEnabled() gate opens — otherwise
  // every buildGraph call in these tests silently runs the cold path and the
  // INV-L4 warm/cold parity assertions below reduce to tautologies.
  mkdirSync(join(tmp, "node_modules"), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(tmp, rel);
    mkdirSync(resolve(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf-8");
  }
  writeFileSync(
    join(tmp, ".artgraph.json"),
    JSON.stringify({ include: ["src/**/*.ts"], specDirs: ["specs"], mode }),
    "utf-8",
  );
  return tmp;
}

// Parse one file in symbol mode and return its fragment.
function parseOne(rel: string): ParsedTS {
  const abs = join(tmp, rel);
  return parseTSFilePaths(tmp, [abs], "symbol").get(abs)!;
}

function implSourcesFor(frag: ParsedTS, target: string): string[] {
  return frag.edges
    .filter((e) => e.kind === "implements" && e.target === target)
    .map((e) => e.source);
}

// impactReqs for a file-unit start (mirrors `artgraph impact <file>`).
function impactReqs(root: string, file: string): string[] {
  const { graph } = buildGraph(root, loadConfig(root));
  const { startIds } = resolveStartIds(graph, [{ path: file }]);
  return impact(graph, startIds, {}).impactReqs.sort();
}

// ---------------------------------------------------------------------------
// (a) leading-comment @impl attribution
// ---------------------------------------------------------------------------

describe("#177 (a) leading-comment @impl binds to the following export symbol", () => {
  it("attaches a tag directly above `export function` to the symbol", () => {
    makeRepo({
      "src/auth.ts":
        "// @impl REQ-001\nexport function validateToken(t: string) {\n  return !!t;\n}\n",
    });
    expect(implSourcesFor(parseOne("src/auth.ts"), "REQ-001")).toEqual([
      "symbol:src/auth.ts#validateToken",
    ]);
  });

  it("attaches a tag above `export const` (arrow) to the symbol — the bootstrap shape", () => {
    // Regression guard: the symbol's parse offset is the DECLARATOR (`handler`,
    // after `export const `), so an offset-based walk would miss the tag. The
    // line-based walk must still reach it.
    makeRepo({
      "src/h.ts": "// @impl REQ-002\nexport const handler = () => {\n  return 1;\n};\n",
    });
    expect(implSourcesFor(parseOne("src/h.ts"), "REQ-002")).toEqual(["symbol:src/h.ts#handler"]);
  });

  it("reaches a tag written ABOVE a JSDoc block above the export", () => {
    makeRepo({
      "src/d.ts":
        "// @impl REQ-003\n/**\n * docs\n * more docs\n */\nexport function run() {\n  return 1;\n}\n",
    });
    expect(implSourcesFor(parseOne("src/d.ts"), "REQ-003")).toEqual(["symbol:src/d.ts#run"]);
  });

  it("keeps a tag above a NON-export statement on the file (no symbol hijack)", () => {
    // `// @impl REQ-004` sits above a private const; the exported `get` is
    // separated by that code line, so the tag must stay file-attributed.
    makeRepo({
      "src/c.ts":
        "// @impl REQ-004\nconst CONFIG = { debug: false };\n\nexport function get() {\n  return CONFIG;\n}\n",
    });
    expect(implSourcesFor(parseOne("src/c.ts"), "REQ-004")).toEqual(["file:src/c.ts"]);
  });

  // A stray Unicode-whitespace-only line between `// @impl` and `export …`
  // used to be treated as a code line, stopping the upward walk and silently
  // binding the tag to the file. `\s` matches Unicode whitespace so the walk
  // continues. Parameterized across representative code points that are the
  // realistic pain sources: U+3000 (JP IME mishap), U+00A0 (non-breaking
  // space from browser copy-paste), U+2028 (LSEP embedded in a string
  // pasted from odd editors). Covers issue #190 more broadly than the
  // single-char report and pins the guarantee across the whole `\s` class.
  for (const [name, whitespace] of [
    ["U+3000 (ideographic space)", "　"],
    ["U+00A0 (no-break space)", " "],
    ["U+2028 (line separator)", " "],
  ] as const) {
    it(`treats a ${name}-only line as blank so the walk reaches @impl (#190)`, () => {
      makeRepo({
        "src/jp.ts": `// @impl REQ-701\n${whitespace}\nexport function validateToken(t: string) {\n  return !!t;\n}\n`,
      });
      expect(implSourcesFor(parseOne("src/jp.ts"), "REQ-701")).toEqual([
        "symbol:src/jp.ts#validateToken",
      ]);
    });
  }

  it("does not change the symbol node contentHash (hash span stays the declaration)", () => {
    // With and without a leading comment, `validateToken`'s hash is identical —
    // proves attribution widening never leaks into the hashed span (INV-L4 /
    // no spurious drift for existing symbol-mode users).
    const body = "export function validateToken(t: string) {\n  return !!t;\n}\n";
    makeRepo({ "src/a.ts": body });
    const bare = parseOne("src/a.ts").nodes.find((n) => n.id === "symbol:src/a.ts#validateToken")!;
    rmSync(tmp, { recursive: true, force: true });
    makeRepo({ "src/a.ts": `// @impl REQ-001\n${body}` });
    const tagged = parseOne("src/a.ts").nodes.find(
      (n) => n.id === "symbol:src/a.ts#validateToken",
    )!;
    expect(tagged.contentHash).toBe(bare.contentHash);
  });
});

// ---------------------------------------------------------------------------
// (D6) `// @impl` counts only inside a REAL line comment
// ---------------------------------------------------------------------------

describe("#177 (D6) @impl in strings / templates / JSX / block comments is not a tag", () => {
  it("ignores `// @impl` inside a string literal but keeps a real neighbour", () => {
    // The string-literal `// @impl REQ-901` must NOT emit an edge; the genuine
    // line comment `// @impl REQ-902` inside `real`'s body still must — proving
    // the filter excludes non-comments without over-rejecting real ones.
    makeRepo({
      "src/s.ts":
        'export const doc = "// @impl REQ-901";\n' +
        "export function real() {\n  // @impl REQ-902\n  return 1;\n}\n",
    });
    const frag = parseOne("src/s.ts");
    expect(implSourcesFor(frag, "REQ-901")).toEqual([]);
    expect(implSourcesFor(frag, "REQ-902")).toEqual(["symbol:src/s.ts#real"]);
  });

  it("ignores `// @impl` inside a template literal", () => {
    makeRepo({ "src/t.ts": "export const tpl = `// @impl REQ-903`;\n" });
    expect(implSourcesFor(parseOne("src/t.ts"), "REQ-903")).toEqual([]);
  });

  it("ignores `// @impl` inside a JSX attribute value", () => {
    makeRepo({
      "src/j.tsx": 'export const El = () => <div title="// @impl REQ-904">x</div>;\n',
    });
    expect(implSourcesFor(parseOne("src/j.tsx"), "REQ-904")).toEqual([]);
  });

  it("ignores a backtick-quoted `// @impl` inside a JSDoc block comment (the rename.ts dogfood shape)", () => {
    // This is the exact false-positive class found by scanning artgraph itself:
    // a JSDoc block comment documenting the `// @impl` syntax was parsed as a
    // real tag. A `Block` comment span is not a `Line` comment, so it is
    // excluded.
    makeRepo({
      "src/d.ts":
        "/**\n * Rewrites `// @impl REQ-905` and `// @impl REQ-905 REQ-906`.\n */\n" +
        "export function rewrite() {\n  return 1;\n}\n",
    });
    const frag = parseOne("src/d.ts");
    expect(implSourcesFor(frag, "REQ-905")).toEqual([]);
    expect(implSourcesFor(frag, "REQ-906")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (D1) a leading tag binds to EVERY sibling binding of one declaration
// ---------------------------------------------------------------------------

describe("#177 (D1) leading @impl binds to all siblings of one declaration", () => {
  it("binds to both names of `export const { a, b } = obj`", () => {
    makeRepo({
      "src/da.ts": "const obj = { a: 1, b: 2 };\n// @impl REQ-910\nexport const { a, b } = obj;\n",
    });
    expect(implSourcesFor(parseOne("src/da.ts"), "REQ-910")).toEqual([
      "symbol:src/da.ts#a",
      "symbol:src/da.ts#b",
    ]);
  });

  it("binds to both names of `export const a = 1, b = 2`", () => {
    makeRepo({ "src/db.ts": "// @impl REQ-911\nexport const a = 1, b = 2;\n" });
    expect(implSourcesFor(parseOne("src/db.ts"), "REQ-911")).toEqual([
      "symbol:src/db.ts#a",
      "symbol:src/db.ts#b",
    ]);
  });

  it("binds to both names of a MULTI-LINE multi-declarator (m2)", () => {
    // The declarators span separate lines: `a = 1` on line 2, `b = 2` on line 3.
    // The old line-range approximation widened each declarator independently, so
    // `a`'s range stopped at the `b = 2` code line and split from `b` — the tag
    // bound only `a`. Statement-level grouping shares one attribution span over
    // the whole `export const … ;`, so BOTH bind.
    makeRepo({ "src/dm.ts": "// @impl REQ-914\nexport const a = 1,\n  b = 2;\n" });
    expect(implSourcesFor(parseOne("src/dm.ts"), "REQ-914")).toEqual([
      "symbol:src/dm.ts#a",
      "symbol:src/dm.ts#b",
    ]);
  });

  it("binds to both names of `export const [a, b] = arr`", () => {
    makeRepo({
      "src/dl.ts": "const arr = [1, 2];\n// @impl REQ-915\nexport const [a, b] = arr;\n",
    });
    expect(implSourcesFor(parseOne("src/dl.ts"), "REQ-915")).toEqual([
      "symbol:src/dl.ts#a",
      "symbol:src/dl.ts#b",
    ]);
  });

  it("does NOT over-broadcast across two exports on the SAME physical line (m1)", () => {
    // `export function a() {} export function b() {}` are two separate
    // statements sharing one physical line. The old line-range approximation
    // gave them identical ranges (same start+end line), so the min-size resolve
    // returned BOTH. Statement grouping keeps them in distinct groups and the
    // resolve returns only the first — `a`.
    makeRepo({
      "src/dsl.ts": "// @impl REQ-916\nexport function a() {} export function b() {}\n",
    });
    expect(implSourcesFor(parseOne("src/dsl.ts"), "REQ-916")).toEqual(["symbol:src/dsl.ts#a"]);
  });

  it("does NOT over-broadcast across consecutive separate exports (D2 stays first-only)", () => {
    // Distinct declaration statements keep distinct widened ranges: only the
    // first export's range covers the tag line, so the tag binds to `a` alone.
    // This is the regression guard against D1 leaking into unrelated siblings.
    makeRepo({
      "src/d2.ts": "// @impl REQ-912\nexport function a() {}\nexport function b() {}\n",
    });
    const frag = parseOne("src/d2.ts");
    expect(implSourcesFor(frag, "REQ-912")).toEqual(["symbol:src/d2.ts#a"]);
  });

  it("keeps single-declarator binding unchanged (one symbol only)", () => {
    // Guards that the multi-value resolve did not start broadcasting a normal
    // single-binding export to neighbours.
    makeRepo({
      "src/d3.ts": "// @impl REQ-913\nexport const only = 1;\nexport const sibling = 2;\n",
    });
    const frag = parseOne("src/d3.ts");
    expect(implSourcesFor(frag, "REQ-913")).toEqual(["symbol:src/d3.ts#only"]);
  });
});

// ---------------------------------------------------------------------------
// (b) barrel symbol materialization
// ---------------------------------------------------------------------------

describe("#177 (b) named/aliased barrel re-exports materialize per-symbol", () => {
  it("materializes `symbol:barrel#name` + edge to the origin symbol", () => {
    makeRepo({
      "src/auth.ts": "export function validateToken(t: string) {\n  return !!t;\n}\n",
      "src/index.ts": 'export { validateToken } from "./auth";\n',
    });
    const frag = parseOne("src/index.ts");
    expect(frag.nodes.map((n) => n.id)).toContain("symbol:src/index.ts#validateToken");
    expect(frag.edges).toContainEqual({
      source: "symbol:src/index.ts#validateToken",
      target: "symbol:src/auth.ts#validateToken",
      kind: "imports",
      provenances: ["ts-import"],
    });
  });

  it("follows `as` renames and `default` / type-only re-exports", () => {
    makeRepo({
      "src/auth.ts": "export function validateToken() {}\nexport default function boot() {}\n",
      "src/types.ts": "export interface Session {}\n",
      "src/index.ts":
        'export { validateToken as vt } from "./auth";\n' +
        'export { default as boot } from "./auth";\n' +
        'export type { Session } from "./types";\n',
    });
    const frag = parseOne("src/index.ts");
    const rex = (source: string) => frag.edges.find((e) => e.source === source)!.target;
    expect(rex("symbol:src/index.ts#vt")).toBe("symbol:src/auth.ts#validateToken");
    expect(rex("symbol:src/index.ts#boot")).toBe("symbol:src/auth.ts#default");
    expect(rex("symbol:src/index.ts#Session")).toBe("symbol:src/types.ts#Session");
  });

  it("lets a local declaration win over a same-name re-export (no clobber, no spurious edge)", () => {
    // `export { foo } from "./other"` collides with the local `foo` (an illegal
    // duplicate export TS tolerates). The single `#foo` node must stay the
    // LOCAL declaration (hashed on `foo = 2`), never the re-export pass-through.
    // The shadowed re-export must ALSO drop its import edge — impact BFS is
    // bidirectional (traverse.ts §"BIDIRECTIONAL"), so a leftover
    // `symbol:index#foo --imports--> symbol:other#foo` would drag every REQ
    // reachable from the origin `foo` into any consumer of the local `foo`.
    makeRepo({
      "src/other.ts": "export const foo = 1;\n",
      "src/index.ts": 'export const foo = 2;\nexport { foo } from "./other";\n',
    });
    const frag = parseOne("src/index.ts");
    const fooNodes = frag.nodes.filter((n) => n.id === "symbol:src/index.ts#foo");
    expect(fooNodes).toHaveLength(1);
    expect(fooNodes[0].contentHash).toBe(hash("foo = 2"));
    const fooEdges = frag.edges.filter(
      (e) => e.source === "symbol:src/index.ts#foo" && e.kind === "imports",
    );
    expect(fooEdges).toEqual([]);
  });

  it("keeps sibling barrel-symbol hashes stable when a sibling specifier is added", () => {
    // Adding `c` to `export { a, b } from "./x"` must not drift the `#a` and
    // `#b` hashes. Prior to per-specifier hashing, the whole statement text
    // was the hash source, so any sibling edit re-hashed every name in it —
    // pure INV-L4 noise for symbol-mode users.
    makeRepo({
      "src/x.ts": "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n",
      "src/index.ts": 'export { a, b } from "./x";\n',
    });
    const before = parseOne("src/index.ts");
    const hashA = before.nodes.find((n) => n.id === "symbol:src/index.ts#a")!.contentHash;
    const hashB = before.nodes.find((n) => n.id === "symbol:src/index.ts#b")!.contentHash;

    // Same repo path, now with `c` added to the re-export statement.
    rmSync(tmp, { recursive: true, force: true });
    makeRepo({
      "src/x.ts": "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n",
      "src/index.ts": 'export { a, b, c } from "./x";\n',
    });
    const after = parseOne("src/index.ts");
    expect(after.nodes.find((n) => n.id === "symbol:src/index.ts#a")!.contentHash).toBe(hashA);
    expect(after.nodes.find((n) => n.id === "symbol:src/index.ts#b")!.contentHash).toBe(hashB);
    // `#c` did not exist before, sanity-check it materialized in the new build.
    expect(after.nodes.some((n) => n.id === "symbol:src/index.ts#c")).toBe(true);
  });

  it("leaves file mode untouched (barrel stays file-grain, no symbol nodes)", () => {
    const root = makeRepo(
      {
        "src/auth.ts": "export function validateToken() {}\n",
        "src/index.ts": 'export { validateToken } from "./auth";\n',
      },
      "file",
    );
    const abs = join(root, "src/index.ts");
    const frag = parseTSFilePaths(root, [abs], "file").get(abs)!;
    expect(frag.nodes.some((n) => n.kind === "symbol")).toBe(false);
    expect(frag.edges).toContainEqual({
      source: "file:src/index.ts",
      target: "file:src/auth.ts",
      kind: "imports",
      provenances: ["ts-import"],
    });
  });
});

// ---------------------------------------------------------------------------
// End-to-end impact — fail-open closed, per-symbol precision, star fail-safe
// ---------------------------------------------------------------------------

describe("#177 impact — fail-open closed with per-symbol precision", () => {
  // REQ-001 and REQ-009 live in SEPARATE spec docs, otherwise the bidirectional
  // BFS would drag REQ-009 in via the shared doc `contains` edge and hide the
  // precision property this asserts.
  const base = {
    "specs/req1.md": "# R1\n\n- REQ-001: validate\n",
    "specs/req9.md": "# R9\n\n- REQ-009: revoke\n",
    // @impl ABOVE declarations (bootstrap style) — exercises fix (a).
    "src/auth.ts":
      "// @impl REQ-001\nexport function validateToken(t: string) {\n  return !!t;\n}\n\n" +
      "// @impl REQ-009\nexport function revokeToken() {}\n",
    "src/index.ts": 'export { validateToken, revokeToken } from "./auth";\n',
    "src/index2.ts": 'export { validateToken } from "./index";\n',
    "src/star.ts": 'export * from "./auth";\n',
  };
  const consumer = (from: string) =>
    `import { validateToken } from "${from}";\nexport function useAuth(t: string) {\n  return validateToken(t);\n}\n`;

  it("direct import of one symbol reaches only its REQ", () => {
    const root = makeRepo({ ...base, "src/consumer.ts": consumer("./auth") });
    expect(impactReqs(root, "src/consumer.ts")).toEqual(["REQ-001"]);
  });

  it("named barrel import of one symbol reaches only its REQ (not the sibling)", () => {
    const root = makeRepo({ ...base, "src/consumer.ts": consumer("./index") });
    expect(impactReqs(root, "src/consumer.ts")).toEqual(["REQ-001"]);
  });

  it("multi-level named barrel chains through to the REQ", () => {
    const root = makeRepo({ ...base, "src/consumer.ts": consumer("./index2") });
    expect(impactReqs(root, "src/consumer.ts")).toEqual(["REQ-001"]);
  });

  it("`export *` barrel closes the fail-open at file grain (non-empty)", () => {
    const root = makeRepo({ ...base, "src/consumer.ts": consumer("./star") });
    // file-grain: reaches the origin FILE, so both siblings surface. The point
    // is it is NOT empty — the fail-open is closed.
    expect(impactReqs(root, "src/consumer.ts")).toEqual(["REQ-001", "REQ-009"]);
  });

  it("a re-export of a name the origin does not export raises no orphan and does not crash", () => {
    const root = makeRepo({
      "specs/req1.md": "# R1\n\n- REQ-001: x\n",
      "src/auth.ts": "// @impl REQ-001\nexport function validateToken() {}\n",
      "src/index.ts": 'export { missing } from "./auth";\n',
      "src/consumer.ts": 'import { missing } from "./index";\nexport const y = missing;\n',
    });
    const { graph, warnings } = buildGraph(root, loadConfig(root));
    expect(warnings.filter((w) => w.type === "orphan-edge")).toHaveLength(0);
    // no crash, graph builds
    expect(graph.nodes.size).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// INV-L4 — the new nodes are deterministic across builds
// ---------------------------------------------------------------------------

describe("#177 INV-L4 — barrel graphs are byte-stable across builds", () => {
  // Compare graph structure (not the lock — its `lastReconciled` is a wall
  // clock). Pins that materialized barrel nodes hash deterministically and
  // land in a stable order — regardless of whether fragments are freshly
  // parsed or read from parse-cache.
  const serialize = (root: string): string => {
    const { graph } = buildGraph(root, loadConfig(root));
    return JSON.stringify({
      nodes: [...graph.nodes.values()].map((n) => `${n.id}|${n.kind}|${n.contentHash}`),
      edges: graph.edges.map((e) => `${e.source}|${e.target}|${e.kind}|${e.provenances.join(",")}`),
    });
  };

  const cachePath = (root: string) =>
    join(root, "node_modules", ".cache", "artgraph", "parse-cache.json");

  // Materialize a fixture into a fresh tmp dir (symbol mode). Returns the tmp
  // path; caller owns cleanup — the module-level `tmp` is left untouched so a
  // preceding makeRepo call stays afterEach-cleanable.
  const scratchRepo = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), "artgraph-177-b-"));
    mkdirSync(join(root, "node_modules"), { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(root, rel);
      mkdirSync(resolve(abs, ".."), { recursive: true });
      writeFileSync(abs, content, "utf-8");
    }
    writeFileSync(
      join(root, ".artgraph.json"),
      JSON.stringify({ include: ["src/**/*.ts"], specDirs: ["specs"], mode: "symbol" }),
      "utf-8",
    );
    return root;
  };

  const barrelFixture = {
    "specs/req.md": "# R\n\n- REQ-001: x\n",
    "src/auth.ts":
      "// @impl REQ-001\nexport function validateToken() {}\nexport function revokeToken() {}\n",
    "src/index.ts": 'export { validateToken as vt, revokeToken } from "./auth";\n',
    "src/index2.ts": 'export { vt } from "./index";\n',
    "src/star.ts": 'export * from "./auth";\n',
  };

  it("cold write then warm read produces the same graph in the same repo", () => {
    const root = makeRepo(barrelFixture);
    const cold = serialize(root);
    // If the write did NOT happen the second call is another cold parse and
    // this assertion degenerates to a tautology, silently hiding regressions.
    expect(existsSync(cachePath(root))).toBe(true);
    const warm = serialize(root);
    expect(warm).toBe(cold);
  });

  it("two independent tmp dirs with identical content produce identical graphs", () => {
    // Guards against tmp-path leakage (rootDir-embedded ids/hashes) and any
    // env difference the first tmp happened to observe.
    const rootA = makeRepo(barrelFixture);
    const a = serialize(rootA);
    const rootB = scratchRepo(barrelFixture);
    try {
      expect(serialize(rootB)).toBe(a);
    } finally {
      rmSync(rootB, { recursive: true, force: true });
    }
  });

  it("`export *` -> named re-export refactor lands warm on the same graph as cold", () => {
    // Pins A1: the phantom-repair pass at builder.ts §"fail-safe repair" must
    // not mutate the shared edge object in place, because the same object is
    // persisted as part of the TS parse-cache fragment. If it did, a consumer
    // whose own content is unchanged after a barrel is refactored to
    // materialize the symbol would keep the stale `file:*` target from the
    // cache — the warm graph would then differ from a cold rebuild of the
    // exact same source tree.
    const consumer =
      'import { validateToken } from "./index";\n' +
      "export function useAuth(t: string) { return validateToken(t); }\n";
    const before = {
      "specs/req.md": "# R\n\n- REQ-001: x\n",
      "src/auth.ts": "// @impl REQ-001\nexport function validateToken() {}\n",
      "src/index.ts": 'export * from "./auth";\n',
      "src/consumer.ts": consumer,
    };
    const after = { ...before, "src/index.ts": 'export { validateToken } from "./auth";\n' };

    // Warm path: cold populates the cache with a phantom-repaired consumer
    // edge; refactor the barrel; the second build hits the cached consumer.
    const rootWarm = makeRepo(before);
    serialize(rootWarm);
    writeFileSync(join(rootWarm, "src/index.ts"), after["src/index.ts"], "utf-8");
    const warmAfter = serialize(rootWarm);

    // Cold reference: fresh tmp starting directly from the refactored state.
    const rootCold = scratchRepo(after);
    try {
      expect(warmAfter).toBe(serialize(rootCold));
    } finally {
      rmSync(rootCold, { recursive: true, force: true });
    }
  });

  it("phantom-repair keeps the persisted parse-cache fragment pristine", () => {
    // Direct check on the mechanism behind A1: after a cold build that fires
    // the file-grain fail-safe, the cached consumer fragment must still hold
    // the original `symbol:*` target. An in-place mutation would leak the
    // `file:*` degrade into the fragment and permanently pin future warm
    // builds to file grain even after the barrel materializes the symbol.
    const root = makeRepo({
      "specs/req.md": "# R\n\n- REQ-001: x\n",
      "src/auth.ts": "// @impl REQ-001\nexport function validateToken() {}\n",
      "src/star.ts": 'export * from "./auth";\n',
      "src/consumer.ts":
        'import { validateToken } from "./star";\n' +
        "export function useAuth(t: string) { return validateToken(t); }\n",
    });
    serialize(root);
    const cache = JSON.parse(readFileSync(cachePath(root), "utf-8"));
    const consumerFrag = cache.ts["src/consumer.ts"];
    const importEdge = consumerFrag.edges.find(
      (e: { source: string; kind: string }) =>
        e.kind === "imports" && e.source === "file:src/consumer.ts",
    );
    expect(importEdge?.target).toBe("symbol:src/star.ts#validateToken");
  });
});

// ---------------------------------------------------------------------------
// #187 — TSImportEqualsDeclaration (CJS-style TS) fail-open closed
// ---------------------------------------------------------------------------

describe("#187 CJS-style TS: import = require() emits at least a file-grain import edge", () => {
  it("produces a file-grain imports edge from consumer to the required module (was silently []) — closes fail-open", () => {
    // `import m = require("./m")` used to be handled by neither
    // ImportDeclaration nor Export*Declaration branches of extractImports,
    // so the consumer ended up with edges=[] and no path to the origin's
    // REQs. The new TSImportEqualsDeclaration branch now maps it to a
    // namespace-style file-grain edge — enough to close the total
    // fail-open. Per-symbol resolution stays out of scope (`export =`
    // has no export name to route through).
    makeRepo({
      "src/m.ts": "// @impl REQ-011\nconst foo = () => 1;\nexport = foo;\n",
      "src/c.ts": 'import m = require("./m");\nexport const use = m;\n',
    });
    const frag = parseOne("src/c.ts");
    const importEdges = frag.edges.filter(
      (e) => e.kind === "imports" && e.source === "file:src/c.ts",
    );
    expect(importEdges.map((e) => e.target)).toEqual(["file:src/m.ts"]);
  });

  it("BFS from consumer reaches REQ-011 on the origin (file-grain)", () => {
    const root = makeRepo({
      "specs/req.md": "# R\n\n- REQ-011: cjs style\n",
      "src/m.ts": "// @impl REQ-011\nconst foo = () => 1;\nexport = foo;\n",
      "src/c.ts": 'import m = require("./m");\nexport const use = m;\n',
    });
    expect(impactReqs(root, "src/c.ts")).toEqual(["REQ-011"]);
  });
});
