import { describe, it, expect, afterEach } from "vitest";
import { resolve } from "node:path";
import { run, runAt, cleanup } from "./helpers.js";

afterEach(cleanup);

const EMPTY_FIXTURE = resolve(import.meta.dirname, "fixtures/empty-graph");
const ALL_VERIFIED_FIXTURE = resolve(import.meta.dirname, "fixtures/all-verified");

// ---------------------------------------------------------------------------
// coverage
// ---------------------------------------------------------------------------
describe("CLI: coverage", () => {
  it("should output coverage as JSON", { timeout: 30000 }, async () => {
    const { stdout, exitCode } = await run(["coverage", "--format", "json"]);
    expect(exitCode).toBe(0);

    const result = JSON.parse(stdout);
    expect(result.items).toBeDefined();
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.summary).toBeDefined();
    expect(result.summary.total).toBeGreaterThan(0);
    expect(typeof result.summary.verified).toBe("number");
    expect(typeof result.summary.implOnly).toBe("number");
    expect(typeof result.summary.untagged).toBe("number");
  });

  it("should include correct status for each REQ in JSON", { timeout: 30000 }, async () => {
    const { stdout, exitCode } = await run(["coverage", "--format", "json"]);
    expect(exitCode).toBe(0);

    const result = JSON.parse(stdout);

    // AUTH-001 has both impl and test -> verified
    const auth001 = result.items.find((i: any) => i.reqId === "AUTH-001");
    expect(auth001).toBeDefined();
    expect(auth001.status).toBe("verified");

    // AUTH-002 has impl but no test -> impl-only
    const auth002 = result.items.find((i: any) => i.reqId === "AUTH-002");
    expect(auth002).toBeDefined();
    expect(auth002.status).toBe("impl-only");

    // AUTH-003 has no impl -> untagged
    const auth003 = result.items.find((i: any) => i.reqId === "AUTH-003");
    expect(auth003).toBeDefined();
    expect(auth003.status).toBe("untagged");
  });

  it("should output summary counts matching items in JSON", { timeout: 30000 }, async () => {
    const { stdout, exitCode } = await run(["coverage", "--format", "json"]);
    expect(exitCode).toBe(0);

    const result = JSON.parse(stdout);
    const { items, summary } = result;

    const verifiedCount = items.filter((i: any) => i.status === "verified").length;
    const implOnlyCount = items.filter((i: any) => i.status === "impl-only").length;
    const untaggedCount = items.filter((i: any) => i.status === "untagged").length;

    expect(summary.total).toBe(items.length);
    expect(summary.verified).toBe(verifiedCount);
    expect(summary.implOnly).toBe(implOnlyCount);
    expect(summary.untagged).toBe(untaggedCount);
  });

  it("should output human-readable text by default", { timeout: 30000 }, async () => {
    const { stdout, exitCode } = await run(["coverage"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("AUTH-001");
    expect(stdout).toContain("verified");
    expect(stdout).toContain("untagged");
  });

  it("should output text with --format text", { timeout: 30000 }, async () => {
    const { stdout, exitCode } = await run(["coverage", "--format", "text"]);
    expect(exitCode).toBe(0);
    // Should contain status lines for each REQ
    expect(stdout).toContain("AUTH-001");
    expect(stdout).toContain("AUTH-002");
    expect(stdout).toContain("AUTH-003");
    // Should contain a summary line
    expect(stdout).toMatch(/total/i);
  });

  it("should show correct status in text output for each REQ", { timeout: 30000 }, async () => {
    const { stdout, exitCode } = await run(["coverage", "--format", "text"]);
    expect(exitCode).toBe(0);

    // AUTH-001 should be verified in text output
    expect(stdout).toMatch(/AUTH-001:\s*verified/);
    // AUTH-002 should be impl-only in text output
    expect(stdout).toMatch(/AUTH-002:\s*impl-only/);
    // AUTH-003 should be untagged in text output
    expect(stdout).toMatch(/AUTH-003:\s*untagged/);
  });

  it("should always exit 0 (no gating)", { timeout: 30000 }, async () => {
    // Even with uncovered items, coverage should exit 0
    const { exitCode } = await run(["coverage"]);
    expect(exitCode).toBe(0);
  });

  it("should appear in --help output", { timeout: 30000 }, async () => {
    const { stdout, exitCode } = await run(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("coverage");
  });

  it("should reject invalid --format value", { timeout: 30000 }, async () => {
    const { exitCode, stderr } = await run(["coverage", "--format", "invalid"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/invalid|allowed|choices/i);
  });
});

// ---------------------------------------------------------------------------
// coverage: empty graph (0 req nodes)
// ---------------------------------------------------------------------------
describe("CLI: coverage (empty graph)", () => {
  it(
    "should return empty items and zero summary for empty graph in JSON",
    { timeout: 30000 },
    async () => {
      const { stdout, exitCode } = await runAt(EMPTY_FIXTURE, ["coverage", "--format", "json"]);
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      expect(result.items).toEqual([]);
      expect(result.summary).toEqual({
        total: 0,
        verified: 0,
        implOnly: 0,
        untagged: 0,
      });
    },
  );

  it("should output text without errors for empty graph", { timeout: 30000 }, async () => {
    const { stdout, exitCode } = await runAt(EMPTY_FIXTURE, ["coverage", "--format", "text"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("COVERAGE:");
    expect(stdout).toMatch(/total=0/);
  });
});

// ---------------------------------------------------------------------------
// coverage: all-verified fixture (all reqs have impl + test)
// ---------------------------------------------------------------------------
describe("CLI: coverage (all verified)", () => {
  it(
    "should show all items as verified when every req has impl and test",
    { timeout: 30000 },
    async () => {
      const { stdout, exitCode } = await runAt(ALL_VERIFIED_FIXTURE, [
        "coverage",
        "--format",
        "json",
      ]);
      expect(exitCode).toBe(0);

      const result = JSON.parse(stdout);
      expect(result.items.length).toBeGreaterThan(0);

      for (const item of result.items) {
        expect(item.status).toBe("verified");
      }

      expect(result.summary.verified).toBe(result.summary.total);
      expect(result.summary.implOnly).toBe(0);
      expect(result.summary.untagged).toBe(0);
    },
  );

  it("should show all verified in text output", { timeout: 30000 }, async () => {
    const { stdout, exitCode } = await runAt(ALL_VERIFIED_FIXTURE, [
      "coverage",
      "--format",
      "text",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("COVERAGE:");
    expect(stdout).toMatch(/VER-001:\s*verified/);
    expect(stdout).toMatch(/VER-002:\s*verified/);
    // No item line should show impl-only or untagged as a status
    const lines = stdout.split("\n").filter((l: string) => l.match(/VER-\d+:/));
    for (const line of lines) {
      expect(line).toContain("verified");
      expect(line).not.toContain("impl-only");
      expect(line).not.toContain("untagged");
    }
    // Summary should show all verified
    expect(stdout).toMatch(/verified=2/);
    expect(stdout).toMatch(/impl-only=0/);
    expect(stdout).toMatch(/untagged=0/);
  });
});
