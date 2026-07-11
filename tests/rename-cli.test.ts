import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { mkdtempSync, mkdirSync, cpSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { runAt, type RunResult } from "./helpers.js";

const RENAME_FIXTURE = resolve(import.meta.dirname, "fixtures/rename");

/** Temp dirs created during tests — cleaned up in afterEach. */
const tempDirs: string[] = [];

function gitCommit(cwd: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd, stdio: "pipe" });
  execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@test.com", "commit", "-m", message],
    { cwd, stdio: "pipe" },
  );
}

/**
 * Copy the rename fixture into a fresh temp directory, seed a .artgraph.json,
 * generate .trace.lock via reconcile, and initialise a git repo so
 * `git ls-files` works.
 */
async function prepareTempDir(): Promise<string> {
  const tmp = mkdtempSync(resolve(tmpdir(), "artgraph-rename-cli-"));
  tempDirs.push(tmp);

  cpSync(RENAME_FIXTURE, tmp, { recursive: true });

  writeFileSync(
    resolve(tmp, ".artgraph.json"),
    JSON.stringify({
      include: ["src/**/*.ts"],
      specDirs: ["specs"],
      testPatterns: ["tests/**/*.test.ts"],
      lockFile: ".trace.lock",
    }),
  );

  execFileSync("git", ["init"], { cwd: tmp, stdio: "pipe" });
  gitCommit(tmp, "init");

  // Generate .trace.lock via reconcile, then commit it so it is tracked.
  await runAt(tmp, ["reconcile"]);
  gitCommit(tmp, "add lock");

  return tmp;
}

function runCli(args: string[], cwd: string): Promise<RunResult> {
  return runAt(cwd, args);
}

/** Run `artgraph check --format json` and return the parsed result. */
async function runCheck(cwd: string): Promise<{
  drifted: unknown[];
  orphans: unknown[];
  uncovered: unknown[];
  pass: boolean;
}> {
  const { stdout } = await runCli(["check", "--format", "json"], cwd);
  return JSON.parse(stdout);
}

function snapshot(tmp: string, files: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of files) out[f] = readFileSync(resolve(tmp, f), "utf-8");
  return out;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

