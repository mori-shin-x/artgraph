import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vitest ESM: `vi.spyOn(fs, "renameSync")` fails with "Cannot redefine property"
// because node:fs's exports are non-configurable. To simulate a renameSync
// failure for the B1+B2 cleanup tests we mock the module with a flag-gated
// pass-through. When `renameControl.shouldThrow` is false the real renameSync
// is used, so every other test in the suite is unaffected.
const renameControl = vi.hoisted(() => ({ shouldThrow: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (
      ...args: Parameters<typeof actual.renameSync>
    ): ReturnType<typeof actual.renameSync> => {
      if (renameControl.shouldThrow) {
        throw new Error("simulated rename failure");
      }
      return actual.renameSync(...args);
    },
  };
});

import {
  chmodSync,
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
      `${execPrefix("pnpm")} check --gate --diff --mode symbol`,
    );
    expect(result.hooksInstall).toEqual({ action: "created", failure: false });
  });

  // -- Case B ------------------------------------------------------------------

  it("Case B: pre-seeded {} with other top-level fields → Stop added, fields preserved", () => {
    seedPm(tmp, "pnpm");
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(settingsPath(tmp), JSON.stringify({ permissions: { allow: ["Bash"] } }));

    const result = runInit(tmp, { noScan: true });

    const parsed = JSON.parse(readFileSync(settingsPath(tmp), "utf-8"));
    expect(parsed.permissions).toEqual({ allow: ["Bash"] });
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe(
      `${execPrefix("pnpm")} check --gate --diff --mode symbol`,
    );
    expect(result.hooksInstall?.action).toBe("merged-b");
    expect(result.hooksInstall?.failure).toBe(false);
  });

  // -- Case C ------------------------------------------------------------------

  it("Case C: pre-seeded hooks.PreToolUse → Stop added, PreToolUse preserved", () => {
    seedPm(tmp, "pnpm");
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    const preToolUse = [{ hooks: [{ type: "command", command: "echo pre" }] }];
    writeFileSync(settingsPath(tmp), JSON.stringify({ hooks: { PreToolUse: preToolUse } }));

    const result = runInit(tmp, { noScan: true });

    const parsed = JSON.parse(readFileSync(settingsPath(tmp), "utf-8"));
    expect(parsed.hooks.PreToolUse).toEqual(preToolUse);
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe(
      `${execPrefix("pnpm")} check --gate --diff --mode symbol`,
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

  // -- H9: array-shaped `hooks` field ---------------------------------------------

  it("hooks field is an array → invalid-json, failure, file untouched (H9)", () => {
    // Before H9, a `hooks: []` field slipped past the `typeof === "object"`
    // check (arrays ARE objects in JS), then Case B/C would wholesale
    // replace it with `{Stop: [...]}` and silently discard the array. That's
    // information loss — reject the shape up front instead.
    seedPm(tmp, "pnpm");
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    const before = JSON.stringify({ hooks: [{ Stop: "surprise" }] });
    writeFileSync(settingsPath(tmp), before);

    const result = runInit(tmp, { noScan: true, force: true });

    expect(result.hooksInstall?.action).toBe("invalid-json");
    expect(result.hooksInstall?.failure).toBe(true);
    // File must be byte-identical — the original array content survives.
    expect(readFileSync(settingsPath(tmp), "utf-8")).toBe(before);
  });

  // -- BOM ------------------------------------------------------------------------

  it("BOM-prefixed existing settings.json parses OK (Case B result)", () => {
    seedPm(tmp, "pnpm");
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(settingsPath(tmp), "﻿{}");

    const result = runInit(tmp, { noScan: true, force: true });

    const parsed = JSON.parse(readFileSync(settingsPath(tmp), "utf-8"));
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe(
      `${execPrefix("pnpm")} check --gate --diff --mode symbol`,
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
        `${execPrefix("pnpm")} check --gate --diff --mode symbol`,
      );
    });
  });

  // -- C1: bare {hooks: {Stop: []}} must NOT tag as merged-c -----------------------

  it("C1: hooks.Stop present but no other hook keys → merged-b (not merged-c)", () => {
    // Before C1, `hadOtherHookKeys` counted `Stop` itself, so a
    // `{hooks: {Stop: []}}` seed reported "other hooks preserved" (merged-c)
    // even though the only pre-existing key was the placeholder Stop we
    // were about to overwrite.
    seedPm(tmp, "pnpm");
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(settingsPath(tmp), JSON.stringify({ hooks: { Stop: [] } }));

    const result = runInit(tmp, { noScan: true, force: true });

    expect(result.hooksInstall?.action).toBe("merged-b");
    expect(result.hooksInstall?.failure).toBe(false);
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
      expect(command).toBe(`${execPrefix(pm)} check --gate --diff --mode symbol`);
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

  it("E1: PM undetectable + default mode + --with-hooks → NOT a failure (redundant flag)", () => {
    // Under default mode, --with-hooks is redundant (hooks are already on)
    // and must NOT flip PM-missing into a failure. Before E1, passing
    // `withHooks: true` in default mode escalated skipped-no-pm → exit 1,
    // giving `init --with-hooks` and plain `init` opposite outcomes for
    // identical on-disk state.
    const result = runInit(tmp, { withHooks: true, noScan: true });

    expect(existsSync(settingsPath(tmp))).toBe(false);
    expect(result.hooksInstall?.action).toBe("skipped-no-pm");
    expect(result.hooksInstall?.failure).toBe(false);
  });

  // -- .artgraph.json#packageManager fallback ------------------------------------------

  it("falls back to the stored .artgraph.json#packageManager once the lockfile/package.json are gone", () => {
    seedPm(tmp, "pnpm");

    // First run: live pnpm-lock.yaml → .artgraph.json records packageManager: "pnpm",
    // and the Stop hook is installed (Case A).
    runInit(tmp, { noScan: true });
    expect(JSON.parse(readFileSync(join(tmp, ".artgraph.json"), "utf-8")).packageManager).toBe(
      "pnpm",
    );
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
      `${execPrefix("pnpm")} check --gate --diff --mode symbol`,
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
      `${execPrefix("pnpm")} check --gate --diff --mode symbol`,
    );
  });

  // -- A3: Case D reason SSOT (rendered template body) -----------------------------

  it("A3: Case D reason mirrors the rendered template command (not a hard-coded literal)", () => {
    // The Case D warning tells the user which command to paste into their
    // hooks.Stop. If this reason string ever drifted from what Cases A/B/C
    // write, the user would be told to paste something different from what
    // artgraph actually wants — silently. Assert that the reason we emit is
    // literally the rendered template body, including whatever suffix the
    // current template carries (--mode symbol today).
    seedPm(tmp, "pnpm");
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(
      settingsPath(tmp),
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: "command", command: "echo x" }] }] },
      }),
    );

    const result = runInit(tmp, { noScan: true, force: true });

    expect(result.hooksInstall?.action).toBe("conflict");
    expect(result.hooksInstall?.reason).toBe(
      `${execPrefix("pnpm")} check --gate --diff --mode symbol`,
    );
  });

  // -- B1+B2: writeAtomic .tmp cleanup on rename failure --------------------------

  describe("writeAtomic .tmp cleanup on failure", () => {
    afterEach(() => {
      // Belt-and-suspenders: reset the mock flag even if a test throws
      // before its own finally block runs.
      renameControl.shouldThrow = false;
    });

    it("Case B: renameSync throw leaves no orphan .tmp file", () => {
      // Simulate a rename failure (e.g. cross-device, EACCES on the parent
      // dir). writeAtomic must delete the `.tmp` it created so a partial
      // write doesn't linger on disk — this is the symmetric-cleanup half
      // of B1+B2 (previously only Case A cleaned up).
      seedPm(tmp, "pnpm");
      mkdirSync(join(tmp, ".claude"), { recursive: true });
      writeFileSync(settingsPath(tmp), JSON.stringify({ permissions: { allow: ["Bash"] } }));

      renameControl.shouldThrow = true;
      let result;
      try {
        result = runInit(tmp, { noScan: true, force: true });
      } finally {
        renameControl.shouldThrow = false;
      }

      expect(result.hooksInstall?.action).toBe("io-error");
      expect(result.hooksInstall?.failure).toBe(true);
      expect(existsSync(`${settingsPath(tmp)}.tmp`)).toBe(false);
    });

    it("Case A: renameSync throw leaves no orphan .tmp file", () => {
      seedPm(tmp, "pnpm");

      renameControl.shouldThrow = true;
      let result;
      try {
        result = runInit(tmp, { noScan: true });
      } finally {
        renameControl.shouldThrow = false;
      }

      expect(result.hooksInstall?.action).toBe("io-error");
      expect(result.hooksInstall?.failure).toBe(true);
      expect(existsSync(`${settingsPath(tmp)}.tmp`)).toBe(false);
    });

    it("Case A: pre-existing symlink at settings.json.tmp is cleaned before write", () => {
      // Symlink-attack surface: if an attacker pre-plants a symlink at
      // `settings.json.tmp` pointing at a sensitive file, `writeFileSync`
      // would follow it and clobber the target. writeAtomic must remove
      // that symlink first (unlinkSync removes the link, not the target).
      seedPm(tmp, "pnpm");
      mkdirSync(join(tmp, ".claude"), { recursive: true });
      const attackTarget = join(tmp, "innocent-victim.txt");
      writeFileSync(attackTarget, "do not clobber me\n");
      symlinkSync(attackTarget, `${settingsPath(tmp)}.tmp`);

      const result = runInit(tmp, { noScan: true });

      expect(result.hooksInstall?.action).toBe("created");
      // The victim file is untouched — writeAtomic removed the symlink
      // instead of writing through it.
      expect(readFileSync(attackTarget, "utf-8")).toBe("do not clobber me\n");
      // And the real settings.json is a plain regular file, not a symlink.
      expect(lstatSync(settingsPath(tmp)).isSymbolicLink()).toBe(false);
    });
  });

  // -- D1: lstat "never throws" contract on EACCES ---------------------------------

  it("D1: lstat EACCES on parent dir → io-error, not an uncaught throw", () => {
    // installHooks' JSDoc guarantees "never throws". Before D1,
    // `lstatSync({ throwIfNoEntry: false })` still threw on EACCES / EPERM
    // / ELOOP because the option only suppresses ENOENT. On non-root Linux
    // we can reproduce EACCES by dropping execute permission on the parent
    // dir so lstat on a file inside it fails. When we can't simulate that
    // (root user / non-Unix FS), skip gracefully — the contract is still
    // enforced by the try/catch code path + tsc.
    //
    // Uses `--minimal --with-hooks` so only the hooks stage runs; a full
    // default init would hit the same chmod'd `.claude` in installSkills
    // first and throw before we can exercise the lstat path.
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return;
    }
    seedPm(tmp, "pnpm");
    const claudeDir = join(tmp, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(settingsPath(tmp), "{}");
    chmodSync(claudeDir, 0o000);

    let result;
    try {
      result = runInit(tmp, { minimal: true, withHooks: true, force: true });
    } finally {
      // Always restore so afterEach's rmSync can descend into `.claude`.
      chmodSync(claudeDir, 0o755);
    }

    // Whatever the failure mode, it must be a structured `io-error` — not
    // an escaped exception that took down the whole init.
    expect(result.hooksInstall?.action).toBe("io-error");
    expect(result.hooksInstall?.failure).toBe(true);
  });
});

