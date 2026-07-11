// spec 020 (tasks.md T018, spec.md FR-021) — `scan --serve` / `--output`
// must render `exercises` edges visually distinct from declared edges and
// list them in the legend. Fixture style mirrors `tests/trace-graph.test.ts`
// (hand-written shard + trace config, no real vitest execution needed) so
// the graph under test carries a real coverage-derived `exercises` edge
// rather than a hand-built RenderData stub.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/builder.js";
import { renderGraphData } from "../src/graph/render.js";
import { writeStaticExport } from "../src/graph/serve.js";
import { SCHEMA_VERSION } from "../src/trace/schema.js";
import type { ArtgraphConfig } from "../src/types.js";

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

const BASE_CONFIG: ArtgraphConfig = {
  include: ["src/**/*.ts"],
  specDirs: ["specs"],
  testPatterns: ["tests/**/*.ts"],
  lockFile: ".trace.lock",
  mode: "symbol",
};

function makeRepo(files: Record<string, string>): string {
  const tmp = track(mkdtempSync(join(tmpdir(), "artgraph-graph-serve-legend-")));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(tmp, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf-8");
  }
  return tmp;
}

function metaLine(): string {
  return JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    kind: "meta",
    runToken: "run-1",
    pool: "forks",
    vitest: "4.1.10",
    startedAt: "2026-07-10T14:00:00Z",
  });
}

function testLine(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    kind: "test",
    testName: "[REQ-900] a test",
    suitePath: [],
    testFile: "tests/x.test.ts",
    passed: true,
    hits: [],
    hashes: {},
    ...overrides,
  });
}

function writeShard(tmp: string, name: string, lines: string[]): void {
  const dir = join(tmp, ".artgraph/trace");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), lines.join("\n"), "utf-8");
}

describe("scan --serve / --output: exercises edge legend + style (T018, FR-021)", () => {
  it("renders an exercises legend entry and a dashed cytoscape style selector when the graph has an exercises edge", async () => {
    const tmp = makeRepo({
      "src/billing.ts": "export function refund() {}\n",
      "specs/spec.md": "# Fixture\n\n- REQ-101: refund reimburses a customer.\n",
    });
    writeShard(tmp, "w1.jsonl", [
      metaLine(),
      testLine({
        testName: "[REQ-101] refunds the customer",
        testFile: "tests/req101.test.ts",
        hits: [{ file: "src/billing.ts", fn: "refund" }],
      }),
    ]);

    const { graph } = buildGraph(tmp, BASE_CONFIG);
    // Sanity: the fixture really does carry an exercises edge into the graph.
    expect(graph.edges.some((e) => e.kind === "exercises")).toBe(true);

    const data = renderGraphData(graph, { rootDir: tmp, generatedAt: "2026-07-10T00:00:00Z" });
    expect(data.edges.some((e) => e.kind === "exercises")).toBe(true);

    const outputDir = track(mkdtempSync(join(tmpdir(), "artgraph-graph-serve-legend-out-")));
    await writeStaticExport({ data, outputDir });

    const html = readFileSync(join(outputDir, "index.html"), "utf-8");
    // Legend entry: a distinct "exercises" section, string-level presence
    // only (not pixel-level rendering).
    expect(html).toContain("exercises");
    expect(html).toMatch(/legend-swatch[^"]*edge-exercises/);

    const appJs = readFileSync(join(outputDir, "app.js"), "utf-8");
    // Cytoscape style block: a selector targeting edge kind "exercises",
    // styled with a dashed line (FR-021's recommended visual distinction).
    expect(appJs).toMatch(/edge\[\s*kind\s*=\s*["']exercises["']\s*\]/);
    expect(appJs).toMatch(/"line-style"\s*:\s*"dashed"/);
  });

  it("still renders the exercises legend entry when the graph has no exercises edges (design: legend entry always present)", async () => {
    const tmp = makeRepo({
      "src/auth.ts": "export function signIn() {\n  // @impl REQ-001\n}\n",
      "specs/spec.md": "# Fixture\n\n- REQ-001: signIn authenticates a user.\n",
    });
    // No trace shard at all — the graph has zero exercises edges.
    const { graph } = buildGraph(tmp, BASE_CONFIG);
    expect(graph.edges.some((e) => e.kind === "exercises")).toBe(false);

    const data = renderGraphData(graph, { rootDir: tmp, generatedAt: "2026-07-10T00:00:00Z" });
    const outputDir = track(mkdtempSync(join(tmpdir(), "artgraph-graph-serve-legend-out-")));
    await writeStaticExport({ data, outputDir });

    const html = readFileSync(join(outputDir, "index.html"), "utf-8");
    expect(html).toContain("exercises");
    expect(html).toMatch(/legend-swatch[^"]*edge-exercises/);
  });
});
