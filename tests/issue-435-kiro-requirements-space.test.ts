// issue #435 — Kiro `_Requirements:` entries resolve into the REQUIREMENT ID
// space, not the task ID space.
//
// Before this change a Kiro `tasks.md` line `- _Requirements: 1.1_` produced
// an edge whose target was the literal string `1.1`, which collides with the
// TASK numbering in the very same file: on a standard Kiro spec the edges came
// out as self-loops (`2.1 -> 2.1`) or pointed at nothing at all. The kiro
// preset now declares `verifiesTargetSpace: "requirement"` and the parser maps
// each capture onto `Requirement-<major>`.
//
// Every fixture here is built in an OS temp directory and torn down again:
// none of them may land under this repository's own `specDirs`
// (`["specs", "docs"]`), and none of them may be built through
// `buildGraph(REPO_ROOT, …)` (issues #427 / #439).
//
// Test IDs referenced from docs/configuration.md's upgrade note are the `it()`
// titles below, prefixed with the variant number they cover.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/builder.js";
import { impact, findOrphans } from "../src/graph/traverse.js";
import { check } from "../src/check.js";
import { parseMarkdownContent } from "../src/parsers/markdown.js";
import { loadConfig } from "../src/config.js";
import {
  kiroRequirementId,
  kiroRequirementIdFromTaskReference,
  isKiroRequirementId,
} from "../src/grammar/tokens.js";
import { runAt } from "./helpers.js";
import type { ArtgraphConfig, GraphNode, GraphEdge, LockFile } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A spec-kit `[<id>]` verifies tag, assembled at runtime.
 *
 * Deliberately NOT written as a literal: `src/parsers/typescript.ts` scans
 * every test file's raw text for `[<REQ-ID>]` and turns each hit into a
 * `test -> verifies -> <id>` edge, so a bracketed Kiro/spec-kit ID written
 * out literally anywhere in this file — fixture string OR comment — would make
 * THIS file claim to verify a requirement that does not exist in this
 * repository: a self-inflicted orphan in artgraph's own `check --diff` (issue
 * #427 / #439's dogfooding class).
 */
function br(id: string): string {
  return `[${id}]`;
}

