// spec 014 — Phase 4 (US1) tests for `resolveSpecDir`.
// Contract: specs/014-reinvent-impact-cli/contracts/cli-flags.md
// (`artgraph plan-coverage --spec` lookup order) and FR-014.
//
// Lookup precedence under test:
//   1. explicit `--spec` flag value (if provided)
//   2. SPECIFY_FEATURE_DIRECTORY environment variable
//   3. .specify/feature.json#feature_directory
//   4. error (Kiro requires --spec; canonical lookup unavailable)

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { resolveSpecDir } from "../src/plan-coverage/spec-resolver.js";

function makeTmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "artgraph-pc-resolver-"));
}

describe("resolveSpecDir — explicit --spec wins everything", () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpRoot();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns the absolute explicit path verbatim when given", () => {
    const dir = join(root, ".specify/specs/explicit");
    mkdirSync(dir, { recursive: true });
    const result = resolveSpecDir({
      explicitFlag: dir,
      env: { SPECIFY_FEATURE_DIRECTORY: "/should/be/ignored" },
      repoRoot: root,
    });
    expect("dir" in result).toBe(true);
    if ("dir" in result) expect(result.dir).toBe(dir);
  });

  it("resolves a relative explicit path against repoRoot", () => {
    const rel = ".specify/specs/relative";
    mkdirSync(join(root, rel), { recursive: true });
    const result = resolveSpecDir({
      explicitFlag: rel,
      env: {},
      repoRoot: root,
    });
    expect("dir" in result).toBe(true);
    if ("dir" in result) {
      expect(result.dir).toBe(resolvePath(root, rel));
    }
  });
});

describe("resolveSpecDir — SPECIFY_FEATURE_DIRECTORY env var", () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpRoot();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("uses the env var when --spec is absent", () => {
    const dir = join(root, ".specify/specs/from-env");
    mkdirSync(dir, { recursive: true });
    const result = resolveSpecDir({
      env: { SPECIFY_FEATURE_DIRECTORY: dir },
      repoRoot: root,
    });
    expect("dir" in result).toBe(true);
    if ("dir" in result) expect(result.dir).toBe(dir);
  });

  it("resolves a relative env-var path against repoRoot", () => {
    const rel = "specs/014-reinvent-impact-cli";
    mkdirSync(join(root, rel), { recursive: true });
    const result = resolveSpecDir({
      env: { SPECIFY_FEATURE_DIRECTORY: rel },
      repoRoot: root,
    });
    expect("dir" in result).toBe(true);
    if ("dir" in result) expect(result.dir).toBe(resolvePath(root, rel));
  });

  it("ignores empty env var value and falls through", () => {
    // Empty string env vars do exist in real CI shells. Per the Spec Kit
    // canonical lookup they should be treated as unset.
    const result = resolveSpecDir({
      env: { SPECIFY_FEATURE_DIRECTORY: "" },
      repoRoot: root,
    });
    expect("error" in result).toBe(true);
  });
});

describe("resolveSpecDir — .specify/feature.json fallback", () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpRoot();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reads feature_directory from .specify/feature.json", () => {
    const dir = join(root, ".specify/specs/from-file");
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(root, ".specify"), { recursive: true });
    writeFileSync(
      join(root, ".specify/feature.json"),
      JSON.stringify({ feature_directory: dir }),
    );
    const result = resolveSpecDir({ env: {}, repoRoot: root });
    expect("dir" in result).toBe(true);
    if ("dir" in result) expect(result.dir).toBe(dir);
  });

  it("resolves a relative feature_directory value against repoRoot", () => {
    const rel = ".specify/specs/014";
    mkdirSync(join(root, rel), { recursive: true });
    mkdirSync(join(root, ".specify"), { recursive: true });
    writeFileSync(
      join(root, ".specify/feature.json"),
      JSON.stringify({ feature_directory: rel }),
    );
    const result = resolveSpecDir({ env: {}, repoRoot: root });
    expect("dir" in result).toBe(true);
    if ("dir" in result) expect(result.dir).toBe(resolvePath(root, rel));
  });

  it("returns error when feature.json is malformed JSON", () => {
    mkdirSync(join(root, ".specify"), { recursive: true });
    writeFileSync(join(root, ".specify/feature.json"), "{ broken json");
    const result = resolveSpecDir({ env: {}, repoRoot: root });
    // Malformed file shouldn't crash — fall through to the error branch.
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/--spec/);
  });

  it("returns error when feature.json lacks feature_directory key", () => {
    mkdirSync(join(root, ".specify"), { recursive: true });
    writeFileSync(
      join(root, ".specify/feature.json"),
      JSON.stringify({ some_other_key: "value" }),
    );
    const result = resolveSpecDir({ env: {}, repoRoot: root });
    expect("error" in result).toBe(true);
  });
});

describe("resolveSpecDir — error path (Kiro / no Spec Kit)", () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpRoot();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns a Kiro-aware error when nothing resolves", () => {
    const result = resolveSpecDir({ env: {}, repoRoot: root });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      // Contract requires "use --spec to point at .specify/specs/<name>/
      // or .kiro/specs/<name>/" guidance.
      expect(result.error).toMatch(/--spec/);
      expect(result.error).toMatch(/\.specify\/specs/);
      expect(result.error).toMatch(/\.kiro\/specs/);
    }
  });

  it("precedence: explicit beats env beats file", () => {
    // All three sources are present; explicit must win.
    const explicit = join(root, ".specify/specs/explicit");
    const envDir = join(root, ".specify/specs/env");
    const fileDir = join(root, ".specify/specs/file");
    for (const d of [explicit, envDir, fileDir]) mkdirSync(d, { recursive: true });
    mkdirSync(join(root, ".specify"), { recursive: true });
    writeFileSync(
      join(root, ".specify/feature.json"),
      JSON.stringify({ feature_directory: fileDir }),
    );

    const result = resolveSpecDir({
      explicitFlag: explicit,
      env: { SPECIFY_FEATURE_DIRECTORY: envDir },
      repoRoot: root,
    });
    expect("dir" in result).toBe(true);
    if ("dir" in result) expect(result.dir).toBe(explicit);
  });
});
