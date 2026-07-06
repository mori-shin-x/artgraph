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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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

  it("lets a local declaration win over a same-name re-export (no clobber)", () => {
    // `export { foo } from "./other"` collides with the local `foo` (an illegal
    // duplicate export TS tolerates). The single `#foo` node must stay the
    // LOCAL declaration (hashed on `foo = 2`), never the re-export pass-through
    // (which would hash the `export { foo } from …` statement text).
    makeRepo({
      "src/other.ts": "export const foo = 1;\n",
      "src/index.ts": 'export const foo = 2;\nexport { foo } from "./other";\n',
    });
    const frag = parseOne("src/index.ts");
    const fooNodes = frag.nodes.filter((n) => n.id === "symbol:src/index.ts#foo");
    expect(fooNodes).toHaveLength(1);
    expect(fooNodes[0].contentHash).toBe(hash("foo = 2"));
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
  it("produces an identical graph (nodes + edges) on a second build", () => {
    const root = makeRepo({
      "specs/req.md": "# R\n\n- REQ-001: x\n",
      "src/auth.ts":
        "// @impl REQ-001\nexport function validateToken() {}\nexport function revokeToken() {}\n",
      "src/index.ts": 'export { validateToken as vt, revokeToken } from "./auth";\n',
      "src/index2.ts": 'export { vt } from "./index";\n',
      "src/star.ts": 'export * from "./auth";\n',
    });
    // Compare graph structure (not the lock — its `lastReconciled` is a wall
    // clock). This pins that the materialized barrel nodes hash deterministically
    // and land in a stable order.
    const serialize = (root: string) => {
      const { graph } = buildGraph(root, loadConfig(root));
      return JSON.stringify({
        nodes: [...graph.nodes.values()].map((n) => `${n.id}|${n.kind}|${n.contentHash}`),
        edges: graph.edges.map(
          (e) => `${e.source}|${e.target}|${e.kind}|${e.provenances.join(",")}`,
        ),
      });
    };
    expect(serialize(root)).toBe(serialize(root));
  });
});
