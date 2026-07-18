// issue #335 (Step 0-pre HIGH-1, implementation 1 point 3) — intentional,
// documented behavior change: the markdown spec-file loop used to call the
// `glob` package's `globSync` directly. Now routed through
// `src/glob-utils.ts`'s `listFilesGuarded`, which pins fast-glob's own
// `followSymbolicLinks: true` default.
//
// PR #339 meta-review (F4) — corrects an earlier, too-broad claim here: the
// `glob` package was NOT blind to symlinked directories before this change.
// A SINGLE-HOP symlinked spec subdirectory was already descended into under
// `glob`'s own `follow: false` default — `**` expansion's bash-mimicking
// spec unconditionally allows the first symlink hop regardless of `follow`.
// The real, narrower behavior change is: (a) a symlink CHAIN of two or more
// hops — `glob` stopped descending after the first hop, fast-glob's
// `followSymbolicLinks: true` tracks every hop, and (b) a symlink LOOP —
// `glob` converged after one hop, fast-glob descends until the OS's own
// loop boundary (Linux `ELOOP`, `MAXSYMLINKS` = 40; measured ~17ms for a
// looped fixture, no hang), producing more `duplicate-id` warning noise
// than before. See docs/configuration.md for the CHANGELOG-relevant note.
// Pinned here so a future regression back to `glob`'s single-hop-only
// semantics is caught — which is why the first test below uses a two-hop
// chain: a single-hop fixture would still pass under the OLD code too and
// would not actually guard against this regression.
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

  it("a symlink CHAIN of two hops under specDir is fully tracked and its .md files are ingested (PR #339 meta-review F4)", () => {
    root = mkdtempSync(join(tmpdir(), "artgraph-symlink-specdir-"));
    // The real files live OUTSIDE the specDir the glob pattern targets...
    mkdirSync(join(root, "real-specs"), { recursive: true });
    writeFileSync(
      join(root, "real-specs", "linked.md"),
      "# Linked spec\n\n- REQSYM-501: needs coverage\n",
    );
    // ...reachable via a TWO-HOP symlink chain: `specs/linked` -> `mid` ->
    // `real-specs`. A single-hop-only glob (the pre-#339-doc-fix understanding
    // of the old `glob` package's behavior) would resolve the first hop
    // (`specs/linked` -> `mid`) but never follow `mid`'s OWN symlink onward to
    // `real-specs`, so it would never reach `linked.md`. A single-hop fixture
    // would pass under BOTH the old and new code and would not be a real
    // regression guard — this two-hop chain is.
    symlinkSync(join(root, "real-specs"), join(root, "mid"), "dir");
    mkdirSync(join(root, "specs"), { recursive: true });
    symlinkSync(join(root, "mid"), join(root, "specs", "linked"), "dir");

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
