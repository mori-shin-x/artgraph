// issue #335 (Step 0-pre HIGH-1, implementation 1 point 3) — intentional,
// documented behavior change: the markdown spec-file loop used to call the
// `glob` package's `globSync` directly, which defaults to `follow: false`
// (symlinked directories are NOT descended into for `**` matching). Now
// routed through `src/glob-utils.ts`'s `listFilesGuarded`, which pins fast-
// glob's own default `followSymbolicLinks: true` — a symlinked spec
// subdirectory (and the .md files inside it) is now picked up by a scan.
// This is a deliberate, CHANGELOG-relevant behavior change (see
// docs/commands.md), not a bug — pinned here so a future regression back to
// `follow: false` semantics is caught.
import { describe, expect, it, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph } from "../src/graph/builder.js";
import type { ArtgraphConfig } from "../src/types.js";

const IS_WIN = process.platform === "win32";

const cfg: ArtgraphConfig = {
  include: [],
  specDirs: ["specs"],
  testPatterns: [],
  lockFile: ".trace.lock",
};

// Windows symlink creation requires elevated privileges / developer mode —
// skipped there like every other symlink-dependent test in this suite (see
// tests/lock.test.ts's precedent).
describe.skipIf(IS_WIN)("buildGraph: markdown-side glob follows symlinks (issue #335)", () => {
  let root: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("a symlinked spec SUBDIRECTORY is descended into and its .md files are ingested", () => {
    root = mkdtempSync(join(tmpdir(), "artgraph-symlink-specdir-"));
    // The real files live OUTSIDE the specDir the glob pattern targets...
    mkdirSync(join(root, "real-specs"), { recursive: true });
    writeFileSync(
      join(root, "real-specs", "linked.md"),
      "# Linked spec\n\n- REQSYM-501: needs coverage\n",
    );
    // ...and are reachable ONLY via a symlinked subdirectory under `specs/`.
    mkdirSync(join(root, "specs"), { recursive: true });
    symlinkSync(join(root, "real-specs"), join(root, "specs", "linked"), "dir");

    const { graph, warnings } = buildGraph(root, cfg);

    expect(graph.nodes.has("REQSYM-501")).toBe(true);
    expect(warnings.some((w) => w.type === "system-resource-exhausted")).toBe(false);
  });

  it("a symlinked .md FILE directly under a specDir is ingested (unchanged from before #335 — symlinked leaves already matched)", () => {
    root = mkdtempSync(join(tmpdir(), "artgraph-symlink-specfile-"));
    mkdirSync(join(root, "elsewhere"), { recursive: true });
    writeFileSync(
      join(root, "elsewhere", "real.md"),
      "# Real spec\n\n- REQSYM-502: needs coverage\n",
    );
    mkdirSync(join(root, "specs"), { recursive: true });
    symlinkSync(join(root, "elsewhere", "real.md"), join(root, "specs", "linked.md"), "file");

    const { graph } = buildGraph(root, cfg);

    expect(graph.nodes.has("REQSYM-502")).toBe(true);
  });
});