/** A fresh temp project root. `files` are project-root-relative paths. */
function makeProject(files: Record<string, string>): string {
  const root = mkdtempSync(resolve(tmpdir(), "artgraph-435-"));
  tempDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = resolve(root, rel);
    mkdirSync(resolve(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf-8");
  }
  return root;
}

const KIRO_CONFIG: ArtgraphConfig = {
  specDirs: [".kiro/specs"],
  include: ["src/**/*.ts"],
  testPatterns: ["tests/**/*.test.ts"],
  lockFile: ".trace.lock",
};

const EMPTY_LOCK: LockFile = {};

/** Task-tag `verifies` edges, sorted, as `source -> target` strings. */
function taskVerifies(edges: GraphEdge[]): string[] {
  return edges
    .filter((e) => e.kind === "verifies" && e.provenances.includes("task-tag"))
    .map((e) => `${e.source} -> ${e.target}`)
    .sort();
}

const AUTH_REQUIREMENTS = [
  "# Requirements",
  "",
  "### Requirement 1",
  "",
  "First requirement.",
  "",
  "### Requirement 2",
  "",
  "Second requirement.",
  "",
].join("\n");

const AUTH_TASKS = [
  "# Implementation Plan",
  "",
  "- [x] 1. Build the token module",
  "  - _Requirements: 1.1, 1.2_",
  "- [ ] 2.1 Build the session module",
  "  - _Requirements: 2.1_",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// The mapping itself (grammar SSOT)
// ---------------------------------------------------------------------------

describe("issue #435 — kiroRequirementIdFromTaskReference (value-domain table)", () => {
  it("maps a `_Requirements:` entry onto the requirement ID space at MAJOR grain", () => {
    // The full value-domain table from the Step 0-pre investigation. Every row
    // is a documented decision, not an accident:
    expect(kiroRequirementIdFromTaskReference("2")).toBe("Requirement-2");
    expect(kiroRequirementIdFromTaskReference("1.1")).toBe("Requirement-1");
    expect(kiroRequirementIdFromTaskReference("1.2")).toBe("Requirement-1");
    expect(kiroRequirementIdFromTaskReference("1.1.1")).toBe("Requirement-1");
    expect(kiroRequirementIdFromTaskReference("10.2")).toBe("Requirement-10");
    // Zero padding is NOT normalized — `01` and `1` stay distinct IDs.
    expect(kiroRequirementIdFromTaskReference("01")).toBe("Requirement-01");
    expect(kiroRequirementIdFromTaskReference("1.1")).not.toBe("Requirement-01");
    // Non-numeric major → unmappable; the caller keeps the raw capture.
    expect(kiroRequirementIdFromTaskReference("FR-001")).toBeNull();
    expect(kiroRequirementIdFromTaskReference(".5")).toBeNull();
    expect(kiroRequirementIdFromTaskReference("")).toBeNull();
  });

  it("is the single source of truth for the `Requirement-N` spelling", () => {
    expect(kiroRequirementId("3")).toBe("Requirement-3");
    expect(kiroRequirementIdFromTaskReference("3.9")).toBe(kiroRequirementId("3"));
    expect(isKiroRequirementId("Requirement-3")).toBe(true);
    expect(isKiroRequirementId("auth/Requirement-3")).toBe(true);
    expect(isKiroRequirementId("FR-001")).toBe(false);
    expect(isKiroRequirementId("Requirement-3x")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ① standard Kiro
// ---------------------------------------------------------------------------

describe("issue #435 ① standard Kiro spec", () => {
  it("resolves every `_Requirements:` entry to a req node — no self-loops, no dangling", () => {
    const root = makeProject({
      ".kiro/specs/auth/requirements.md": AUTH_REQUIREMENTS,
      ".kiro/specs/auth/tasks.md": AUTH_TASKS,
      "src/token.ts": "// @impl Requirement-1\nexport const token = 1;\n",
    });
    const { graph } = buildGraph(root, KIRO_CONFIG);

    // `1.1` and `1.2` collapse onto Requirement-1 and dedup to ONE edge.
    expect(taskVerifies(graph.edges)).toEqual(["1 -> Requirement-1", "2.1 -> Requirement-2"]);
    for (const e of graph.edges.filter((x) => x.kind === "verifies")) {
      expect(e.source).not.toBe(e.target);
      expect(graph.nodes.get(e.target)?.kind).toBe("req");
    }
  });

  it("REGRESSION PIN: task-tag verifies edges never enter coverage / uncovered / orphans", () => {
    // The Step 0-pre "measured NEGATIVE": `src/coverage.ts` drops `verifies`
    // whose source is a task, so a Kiro project's `check` output must be
    // exactly what it would be if the `_Requirements:` lines did not exist.
    // Asserted here by building the SAME project twice, with and without
    // those lines, and comparing everything `check` reports.
    const withRefs = makeProject({
      ".kiro/specs/auth/requirements.md": AUTH_REQUIREMENTS,
      ".kiro/specs/auth/tasks.md": AUTH_TASKS,
      "src/token.ts": "// @impl Requirement-1\nexport const token = 1;\n",
    });
    const withoutRefs = makeProject({
      ".kiro/specs/auth/requirements.md": AUTH_REQUIREMENTS,
      ".kiro/specs/auth/tasks.md": AUTH_TASKS.split("\n")
        .filter((l) => !l.includes("_Requirements:"))
        .join("\n"),
      "src/token.ts": "// @impl Requirement-1\nexport const token = 1;\n",
    });

    const a = check(buildGraph(withRefs, KIRO_CONFIG).graph, EMPTY_LOCK);
    const b = check(buildGraph(withoutRefs, KIRO_CONFIG).graph, EMPTY_LOCK);

    expect(a.coverage).toEqual(b.coverage);
    expect(a.uncovered).toEqual(b.uncovered);
    expect(a.orphans).toEqual(b.orphans);
    expect(a.drifted).toEqual(b.drifted);
    expect(a.pass).toEqual(b.pass);
    // …and the values themselves, so a future change that makes BOTH sides
    // wrong in the same way still fails.
    expect(a.coverage).toEqual([
      { reqId: "Requirement-1", status: "impl-only" },
      { reqId: "Requirement-2", status: "untagged" },
    ]);
    expect(a.uncovered).toEqual(["Requirement-2"]);
    expect(a.orphans).toEqual([]);
  });

  it("REGRESSION PIN: `reconcile` writes the same lock entries with and without `_Requirements:`", async () => {
    const mk = (tasks: string) =>
      makeProject({
        ".artgraph.json": JSON.stringify(KIRO_CONFIG),
        ".kiro/specs/auth/requirements.md": AUTH_REQUIREMENTS,
        ".kiro/specs/auth/tasks.md": tasks,
        "src/token.ts": "// @impl Requirement-1\nexport const token = 1;\n",
      });
    const withRefs = mk(AUTH_TASKS);
    const withoutRefs = mk(
      AUTH_TASKS.split("\n")
        .filter((l) => !l.includes("_Requirements:"))
        .join("\n"),
    );
    for (const root of [withRefs, withoutRefs]) {
      const r = await runAt(root, ["reconcile"]);
      expect(r.exitCode).toBe(0);
    }
    const read = (root: string) =>
      JSON.parse(
        readFileSync(resolve(root, ".trace.lock"), "utf-8").replace(
          /"lastReconciled": "[^"]*"/g,
          '"lastReconciled": "<TS>"',
        ),
      ) as Record<string, unknown>;
    const a = read(withRefs);
    const b = read(withoutRefs);

    // Same key set, and no key is a task id — `src/lock.ts` locks req/doc/
    // symbol only, so #435's new req-space targets cannot mint lock entries.
    expect(Object.keys(a).sort()).toEqual([
      "Requirement-1",
      "Requirement-2",
      "_meta",
      "doc:auth/requirements.md",
      "doc:auth/tasks.md",
    ]);
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    // Every non-`doc:` entry is identical. The two `doc:auth/tasks.md` hashes
    // MUST differ (the files differ by the `_Requirements:` lines themselves)
    // — that is `LOW-1`'s "the acceptance-criterion grain survives at doc
    // grain" and is asserted, not tolerated.
    for (const key of Object.keys(a)) {
      if (key.startsWith("doc:")) continue;
      expect(a[key]).toEqual(b[key]);
    }
    expect((a["doc:auth/requirements.md"] as { contentHash: string }).contentHash).toBe(
      (b["doc:auth/requirements.md"] as { contentHash: string }).contentHash,
    );
    expect((a["doc:auth/tasks.md"] as { contentHash: string }).contentHash).not.toBe(
      (b["doc:auth/tasks.md"] as { contentHash: string }).contentHash,
    );
    // The requirement entries carry no task-sourced evidence.
    expect(a["Requirement-1"]).toEqual({
      contentHash: expect.any(String),
      lastReconciled: "<TS>",
      specFile: ".kiro/specs/auth/requirements.md",
      impl: ["file:src/token.ts"],
    });
  });
});

// ---------------------------------------------------------------------------
// ② `### 要件 N` — the issue #431 population
// ---------------------------------------------------------------------------

describe("issue #435 ② `### 要件 N` headings (issue #431 population)", () => {
  it("is a complete NO-OP and completely SILENT while #431 is open", () => {
    // `KIRO_HEADING_RE` does not match `### 要件 1`, so no req node is minted
    // and the mapped targets have nothing to land on. `findOrphans` skips
    // task-source edges unconditionally, so nothing is reported anywhere —
    // this test pins that silence deliberately, so the day #415 changes it
    // this assertion is what tells you.
    const root = makeProject({
      ".kiro/specs/auth/requirements.md": [
        "# 要件定義",
        "",
        "### 要件 1",
        "",
        "ユーザーはログインできる。",
        "",
        "### 要件 2",
        "",
        "ユーザーはログアウトできる。",
        "",
      ].join("\n"),
      ".kiro/specs/auth/tasks.md": AUTH_TASKS,
      "src/token.ts": "export const token = 1;\n",
    });
    const { graph, warnings } = buildGraph(root, KIRO_CONFIG);

    expect([...graph.nodes.values()].filter((n) => n.kind === "req")).toEqual([]);
    expect(taskVerifies(graph.edges)).toEqual(["1 -> Requirement-1", "2.1 -> Requirement-2"]);
    for (const e of graph.edges.filter((x) => x.kind === "verifies")) {
      expect(graph.nodes.has(e.target)).toBe(false);
    }
    // Silent: no orphans, no warnings, and `check` reports nothing at all.
    expect(findOrphans(graph)).toEqual([]);
    expect(warnings).toEqual([]);
    const result = check(graph, EMPTY_LOCK);
    expect(result.orphans).toEqual([]);
    expect(result.coverage).toEqual([]);
    expect(result.uncovered).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ③ two spec dirs — directory scoping comes from the existing resolver
// ---------------------------------------------------------------------------

describe("issue #435 ③ two spec dirs with colliding requirement numbers", () => {
  it("qualifies each task reference with its OWN spec dir (no new scoping code)", () => {
    // `src/graph/builder.ts` already routes task-emitted edges through
    // `resolveAnnotationTarget(target, req.specDir, …)`, which prefers a
    // same-directory match. #435 adds no scoping logic of its own; this test
    // pins that the existing mechanism covers it.
    const files: Record<string, string> = {
      "src/a.ts": "// @impl auth/Requirement-1\nexport const a = 1;\n",
    };
    for (const dir of ["auth", "billing"]) {
      files[`.kiro/specs/${dir}/requirements.md`] = AUTH_REQUIREMENTS;
      files[`.kiro/specs/${dir}/tasks.md`] = AUTH_TASKS;
    }
    const root = makeProject(files);
    const { graph, warnings } = buildGraph(root, KIRO_CONFIG);

    expect(taskVerifies(graph.edges)).toEqual([
      "auth/1 -> auth/Requirement-1",
      "auth/2.1 -> auth/Requirement-2",
      "billing/1 -> billing/Requirement-1",
      "billing/2.1 -> billing/Requirement-2",
    ]);
    expect(warnings.filter((w) => w.type === "ambiguous-id")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ④ a tasks.md whose directory has no requirements.md
// ---------------------------------------------------------------------------

describe("issue #435 ④ tasks.md in a directory without requirements.md", () => {
  it("drops the edge and reports `ambiguous-id` (fail-loud, accepted)", () => {
    const root = makeProject({
      ".kiro/specs/auth/requirements.md": AUTH_REQUIREMENTS,
      ".kiro/specs/billing/requirements.md": AUTH_REQUIREMENTS,
      ".kiro/specs/plan/tasks.md": [
        "# Cross-cutting plan",
        "",
        "- [x] 1. cross-cutting work",
        "  - _Requirements: 1.1_",
        "",
      ].join("\n"),
      "src/a.ts": "export const a = 1;\n",
    });
    const { graph, warnings } = buildGraph(root, KIRO_CONFIG);

    expect(taskVerifies(graph.edges)).toEqual([]);
    expect(warnings.filter((w) => w.type === "ambiguous-id")).toEqual([
      { type: "ambiguous-id", id: "Requirement-1", files: ["auth", "billing"] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// ⑤ the docs `kiro-no-checkbox` recipe
// ---------------------------------------------------------------------------

const NO_CHECKBOX_PRESET = {
  name: "kiro-no-checkbox",
  fileStems: ["tasks"],
  taskIdRe: "^(\\d+|\\d+\\.\\d+|\\d+\\.\\d+\\.\\d+)\\.?[\\s\\u00A0]",
  verifiesTagRe: "(?<=Requirements:[\\s\\d.,]*)(\\d+\\.\\d+|\\d+)",
};

const MIXED_TASKS = [
  "# Implementation Plan",
  "",
  "- 1 no checkbox task",
  "  - _Requirements: 1.1_",
  "- [x] 2.1 checkbox task",
  "  - _Requirements: 2.1_",
  "",
].join("\n");

describe("issue #435 ⑤ the docs `kiro-no-checkbox` recipe", () => {
  it("WITHOUT `verifiesTargetSpace` the two presets disagree inside one file", () => {
    // This is the shape docs/configuration.md shipped before #435 — kept as a
    // test so the docs' own warning ("add verifiesTargetSpace") stays true.
    const root = makeProject({
      ".kiro/specs/auth/requirements.md": AUTH_REQUIREMENTS,
      ".kiro/specs/auth/tasks.md": MIXED_TASKS,
      "src/a.ts": "export const a = 1;\n",
    });
    const { graph } = buildGraph(root, {
      ...KIRO_CONFIG,
      taskConventions: [NO_CHECKBOX_PRESET],
    });
    expect(taskVerifies(graph.edges)).toEqual([
      "1 -> 1.1", // user preset — still the task ID space
      "2.1 -> Requirement-2", // built-in kiro — requirement space
    ]);
  });

  it('WITH `verifiesTargetSpace: "requirement"` both presets agree', () => {
    const root = makeProject({
      ".kiro/specs/auth/requirements.md": AUTH_REQUIREMENTS,
      ".kiro/specs/auth/tasks.md": MIXED_TASKS,
      "src/a.ts": "export const a = 1;\n",
    });
    const { graph } = buildGraph(root, {
      ...KIRO_CONFIG,
      taskConventions: [{ ...NO_CHECKBOX_PRESET, verifiesTargetSpace: "requirement" }],
    });
    expect(taskVerifies(graph.edges)).toEqual(["1 -> Requirement-1", "2.1 -> Requirement-2"]);
  });

  it("`loadConfig` accepts the updated recipe and rejects a bad `verifiesTargetSpace`", () => {
    const ok = makeProject({
      ".artgraph.json": JSON.stringify({
        ...KIRO_CONFIG,
        taskConventions: [{ ...NO_CHECKBOX_PRESET, verifiesTargetSpace: "requirement" }],
      }),
    });
    expect(loadConfig(ok).taskConventions?.[0].verifiesTargetSpace).toBe("requirement");

    for (const bad of ["req", "", "Requirement", 1, true, null]) {
      const root = makeProject({
        ".artgraph.json": JSON.stringify({
          ...KIRO_CONFIG,
          taskConventions: [{ ...NO_CHECKBOX_PRESET, verifiesTargetSpace: bad }],
        }),
      });
      expect(() => loadConfig(root)).toThrow(/verifiesTargetSpace: must be one of/);
    }

    // Absent is valid and means `"task"` (backward compatibility).
    const legacy = makeProject({
      ".artgraph.json": JSON.stringify({ ...KIRO_CONFIG, taskConventions: [NO_CHECKBOX_PRESET] }),
    });
    expect(loadConfig(legacy).taskConventions?.[0].verifiesTargetSpace).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ⑥ zero padding / three levels / hierarchical requirement numbers
// ---------------------------------------------------------------------------

describe("issue #435 ⑥ numeric variants (zero padding, 3 levels, hierarchical)", () => {
  it("pins which variants resolve and which are left dangling and silent", () => {
    const root = makeProject({
      ".kiro/specs/auth/requirements.md": [
        "# Requirements",
        "",
        "### Requirement 01",
        "",
        "Zero padded.",
        "",
        "### Requirement 0.1",
        "",
        "Hierarchical — issue #431, NOT a req node.",
        "",
        "### Requirement 10",
        "",
        "Two digit.",
        "",
        "### Requirement 2",
        "",
        "Plain.",
        "",
      ].join("\n"),
      ".kiro/specs/auth/tasks.md": [
        "# Implementation Plan",
        "",
        "- [x] 1. zero padded ref",
        "  - _Requirements: 1.1_",
        "- [x] 2. hierarchical ref",
        "  - _Requirements: 0.1_",
        "- [x] 3. two digit ref",
        "  - _Requirements: 10.2_",
        "- [x] 4. three level ref",
        "  - _Requirements: 2.1.1_",
        "- [x] 5. bare major ref",
        "  - _Requirements: 2_",
        "- [x] 6. two criteria of one requirement",
        "  - _Requirements: 2.1, 2.2_",
        "",
      ].join("\n"),
      "src/a.ts": "export const a = 1;\n",
    });
    const { graph } = buildGraph(root, KIRO_CONFIG);

    expect(
      [...graph.nodes.values()]
        .filter((n) => n.kind === "req")
        .map((n) => n.id)
        .sort(),
    ).toEqual(["Requirement-01", "Requirement-10", "Requirement-2"]);
    // Six tasks, six references, but task 6's two criteria dedup to one edge.
    expect(taskVerifies(graph.edges)).toEqual([
      "1 -> Requirement-1", // `### Requirement 01` is NOT normalized → dangles
      "2 -> Requirement-0", // `### Requirement 0.1` is not a req node (#431)
      "3 -> Requirement-10",
      "4 -> Requirement-2", // 3-level `2.1.1` → major grain
      "5 -> Requirement-2",
      "6 -> Requirement-2",
    ]);
    const dangling = graph.edges
      .filter((e) => e.kind === "verifies" && !graph.nodes.has(e.target))
      .map((e) => e.target)
      .sort();
    expect(dangling).toEqual(["Requirement-0", "Requirement-1"]);
    // …and both of them are silent (issue #415's population, which #435 grows).
    expect(findOrphans(graph)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ⑦ spec-kit identity
// ---------------------------------------------------------------------------

describe("issue #435 ⑦ the spec-kit preset is byte-for-byte unchanged", () => {
  it("emits every capture verbatim — including a Kiro-shaped bracket", () => {
    const content = [
      "# Tasks",
      "",
      `- [x] T001 build the thing @impl(FR-001) ${br("REQ-FR-001")}`,
      `- [ ] T002 verify the thing ${br("FR-002")}`,
      `- [ ] T003 kiro-shaped bracket ${br("Requirement-3")}`,
      `- [ ] T004 namespaced ${br("auth/FR-7")}`,
      "",
    ].join("\n");
    const result = parseMarkdownContent(content, "specs/001/tasks.md");
    expect(
      result.edges
        .filter((e) => e.kind === "verifies")
        .map((e) => `${e.source} -> ${e.target}`)
        .sort(),
    ).toEqual([
      "T001 -> REQ-FR-001",
      "T002 -> FR-002",
      "T003 -> Requirement-3",
      "T004 -> auth/FR-7",
    ]);
    expect(
      result.edges.filter((e) => e.kind === "implements").map((e) => `${e.source} -> ${e.target}`),
    ).toEqual(["T001 -> FR-001"]);
  });

  it("a preset with no `verifiesTargetSpace` keeps numeric captures in the task ID space", () => {
    // The default really is `"task"`, not "whatever kiro does": a user preset
    // that captures the same `\d+.\d+` shape must be untouched by #435.
    const content = ["# Tasks", "", "- OS-1 do it", "  - Requirements: 1.1", ""].join("\n");
    const result = parseMarkdownContent(content, "specs/001/tasks.md", {
      taskConventions: [
        {
          name: "openspec",
          fileStems: ["tasks"],
          taskIdRe: "^(OS-\\d+)\\b",
          verifiesTagRe: "(?<=Requirements:[\\s\\d.,]*)(\\d+\\.\\d+|\\d+)",
        },
      ],
    });
    expect(
      result.edges.filter((e) => e.kind === "verifies").map((e) => `${e.source} -> ${e.target}`),
    ).toEqual(["OS-1 -> 1.1"]);
  });
});

// ---------------------------------------------------------------------------
// ⑧ the task hub (D1-a: reverse `verifies` onto a task node is `restricted`)
// ---------------------------------------------------------------------------

function n(id: string, kind: GraphNode["kind"], filePath: string): GraphNode {
  return { id, kind, filePath, contentHash: "h" };
}

/**
 * A daisy chain: req1..req4, task1..task3, each task verifying two adjacent
 * requirements, and `file:src/one.ts` implementing `Requirement-1` only.
 * `claimed` lists extra requirements given their own `implements` edge.
 */
function daisyChain(claimed: string[] = []) {
  const nodes = new Map<string, GraphNode>();
  for (let i = 1; i <= 4; i++) {
    nodes.set(`Requirement-${i}`, n(`Requirement-${i}`, "req", ".kiro/specs/auth/requirements.md"));
  }
  for (let i = 1; i <= 3; i++) {
    nodes.set(`${i}`, n(`${i}`, "task", ".kiro/specs/auth/tasks.md"));
  }
  nodes.set("file:src/one.ts", n("file:src/one.ts", "file", "src/one.ts"));
  for (const c of claimed)
    nodes.set(`file:src/${c}.ts`, n(`file:src/${c}.ts`, "file", `src/${c}.ts`));

  const edges: GraphEdge[] = [
    {
      source: "file:src/one.ts",
      target: "Requirement-1",
      kind: "implements",
      provenances: ["code-tag"],
    },
  ];
  for (let i = 1; i <= 3; i++) {
    edges.push({
      source: `${i}`,
      target: `Requirement-${i}`,
      kind: "verifies",
      provenances: ["task-tag"],
    });
    edges.push({
      source: `${i}`,
      target: `Requirement-${i + 1}`,
      kind: "verifies",
      provenances: ["task-tag"],
    });
  }
  for (const c of claimed) {
    edges.push({
      source: `file:src/${c}.ts`,
      target: c,
      kind: "implements",
      provenances: ["code-tag"],
    });
  }
  return { nodes, edges };
}

describe("issue #435 ⑧ task hub daisy-chain", () => {
  it("a task hub does NOT pass reach on to a third requirement (reach stops one hop out)", () => {
    // Without the `"restricted"` arrival this walks
    // Requirement-1 -> task 1 -> Requirement-2 -> task 2 -> Requirement-3 -> …
    // and collapses the whole spec directory into one impact set.
    const result = impact(daisyChain(), ["file:src/one.ts"], EMPTY_LOCK);
    expect(result.impactReqs.sort()).toEqual(["Requirement-1", "Requirement-2"]);
    expect(result.affectedTasks).toEqual(["1"]);
  });

  it("a sibling requirement that already has its own `@impl` is excluded entirely (#303 R3a)", () => {
    const result = impact(daisyChain(["Requirement-2"]), ["file:src/one.ts"], EMPTY_LOCK);
    expect(result.impactReqs).toEqual(["Requirement-1"]);
    expect(result.affectedTasks).toEqual(["1"]);
  });

  it("does not change reach for a TEST hub (the #303 mechanism is reused, not redefined)", () => {
    const nodes = new Map<string, GraphNode>([
      ["REQ-1", n("REQ-1", "req", "specs/x.md")],
      ["REQ-2", n("REQ-2", "req", "specs/x.md")],
      ["file:src/a.ts", n("file:src/a.ts", "file", "src/a.ts")],
      ["file:tests/a.test.ts", n("file:tests/a.test.ts", "test", "tests/a.test.ts")],
    ]);
    const edges: GraphEdge[] = [
      { source: "file:src/a.ts", target: "REQ-1", kind: "implements", provenances: ["code-tag"] },
      {
        source: "file:tests/a.test.ts",
        target: "REQ-1",
        kind: "verifies",
        provenances: ["code-tag"],
      },
      {
        source: "file:tests/a.test.ts",
        target: "REQ-2",
        kind: "verifies",
        provenances: ["code-tag"],
      },
    ];
    const result = impact({ nodes, edges }, ["file:src/a.ts"], EMPTY_LOCK);
    expect(result.impactReqs.sort()).toEqual(["REQ-1", "REQ-2"]);
  });
});

// ---------------------------------------------------------------------------
// D2 — `rename` is fail-loud about references it cannot rewrite
// ---------------------------------------------------------------------------

describe("issue #435 D2 — rename fail-loud on unrewritten `_Requirements:` references", () => {
  const renameProject = () =>
    makeProject({
      ".artgraph.json": JSON.stringify(KIRO_CONFIG),
      ".kiro/specs/auth/requirements.md": AUTH_REQUIREMENTS,
      ".kiro/specs/auth/tasks.md": AUTH_TASKS,
      "src/token.ts": "// @impl Requirement-1\nexport const token = 1;\n",
    });

  it("warns and exits 1 while still applying the rewrite (partial success)", async () => {
    const root = renameProject();
    const r = await runAt(root, ["rename", "--from", "Requirement-1", "--to", "Requirement-9"]);

    // Exit code is the signal; the output is printed in full first.
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("Renamed Requirement-1 → Requirement-9");
    expect(r.stdout).toContain("WARNING:");
    expect(r.stdout).toContain(".kiro/specs/auth/tasks.md");
    // The rewrite really happened — this is a partial success, not an abort.
    expect(readFileSync(resolve(root, ".kiro/specs/auth/requirements.md"), "utf-8")).toContain(
      "### Requirement 9",
    );
    expect(readFileSync(resolve(root, "src/token.ts"), "utf-8")).toContain("@impl Requirement-9");
    // …and the reference rename could not reach is untouched, as documented.
    expect(readFileSync(resolve(root, ".kiro/specs/auth/tasks.md"), "utf-8")).toContain(
      "_Requirements: 1.1, 1.2_",
    );
  });

  it("keeps the JSON shape unchanged — the warning rides in the existing `warnings` array", async () => {
    const root = renameProject();
    const r = await runAt(root, [
      "rename",
      "--from",
      "Requirement-1",
      "--to",
      "Requirement-9",
      "--dry-run",
      "--format",
      "json",
    ]);
    expect(r.exitCode).toBe(1);
    const payload = JSON.parse(r.stdout);
    expect(payload.operation).toBe("rename");
    expect(payload.applied).toBe(false);
    expect(payload.warnings).toEqual([
      {
        type: "unrewritten-task-requirement-ref",
        oldId: "Requirement-1",
        files: [".kiro/specs/auth/tasks.md"],
        message: expect.stringContaining("Requirement-1"),
      },
    ]);
  });

  it("stays silent (exit 0) for a requirement no task references", async () => {
    const root = makeProject({
      ".artgraph.json": JSON.stringify(KIRO_CONFIG),
      ".kiro/specs/auth/requirements.md": AUTH_REQUIREMENTS,
      ".kiro/specs/auth/tasks.md": AUTH_TASKS.split("\n")
        .filter((l) => !l.includes("_Requirements:"))
        .join("\n"),
      "src/token.ts": "// @impl Requirement-1\nexport const token = 1;\n",
    });
    const r = await runAt(root, ["rename", "--from", "Requirement-1", "--to", "Requirement-9"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain("WARNING:");
  });

  it("stays silent for a spec-kit project (IDs outside the Kiro requirement space)", async () => {
    const root = makeProject({
      ".artgraph.json": JSON.stringify({
        specDirs: ["kit-specs"],
        include: ["src/**/*.ts"],
        testPatterns: ["tests/**/*.test.ts"],
        lockFile: ".trace.lock",
      }),
      "kit-specs/001/spec.md": "# Feature\n\n- FR-001: first\n",
      "kit-specs/001/tasks.md": `# Tasks\n\n- [x] T001 build it ${br("FR-001")}\n`,
      "src/a.ts": "// @impl FR-001\nexport const a = 1;\n",
    });
    const r = await runAt(root, ["rename", "--from", "FR-001", "--to", "FR-009"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain("WARNING:");
  });

  it("only warns for IDs the operation REMOVES — a surviving `--into` target is not one", async () => {
    // `--merge Requirement-1,Requirement-2 --into Requirement-1`: only
    // Requirement-2 disappears, so only its references are stranded.
    const merged = await runAt(renameProject(), [
      "rename",
      "--merge",
      "Requirement-1",
      "Requirement-2",
      "--into",
      "Requirement-1",
      "--dry-run",
      "--format",
      "json",
    ]);
    expect(merged.exitCode).toBe(1);
    expect(
      JSON.parse(merged.stdout).warnings.filter(
        (w: { type: string }) => w.type === "unrewritten-task-requirement-ref",
      ),
    ).toEqual([
      {
        type: "unrewritten-task-requirement-ref",
        oldId: "Requirement-2",
        files: [".kiro/specs/auth/tasks.md"],
        message: expect.stringContaining("Requirement-2"),
      },
    ]);

    // `--split Requirement-1 --into Requirement-1,Requirement-3`: the source
    // ID survives, so nothing is stranded and the exit code stays 0.
    const split = await runAt(renameProject(), [
      "rename",
      "--split",
      "Requirement-1",
      "--into",
      "Requirement-1",
      "Requirement-3",
      "--dry-run",
      "--format",
      "json",
    ]);
    expect(split.exitCode).toBe(0);
    expect(
      JSON.parse(split.stdout).warnings.filter(
        (w: { type: string }) => w.type === "unrewritten-task-requirement-ref",
      ),
    ).toEqual([]);
  });
});
