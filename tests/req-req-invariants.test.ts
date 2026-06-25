import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { buildGraph } from "../src/graph/builder.js";
import { buildLockFromGraph } from "../src/lock.js";
import { rewriteFile, rewriteAnnotationIds } from "../src/rename.js";
import { formatGraphJSON } from "../src/graph/format.js";
import type { ArtgraphConfig, ArtifactGraph } from "../src/types.js";

// Regression suite for meta-review remediation (Blocker + Major findings).
// Each `it` corresponds to a specific finding from the PR#77 meta review.

const TMP_BASE = resolve(import.meta.dirname, "fixtures/_invariants_tmp");

function setupTmp(files: Record<string, string>): string {
  if (existsSync(TMP_BASE)) rmSync(TMP_BASE, { recursive: true, force: true });
  mkdirSync(TMP_BASE, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = resolve(TMP_BASE, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf-8");
  }
  return TMP_BASE;
}

const baseConfig: ArtgraphConfig = {
  include: [],
  specDirs: ["specs"],
  testPatterns: [],
  lockFile: ".trace.lock",
};

describe("req-req invariants (meta-review remediation)", () => {
  afterEach(() => {
    if (existsSync(TMP_BASE)) rmSync(TMP_BASE, { recursive: true, force: true });
  });

  it("hash-F2: collision で annotation edge は specDir ごとに正しく帰属する", () => {
    setupTmp({
      "specs/010-a/spec.md": "- AUTH-001: a (depends_on: SUP-100)\n- SUP-100: x\n",
      "specs/010-b/spec.md": "- AUTH-001: b (depends_on: SUP-200)\n- SUP-200: y\n",
    });
    const { graph } = buildGraph(TMP_BASE, baseConfig);
    const annEdges = graph.edges.filter((e) => e.provenance === "annotation");

    const aEdges = annEdges.filter((e) => e.source === "010-a/AUTH-001");
    const bEdges = annEdges.filter((e) => e.source === "010-b/AUTH-001");
    expect(aEdges).toHaveLength(1);
    expect(aEdges[0].target).toBe("SUP-100");
    expect(bEdges).toHaveLength(1);
    expect(bEdges[0].target).toBe("SUP-200");
  });

  it("C1-parser: inline code 内の `(depends_on: X)` は edge を生成しない", () => {
    setupTmp({
      "specs/010-a/spec.md":
        "- INLN-001: foo `(depends_on: AUTH-001)` baz\n- AUTH-001: x\n",
    });
    const { graph } = buildGraph(TMP_BASE, baseConfig);
    const edges = graph.edges.filter((e) => e.provenance === "annotation");
    expect(edges).toHaveLength(0);
  });

  it("C1-parser: HTML コメント内の `(depends_on: X)` は edge を生成しない", () => {
    setupTmp({
      "specs/010-a/spec.md":
        "- HTML-001: foo <!-- (depends_on: AUTH-001) --> baz\n- AUTH-001: x\n",
    });
    const { graph } = buildGraph(TMP_BASE, baseConfig);
    const edges = graph.edges.filter((e) => e.provenance === "annotation");
    expect(edges).toHaveLength(0);
  });

  it("C1-parser: blockquote 内の list-item 注釈は edge を生成しない", () => {
    setupTmp({
      "specs/010-a/spec.md":
        "> - BQ-001: y (depends_on: AUTH-001)\n\n- AUTH-001: x\n",
    });
    const { graph } = buildGraph(TMP_BASE, baseConfig);
    const edges = graph.edges.filter((e) => e.provenance === "annotation");
    expect(edges).toHaveLength(0);
  });

  it("C1-rewriter: inline code / HTML コメント / blockquote 内は書換しない", () => {
    const r1 = rewriteAnnotationIds(
      "- X: y `(depends_on: AUTH-001)` z",
      "AUTH-001",
      "AUTH-100",
    );
    expect(r1.content).toBe("- X: y `(depends_on: AUTH-001)` z");
    expect(r1.changes).toHaveLength(0);

    const r2 = rewriteAnnotationIds(
      "- X: y <!-- (depends_on: AUTH-001) --> z",
      "AUTH-001",
      "AUTH-100",
    );
    expect(r2.content).toBe("- X: y <!-- (depends_on: AUTH-001) --> z");
    expect(r2.changes).toHaveLength(0);

    const r3 = rewriteAnnotationIds(
      "> - X: y (depends_on: AUTH-001)",
      "AUTH-001",
      "AUTH-100",
    );
    expect(r3.content).toBe("> - X: y (depends_on: AUTH-001)");
    expect(r3.changes).toHaveLength(0);
  });

  it("C7: ambiguous で annotation edge は生成されず orphan-edge と二重警告にならない", () => {
    setupTmp({
      "specs/010-a/spec.md": "- ROOT-001: foo (depends_on: AUTH-001)\n",
      "specs/010-b/spec.md": "- AUTH-001: b\n",
      "specs/010-c/spec.md": "- AUTH-001: c\n",
    });
    const { graph, warnings } = buildGraph(TMP_BASE, baseConfig);

    const annEdges = graph.edges.filter((e) => e.provenance === "annotation");
    expect(annEdges).toHaveLength(0);

    const ambig = warnings.filter(
      (w) => w.type === "ambiguous-id" && w.id === "AUTH-001",
    );
    const orphan = warnings.filter(
      (w) => w.type === "orphan-edge" && w.id === "AUTH-001",
    );
    expect(ambig).toHaveLength(1);
    expect(orphan).toHaveLength(0);
  });

  it("C4: 空トークンがカンマで紛れても invalid-annotation-id key=`` 警告は出ない", () => {
    setupTmp({
      "specs/010-a/spec.md":
        "- X-001: y (depends_on: ,A-1,,B-2,)\n- A-1: a\n- B-2: b\n",
    });
    const { graph, warnings } = buildGraph(TMP_BASE, baseConfig);

    const annEdges = graph.edges.filter((e) => e.provenance === "annotation");
    expect(annEdges.map((e) => e.target).sort()).toEqual(["A-1", "B-2"]);

    const emptyKey = warnings.filter(
      (w) => w.type === "invalid-annotation-id" && w.id === "",
    );
    expect(emptyKey).toHaveLength(0);
  });

  it("hash-F1: heading 中間行の注釈で contentHash が drift しない", () => {
    const filePath = "specs/010-a/spec.md";
    setupTmp({
      [filePath]:
        "## Requirement 2: タイトル\n\n本文 line 1\n本文 line 2 (depends_on: Requirement-1)\n本文 line 3\n\n## Requirement 1: t\n",
    });
    const { graph: g1 } = buildGraph(TMP_BASE, baseConfig);
    const h1 = g1.nodes.get("Requirement-2")!.contentHash;

    writeFileSync(
      resolve(TMP_BASE, filePath),
      "## Requirement 2: タイトル\n\n本文 line 1\n本文 line 2\n本文 line 3\n\n## Requirement 1: t\n",
      "utf-8",
    );
    const { graph: g2 } = buildGraph(TMP_BASE, baseConfig);
    const h2 = g2.nodes.get("Requirement-2")!.contentHash;

    expect(h1).toBe(h2);
  });

  it("hash-F3: 注釈の括弧前後の空白の有無で hash drift しない", () => {
    const filePath = "specs/010-a/spec.md";
    setupTmp({
      [filePath]:
        "- AUTH-002:(depends_on: AUTH-001) actual content\n- AUTH-001: x\n",
    });
    const { graph: g1 } = buildGraph(TMP_BASE, baseConfig);
    const h1 = g1.nodes.get("AUTH-002")!.contentHash;

    writeFileSync(
      resolve(TMP_BASE, filePath),
      "- AUTH-002: actual content\n- AUTH-001: x\n",
      "utf-8",
    );
    const { graph: g2 } = buildGraph(TMP_BASE, baseConfig);
    const h2 = g2.nodes.get("AUTH-002")!.contentHash;

    expect(h1).toBe(h2);
  });

  it("hash: 同一行に同 ID を順序入れ替えしても hash 不変", () => {
    const filePath = "specs/010-a/spec.md";
    setupTmp({
      [filePath]: "- X-001: foo (depends_on: A-1, A-2)\n- A-1: a\n- A-2: b\n",
    });
    const { graph: g1 } = buildGraph(TMP_BASE, baseConfig);
    const h1 = g1.nodes.get("X-001")!.contentHash;

    writeFileSync(
      resolve(TMP_BASE, filePath),
      "- X-001: foo (depends_on: A-2, A-1)\n- A-1: a\n- A-2: b\n",
      "utf-8",
    );
    const { graph: g2 } = buildGraph(TMP_BASE, baseConfig);
    const h2 = g2.nodes.get("X-001")!.contentHash;

    expect(h1).toBe(h2);
  });

  it("C5: rewriter は reqPatterns.codeId にマッチしない oldId を no-op で扱う", () => {
    const result = rewriteAnnotationIds(
      "- X-1: y (depends_on: foo-bar)\n",
      "foo-bar",
      "foo-baz",
      { reqPatterns: { codeId: "^AUTH-\\d+$" } },
    );
    expect(result.content).toBe("- X-1: y (depends_on: foo-bar)\n");
    expect(result.changes).toHaveLength(0);
  });

  it("CRLF: CRLF ファイルでも書換が発生し改行コードが保持される", () => {
    const input = "- X-1: y (depends_on: AUTH-001)\r\n- AUTH-001: a\r\n";
    const result = rewriteFile("test.md", input, "AUTH-001", "AUTH-100");
    expect(result.content).toContain("AUTH-100");
    expect(result.content).toContain("\r\n");
    // LF-only lines must NOT appear when input was CRLF.
    expect(/[^\r]\n/.test(result.content)).toBe(false);
  });

  it("追加F2: annotation edge は lock の dependsOn に含まれない", () => {
    setupTmp({
      "specs/010-a/spec.md": "- A-1: foo (depends_on: A-2)\n- A-2: bar\n",
    });
    const { graph } = buildGraph(TMP_BASE, baseConfig);
    const lock = buildLockFromGraph(graph);
    expect(lock["A-1"]?.dependsOn).toBeUndefined();
  });

  it("追加F6: provenance が不正な値ならば JSON 出力で省略される", () => {
    const fakeGraph: ArtifactGraph = {
      nodes: new Map([
        [
          "A",
          {
            id: "A",
            kind: "req",
            filePath: "x.md",
            contentHash: "h",
            label: "A",
          },
        ],
        [
          "B",
          {
            id: "B",
            kind: "req",
            filePath: "x.md",
            contentHash: "h",
            label: "B",
          },
        ],
      ]),
      edges: [
        {
          source: "A",
          target: "B",
          kind: "depends_on",
          provenance: "annotation",
        },
        {
          source: "A",
          target: "B",
          kind: "depends_on",
          provenance: "" as unknown as undefined,
        },
        {
          source: "A",
          target: "B",
          kind: "depends_on",
          provenance: null as unknown as undefined,
        },
        {
          source: "A",
          target: "B",
          kind: "depends_on",
          provenance: "bogus" as unknown as undefined,
        },
        { source: "A", target: "B", kind: "depends_on" },
      ],
    };
    const json = JSON.parse(formatGraphJSON(fakeGraph));
    expect(json.edges).toHaveLength(5);
    expect(json.edges[0].provenance).toBe("annotation");
    for (let i = 1; i < json.edges.length; i++) {
      expect(json.edges[i].provenance).toBeUndefined();
    }
  });

  it("rename round-trip: 注釈 edge 集合が rename 前後で同型", () => {
    const filePath = "specs/010-a/spec.md";
    setupTmp({
      [filePath]:
        "- A-2: foo (depends_on: A-1, A-3)\n- A-1: bar\n- A-3: baz\n",
    });
    const { graph: g1 } = buildGraph(TMP_BASE, baseConfig);
    const set1 = g1.edges
      .filter((e) => e.provenance === "annotation")
      .map((e) => `${e.source}->${e.target}:${e.kind}`)
      .sort();

    const absPath = resolve(TMP_BASE, filePath);
    const content = readFileSync(absPath, "utf-8");
    const renamed = rewriteFile(absPath, content, "A-1", "A-100");
    writeFileSync(absPath, renamed.content, "utf-8");

    const { graph: g2 } = buildGraph(TMP_BASE, baseConfig);
    const set2 = g2.edges
      .filter((e) => e.provenance === "annotation")
      .map((e) => `${e.source}->${e.target}:${e.kind}`)
      .sort();

    expect(set2.length).toBe(set1.length);
    const expected = set1.map((s) => s.replace(/A-1(?!\d)/g, "A-100")).sort();
    expect(set2).toEqual(expected);
  });

  it("rename idempotency: rewriteAnnotationIds を 2 回適用しても変化なし", () => {
    const input = "- A-2: foo (depends_on: A-1, A-3)";
    const r1 = rewriteAnnotationIds(input, "A-1", "A-100");
    const r2 = rewriteAnnotationIds(r1.content, "A-1", "A-100");
    expect(r2.content).toBe(r1.content);
    expect(r2.changes).toHaveLength(0);
  });

  it("ambiguous-id 警告の files 配列は specDirs 順に依存せず決定的", () => {
    setupTmp({
      "specs/010-c/spec.md": "- ROOT-001: foo (depends_on: AUTH-001)\n",
      "specs/010-a/spec.md": "- AUTH-001: a\n",
      "specs/010-b/spec.md": "- AUTH-001: b\n",
    });
    const { warnings } = buildGraph(TMP_BASE, baseConfig);
    const ambig = warnings.find(
      (w) => w.type === "ambiguous-id" && w.id === "AUTH-001",
    );
    // sort 済みで決定的
    expect(ambig?.files).toEqual([...(ambig?.files ?? [])].sort());
  });
});
