import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../src/init.js";
import { execPrefix, type PackageManager } from "../src/package-manager.js";
import { runCli } from "../src/cli.js";

// Comprehensive coverage of installHooks' 4-case Stop-hook merge, per
// specs/012-skills-expansion/contracts/settings-merge.md and plan §8
// (issue #109). installHooks itself is not exported; it is exercised
// exclusively through runInit()/runCli(["init", ...]) and the resulting
// InitResult.hooksInstall / on-disk .claude/settings.json state.

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "artgraph-hooks-"));
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

function settingsPath(tmp: string): string {
  return join(tmp, ".claude", "settings.json");
}

/** Seed package.json + a matching lockfile/config so PM detection resolves to `pm`. */
function seedPm(tmp: string, pm: PackageManager): void {
  if (pm !== "deno") {
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "t", type: "module" }));
  }
  switch (pm) {
    case "npm":
      writeFileSync(join(tmp, "package-lock.json"), "{}");
      break;
    case "pnpm":
      writeFileSync(join(tmp, "pnpm-lock.yaml"), "");
      break;
    case "bun":
      writeFileSync(join(tmp, "bun.lock"), "");
      break;
    case "deno":
      writeFileSync(join(tmp, "deno.json"), "{}");
      break;
  }
}

describe("installHooks (Stop-hook merge)", () => {
  let tmp: string;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = makeTmpDir();
    // detectPackageManager() writes "ERROR: Cannot detect package manager..."
    // to stderr whenever no PM signal is present; several cases below
    // intentionally exercise that path. Silence it so test output stays clean
    // (the warning content itself is covered by package-manager tests).
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
    cleanup(tmp);
  });

  // -- Case A ----------------------------------------------------------------

  it("Case A: no settings.json → created with the rendered Stop hook command", () => {
    seedPm(tmp, "pnpm");

    const result = runInit(tmp, { noScan: true });

    const p = settingsPath(tmp);
    expect(existsSync(p)).toBe(true);
    const raw = readFileSync(p, "utf-8");
    // Loud-fail guard: substitution must have fully resolved — no leftover
    // {{...}} placeholders in the written file.
    expect(raw).not.toContain("{{");
    const parsed = JSON.parse(raw);
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe(
      `${execPrefix("pnpm")} check --gate --diff`,
    );
    expect(result.hooksInstall).toEqual({ action: "created", failure: false });
  });

  // -- Case B ------------------------------------------------------------------

  it("Case B: pre-seeded {} with other top-level fields → Stop added, fields preserved", () => {
    seedPm(tmp, "pnpm");
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(
      settingsPath(tmp),
      JSON.stringify({ permissions: { allow: ["Bash"] } }),
    );

    const result = runInit(tmp, { noScan: true });

    const parsed = JSON.parse(readFileSync(settingsPath(tmp), "utf-8"));
    expect(parsed.permissions).toEqual({ allow: ["Bash"] });
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe(
      `${execPrefix("pnpm")} check --gate --diff`,
    );
    expect(result.hooksInstall?.action).toBe("merged-b");
    expect(result.hooksInstall?.failure).toBe(false);
  });

  // -- Case C ------------------------------------------------------------------

  it("Case C: pre-seeded hooks.PreToolUse → Stop added, PreToolUse preserved", () => {
    seedPm(tmp, "pnpm");
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    const preToolUse = [{ hooks: [{ type: "command", command: "echo pre" }] }];
    writeFileSync(
      settingsPath(tmp),
      JSON.stringify({ hooks: { PreToolUse: preToolUse } }),
    );

    const result = runInit(tmp, { noScan: true });

    const parsed = JSON.parse(readFileSync(settingsPath(tmp), "utf-8"));
    expect(parsed.hooks.PreToolUse).toEqual(preToolUse);
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe(
      `${execPrefix("pnpm")} check --gate --diff`,
    );
    expect(result.hooksInstall?.action).toBe("merged-c");
    expect(result.hooksInstall?.failure).toBe(false);
  });

  // -- Case D ------------------------------------------------------------------

  it("Case D: existing hooks.Stop → file byte-identical, conflict + failure", () => {
    seedPm(tmp, "pnpm");
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    const before = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo x" }] }] },
    });
    writeFileSync(settingsPath(tmp), before);

    const result = runInit(tmp, { noScan: true, force: true });

    expect(readFileSync(settingsPath(tmp), "utf-8")).toBe(before);
    expect(result.hooksInstall?.action).toBe("conflict");
    expect(result.hooksInstall?.failure).toBe(true);
  });

  it("Case D via CLI --force: exit code 1, settings.json untouched, .artgraph.json still (re-)written", async () => {
    seedPm(tmp, "pnpm");
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    const before = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo x" }] }] },
    });
    writeFileSync(settingsPath(tmp), before);

    const r = await runCli(["init", "--force"], { cwd: tmp });

    expect(r.exitCode).toBe(1);
    expect(readFileSync(settingsPath(tmp), "utf-8")).toBe(before);
    expect(existsSync(join(tmp, ".artgraph.json"))).toBe(true);
    // .artgraph.json is a valid, freshly (re-)written config despite the
    // Stop-hook conflict — hooks failure must not block config/skills.
    const config = JSON.parse(readFileSync(join(tmp, ".artgraph.json"), "utf-8"));
    expect(config.packageManager).toBe("pnpm");
  });

  // -- Invalid JSON --------------------------------------------------------------

  it("invalid JSON: pre-seeded 'not a json' → invalid-json, failure, file unchanged", () => {
    seedPm(tmp, "pnpm");
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(settingsPath(tmp), "not a json");

    const result = runInit(tmp, { noScan: true, force: true });

    expect(readFileSync(settingsPath(tmp), "utf-8")).toBe("not a json");
    expect(result.hooksInstall?.action).toBe("invalid-json");
    expect(result.hooksInstall?.failure).toBe(true);
  });

  // -- BOM ------------------------------------------------------------------------

  it("BOM-prefixed existing settings.json parses OK (Case B result)", () => {
    seedPm(tmp, "pnpm");
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(settingsPath(tmp), "﻿{}");

    const result = runInit(tmp, { noScan: true, force: true });

    const parsed = JSON.parse(readFileSync(settingsPath(tmp), "utf-8"));
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe(
      `${execPrefix("pnpm")} check --gate --diff`,
    );
    expect(result.hooksInstall?.action).toBe("merged-b");
    expect(result.hooksInstall?.failure).toBe(false);
  });

  // -- Non-regular-file guards ------------------------------------------------------

  it(".claude/settings.json is a directory → io-error, failure, left untouched", () => {
    seedPm(tmp, "pnpm");
    mkdirSync(settingsPath(tmp), { recursive: true });

    const result = runInit(tmp, { noScan: true });

    expect(result.hooksInstall?.action).toBe("io-error");
    expect(result.hooksInstall?.failure).toBe(true);
    expect(statSync(settingsPath(tmp)).isDirectory()).toBe(true);
  });

  it(".claude/settings.json is a symlink → io-error, failure, symlink left untouched", () => {
    seedPm(tmp, "pnpm");
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    symlinkSync(join(tmp, "elsewhere-target.json"), settingsPath(tmp));

    const result = runInit(tmp, { noScan: true });

    expect(result.hooksInstall?.action).toBe("io-error");
    expect(result.hooksInstall?.failure).toBe(true);
    expect(lstatSync(settingsPath(tmp)).isSymbolicLink()).toBe(true);
  });

  // -- Regression guards: non-conflicting hooks.Stop shapes --------------------------

  describe.each([
    ["empty array", []],
    ["empty object", {}],
    ["non-array number", 42],
  ] as const)("hooks.Stop = %s (not a populated array)", (_label, stopValue) => {
    it("is overwritten (Case B/C path), not treated as a conflict", () => {
      seedPm(tmp, "pnpm");
      mkdirSync(join(tmp, ".claude"), { recursive: true });
      writeFileSync(
        settingsPath(tmp),
        JSON.stringify({ hooks: { Stop: stopValue, PreToolUse: [] } }),
      );

      const result = runInit(tmp, { noScan: true, force: true });

      expect(result.hooksInstall?.action).not.toBe("conflict");
      expect(result.hooksInstall?.failure).toBeFalsy();
      const parsed = JSON.parse(readFileSync(settingsPath(tmp), "utf-8"));
      expect(parsed.hooks.Stop[0].hooks[0].command).toBe(
        `${execPrefix("pnpm")} check --gate --diff`,
      );
    });
  });

  // -- PM matrix --------------------------------------------------------------------

  describe.each([
    ["npm", "package-lock.json"],
    ["pnpm", "pnpm-lock.yaml"],
    ["bun", "bun.lock"],
    ["deno", "deno.json"],
  ] as const)("PM detection: %s (via %s)", (pm, _lockfile) => {
    it(`renders the Stop hook command with ${pm}'s exec prefix`, () => {
      seedPm(tmp, pm);

      runInit(tmp, { noScan: true });

      const parsed = JSON.parse(readFileSync(settingsPath(tmp), "utf-8"));
      const command: string = parsed.hooks.Stop[0].hooks[0].command;
      expect(command.startsWith(execPrefix(pm))).toBe(true);
      expect(command).toBe(`${execPrefix(pm)} check --gate --diff`);
    });
  });

  // -- PM detection failure -----------------------------------------------------------

  it("PM undetectable + default full setup → skipped-no-pm, not a failure", () => {
    // No package.json, no lockfile, no deno marker anywhere in tmp.
    const result = runInit(tmp, { noScan: true });

    expect(existsSync(settingsPath(tmp))).toBe(false);
    expect(result.hooksInstall?.action).toBe("skipped-no-pm");
    expect(result.hooksInstall?.failure).toBe(false);
  });

  it("PM undetectable + --minimal --with-hooks (explicit opt-in) → skipped-no-pm, failure", () => {
    const result = runInit(tmp, { minimal: true, withHooks: true });

    expect(existsSync(settingsPath(tmp))).toBe(false);
    expect(result.hooksInstall?.action).toBe("skipped-no-pm");
    expect(result.hooksInstall?.failure).toBe(true);
  });

  // -- .artgraph.json#packageManager fallback ------------------------------------------

  it("falls back to the stored .artgraph.json#packageManager once the lockfile/package.json are gone", () => {
    seedPm(tmp, "pnpm");

    // First run: live pnpm-lock.yaml → .artgraph.json records packageManager: "pnpm",
    // and the Stop hook is installed (Case A).
    runInit(tmp, { noScan: true });
    expect(
      JSON.parse(readFileSync(join(tmp, ".artgraph.json"), "utf-8")).packageManager,
    ).toBe("pnpm");
    expect(existsSync(settingsPath(tmp))).toBe(true);

    // Remove every live PM signal AND the previously-installed settings.json
    // so the second run must fall back to the stored config value and hit
    // Case A again (not Case D).
    rmSync(join(tmp, "pnpm-lock.yaml"));
    rmSync(join(tmp, "package.json"));
    rmSync(settingsPath(tmp));

    const result = runInit(tmp, { noScan: true, force: true });

    // settings.json was removed above, so this is a fresh Case A write —
    // the key assertion is that it used the *stored* PM (pnpm) rather than
    // failing outright now that live detection is inconclusive.
    expect(result.hooksInstall?.action).toBe("created");
    expect(existsSync(settingsPath(tmp))).toBe(true);
    const parsed = JSON.parse(readFileSync(settingsPath(tmp), "utf-8"));
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe(
      `${execPrefix("pnpm")} check --gate --diff`,
    );
  });

  // -- --no-hooks --------------------------------------------------------------------

  it("--no-hooks preserves an existing settings.json byte-for-byte and reports no hooksInstall", () => {
    seedPm(tmp, "pnpm");
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    const before = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo x" }] }] },
    });
    writeFileSync(settingsPath(tmp), before);

    const result = runInit(tmp, { noScan: true, noHooks: true, force: true });

    expect(readFileSync(settingsPath(tmp), "utf-8")).toBe(before);
    expect(result.hooksInstall).toBeUndefined();
  });

  // -- --minimal --with-hooks in an empty dir ------------------------------------------

  it("--minimal --with-hooks creates .claude/settings.json when .claude/ doesn't exist yet", () => {
    seedPm(tmp, "pnpm");
    expect(existsSync(join(tmp, ".claude"))).toBe(false);

    const result = runInit(tmp, { minimal: true, withHooks: true });

    expect(existsSync(settingsPath(tmp))).toBe(true);
    expect(result.hooksInstall?.action).toBe("created");
    const parsed = JSON.parse(readFileSync(settingsPath(tmp), "utf-8"));
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe(
      `${execPrefix("pnpm")} check --gate --diff`,
    );
  });
});