// -- E2-2: --no-integrate + --integrations conflict via CLI ------------------------

describe("init CLI: --no-integrate + --integrations conflict (E2-2)", () => {
  let tmp: string;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-cli-conflicts-"));
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("--no-integrate --integrations=speckit → exit 1 with 'mutually exclusive'", async () => {
    // Before E2-2, this pair silently dropped `--integrations` in default
    // mode and *reversed* into an opt-in under `--minimal`. Both surfaces
    // must now be flagged as a hard error before any fs writes occur.
    const r = await runCli(["init", "--no-integrate", "--integrations", "speckit"], { cwd: tmp });

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/mutually exclusive/);
    // No writes happened because the check runs before runInit.
    expect(existsSync(join(tmp, ".artgraph.json"))).toBe(false);
  });

  it("--no-integrate --integrations=all → exit 1 with 'mutually exclusive'", async () => {
    const r = await runCli(["init", "--no-integrate", "--integrations", "all"], { cwd: tmp });

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/mutually exclusive/);
    expect(existsSync(join(tmp, ".artgraph.json"))).toBe(false);
  });

  it("--no-integrate --integrations='' (empty) is NOT a conflict (parseInitIntegrations collapses to undefined)", async () => {
    // Empty / whitespace / ",,," inputs collapse to undefined, which is
    // semantically "no provider chosen" — indistinguishable from omitting
    // the flag. Must not trigger the mutual-exclusion check.
    const r = await runCli(["init", "--no-integrate", "--integrations", "", "--minimal"], {
      cwd: tmp,
    });

    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toMatch(/mutually exclusive/);
    expect(existsSync(join(tmp, ".artgraph.json"))).toBe(true);
  });
});
