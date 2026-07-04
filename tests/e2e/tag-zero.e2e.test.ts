// Tag-zero brownfield regression guard (issue #122 / growth-strategy §2 P0).
//
// The whole point of the "tag-zero" onboarding claim is:
//
//   > On an existing TS repo with **no** specs/, **no** `@impl` tags, and
//   > **no** spec.md files, `artgraph init && artgraph impact --diff` still
//   > returns the import transitive closure of the changed files.
//
// The mechanics are already in place — `ts-import` is a first-class edge
// provenance (src/types.ts), the TS parser emits it (src/parsers/typescript.ts),
// impact()'s BFS is bidirectional (src/graph/traverse.ts), and the `--diff`
// channel resolves file-unit entries without touching specs or lock. What was
// missing was a test that pins the whole chain end-to-end so a future refactor
// (e.g. requiring a spec node to seed startIds, or dropping `ts-import` from
// the default provenance set) can't silently kill the brownfield entry point.
//
// The suite spawns the built `dist/cli.js` in a throwaway git repo so we
// exercise the real binary, not the in-process CLI. If this test regresses,
// the README's "Tag-zero 30s" claim is a lie — fail loudly.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const CLI = resolve(REPO_ROOT, "dist/cli.js");

// `spawnSync` reports timeouts and spawn failures via `error`/`signal` with
// `status: null` — printing only `stdout`/`stderr` in that case yields an
// undiagnosable "exit null" failure message. Surface all four fields so a CI
// timeout or ENOENT is distinguishable from a genuine non-zero exit.
function cliFailureMessage(r: SpawnSyncReturns<string>): string {
  return `CLI failed: exit ${r.status} signal=${r.signal ?? "none"} error=${r.error?.message ?? "none"}\nstderr:\n${r.stderr}\nstdout:\n${r.stdout}`;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      // Deterministic identity so `git commit` works in CI containers that
      // don't have a global git config.
      GIT_AUTHOR_NAME: "artgraph-e2e",
      GIT_AUTHOR_EMAIL: "e2e@example.com",
      GIT_COMMITTER_NAME: "artgraph-e2e",
      GIT_COMMITTER_EMAIL: "e2e@example.com",
    },
  });
}

describe("e2e: tag-zero brownfield (issue #122)", () => {
  let workDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "artgraph-tag-zero-"));

    // Brownfield fixture: two TS files linked only by `import`. No specs/,
    // no @impl tag, no spec.md — the exact state of a repo where a user
    // just ran `npx artgraph init` for the first time.
    mkdirSync(join(workDir, "src"), { recursive: true });
    writeFileSync(
      join(workDir, "src", "a.ts"),
      `import { hello } from "./b";\nexport const greeting = hello();\n`,
      "utf-8",
    );
    writeFileSync(
      join(workDir, "src", "b.ts"),
      `export function hello(): string {\n  return "hi";\n}\n`,
      "utf-8",
    );
    writeFileSync(
      join(workDir, "package.json"),
      JSON.stringify({ name: "brownfield-fixture", version: "0.0.0", type: "module" }, null, 2),
      "utf-8",
    );

    // Baseline commit so `git diff` has something to diff against.
    git(workDir, "init", "-q", "-b", "main");
    git(workDir, "add", ".");
    git(workDir, "commit", "-q", "-m", "baseline");

    // Modify src/b.ts so `git diff --name-only` reports it as unstaged. This
    // is the file the user "just changed" in the 30-second demo.
    writeFileSync(
      join(workDir, "src", "b.ts"),
      `export function hello(): string {\n  return "hi there";\n}\n`,
      "utf-8",
    );
  });

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("`artgraph init` succeeds without any specs/ or @impl tags", () => {
    // `--force` makes this call idempotent. Without it, a vitest retry (see
    // `retry: 1` in vitest.e2e.config.ts) re-runs only this `it` body — not
    // `beforeAll` — so a second attempt would hit the pre-existing
    // `.artgraph.json` written by attempt 1 and fail with an unrelated
    // "already exists" error, masking whatever assertion actually triggered
    // the retry.
    const r = spawnSync("node", [CLI, "init", "--force"], {
      encoding: "utf-8",
      cwd: workDir,
      timeout: 30000,
    });
    // Zero specs must not fatal. The whole DoD is "init completes without
    // warning when there are no tags to find".
    expect(r.status, cliFailureMessage(r)).toBe(0);
    expect(existsSync(join(workDir, ".artgraph.json"))).toBe(true);
    // No `Error:` line and no stray stack trace on stderr.
    expect(r.stderr).not.toMatch(/^Error:/m);
    // The onboarding hint must reach the user via the built binary, not
    // just the in-process CLI tests. This is the message that sells the
    // tag-zero pitch to a first-time visitor.
    expect(r.stdout).toContain("Zero-tag ready");
    expect(r.stdout).toContain("artgraph impact --diff");
  });

  it("`artgraph impact --diff` returns the ts-import closure of the changed file", () => {
    const r = spawnSync("node", [CLI, "impact", "--diff", "--depth", "3"], {
      encoding: "utf-8",
      cwd: workDir,
      timeout: 30000,
    });
    expect(r.status, cliFailureMessage(r)).toBe(0);

    // The BFS from `file:src/b.ts` follows the reverse `imports` edge back to
    // `file:src/a.ts` because a.ts imports "./b". If this line ever stops
    // matching, the tag-zero claim is broken and README.md is a lie.
    expect(r.stdout).toContain("src/a.ts");
    expect(r.stdout).toContain("Affected Files:");
  });

  it("`artgraph impact --diff` in JSON mode lists a.ts in affectedFiles", () => {
    const r = spawnSync("node", [CLI, "impact", "--diff", "--depth", "3", "--format", "json"], {
      encoding: "utf-8",
      cwd: workDir,
      timeout: 30000,
    });
    expect(r.status, cliFailureMessage(r)).toBe(0);
    const parsed = JSON.parse(r.stdout) as { affectedFiles?: string[] };
    expect(Array.isArray(parsed.affectedFiles)).toBe(true);
    // Order-independent assertion — impact() has no documented file ordering.
    expect(parsed.affectedFiles).toEqual(
      expect.arrayContaining(["src/a.ts", "src/b.ts"]),
    );
  });
});
