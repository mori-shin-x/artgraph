import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { buildGraph } from "../src/graph/builder.js";
import { computeCoverage, type CoverageEntry } from "../src/coverage.js";
import type { SpectraceConfig } from "../src/types.js";

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures");

const config: SpectraceConfig = {
  include: ["src/**/*.ts"],
  specDirs: ["specs"],
  testPatterns: ["tests/**/*.ts"],
  lockFile: ".trace.lock",
};

describe("computeCoverage", () => {
  const { graph } = buildGraph(FIXTURE_DIR, config);

  it("should mark REQ with @impl and test as verified", () => {
    const coverage = computeCoverage(graph);
    const entry = coverage.find((c) => c.reqId === "AUTH-001");

    expect(entry).toBeDefined();
    expect(entry!.status).toBe("verified");
    expect(entry!.implFiles.length).toBeGreaterThan(0);
    expect(entry!.testFiles.length).toBeGreaterThan(0);
  });

  it("should mark REQ with @impl but no test as impl-only", () => {
    const coverage = computeCoverage(graph);
    const entry = coverage.find((c) => c.reqId === "AUTH-002");

    expect(entry).toBeDefined();
    expect(entry!.status).toBe("impl-only");
    expect(entry!.implFiles.length).toBeGreaterThan(0);
    expect(entry!.testFiles).toHaveLength(0);
  });

  it("should mark REQ without @impl as untagged", () => {
    const coverage = computeCoverage(graph);
    const entry = coverage.find((c) => c.reqId === "AUTH-003");

    expect(entry).toBeDefined();
    expect(entry!.status).toBe("untagged");
    expect(entry!.implFiles).toHaveLength(0);
    expect(entry!.testFiles).toHaveLength(0);
  });

  it("should return entries for all REQs", () => {
    const coverage = computeCoverage(graph);
    expect(coverage.length).toBeGreaterThanOrEqual(3);
  });
});