// ---------------------------------------------------------------------------
// rename
// ---------------------------------------------------------------------------
describe("CLI: rename --from/--to", () => {
  it("should rename REQ-001 to REQ-100 across all files", { timeout: 30000 }, async () => {
    const tmp = await prepareTempDir();

    const { exitCode } = await runCli(["rename", "--from", "REQ-001", "--to", "REQ-100"], tmp);
    expect(exitCode).toBe(0);

    const spec = readFileSync(resolve(tmp, "specs/feature.md"), "utf-8");
    expect(spec).toContain("REQ-100: ユーザー認証");
    expect(spec).not.toMatch(/^- REQ-001:/m);

    const src = readFileSync(resolve(tmp, "src/feature.ts"), "utf-8");
    expect(src).toContain("@impl REQ-100");
    expect(src).not.toContain("@impl REQ-001");

    const test = readFileSync(resolve(tmp, "tests/feature.test.ts"), "utf-8");
    expect(test).toContain("[REQ-100]");
    expect(test).not.toContain("[REQ-001]");

    const lock = JSON.parse(readFileSync(resolve(tmp, ".trace.lock"), "utf-8"));
    expect(lock["REQ-100"]).toBeDefined();
    expect(lock["REQ-001"]).toBeUndefined();

    // Non-target references must be preserved: REQ-002 untouched and a prose
    // mention of REQ-001 (not a tracked reference) is left as-is.
    expect(spec).toContain("- REQ-002: ユーザー登録");
    expect(spec).toContain("REQ-001 は認証基盤の中核要件として");
  });

  it(
    "leaves the lock drift-free so `check` passes afterwards (F1)",
    { timeout: 30000 },
    async () => {
      const tmp = await prepareTempDir();
      const before = await runCheck(tmp);
      expect(before.pass).toBe(true);

      const { exitCode } = await runCli(["rename", "--from", "REQ-001", "--to", "REQ-100"], tmp);
      expect(exitCode).toBe(0);

      const after = await runCheck(tmp);
      expect(after.drifted).toEqual([]);
      expect(after.pass).toBe(true);
    },
  );

  it("should not modify files when --dry-run is used", { timeout: 30000 }, async () => {
    const tmp = await prepareTempDir();
    const files = ["specs/feature.md", "src/feature.ts", "tests/feature.test.ts", ".trace.lock"];
    const orig = snapshot(tmp, files);

    const { exitCode, stdout } = await runCli(
      ["rename", "--from", "REQ-001", "--to", "REQ-100", "--dry-run"],
      tmp,
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("dry-run");

    expect(snapshot(tmp, files)).toEqual(orig);
  });

  it("should output valid JSON with --format json", { timeout: 30000 }, async () => {
    const tmp = await prepareTempDir();

    const { exitCode, stdout } = await runCli(
      ["rename", "--from", "REQ-001", "--to", "REQ-100", "--format", "json"],
      tmp,
    );
    expect(exitCode).toBe(0);

    const result = JSON.parse(stdout);
    expect(result.operation).toBe("rename");
    expect(result.from).toBe("REQ-001");
    expect(result.to).toBe("REQ-100");
    expect(Array.isArray(result.changes)).toBe(true);
    expect(result.changes.length).toBeGreaterThan(0);
    expect(result.applied).toBe(true);
  });

  it("emits JSON on the error path with --format json (F7)", { timeout: 30000 }, async () => {
    const tmp = await prepareTempDir();
    const { exitCode, stderr } = await runCli(
      ["rename", "--from", "NONEXISTENT", "--to", "REQ-100", "--format", "json"],
      tmp,
    );
    expect(exitCode).not.toBe(0);
    expect(() => JSON.parse(stderr)).not.toThrow();
    expect(JSON.parse(stderr).error).toContain("NONEXISTENT");
  });

  it("should fail when source ID does not exist", { timeout: 30000 }, async () => {
    const tmp = await prepareTempDir();
    const { exitCode, stderr } = await runCli(
      ["rename", "--from", "NONEXISTENT", "--to", "REQ-100"],
      tmp,
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("NONEXISTENT");
  });

  it("should fail when target ID already exists", { timeout: 30000 }, async () => {
    const tmp = await prepareTempDir();
    const { exitCode, stderr } = await runCli(
      ["rename", "--from", "REQ-001", "--to", "REQ-002"],
      tmp,
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("REQ-002");
  });

  it("rejects an invalid target ID (F2)", { timeout: 30000 }, async () => {
    const tmp = await prepareTempDir();
    const { exitCode, stderr } = await runCli(
      ["rename", "--from", "REQ-001", "--to", "REQ-001a"],
      tmp,
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/invalid target id/i);
  });

  it("rejects a self-rename (F9)", { timeout: 30000 }, async () => {
    const tmp = await prepareTempDir();
    const { exitCode, stderr } = await runCli(
      ["rename", "--from", "REQ-001", "--to", "REQ-001"],
      tmp,
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/identical/i);
  });
});

// ---------------------------------------------------------------------------
// split
// ---------------------------------------------------------------------------
describe("CLI: rename --split/--into", () => {
  it("should split REQ-001 into REQ-101 and REQ-102", { timeout: 30000 }, async () => {
    const tmp = await prepareTempDir();

    const { exitCode, stdout, stderr } = await runCli(
      ["rename", "--split", "REQ-001", "--into", "REQ-101", "REQ-102"],
      tmp,
    );
    expect(exitCode).toBe(0);

    const spec = readFileSync(resolve(tmp, "specs/feature.md"), "utf-8");
    expect(spec).not.toMatch(/^- REQ-001:/m);
    expect(spec).toContain("REQ-101");
    expect(spec).toContain("REQ-102");

    // @impl REQ-001 should NOT be rewritten (manual assignment needed).
    const src = readFileSync(resolve(tmp, "src/feature.ts"), "utf-8");
    expect(src).toContain("@impl REQ-001");
    expect(stdout + stderr).toMatch(/manual.*assignment|WARNING/i);

    const lock = JSON.parse(readFileSync(resolve(tmp, ".trace.lock"), "utf-8"));
    expect(lock["REQ-001"]).toBeUndefined();
    expect(lock["REQ-101"]).toBeDefined();
    expect(lock["REQ-102"]).toBeDefined();
  });

  it(
    "leaves no drift after split (new IDs are uncovered, not drifted)",
    { timeout: 30000 },
    async () => {
      const tmp = await prepareTempDir();
      const { exitCode } = await runCli(
        ["rename", "--split", "REQ-001", "--into", "REQ-101", "REQ-102"],
        tmp,
      );
      expect(exitCode).toBe(0);

      const after = await runCheck(tmp);
      // contentHash drift must be gone …
      expect(after.drifted).toEqual([]);
      // … but the freshly-scaffolded IDs are legitimately uncovered until @impl
      // tags are assigned manually.
      expect(after.uncovered).toContain("REQ-101");
      expect(after.uncovered).toContain("REQ-102");
    },
  );

  it("does not modify files with --dry-run", { timeout: 30000 }, async () => {
    const tmp = await prepareTempDir();
    const files = ["specs/feature.md", "src/feature.ts", "tests/feature.test.ts", ".trace.lock"];
    const orig = snapshot(tmp, files);

    const { exitCode } = await runCli(
      ["rename", "--split", "REQ-001", "--into", "REQ-101", "REQ-102", "--dry-run"],
      tmp,
    );
    expect(exitCode).toBe(0);
    expect(snapshot(tmp, files)).toEqual(orig);
  });

  it("rejects duplicate --into targets (M2)", { timeout: 30000 }, async () => {
    const tmp = await prepareTempDir();
    const { exitCode, stderr } = await runCli(
      ["rename", "--split", "REQ-001", "--into", "REQ-101", "REQ-101"],
      tmp,
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/duplicate/i);
  });

  it("rejects an invalid split target (F2)", { timeout: 30000 }, async () => {
    const tmp = await prepareTempDir();
    const { exitCode, stderr } = await runCli(
      ["rename", "--split", "REQ-001", "--into", "REQ-001a", "REQ-001b"],
      tmp,
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/invalid target id/i);
  });
});

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------
describe("CLI: rename --merge/--into", () => {
  it(
    "should merge REQ-001 and REQ-002 into REQ-100 without duplicating it (C1)",
    { timeout: 30000 },
    async () => {
      const tmp = await prepareTempDir();

      const { exitCode } = await runCli(
        ["rename", "--merge", "REQ-001", "REQ-002", "--into", "REQ-100"],
        tmp,
      );
      expect(exitCode).toBe(0);

      const spec = readFileSync(resolve(tmp, "specs/feature.md"), "utf-8");
      const src = readFileSync(resolve(tmp, "src/feature.ts"), "utf-8");
      const test = readFileSync(resolve(tmp, "tests/feature.test.ts"), "utf-8");

      expect(src).toContain("@impl REQ-100");
      expect(test).toContain("[REQ-100]");
      expect(src).not.toContain("@impl REQ-001");
      expect(src).not.toContain("@impl REQ-002");

      // C1: the merge target must appear exactly once as a definition list item.
      const defLines = spec.split("\n").filter((l) => /^- REQ-100:/.test(l));
      expect(defLines).toHaveLength(1);
      // Old definitions are gone.
      expect(spec).not.toMatch(/^- REQ-001:/m);
      expect(spec).not.toMatch(/^- REQ-002:/m);

      const lock = JSON.parse(readFileSync(resolve(tmp, ".trace.lock"), "utf-8"));
      expect(lock["REQ-001"]).toBeUndefined();
      expect(lock["REQ-002"]).toBeUndefined();
      expect(lock["REQ-100"]).toBeDefined();
    },
  );

  it(
    "leaves the lock drift-free so `check` passes after merge (F1/C2/H5)",
    { timeout: 30000 },
    async () => {
      const tmp = await prepareTempDir();
      const { exitCode } = await runCli(
        ["rename", "--merge", "REQ-001", "REQ-002", "--into", "REQ-100"],
        tmp,
      );
      expect(exitCode).toBe(0);

      const after = await runCheck(tmp);
      expect(after.drifted).toEqual([]);
      expect(after.pass).toBe(true);
    },
  );

  it("does not modify files with --dry-run", { timeout: 30000 }, async () => {
    const tmp = await prepareTempDir();
    const files = ["specs/feature.md", "src/feature.ts", "tests/feature.test.ts", ".trace.lock"];
    const orig = snapshot(tmp, files);

    const { exitCode } = await runCli(
      ["rename", "--merge", "REQ-001", "REQ-002", "--into", "REQ-100", "--dry-run"],
      tmp,
    );
    expect(exitCode).toBe(0);
    expect(snapshot(tmp, files)).toEqual(orig);
  });

  it("rejects an invalid merge target (F2)", { timeout: 30000 }, async () => {
    const tmp = await prepareTempDir();
    const { exitCode, stderr } = await runCli(
      ["rename", "--merge", "REQ-001", "REQ-002", "--into", "REQ-COMBINED"],
      tmp,
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/invalid target id/i);
  });
});

// ---------------------------------------------------------------------------
// issue #212 — file enumeration is `.artgraph.json`-pattern based, not
// git-tracked. Untracked (pre-commit) files must be rewritten like committed
// ones, a zero-hit scan must fail loudly, and JSON output must expose the
// scanned-file count.
// ---------------------------------------------------------------------------
describe("CLI: rename enumeration ignores git tracking state (#212)", () => {
  /** Fixture copy + config, WITHOUT any commit — files exist but are untracked. */
  function prepareBareDir(withGit: boolean): string {
    const tmp = mkdtempSync(resolve(tmpdir(), "artgraph-rename-untracked-"));
    tempDirs.push(tmp);
    cpSync(RENAME_FIXTURE, tmp, { recursive: true });
    writeFileSync(
      resolve(tmp, ".artgraph.json"),
      JSON.stringify({
        include: ["src/**/*.ts"],
        specDirs: ["specs"],
        testPatterns: ["tests/**/*.test.ts"],
        lockFile: ".trace.lock",
      }),
    );
    if (withGit) execFileSync("git", ["init"], { cwd: tmp, stdio: "pipe" });
    return tmp;
  }

  it(
    "rewrites untracked (never committed) files instead of silently no-opping",
    { timeout: 30000 },
    async () => {
      // `git init` only — the exact state of a Spec Kit specify→implement flow
      // before the first `git add`, which used to be a silent no-op.
      const tmp = prepareBareDir(true);
      await runAt(tmp, ["reconcile"]);

      const { exitCode } = await runCli(["rename", "--from", "REQ-001", "--to", "REQ-100"], tmp);
      expect(exitCode).toBe(0);

      const spec = readFileSync(resolve(tmp, "specs/feature.md"), "utf-8");
      expect(spec).toContain("REQ-100: ユーザー認証");
      expect(spec).not.toMatch(/^- REQ-001:/m);
      const src = readFileSync(resolve(tmp, "src/feature.ts"), "utf-8");
      expect(src).toContain("@impl REQ-100");
      expect(src).not.toContain("@impl REQ-001");
      const test = readFileSync(resolve(tmp, "tests/feature.test.ts"), "utf-8");
      expect(test).toContain("[REQ-100]");

      const lock = JSON.parse(readFileSync(resolve(tmp, ".trace.lock"), "utf-8"));
      expect(lock["REQ-100"]).toBeDefined();
      expect(lock["REQ-001"]).toBeUndefined();
    },
  );

  it("works in a directory that is not a git repository at all", { timeout: 30000 }, async () => {
    // Used to die with `Error: Failed to run git ls-files`.
    const tmp = prepareBareDir(false);
    await runAt(tmp, ["reconcile"]);

    const { exitCode } = await runCli(["rename", "--from", "REQ-001", "--to", "REQ-100"], tmp);
    expect(exitCode).toBe(0);
    expect(readFileSync(resolve(tmp, "src/feature.ts"), "utf-8")).toContain("@impl REQ-100");
  });

  it("reports filesScanned in JSON output, including --dry-run", { timeout: 30000 }, async () => {
    const tmp = await prepareTempDir();
    const { exitCode, stdout } = await runCli(
      ["rename", "--from", "REQ-001", "--to", "REQ-100", "--dry-run", "--format", "json"],
      tmp,
    );
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    // Fixture scope: specs/feature.md + src/feature.ts + tests/feature.test.ts.
    expect(result.filesScanned).toBe(3);
    expect(result.applied).toBe(false);
  });

  it(
    "fails (non-zero) when --from exists in the graph but no scanned file is rewritable",
    { timeout: 30000 },
    async () => {
      // A kiro heading req can only be renamed to another `Requirement-N` ID;
      // renaming it to `REQ-500` finds zero rewritable references. This used to
      // report success while touching nothing but the lock (safety valve #212).
      const tmp = await prepareTempDir();
      writeFileSync(
        resolve(tmp, "specs/kiro.md"),
        ["# Kiro spec", "", "### Requirement 1: 認証フロー", ""].join("\n"),
        "utf-8",
      );
      await runAt(tmp, ["reconcile"]);
      const before = readFileSync(resolve(tmp, "specs/kiro.md"), "utf-8");

      const { exitCode, stderr } = await runCli(
        ["rename", "--from", "Requirement-1", "--to", "REQ-500"],
        tmp,
      );
      expect(exitCode).not.toBe(0);
      expect(stderr).toMatch(/was not found in any of the \d+ files/);
      expect(readFileSync(resolve(tmp, "specs/kiro.md"), "utf-8")).toBe(before);
    },
  );
});

// ---------------------------------------------------------------------------
// issue #213 — `--split`/`--merge` with a brand-new `--into` ID must scaffold
// the new ID ONLY in the spec file that defines the split source. No stub
// insertion into `.claude/`, `.specify/`, AGENTS.md/CLAUDE.md or unrelated
// specs — even when those files are git-tracked.
// ---------------------------------------------------------------------------
describe("CLI: split scaffolds are limited to the source spec file (#213)", () => {
  const OUT_OF_SCOPE_FILES = [
    ".claude/skills/foo/SKILL.md",
    ".specify/templates/tasks-template.md",
    "AGENTS.md",
    "CLAUDE.md",
  ] as const;

  async function prepareMultiSpecDir(): Promise<string> {
    const tmp = mkdtempSync(resolve(tmpdir(), "artgraph-rename-split-scope-"));
    tempDirs.push(tmp);

    writeFileSync(
      resolve(tmp, ".artgraph.json"),
      JSON.stringify({
        include: ["src/**/*.ts"],
        specDirs: ["specs"],
        testPatterns: ["tests/**/*.test.ts"],
        lockFile: ".trace.lock",
      }),
    );
    for (const dir of [
      "specs/feat-a",
      "specs/feat-b",
      ".claude/skills/foo",
      ".specify/templates",
      "src",
      "tests",
    ]) {
      mkdirSync(resolve(tmp, dir), { recursive: true });
    }
    writeFileSync(resolve(tmp, "specs/feat-a/spec.md"), "# Feat A\n\n- REQ-022: 分割元要件\n");
    writeFileSync(resolve(tmp, "specs/feat-b/spec.md"), "# Feat B\n\n- REQ-001: 無関係な要件\n");
    writeFileSync(
      resolve(tmp, ".claude/skills/foo/SKILL.md"),
      "# SKILL\n\nDistributed skill doc.\n",
    );
    writeFileSync(
      resolve(tmp, ".specify/templates/tasks-template.md"),
      "# Tasks template\n\n- [ ] task\n",
    );
    writeFileSync(resolve(tmp, "AGENTS.md"), "# AGENTS\n");
    writeFileSync(resolve(tmp, "CLAUDE.md"), "# CLAUDE\n");
    writeFileSync(resolve(tmp, "src/impl.ts"), "// @impl REQ-022\nexport const impl = 1;\n");
    writeFileSync(resolve(tmp, "tests/impl.test.ts"), "// [REQ-022]\nexport {};\n");

    // Everything is committed (tracked): the out-of-scope files must be
    // protected by scan-scope enumeration, not by git-tracking accidents.
    execFileSync("git", ["init"], { cwd: tmp, stdio: "pipe" });
    gitCommit(tmp, "init");
    await runAt(tmp, ["reconcile"]);
    gitCommit(tmp, "add lock");
    return tmp;
  }

  it(
    "dry-run proposes spec changes only in the file defining the split source",
    { timeout: 30000 },
    async () => {
      const tmp = await prepareMultiSpecDir();

      const { exitCode, stdout } = await runCli(
        [
          "rename",
          "--split",
          "REQ-022",
          "--into",
          "REQ-022",
          "REQ-027",
          "--dry-run",
          "--format",
          "json",
        ],
        tmp,
      );
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      const changedFiles = [
        ...new Set(result.changes.map((c: { filePath: string }) => c.filePath)),
      ];
      expect(changedFiles).toEqual(["specs/feat-a/spec.md"]);

      // The brand-new ID is scaffolded in the source spec file…
      const scaffolds = result.changes.filter((c: { after: string }) =>
        c.after.startsWith("- REQ-027:"),
      );
      expect(scaffolds).toHaveLength(1);
      expect(scaffolds[0].filePath).toBe("specs/feat-a/spec.md");

      // …the code side stays a manual-assignment warning, and the scanned set
      // is the 4 in-scope files (2 specs + 1 src + 1 test).
      expect(result.warnings).toEqual([
        {
          type: "manual-assignment-needed",
          filePath: "src/impl.ts",
          oldId: "REQ-022",
          newIds: ["REQ-022", "REQ-027"],
        },
      ]);
      expect(result.filesScanned).toBe(4);
    },
  );

  it(
    "applied split leaves tracked out-of-scope markdown and unrelated specs byte-identical",
    { timeout: 30000 },
    async () => {
      const tmp = await prepareMultiSpecDir();
      const untouched = [...OUT_OF_SCOPE_FILES, "specs/feat-b/spec.md"];
      const orig = snapshot(tmp, untouched);

      const { exitCode } = await runCli(
        ["rename", "--split", "REQ-022", "--into", "REQ-022", "REQ-027"],
        tmp,
      );
      expect(exitCode).toBe(0);

      expect(snapshot(tmp, untouched)).toEqual(orig);

      const specA = readFileSync(resolve(tmp, "specs/feat-a/spec.md"), "utf-8");
      expect(specA).not.toContain("REQ-022: 分割元要件");
      expect(specA).toContain("- REQ-022: (TODO: describe this requirement)");
      expect(specA).toContain("- REQ-027: (TODO: describe this requirement)");

      const lock = JSON.parse(readFileSync(resolve(tmp, ".trace.lock"), "utf-8"));
      expect(lock["REQ-027"]).toBeDefined();
    },
  );
});

// ---------------------------------------------------------------------------
// non-ASCII paths (H4)
// ---------------------------------------------------------------------------
describe("CLI: rename across non-ASCII paths", () => {
  it("rewrites references inside files with non-ASCII names", { timeout: 30000 }, async () => {
    const tmp = await prepareTempDir();

    // Add a second spec file whose name is non-ASCII; git ls-files would
    // octal-quote it without the -z / core.quotePath=false guard.
    writeFileSync(
      resolve(tmp, "specs/要件.md"),
      ["# 追加仕様", "", "- REQ-003: 追加要件", ""].join("\n"),
      "utf-8",
    );
    gitCommit(tmp, "add non-ascii spec");
    await runAt(tmp, ["reconcile"]);
    gitCommit(tmp, "reconcile");

    const { exitCode } = await runCli(["rename", "--from", "REQ-003", "--to", "REQ-300"], tmp);
    expect(exitCode).toBe(0);

    const spec = readFileSync(resolve(tmp, "specs/要件.md"), "utf-8");
    expect(spec).toContain("- REQ-300: 追加要件");
    expect(spec).not.toContain("REQ-003");
  });
});

// ---------------------------------------------------------------------------
// spec 020 T017 — trace shard REQ ID rewrite on rename/split/merge (FR-016)
// ---------------------------------------------------------------------------
describe("CLI: rename rewrites trace shards (spec 020 FR-016)", () => {
  const SCHEMA_VERSION = 1;

  function metaLine(runToken: string): string {
    return JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      kind: "meta",
      runToken,
      pool: "forks",
      vitest: "4.1.10",
      startedAt: "2026-07-10T00:00:00.000Z",
    });
  }

  function testLine(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      kind: "test",
      testName: "[REQ-001] should verify [REQ-001]",
      suitePath: ["[REQ-001] ユーザー認証"],
      testFile: "tests/feature.test.ts",
      passed: true,
      hits: [{ file: "src/feature.ts", fn: "authenticate" }],
      hashes: { "src/feature.ts": "sha256:deadbeef" },
      ...overrides,
    });
  }

  function writeShard(tmp: string, relPath: string, lines: string[]): string {
    const abs = resolve(tmp, relPath);
    mkdirSync(resolve(abs, ".."), { recursive: true });
    writeFileSync(abs, lines.join("\n") + "\n", "utf-8");
    return abs;
  }

  it(
    "--from/--to rewrites [REQ-001] inside shard testName/suitePath across all matched shards",
    { timeout: 30000 },
    async () => {
      const tmp = await prepareTempDir();
      const shardPath = writeShard(tmp, ".artgraph/trace/w1-tok.jsonl", [
        metaLine("tok-1"),
        testLine(),
      ]);

      const { exitCode } = await runCli(["rename", "--from", "REQ-001", "--to", "REQ-100"], tmp);
      expect(exitCode).toBe(0);

      const shard = readFileSync(shardPath, "utf-8");
      expect(shard).toContain('"testName":"[REQ-100] should verify [REQ-100]"');
      expect(shard).toContain('"suitePath":["[REQ-100] ユーザー認証"]');
      expect(shard).not.toContain("REQ-001");
      // Untouched fields survive byte-identically.
      expect(shard).toContain('"hits":[{"file":"src/feature.ts","fn":"authenticate"}]');
    },
  );

  it(
    "rename summary output lists the trace shard among rewritten artifacts",
    { timeout: 30000 },
    async () => {
      const tmp = await prepareTempDir();
      writeShard(tmp, ".artgraph/trace/w1-tok.jsonl", [metaLine("tok-1"), testLine()]);

      const { exitCode, stdout } = await runCli(
        ["rename", "--from", "REQ-001", "--to", "REQ-100", "--format", "json"],
        tmp,
      );
      expect(exitCode).toBe(0);
      const result = JSON.parse(stdout);
      const shardChanges = result.changes.filter((c: { kind: string }) => c.kind === "trace-shard");
      expect(shardChanges.length).toBeGreaterThan(0);
      expect(shardChanges[0].filePath).toBe(".artgraph/trace/w1-tok.jsonl");

      const tmp2 = await prepareTempDir();
      writeShard(tmp2, ".artgraph/trace/w1-tok.jsonl", [metaLine("tok-1"), testLine()]);
      const { stdout: textOut } = await runCli(
        ["rename", "--from", "REQ-001", "--to", "REQ-100"],
        tmp2,
      );
      expect(textOut).toContain(".artgraph/trace/w1-tok.jsonl");
    },
  );

  it(
    "--merge collapses shard testName/suitePath REQ IDs into the target ID",
    { timeout: 30000 },
    async () => {
      const tmp = await prepareTempDir();
      const shardPath = writeShard(tmp, ".artgraph/trace/w1-tok.jsonl", [
        metaLine("tok-1"),
        testLine({ testName: "[REQ-001] a", suitePath: [] }),
        testLine({ testName: "[REQ-002] b", suitePath: [], hits: [] }),
      ]);

      const { exitCode } = await runCli(
        ["rename", "--merge", "REQ-001", "REQ-002", "--into", "REQ-100"],
        tmp,
      );
      expect(exitCode).toBe(0);

      const shard = readFileSync(shardPath, "utf-8");
      expect(shard).toContain('"testName":"[REQ-100] a"');
      expect(shard).toContain('"testName":"[REQ-100] b"');
      expect(shard).not.toContain("REQ-001");
      expect(shard).not.toContain("REQ-002");
    },
  );

  it(
    "③不正遷移: an unknown-schemaVersion shard is left untouched and warned about by name",
    { timeout: 30000 },
    async () => {
      const tmp = await prepareTempDir();
      const staleMeta = JSON.stringify({
        schemaVersion: SCHEMA_VERSION + 999,
        kind: "meta",
        runToken: "tok-stale",
        pool: "forks",
        vitest: "4.1.10",
        startedAt: "2026-07-10T00:00:00.000Z",
      });
      const shardPath = writeShard(tmp, ".artgraph/trace/stale.jsonl", [staleMeta, testLine()]);
      const original = readFileSync(shardPath, "utf-8");

      const { exitCode, stdout, stderr } = await runCli(
        ["rename", "--from", "REQ-001", "--to", "REQ-100"],
        tmp,
      );
      expect(exitCode).toBe(0);

      expect(readFileSync(shardPath, "utf-8")).toBe(original);
      expect(stdout + stderr).toContain(".artgraph/trace/stale.jsonl");
      expect((stdout + stderr).toLowerCase()).toMatch(/warning|schema/);
    },
  );

  it(
    "--split leaves shard content byte-identical (mirrors code-side [REQ] test-tag policy on split)",
    { timeout: 30000 },
    async () => {
      const tmp = await prepareTempDir();
      const shardPath = writeShard(tmp, ".artgraph/trace/w1-tok.jsonl", [
        metaLine("tok-1"),
        testLine(),
      ]);
      const original = readFileSync(shardPath, "utf-8");

      const { exitCode } = await runCli(
        ["rename", "--split", "REQ-001", "--into", "REQ-101", "REQ-102"],
        tmp,
      );
      expect(exitCode).toBe(0);
      expect(readFileSync(shardPath, "utf-8")).toBe(original);
    },
  );

  it(
    "⑦回帰: no trace shards / no trace config → rename behaves exactly as before",
    { timeout: 30000 },
    async () => {
      const tmp = await prepareTempDir();

      const { exitCode, stdout } = await runCli(
        ["rename", "--from", "REQ-001", "--to", "REQ-100", "--format", "json"],
        tmp,
      );
      expect(exitCode).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.changes.every((c: { kind: string }) => c.kind !== "trace-shard")).toBe(true);
      expect(result.warnings).toEqual([]);
      // Unaffected: same scanned-file count as the pre-existing (trace-less) test above.
      expect(result.filesScanned).toBe(3);
    },
  );
});
