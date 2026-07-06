// End-to-end smoke tests that spawn the *built* `dist/cli.js`. The rest
// of the suite invokes `runCli` in-process from src — that's fast but
// blind to whether the bin-entry guard (`import.meta.url === entryHref`)
// fires when Node resolves a symlink to the real script (PR #99 regression
// surface — npm/pnpm install hands users a symlinked bin shim).
//
// These tests reuse the perf suite's vitest config (singleFork +
// fileParallelism:false) via tests/e2e/vitest config, so the spawned bin
// never fights worker CPU.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const CLI = resolve(REPO_ROOT, "dist/cli.js");
const PKG_VERSION = (
  JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8")) as {
    version: string;
  }
).version;

describe("e2e: real bin invocation", () => {
  it("direct-path `node dist/cli.js --version` prints the version", () => {
    const r = spawnSync("node", [CLI, "--version"], { encoding: "utf-8", timeout: 15000 });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(PKG_VERSION);
  });

  it("symlinked bin shim resolves and parses argv (PR #99 regression guard)", () => {
    // Reproduce npm/pnpm bin-shim layout: `node_modules/.bin/artgraph`
    // is a symlink whose target is `../<pkg>/dist/cli.js`. Node's ESM
    // loader resolves the script via realpath, so `import.meta.url`
    // points at the real `dist/cli.js`, while `process.argv[1]` stays
    // as the symlink path. The bin-entry guard MUST normalize both sides
    // with realpath; otherwise the script imports its modules and exits
    // silently without parsing argv.
    const dir = mkdtempSync(join(tmpdir(), "artgraph-bin-shim-"));
    try {
      const shim = join(dir, "artgraph-shim");
      symlinkSync(CLI, shim);
      const r = spawnSync("node", [shim, "--version"], { encoding: "utf-8", timeout: 15000 });
      expect(r.status).toBe(0);
      // The critical assertion: stdout must contain the version. A
      // broken guard would exit 0 with empty stdout (silent failure).
      expect(r.stdout.trim()).toBe(PKG_VERSION);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Heavy variant — actually `npm pack` + install into a temp dir and run
// the bin via the npm-installed shim. Skipped by default because pack +
// install takes ~10–30s and adds little signal on top of the symlink
// smoke above. Enable with ARTGRAPH_E2E_PACK=1 (used by the release
// workflow before npm publish).
const RUN_PACK = process.env.ARTGRAPH_E2E_PACK === "1";
describe.skipIf(!RUN_PACK)("e2e: npm pack + install", () => {
  let workDir: string;
  let pkgDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "artgraph-pack-"));
    // `pnpm pack` writes a tarball into workDir; npm install --no-save
    // unpacks it into a sibling node_modules layout.
    const pack = spawnSync("pnpm", ["pack", "--pack-destination", workDir], {
      encoding: "utf-8",
      cwd: REPO_ROOT,
      timeout: 120000,
    });
    if (pack.status !== 0) {
      throw new Error(`pnpm pack failed: ${pack.stderr}`);
    }
    const tgz = pack.stdout.trim().split("\n").pop();
    if (!tgz || !existsSync(tgz)) {
      throw new Error(`pnpm pack did not produce a tarball (stdout: ${pack.stdout})`);
    }
    pkgDir = join(workDir, "consumer");
    const install = spawnSync("npm", ["init", "-y"], { cwd: workDir, encoding: "utf-8" });
    if (install.status !== 0) throw new Error(`npm init failed: ${install.stderr}`);
    const add = spawnSync("npm", ["install", "--no-save", "--no-package-lock", tgz], {
      cwd: workDir,
      encoding: "utf-8",
      timeout: 180000,
    });
    if (add.status !== 0) throw new Error(`npm install failed: ${add.stderr}`);
    pkgDir = workDir;
  });

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("`./node_modules/.bin/artgraph --version` works after npm install", () => {
    const binShim = join(pkgDir, "node_modules", ".bin", "artgraph");
    expect(existsSync(binShim)).toBe(true);
    const r = spawnSync(binShim, ["--version"], { encoding: "utf-8", timeout: 30000 });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(PKG_VERSION);
  });
});
