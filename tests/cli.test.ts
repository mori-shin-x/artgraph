import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import {
  existsSync,
  readFileSync,
  unlinkSync,
  cpSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { run, runAt, cleanup, FIXTURE_DIR, LOCK_PATH, type RunResult } from "./helpers.js";

// E4 (issue #122 follow-up): build a temp repo with a fully-committed,
// clean working tree so `getGitDiffFiles` deterministically returns `[]`.
// The `--diff` smoke tests elsewhere in this file run against the enclosing
// artgraph repo checkout, whose git state is whatever the sandbox happens to
// have dirty — fine for "doesn't crash", useless for asserting the exact
// empty-diff JSON shape.
function makeCleanGitRepo(prefix: string): string {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(tmp, "src"), { recursive: true });
  writeFileSync(join(tmp, "src", "app.ts"), "export const x = 1;\n");
  execFileSync("git", ["init"], { cwd: tmp, stdio: "pipe" });
  execFileSync("git", ["add", "-A"], { cwd: tmp, stdio: "pipe" });
  execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@test.com", "commit", "-m", "init"],
    { cwd: tmp, stdio: "pipe" },
  );
  return tmp;
}

afterEach(cleanup);

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------
describe("CLI: scan", () => {
  it("should output graph summary as JSON", { timeout: 30000 }, async () => {
    const { stdout, exitCode } = await run(["scan", "--format", "json"]);
    expect(exitCode).toBe(0);

    const result = JSON.parse(stdout);
    expect(result.nodeCount).toBeGreaterThan(0);
    expect(result.edgeCount).toBeGreaterThan(0);
    expect(result.reqCount).toBeGreaterThanOrEqual(2);
  });

  it("should output human-readable text by default", { timeout: 30000 }, async () => {
    const { stdout, exitCode } = await run(["scan"]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Nodes:\s+[1-9]/);
    expect(stdout).toMatch(/Edges:\s+[1-9]/);
    expect(stdout).toContain("req:");
    expect(stdout).toContain("file:");
  });

  it("should output text with --format text", { timeout: 30000 }, async () => {
    const { stdout, exitCode } = await run(["scan", "--format", "text"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Nodes:");
    expect(stdout).toContain("Edges:");
  });

  it("JSON output includes taskCount (Issue #28 / H3)", { timeout: 30000 }, async () => {
    const { stdout, exitCode } = await run(["scan", "--format", "json"]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    // taskCount must be present even when 0 — otherwise downstream parsers
    // can't tell "no tasks" from "old artgraph that didn't know about tasks".
    expect(result).toHaveProperty("taskCount");
    expect(typeof result.taskCount).toBe("number");
  });

  it("text output adds `task:` column when taskCount > 0 (H3)", { timeout: 30000 }, async () => {
    const taskFixture = resolve(FIXTURE_DIR, "tasks/speckit-plan");
    const { stdout, exitCode } = await runAt(taskFixture, ["scan"]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/task:\s+[1-9]/);
  });
});

// ---------------------------------------------------------------------------
// impact
//
// Spec 014 made `impact` file-only: REQ-ID / `doc:` prefix inputs are now
// rejected by the CLI (covered by tests/impact-cli.test.ts). The remaining
// smoke tests here use real file paths so they exercise the same code paths
// the user will actually hit.
// ---------------------------------------------------------------------------
describe("CLI: impact", () => {
  it("should show impact for a file path", { timeout: 30000 }, async () => {
    const { stdout, exitCode } = await run(["impact", "src/auth/login.ts", "--format", "json"]);
    expect(exitCode).toBe(0);

    const result = JSON.parse(stdout);
    // spec 016 INV-S7: `affectedReqs` was renamed to `impactReqs`.
    expect(result.impactReqs).toContain("AUTH-001");
    // spec 016 INV-S6: `originReqs` axis is always present (possibly empty).
    expect(Array.isArray(result.originReqs)).toBe(true);
  });

  it("should output human-readable text by default (file input)", { timeout: 30000 }, async () => {
    const { stdout, exitCode } = await run(["impact", "src/auth/login.ts"]);
    expect(exitCode).toBe(0);
    // spec 016 FR-023: text header is "Impact reqs:" + "Origin reqs ..."
    expect(stdout).toContain("Impact reqs:");
    expect(stdout).toContain("AUTH-001");
    expect(stdout).toContain("Origin reqs (@impl claims):");
  });

  it("should show impact for multiple file targets", { timeout: 30000 }, async () => {
    const { stdout, exitCode } = await run([
      "impact",
      "src/auth/login.ts",
      "src/auth/session.ts",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(0);

    const result = JSON.parse(stdout);
    expect(result.impactReqs).toContain("AUTH-001");
    expect(result.affectedFiles.length).toBeGreaterThan(0);
  });

  it("should fail when no start source is given", { timeout: 30000 }, async () => {
    const { exitCode, stderr } = await run(["impact"]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/no start source|no.*target/i);
  });

  it("should fail when target file is not in the graph", { timeout: 30000 }, async () => {
    const { exitCode, stderr } = await run(["impact", "src/does/not/exist.ts"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("No matching nodes found");
  });

  // Smoke test: --diff depends on real git state so the result is non-deterministic.
  // A proper test would need a temporary git repo with a controlled diff.
  it("should not crash with --diff flag", { timeout: 30000 }, async () => {
    const { exitCode } = await run(["impact", "--diff"]);
    expect([0, 1]).toContain(exitCode);
  });

  // E4: pre-existing bug (not introduced by this PR) — `impact --diff
  // --format json` on a clean working tree used to always print the plain
  // text "No changes detected in git diff." and exit 0, ignoring
  // `--format json` entirely. A JSON consumer (e.g. a CI script piping into
  // `jq`) would fail to parse that. Fixed to emit an all-empty
  // `ImpactResult`-shaped payload plus a `message` field.
  it(
    "emits valid ImpactResult-shaped JSON for `impact --diff --format json` with an empty git diff (E4)",
    { timeout: 30000 },
    async () => {
      const tmp = makeCleanGitRepo("artgraph-impact-diff-empty-");
      try {
        const { stdout, exitCode } = await runAt(tmp, ["impact", "--diff", "--format", "json"]);
        expect(exitCode).toBe(0);
        const result = JSON.parse(stdout);
        expect(result.affectedFiles).toEqual([]);
        expect(result.impactReqs).toEqual([]);
        expect(result.summary).toEqual({ docs: 0, reqs: 0, files: 0, tasks: 0 });
        expect(result.message).toContain("No changes detected in git diff.");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------
describe("CLI: check", () => {
  it("should exit 2 with --gate when issues exist", { timeout: 30000 }, async () => {
    cleanup();
    const { exitCode } = await run(["check", "--gate"]);
    expect(exitCode).toBe(2);
  });

  it("should report issues in JSON format", { timeout: 30000 }, async () => {
    cleanup();
    const { stdout } = await run(["check", "--format", "json"]);
    const result = JSON.parse(stdout);

    expect(result.uncovered.length).toBeGreaterThan(0);
  });

  it("should output human-readable text by default", { timeout: 30000 }, async () => {
    cleanup();
    const { stdout } = await run(["check"]);
    // Without a lock file, there will be uncovered items.
    expect(stdout).toContain("UNCOVERED:");
    expect(stdout).toContain("COVERAGE:");
  });

  // Smoke test: --diff depends on real git state so the result is non-deterministic.
  // A proper test would need a temporary git repo with a controlled diff.
  it("should not crash with --diff flag", { timeout: 30000 }, async () => {
    cleanup();
    const { exitCode } = await run(["check", "--diff"]);
    // Without --gate, check never calls process.exit(2).
    expect(exitCode).toBe(0);
  });

  // E4: same pre-existing bug as `impact --diff --format json` (not
  // introduced by this PR) — `check --diff --format json` on a clean
  // working tree ignored `--format json` and always printed plain text.
  // Fixed to emit an all-clear `CheckResult`-shaped payload plus `warnings`
  // and a `message` field.
  it(
    "emits valid CheckResult-shaped JSON for `check --diff --format json` with an empty git diff (E4)",
    { timeout: 30000 },
    async () => {
      const tmp = makeCleanGitRepo("artgraph-check-diff-empty-");
      try {
        const { stdout, exitCode } = await runAt(tmp, ["check", "--diff", "--format", "json"]);
        expect(exitCode).toBe(0);
        const result = JSON.parse(stdout);
        expect(result.drifted).toEqual([]);
        expect(result.orphans).toEqual([]);
        expect(result.uncovered).toEqual([]);
        expect(result.pass).toBe(true);
        expect(Array.isArray(result.warnings)).toBe(true);
        expect(result.message).toContain("No changes detected in git diff.");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});

// ---------------------------------------------------------------------------
// reconcile
// ---------------------------------------------------------------------------
describe("CLI: reconcile", () => {
  it("should create a lock file after reconcile", { timeout: 30000 }, async () => {
    cleanup();
    const { exitCode, stdout } = await run(["reconcile"]);
    expect(exitCode).toBe(0);
    expect(existsSync(LOCK_PATH)).toBe(true);
    expect(stdout).toContain("Lock file updated");
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// reconcile -> check scenario (no drift expected)
// ---------------------------------------------------------------------------
describe("CLI: reconcile then check (no drift)", () => {
  it("should have no drift immediately after reconcile", { timeout: 30000 }, async () => {
    cleanup();

    // Step 1: reconcile to create a fresh lock.
    const rec = await run(["reconcile"]);
    expect(rec.exitCode).toBe(0);
    expect(existsSync(LOCK_PATH)).toBe(true);

    // Step 2: check should report zero drift and zero orphans.
    // Note: pass may still be false due to uncovered REQs in the fixture
    // (AUTH-003 has no @impl), but drift should be empty.
    const chk = await run(["check", "--format", "json"]);
    expect(chk.exitCode).toBe(0);

    const result = JSON.parse(chk.stdout);
    expect(result.drifted).toEqual([]);
    expect(result.orphans).toEqual([]);
    // AUTH-003 has no @impl, so pass is false and uncovered contains it.
    expect(result.pass).toBe(false);
    expect(result.uncovered).toContain("AUTH-003");
  });

  it("should include coverage information after reconcile", { timeout: 30000 }, async () => {
    cleanup();

    const rec = await run(["reconcile"]);
    expect(rec.exitCode).toBe(0);

    const chk = await run(["check", "--format", "json"]);
    expect(chk.exitCode).toBe(0);

    const result = JSON.parse(chk.stdout);
    expect(result.coverage.length).toBeGreaterThan(0);

    // AUTH-001 should be verified (has both impl and test).
    const req7f3a = result.coverage.find((c: any) => c.reqId === "AUTH-001");
    expect(req7f3a).toEqual(expect.objectContaining({ status: "verified" }));

    cleanup();
  });

  it("should show COVERAGE in text output after reconcile", { timeout: 30000 }, async () => {
    cleanup();

    const rec = await run(["reconcile"]);
    expect(rec.exitCode).toBe(0);

    const chk = await run(["check"]);
    expect(chk.exitCode).toBe(0);
    expect(chk.stdout).toContain("COVERAGE:");

    cleanup();
  });
});

// ---------------------------------------------------------------------------
// scan --format json graph payload (absorbed the old `graph` command)
// ---------------------------------------------------------------------------
describe("CLI: scan graph payload", () => {
  it(
    "should include nodes and edges arrays alongside the count summary",
    { timeout: 30000 },
    async () => {
      const { stdout, exitCode } = await run(["scan", "--format", "json"]);
      expect(exitCode).toBe(0);

      const parsed = JSON.parse(stdout);
      expect(Array.isArray(parsed.nodes)).toBe(true);
      expect(Array.isArray(parsed.edges)).toBe(true);
      expect(parsed.nodes.length).toBe(parsed.nodeCount);
      for (const node of parsed.nodes) {
        expect(node.id).toBeDefined();
        expect(node.kind).toBeDefined();
        expect(node.filePath).toBeDefined();
      }
      for (const edge of parsed.edges) {
        expect(edge.source).toBeDefined();
        expect(edge.target).toBeDefined();
        expect(edge.kind).toBeDefined();
      }
    },
  );

  it("text output stays a count summary without node/edge dumps", { timeout: 30000 }, async () => {
    const { stdout, exitCode } = await run(["scan"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Nodes:");
    expect(stdout).not.toContain("file:src/auth/login.ts");
  });

  // Wave 2 (issue #125): `--output <dir>` writes a static HTML export with the
  // rendered graph data embedded in a JSON script tag. Verifies both the
  // filesystem layout (index.html + app.js + vendor bundle) and the payload
  // shape so a regression in `renderGraphData` or the template injection
  // pipeline surfaces here rather than only in visual QA.
  it("T-graph-serve-1: --output writes a static HTML export with embedded data", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "artgraph-graph-output-"));
    try {
      const { exitCode, stderr } = await run(["scan", "--output", outDir]);
      expect(exitCode).toBe(0);
      expect(stderr).toContain("static export written to");

      const indexPath = join(outDir, "index.html");
      const appPath = join(outDir, "app.js");
      const vendorPath = join(outDir, "vendor", "cytoscape.min.js");
      expect(existsSync(indexPath)).toBe(true);
      expect(existsSync(appPath)).toBe(true);
      expect(existsSync(vendorPath)).toBe(true);

      const html = readFileSync(indexPath, "utf-8");
      // Payload lives inside `<script id="artgraph-data" type="application/json">…</script>`.
      // Extract that block and JSON.parse it — this catches both a missing
      // injection (payload still contains the `{{ARTGRAPH_DATA}}` placeholder)
      // and a malformed payload.
      const match = html.match(
        /<script id="artgraph-data" type="application\/json">([\s\S]*?)<\/script>/,
      );
      expect(match).not.toBeNull();
      const rawJson = match![1]!;
      const data = JSON.parse(rawJson);
      expect(Array.isArray(data.nodes)).toBe(true);
      expect(Array.isArray(data.edges)).toBe(true);
      expect(data.meta).toBeDefined();
      expect(data.meta.stats).toBeDefined();

      // `<` characters in the payload must be escaped so a payload containing
      // `</script>` can't break out of the script tag. The fixture always has
      // filePaths (`src/…`) with no `<`, but any label containing `<` would
      // appear as `<` — sanity-check the escape is applied whenever
      // a raw `<` sneaks in.
      if (rawJson.includes("\\u003c")) {
        expect(rawJson).not.toMatch(/<\/script>/);
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("T-graph-serve-2: --serve + --output errors out", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "artgraph-graph-both-"));
    try {
      const { exitCode, stderr } = await run(["scan", "--serve", "--output", outDir]);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/--serve.*--output.*cannot be combined/i);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  // issue #170 D1: --output used to overwrite whatever sat at index.html /
  // app.js / vendor/cytoscape.min.js without checking what else lived in the
  // directory. Pointing --output at the wrong dir (GitHub Pages' docs/, repo
  // root) could silently replace unrelated files.
  it("T-graph-serve-3: --output refuses a dir with unmanaged files, --force overrides", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "artgraph-graph-unmanaged-"));
    try {
      writeFileSync(join(outDir, "USER-IMPORTANT-INDEX.md"), "do not touch\n");

      const refused = await run(["scan", "--output", outDir]);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toMatch(/doesn't manage/);
      expect(refused.stderr).toContain("USER-IMPORTANT-INDEX.md");
      expect(refused.stderr).toMatch(/--force/);
      // Refusal must be fail-fast: no export files written alongside the
      // untouched user file.
      expect(existsSync(join(outDir, "index.html"))).toBe(false);
      expect(existsSync(join(outDir, "USER-IMPORTANT-INDEX.md"))).toBe(true);

      const forced = await run(["scan", "--output", outDir, "--force"]);
      expect(forced.exitCode).toBe(0);
      expect(existsSync(join(outDir, "index.html"))).toBe(true);
      // --force overwrites the managed export paths but must not delete
      // unrelated files sitting alongside them.
      expect(existsSync(join(outDir, "USER-IMPORTANT-INDEX.md"))).toBe(true);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  // issue #170 D2: a stale vendor/ file from a previous artgraph release (or
  // a differently-named vendor bundle) must not survive a re-export — the
  // vendor/ subdirectory is fully artgraph-owned and gets wiped + rewritten
  // on every --output run. `vendor` itself is a D1-managed top-level entry,
  // so this cleanup happens without needing --force — a CI pipe that reruns
  // `--output` on the same dir every build must not have to pass --force
  // just to keep vendor/ tidy.
  it("T-graph-serve-4: --output clears stale vendor/ artifacts on re-run, no --force needed", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "artgraph-graph-stale-vendor-"));
    try {
      mkdirSync(join(outDir, "vendor"), { recursive: true });
      writeFileSync(join(outDir, "vendor", "old-cytoscape.min.js"), "stale\n");

      const { exitCode } = await run(["scan", "--output", outDir]);
      expect(exitCode).toBe(0);
      expect(existsSync(join(outDir, "vendor", "cytoscape.min.js"))).toBe(true);
      expect(existsSync(join(outDir, "vendor", "old-cytoscape.min.js"))).toBe(false);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// impact text summary
// ---------------------------------------------------------------------------
describe("CLI: impact text summary", () => {
  it("T059: should show summary in text output", { timeout: 30000 }, async () => {
    const { stdout, exitCode } = await run(["impact", "src/auth/login.ts"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Summary:");
    expect(stdout).toMatch(/\d+ docs/);
    expect(stdout).toMatch(/\d+ reqs/);
    expect(stdout).toMatch(/\d+ files/);
  });
});

// ---------------------------------------------------------------------------
// impact: 3-stage dependency chain — now scoped to spec-file inputs
//
// Spec 014 dropped `doc:` prefix / bare doc-id positional inputs, but a
// caller can still pass the spec file path itself: resolveFileStartIds()
// drags in every doc / req node parsed out of that file via the
// `node.filePath === input` branch. We use the doc-chain fixture's
// `requirements.md` as the entry point so the traversal still reaches
// the downstream `design` / `tasks` docs through `derives_from`.
// ---------------------------------------------------------------------------
describe("CLI: impact spec-file traversal", () => {
  it(
    "should trace through full doc derives_from chain when started from a spec file path",
    { timeout: 30000 },
    async () => {
      const { stdout, exitCode } = await run([
        "impact",
        "specs/doc-chain/requirements.md",
        "--format",
        "json",
      ]);
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      expect(result.affectedDocs).toContain("requirements");
      expect(result.affectedDocs).toContain("design");
      const hasTasksDoc = result.affectedDocs.some((d: string) => d.includes("tasks"));
      expect(hasTasksDoc).toBe(true);
    },
  );

  it("should reach req from spec file via contains", { timeout: 30000 }, async () => {
    // specs/auth.md → doc:auth-design + AUTH-001/002/003 (filePath match).
    const { stdout, exitCode } = await run(["impact", "specs/auth.md", "--format", "json"]);
    expect(exitCode).toBe(0);

    const result = JSON.parse(stdout);
    expect(result.impactReqs).toContain("AUTH-001");
  });
});

// ---------------------------------------------------------------------------
// CLI warnings (orphan-doc, invalid-relation)
// ---------------------------------------------------------------------------
describe("CLI: warning output", () => {
  it("should output orphan-doc warning to stderr", { timeout: 30000 }, async () => {
    const { mkdirSync, writeFileSync, rmSync: rm } = require("node:fs");
    const { mkdtempSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");
    const tmpRoot = mkdtempSync(join(tmpdir(), "artgraph-warn-"));
    mkdirSync(join(tmpRoot, "specs"), { recursive: true });
    mkdirSync(join(tmpRoot, "src"), { recursive: true });
    writeFileSync(join(tmpRoot, "src", "app.ts"), "export const x = 1;\n");
    writeFileSync(
      join(tmpRoot, ".artgraph.json"),
      JSON.stringify({ include: ["src/**/*.ts"], specDirs: ["specs"] }),
    );
    writeFileSync(
      join(tmpRoot, "specs", "orphan.md"),
      `---\nartgraph:\n  node_id: "orphan-src"\n  derives_from:\n    - nonexistent-target\n---\n# Orphan\n`,
    );

    try {
      const proc = await runAt(tmpRoot, ["scan"]);
      expect(proc.exitCode).toBe(0);
      expect(proc.stderr).toContain("orphan-doc");
      expect(proc.stderr).toContain("nonexistent-target");
    } finally {
      rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("should output invalid-relation warning to stderr", { timeout: 30000 }, async () => {
    const { mkdirSync, writeFileSync, rmSync: rm } = require("node:fs");
    const { mkdtempSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");
    const tmpRoot = mkdtempSync(join(tmpdir(), "artgraph-warn-"));
    mkdirSync(join(tmpRoot, "specs"), { recursive: true });
    mkdirSync(join(tmpRoot, "src"), { recursive: true });
    writeFileSync(join(tmpRoot, "src", "app.ts"), "export const x = 1;\n");
    writeFileSync(
      join(tmpRoot, ".artgraph.json"),
      JSON.stringify({ include: ["src/**/*.ts"], specDirs: ["specs"] }),
    );
    writeFileSync(
      join(tmpRoot, "specs", "invalid.md"),
      `---\nartgraph:\n  node_id: "inv-src"\n  extends:\n    - some-doc\n---\n# Invalid\n`,
    );

    try {
      const proc = await runAt(tmpRoot, ["scan"]);
      expect(proc.exitCode).toBe(0);
      expect(proc.stderr).toContain("invalid relation");
      expect(proc.stderr).toContain("extends");
    } finally {
      rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it(
    "should output unresolved-link warning to stderr (issue #11)",
    { timeout: 30000 },
    async () => {
      const { mkdirSync, writeFileSync, rmSync: rm } = require("node:fs");
      const { mkdtempSync } = require("node:fs");
      const { tmpdir } = require("node:os");
      const { join } = require("node:path");
      const tmpRoot = mkdtempSync(join(tmpdir(), "artgraph-warn-"));
      mkdirSync(join(tmpRoot, "specs"), { recursive: true });
      mkdirSync(join(tmpRoot, "src"), { recursive: true });
      writeFileSync(join(tmpRoot, "src", "app.ts"), "export const x = 1;\n");
      writeFileSync(
        join(tmpRoot, ".artgraph.json"),
        JSON.stringify({ include: ["src/**/*.ts"], specDirs: ["specs"] }),
      );
      writeFileSync(
        join(tmpRoot, "specs", "dead.md"),
        `# Dead link\n\nSee [gone](./missing.md).\n`,
      );

      try {
        const proc = await runAt(tmpRoot, ["scan"]);
        expect(proc.exitCode).toBe(0);
        expect(proc.stderr).toContain("unresolved-link");
        expect(proc.stderr).toContain("specs/missing.md");
      } finally {
        rm(tmpRoot, { recursive: true, force: true });
      }
    },
  );

  it(
    "should build depends_on edge from inline markdown link (issue #11)",
    { timeout: 30000 },
    async () => {
      const { mkdirSync, writeFileSync, rmSync: rm } = require("node:fs");
      const { mkdtempSync } = require("node:fs");
      const { tmpdir } = require("node:os");
      const { join } = require("node:path");
      const tmpRoot = mkdtempSync(join(tmpdir(), "artgraph-il-"));
      mkdirSync(join(tmpRoot, "specs"), { recursive: true });
      mkdirSync(join(tmpRoot, "src"), { recursive: true });
      writeFileSync(join(tmpRoot, "src", "app.ts"), "export const x = 1;\n");
      writeFileSync(
        join(tmpRoot, ".artgraph.json"),
        JSON.stringify({ include: ["src/**/*.ts"], specDirs: ["specs"] }),
      );
      // Use non-convention stems (source/target rather than design/requirements)
      // so the kiro/spec-kit autoConventions inference does not pre-populate a
      // `derives_from` edge for this pair. A pre-existing convention edge would
      // be picked up by builder's `explicitPairs` set and suppress the inline
      // `depends_on` we are trying to assert here (intentional: a stronger
      // already-known relationship always wins over inline links).
      writeFileSync(
        join(tmpRoot, "specs", "source.md"),
        `# Source\n\nDerived from [target](./target.md).\n`,
      );
      writeFileSync(join(tmpRoot, "specs", "target.md"), `# Target\n`);

      try {
        const proc = await runAt(tmpRoot, ["scan", "--format", "json"]);
        expect(proc.exitCode).toBe(0);
        const out = JSON.parse(proc.stdout);
        const edge = out.edges.find(
          (e: any) =>
            e.kind === "depends_on" && e.source === "doc:source.md" && e.target === "doc:target.md",
        );
        expect(edge).toBeDefined();
      } finally {
        rm(tmpRoot, { recursive: true, force: true });
      }
    },
  );
});

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
describe("CLI: init", () => {
  let initTmp: string;

  function runInit(args: string[]): Promise<RunResult> {
    return runAt(initTmp, ["init", ...args]);
  }

  beforeEach(() => {
    const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");
    initTmp = mkdtempSync(join(tmpdir(), "artgraph-cli-init-"));
    mkdirSync(join(initTmp, "src"));
    writeFileSync(join(initTmp, "src", "app.ts"), "export const x = 1;\n");
  });

  afterEach(() => {
    const { rmSync } = require("node:fs");
    rmSync(initTmp, { recursive: true, force: true });
  });

  it("should create .artgraph.json and .trace.lock", { timeout: 30000 }, async () => {
    // spec 013: --agents=claude needed for the default Skills + agent-context
    // path; we keep the legacy single-Claude expectation here.
    const { exitCode, stdout } = await runInit(["--agents=claude"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Created .artgraph.json");
    expect(stdout).toContain("Created .trace.lock");
    expect(stdout).toContain("Nodes:");
  });

  // Issue #122: on a brownfield repo (TS files, no specs, no @impl), the
  // closing hint must NOT tell the user to run `artgraph check` — there's
  // nothing to check yet. Instead it must announce that `impact --diff`
  // already works off the import graph, and that tags are optional.
  it(
    "shows zero-tag onboarding hint when scan finds files but no reqs/docs (issue #122)",
    { timeout: 30000 },
    async () => {
      // spec 013: init requires --agents unless Skills/agent-context are opted
      // out. The zero-tag hint is orthogonal to those stages, so disable them.
      const { exitCode, stdout } = await runInit(["--no-skills", "--no-agent-context"]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Zero-tag ready");
      expect(stdout).toContain("artgraph impact --diff");
      expect(stdout).toContain("Tags are optional");
      // Regression guard: the classic "verify traceability" line must not
      // fire in the brownfield case — it's the misleading message we
      // replaced.
      expect(stdout).not.toContain("verify traceability");
    },
  );

  // Once req nodes exist the classic closing hint should come back — the
  // zero-tag branch is opt-in on empty scan summaries, not blanket.
  it(
    "keeps the classic 'verify traceability' hint once reqs are present",
    { timeout: 30000 },
    async () => {
      const { mkdirSync, writeFileSync } = require("node:fs");
      const { join } = require("node:path");
      mkdirSync(join(initTmp, "specs"), { recursive: true });
      writeFileSync(join(initTmp, "specs", "auth.md"), "- REQ-001: users can sign in.\n");
      const { exitCode, stdout } = await runInit(["--no-skills", "--no-agent-context"]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("verify traceability");
      expect(stdout).not.toContain("Zero-tag ready");
    },
  );

  // D2 (issue #122 follow-up): state-transition guard. `scanSummary` is
  // recomputed fresh on every `runInit` call — nothing is cached across a
  // `--force` rerun — so once specs are added to a previously zero-tag repo,
  // the closing hint must flip back to the classic one. This was a pure test
  // gap (the implementation already behaves correctly); this test just
  // closes it.
  it(
    "switches the closing hint from Zero-tag ready to classic once specs are added via init --force",
    { timeout: 30000 },
    async () => {
      const { mkdirSync, writeFileSync } = require("node:fs");
      const { join } = require("node:path");

      const first = await runInit(["--no-skills", "--no-agent-context"]);
      expect(first.exitCode).toBe(0);
      expect(first.stdout).toContain("Zero-tag ready");
      expect(first.stdout).not.toContain("verify traceability");

      mkdirSync(join(initTmp, "specs"), { recursive: true });
      writeFileSync(join(initTmp, "specs", "auth.md"), "- REQ-001: users can sign in.\n");

      const second = await runInit(["--force", "--no-skills", "--no-agent-context"]);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("verify traceability");
      expect(second.stdout).not.toContain("Zero-tag ready");
    },
  );

  it("should output JSON with --format json", { timeout: 30000 }, async () => {
    const { exitCode, stdout } = await runInit(["--agents=claude", "--format", "json"]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.configPath).toBeDefined();
    expect(result.scanSummary).toBeDefined();
    expect(result.scanSummary.nodeCount).toBeGreaterThanOrEqual(0);
    expect(result.warnings).toBeDefined();
  });

  it("should fail when .artgraph.json already exists", { timeout: 30000 }, async () => {
    const { writeFileSync } = require("node:fs");
    const { join } = require("node:path");
    writeFileSync(join(initTmp, ".artgraph.json"), "{}\n");

    const { exitCode, stderr } = await runInit(["--agents=claude"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("already exists");
  });

  it("should succeed with --force when .artgraph.json exists", { timeout: 30000 }, async () => {
    const { writeFileSync } = require("node:fs");
    const { join } = require("node:path");
    writeFileSync(join(initTmp, ".artgraph.json"), "{}\n");

    const { exitCode, stdout } = await runInit(["--agents=claude", "--force"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Created .artgraph.json");
  });

  it("should skip scan with --no-scan", { timeout: 30000 }, async () => {
    const { exitCode, stdout } = await runInit(["--agents=claude", "--no-scan"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("scan skipped");
    expect(stdout).not.toContain("Nodes:");
  });

  // spec 013 (FR-002 / SC-006): `init` without --agents fails fast with the
  // 3-corrective-option error UX before any disk write.
  it(
    "fails with the spec-013 3-option error when --agents is missing",
    { timeout: 30000 },
    async () => {
      const { existsSync } = require("node:fs");
      const { join } = require("node:path");
      const { exitCode, stderr } = await runInit([]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("ERROR: --agents=<list> is required");
      expect(stderr).toContain("Supported values: claude, codex, copilot, cursor, kiro");
      expect(stderr).toContain("1. Specify target agents:");
      expect(stderr).toContain("2. Skip Skills and agent-context distribution:");
      expect(stderr).toContain("3. Skip every extra setup stage:");
      // No .artgraph.json gets written when --agents validation fails.
      expect(existsSync(join(initTmp, ".artgraph.json"))).toBe(false);
    },
  );

  it(
    "default init installs skills as part of the full agent-native setup (text output)",
    { timeout: 30000 },
    async () => {
      const { existsSync } = require("node:fs");
      const { join } = require("node:path");
      const { exitCode, stdout } = await runInit(["--agents=claude", "--no-scan"]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Installed");
      expect(stdout).toContain("Claude Code skills");
      // New directory-format Skill paths.
      expect(stdout).toContain(".claude/skills/artgraph-impact/SKILL.md");
      for (const dir of [
        "artgraph-bootstrap",
        "artgraph-impact",
        "artgraph-plan-coverage",
        "artgraph-rename",
        "artgraph-setup",
        "artgraph-verify",
      ]) {
        expect(existsSync(join(initTmp, ".claude", "skills", dir, "SKILL.md"))).toBe(true);
      }
    },
  );

  it("default init reports skillsInstalled in JSON output", { timeout: 30000 }, async () => {
    const { exitCode, stdout } = await runInit([
      "--agents=claude",
      "--no-scan",
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    // H6: JSON shape changed from string[] to { skills, fragments }.
    expect(typeof result.skillsInstalled).toBe("object");
    expect(Array.isArray(result.skillsInstalled.skills)).toBe(true);
    // Bumped 7 -> 8 in spec 014 (artgraph-plan-coverage added).
    // Bumped 8 -> 9 in issue #123 (artgraph-bootstrap added).
    // Reduced 9 -> 6 in #135 (detect / integrate absorbed into setup, coverage deleted).
    expect(result.skillsInstalled.skills.length).toBe(6);
    expect(result.skillsInstalled.fragments.length).toBeGreaterThanOrEqual(3);
    expect(result.skillsInstalled.skills).toContain(".claude/skills/artgraph-impact/SKILL.md");
  });

  it("--minimal suppresses skills install", { timeout: 30000 }, async () => {
    const { existsSync } = require("node:fs");
    const { join } = require("node:path");
    const { exitCode, stdout } = await runInit(["--minimal"]);
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("Installed");
    expect(existsSync(join(initTmp, ".claude", "skills"))).toBe(false);
  });

  // spec 013 (FR-013): --minimal overrides --agents — stderr WARNING, no install.
  it("--minimal --agents=claude warns and ignores --agents", { timeout: 30000 }, async () => {
    const { existsSync } = require("node:fs");
    const { join } = require("node:path");
    const { exitCode, stderr } = await runInit(["--minimal", "--agents=claude"]);
    expect(exitCode).toBe(0);
    expect(stderr).toMatch(/WARNING:\s*--minimal overrides --agents/);
    expect(existsSync(join(initTmp, ".claude", "skills"))).toBe(false);
  });

  it(
    "--no-skills --no-agent-context suppresses skills install (no --agents needed)",
    { timeout: 30000 },
    async () => {
      const { existsSync } = require("node:fs");
      const { join } = require("node:path");
      const { exitCode, stdout } = await runInit([
        "--no-scan",
        "--no-skills",
        "--no-agent-context",
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).not.toContain("Installed");
      expect(existsSync(join(initTmp, ".claude", "skills"))).toBe(false);
      expect(existsSync(join(initTmp, ".artgraph.json"))).toBe(true);
    },
  );

  it(
    "should fail and not write .artgraph.json when skill files conflict",
    { timeout: 30000 },
    async () => {
      const { mkdirSync, writeFileSync, existsSync } = require("node:fs");
      const { join } = require("node:path");
      mkdirSync(join(initTmp, ".claude", "skills", "artgraph-impact"), { recursive: true });
      writeFileSync(join(initTmp, ".claude", "skills", "artgraph-impact", "SKILL.md"), "user\n");

      const { exitCode, stderr } = await runInit(["--agents=claude", "--no-scan"]);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/artgraph-impact[/\\]SKILL\.md.*--force/);
      // Pre-flight validation must reject before any write.
      expect(existsSync(join(initTmp, ".artgraph.json"))).toBe(false);
    },
  );

  // -------------------------------------------------------------------------
  // E-adj-A1 / E-adj-A2 / E-adj-A9 / BND-7: init --help text accuracy.
  // Commander word-wraps help text to terminal width, so normalize
  // whitespace before asserting on multi-word phrases.
  // -------------------------------------------------------------------------
  it("init --help documents --force's full overwrite scope", { timeout: 30000 }, async () => {
    const { stdout, exitCode } = await runInit(["--help"]);
    expect(exitCode).toBe(0);
    const normalized = stdout.replace(/\s+/g, " ");
    expect(normalized).toContain(
      "Overwrite existing .artgraph.json, distributed Skill files, and integration files.",
    );
    expect(normalized).toContain("Refuses symlinks even with --force.");
  });

  it(
    "init --help derives the --agents id list from AGENT_IDS (not a stale literal)",
    { timeout: 30000 },
    async () => {
      const { stdout, exitCode } = await runInit(["--help"]);
      expect(exitCode).toBe(0);
      const normalized = stdout.replace(/\s+/g, " ");
      expect(normalized).toContain("claude, codex, copilot, cursor, kiro");
    },
  );
});

// ---------------------------------------------------------------------------
// error cases
// ---------------------------------------------------------------------------
describe("CLI: error cases", () => {
  it("should show usage info when no command is given", { timeout: 30000 }, async () => {
    const { stderr, exitCode } = await run([]);
    // Commander exits 1 and prints usage info to stderr when no command is provided.
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Usage:");
  });

  it("should fail for unknown command", { timeout: 30000 }, async () => {
    const { exitCode, stderr } = await run(["foobar"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("unknown command");
  });

  it("should show version with --version", { timeout: 30000 }, async () => {
    const { stdout, exitCode } = await run(["--version"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("should show help with --help", { timeout: 30000 }, async () => {
    const { stdout, exitCode } = await run(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("scan");
    expect(stdout).toContain("impact");
    expect(stdout).toContain("check");
    expect(stdout).toContain("reconcile");
  });
});

// ---------------------------------------------------------------------------
// symbol mode — driven purely by `.artgraph.json`'s `mode` field:
//   * fixtures/symbol-mode ships `"mode": "symbol"` in its config
//   * fixtures/symbol-level has no config, so scan stays in file mode
// ---------------------------------------------------------------------------
const SYM_CONFIG_FIXTURE = resolve(import.meta.dirname, "fixtures/symbol-mode");
const FILE_MODE_FIXTURE = resolve(import.meta.dirname, "fixtures/symbol-level");
const FILE_MODE_LOCK_PATH = resolve(FILE_MODE_FIXTURE, ".trace.lock");

describe("CLI: symbol mode", () => {
  afterEach(() => {
    if (existsSync(FILE_MODE_LOCK_PATH)) unlinkSync(FILE_MODE_LOCK_PATH);
  });

  it("should show symbol count when config mode is symbol", { timeout: 30000 }, async () => {
    const { stdout, exitCode } = await runAt(SYM_CONFIG_FIXTURE, ["scan"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("symbol:");
  });

  it("should not show symbol count in file mode", { timeout: 30000 }, async () => {
    const { stdout, exitCode } = await runAt(FILE_MODE_FIXTURE, ["scan"]);
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("symbol:");
  });

  it("should include symbolCount in JSON output", { timeout: 30000 }, async () => {
    const { stdout, exitCode } = await runAt(SYM_CONFIG_FIXTURE, ["scan", "--format", "json"]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.symbolCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// test-results integration — driven purely by `.artgraph.json`'s
// `testResultPaths` field. Each test builds a tmp copy of the all-verified
// fixture whose config points at the desired result file.
// ---------------------------------------------------------------------------
const TEST_RESULTS_DIR = resolve(import.meta.dirname, "fixtures/test-results");
const ALL_VERIFIED_DIR = resolve(import.meta.dirname, "fixtures/all-verified");
const ALL_VERIFIED_LOCK = resolve(ALL_VERIFIED_DIR, ".trace.lock");

function runAllVerified(args: string[]): Promise<RunResult> {
  return runAt(ALL_VERIFIED_DIR, args);
}

describe("CLI: test-results integration", () => {
  const tmpDirs: string[] = [];

  // Tmp copy of fixtures/all-verified with `testResultPaths` pointing at the
  // given fixtures/test-results file (copied in as results.json).
  function makeResultsProject(resultFile: string): string {
    const tmp = mkdtempSync(join(tmpdir(), "artgraph-test-results-"));
    tmpDirs.push(tmp);
    cpSync(ALL_VERIFIED_DIR, tmp, { recursive: true });
    cpSync(resolve(TEST_RESULTS_DIR, resultFile), join(tmp, "results.json"));
    writeFileSync(
      join(tmp, ".artgraph.json"),
      JSON.stringify({
        include: ["src/**/*.ts"],
        specDirs: ["requirements"],
        testPatterns: ["tests/**/*.test.ts"],
        lockFile: ".trace.lock",
        testResultPaths: ["results.json"],
      }),
    );
    return tmp;
  }

  function coverageById(checkJson: string): Record<string, string> {
    const result = JSON.parse(checkJson);
    return Object.fromEntries(result.coverage.map((c: any) => [c.reqId, c.status]));
  }

  afterEach(() => {
    if (existsSync(ALL_VERIFIED_LOCK)) unlinkSync(ALL_VERIFIED_LOCK);
    while (tmpDirs.length > 0) {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  it(
    "should accept config testResultPaths on check command without crash",
    { timeout: 30000 },
    async () => {
      const tmp = makeResultsProject("vitest-pass.json");
      const { exitCode } = await runAt(tmp, ["check"]);
      // Without --gate, check always exits 0 even with issues
      expect(exitCode).toBe(0);
    },
  );

  it("should include testResultStats in scan JSON output", { timeout: 30000 }, async () => {
    const tmp = makeResultsProject("vitest-mixed.json");
    const { stdout, exitCode } = await runAt(tmp, ["scan", "--format", "json"]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.testResultStats).toBeDefined();
    expect(result.testResultStats.totalTests).toBe(2);
    expect(result.testResultStats.passedTests).toBe(1);
    expect(result.testResultStats.failedTests).toBe(1);
  });

  it("should show test result stats in scan text output", { timeout: 30000 }, async () => {
    const tmp = makeResultsProject("vitest-mixed.json");
    const { stdout, exitCode } = await runAt(tmp, ["scan"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Test Results:");
    expect(stdout).toContain("passed=1");
    expect(stdout).toContain("failed=1");
  });

  it(
    "should report all REQs verified without testResultPaths (legacy)",
    { timeout: 30000 },
    async () => {
      const { stdout } = await runAllVerified(["check", "--format", "json"]);
      const byId = coverageById(stdout);
      expect(byId["VER-001"]).toBe("verified");
      expect(byId["VER-002"]).toBe("verified");
    },
  );

  it(
    "should keep status verified when test results show all passing",
    { timeout: 30000 },
    async () => {
      const tmp = makeResultsProject("all-verified-pass.json");
      const { stdout } = await runAt(tmp, ["check", "--format", "json"]);
      const byId = coverageById(stdout);
      expect(byId["VER-001"]).toBe("verified");
      expect(byId["VER-002"]).toBe("verified");
    },
  );

  it(
    "should downgrade a REQ to impl-only when its test fails (verified -> impl-only)",
    { timeout: 30000 },
    async () => {
      const tmp = makeResultsProject("all-verified-fail.json");
      const { stdout } = await runAt(tmp, ["check", "--format", "json"]);
      const byId = coverageById(stdout);
      // VER-001's test failed -> must transition away from "verified".
      expect(byId["VER-001"]).toBe("impl-only");
      // VER-002's test still passes -> stays verified.
      expect(byId["VER-002"]).toBe("verified");
    },
  );

  it("should pass check --gate when all tests pass", { timeout: 30000 }, async () => {
    const tmp = makeResultsProject("all-verified-pass.json");
    const { exitCode } = await runAt(tmp, ["check", "--gate"]);
    expect(exitCode).toBe(0);
  });

  it("should fail check --gate (exit 2) when a test fails", { timeout: 30000 }, async () => {
    const tmp = makeResultsProject("all-verified-fail.json");
    const { stdout, exitCode } = await runAt(tmp, ["check", "--gate"]);
    expect(exitCode).toBe(2);
    expect(stdout).toContain("TEST FAILURES:");
    expect(stdout).toContain("VER-001");
  });

  it(
    "should not fail check --gate for test failures when testResultPaths is absent",
    { timeout: 30000 },
    async () => {
      // Legacy: without test results the gate ignores pass/fail entirely.
      const { exitCode } = await runAllVerified(["check", "--gate"]);
      expect(exitCode).toBe(0);
    },
  );
});
