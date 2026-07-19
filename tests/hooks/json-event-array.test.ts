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
      // Path-guarded so the mock only trips the hooks writer's writeAtomic on
      // `settings.json.tmp` / `hooks.json.tmp` — NOT spec 013's
      // `atomicWriteFile(.artgraph.json)` or `lock.ts`'s `.trace.lock.tmp`,
      // which use renameSync too. Without this guard, the writeAtomic tests
      // would blow up on an unrelated write before ever asserting on
      // hooksInstall.
      const src = String(args[0] ?? "");
      if (
        renameControl.shouldThrow &&
        (src.endsWith("settings.json.tmp") || src.endsWith("hooks.json.tmp"))
      ) {
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
import { runInit, type InitResult } from "../../src/init.js";
import { execPrefix, type PackageManager } from "../../src/package-manager.js";
import { runCli } from "../../src/cli.js";
import type { AgentId } from "../../src/agents/descriptors.js";

// Comprehensive coverage of the "json-event-array" hook writer's 4-case
// Stop-hook merge (`src/hooks/json-event-array.ts`, generalized by issue
// #366 scope A from the original Claude-only `installHooks()` — see
// specs/012-skills-expansion/contracts/settings-merge.md and plan §8, issue
// #109). The writer itself is not exported; it is exercised exclusively
// through runInit()/runCli(["init", ...]) and the resulting
// InitResult.hooksInstall.perAgent / on-disk config file state.
//
// Parametrized across every agent that uses this format (Claude Code,
// Codex CLI) so the two config files (`.claude/settings.json`,
// `.codex/hooks.json`) get identical coverage of the merge/conflict/error
// cases — the underlying writer is format-shared, only the target path and
// event key differ per agent.

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "artgraph-hooks-"));
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
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

/** Extract this agent's outcome out of the new per-agent `hooksInstall` shape. */
function outcomeFor(result: InitResult, agentId: AgentId) {
  return result.hooksInstall?.perAgent.find((o) => o.agentId === agentId);
}

type AgentFixture = { agentId: AgentId; relPath: [string, string] };

const AGENT_FIXTURES: AgentFixture[] = [
  { agentId: "claude", relPath: [".claude", "settings.json"] },
  { agentId: "codex", relPath: [".codex", "hooks.json"] },
];

describe.each(AGENT_FIXTURES)("json-event-array hook writer ($agentId)", ({ agentId, relPath }) => {
  let tmp: string;
  let errSpy: ReturnType<typeof vi.spyOn>;

  function configPath(dir: string): string {
    return join(dir, ...relPath);
  }

  beforeEach(() => {
    tmp = makeTmpDir();
    // detectPackageManager() writes "ERROR: Cannot detect package manager..."
    // to stderr whenever no PM signal is present; several cases below
    // intentionally exercise that path. Silence it so test output stays
    // clean (the warning content itself is covered by package-manager
    // tests).
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
    cleanup(tmp);
  });

  // -- Case A --------------------------------------------------------------

  it("Case A: no config file → created with the rendered Stop hook command", () => {
    seedPm(tmp, "pnpm");

    const result = runInit(tmp, { noScan: true, agents: [agentId] });

    const p = configPath(tmp);
    expect(existsSync(p)).toBe(true);
    const raw = readFileSync(p, "utf-8");
    // Loud-fail guard: substitution must have fully resolved — no leftover
    // {{...}} placeholders in the written file.
    expect(raw).not.toContain("{{");
    const parsed = JSON.parse(raw);
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe(`${execPrefix("pnpm")} check --gate --diff`);
    expect(outcomeFor(result, agentId)).toEqual({
      agentId,
      action: "created",
      failure: false,
    });
  });

  // -- Case B ----------------------------------------------------------------

  it("Case B: pre-seeded {} with other top-level fields → Stop added, fields preserved", () => {
    seedPm(tmp, "pnpm");
    mkdirSync(join(tmp, relPath[0]), { recursive: true });
    writeFileSync(configPath(tmp), JSON.stringify({ permissions: { allow: ["Bash"] } }));

    const result = runInit(tmp, { noScan: true, agents: [agentId] });

    const parsed = JSON.parse(readFileSync(configPath(tmp), "utf-8"));
    expect(parsed.permissions).toEqual({ allow: ["Bash"] });
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe(`${execPrefix("pnpm")} check --gate --diff`);
    expect(outcomeFor(result, agentId)?.action).toBe("merged-b");
    expect(outcomeFor(result, agentId)?.failure).toBe(false);
  });

  // -- Case C ----------------------------------------------------------------

  it("Case C: pre-seeded hooks.PreToolUse → Stop added, PreToolUse preserved", () => {
    seedPm(tmp, "pnpm");
    mkdirSync(join(tmp, relPath[0]), { recursive: true });
    const preToolUse = [{ hooks: [{ type: "command", command: "echo pre" }] }];
    writeFileSync(configPath(tmp), JSON.stringify({ hooks: { PreToolUse: preToolUse } }));

    const result = runInit(tmp, { noScan: true, agents: [agentId] });

    const parsed = JSON.parse(readFileSync(configPath(tmp), "utf-8"));
    expect(parsed.hooks.PreToolUse).toEqual(preToolUse);
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe(`${execPrefix("pnpm")} check --gate --diff`);
    expect(outcomeFor(result, agentId)?.action).toBe("merged-c");
    expect(outcomeFor(result, agentId)?.failure).toBe(false);
  });

  // -- Case D ------------------------------------------------------------------

  it("Case D: existing hooks.Stop → file byte-identical, conflict + failure", () => {
    seedPm(tmp, "pnpm");
    mkdirSync(join(tmp, relPath[0]), { recursive: true });
    const before = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo x" }] }] },
    });
    writeFileSync(configPath(tmp), before);

    const result = runInit(tmp, { noScan: true, force: true, agents: [agentId] });

    expect(readFileSync(configPath(tmp), "utf-8")).toBe(before);
    expect(outcomeFor(result, agentId)?.action).toBe("conflict");
    expect(outcomeFor(result, agentId)?.failure).toBe(true);
  });

  it("Case D via CLI --force: exit code 1, config untouched, .artgraph.json still (re-)written", async () => {
    seedPm(tmp, "pnpm");
    mkdirSync(join(tmp, relPath[0]), { recursive: true });
    const before = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo x" }] }] },
    });
    writeFileSync(configPath(tmp), before);

    const r = await runCli(["init", "--force", `--agents=${agentId}`], { cwd: tmp });

    expect(r.exitCode).toBe(1);
    expect(readFileSync(configPath(tmp), "utf-8")).toBe(before);
    expect(existsSync(join(tmp, ".artgraph.json"))).toBe(true);
    // .artgraph.json is a valid, freshly (re-)written config despite the
    // Stop-hook conflict — hooks failure must not block config/skills.
    const config = JSON.parse(readFileSync(join(tmp, ".artgraph.json"), "utf-8"));
    expect(config.packageManager).toBe("pnpm");
  });

  // -- Invalid JSON --------------------------------------------------------------

  it("invalid JSON: pre-seeded 'not a json' → invalid-json, failure, file unchanged", () => {
    seedPm(tmp, "pnpm");
    mkdirSync(join(tmp, relPath[0]), { recursive: true });
    writeFileSync(configPath(tmp), "not a json");

    const result = runInit(tmp, { noScan: true, force: true, agents: [agentId] });

    expect(readFileSync(configPath(tmp), "utf-8")).toBe("not a json");
    expect(outcomeFor(result, agentId)?.action).toBe("invalid-json");
    expect(outcomeFor(result, agentId)?.failure).toBe(true);
  });

  // -- H9: array-shaped `hooks` field ---------------------------------------------

  it("hooks field is an array → invalid-json, failure, file untouched (H9)", () => {
    // Before H9, a `hooks: []` field slipped past the `typeof === "object"`
    // check (arrays ARE objects in JS), then Case B/C would wholesale
    // replace it with `{Stop: [...]}` and silently discard the array. That's
    // information loss — reject the shape up front instead.
    seedPm(tmp, "pnpm");
    mkdirSync(join(tmp, relPath[0]), { recursive: true });
    const before = JSON.stringify({ hooks: [{ Stop: "surprise" }] });
    writeFileSync(configPath(tmp), before);

    const result = runInit(tmp, { noScan: true, force: true, agents: [agentId] });

    expect(outcomeFor(result, agentId)?.action).toBe("invalid-json");
    expect(outcomeFor(result, agentId)?.failure).toBe(true);
    // File must be byte-identical — the original array content survives.
    expect(readFileSync(configPath(tmp), "utf-8")).toBe(before);
  });

  // -- MEDIUM-2: empty-array `hooks` field ----------------------------------------

  it("hooks field is an EMPTY array → falls through to Case A/B merge, not invalid-json (MEDIUM-2)", () => {
    // Unlike a non-empty array (H9, which encodes real data that would be
    // silently destroyed by a wholesale overwrite), `hooks: []` carries no
    // data — it's syntactically valid JSON and behaviorally equivalent to
    // "no hooks yet" (Case A/B). Before MEDIUM-2 this was misdiagnosed as
    // invalid-json even though nothing would have been lost by merging.
    seedPm(tmp, "pnpm");
    mkdirSync(join(tmp, relPath[0]), { recursive: true });
    writeFileSync(configPath(tmp), JSON.stringify({ hooks: [] }));

    const result = runInit(tmp, { noScan: true, force: true, agents: [agentId] });

    expect(outcomeFor(result, agentId)?.action).toBe("merged-b");
    expect(outcomeFor(result, agentId)?.failure).toBe(false);
    const parsed = JSON.parse(readFileSync(configPath(tmp), "utf-8"));
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe(`${execPrefix("pnpm")} check --gate --diff`);
  });

  // -- BOM ------------------------------------------------------------------------

  it("BOM-prefixed existing config parses OK (Case B result)", () => {
    seedPm(tmp, "pnpm");
    mkdirSync(join(tmp, relPath[0]), { recursive: true });
    writeFileSync(configPath(tmp), "﻿{}");

    const result = runInit(tmp, { noScan: true, force: true, agents: [agentId] });

    const parsed = JSON.parse(readFileSync(configPath(tmp), "utf-8"));
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe(`${execPrefix("pnpm")} check --gate --diff`);
    expect(outcomeFor(result, agentId)?.action).toBe("merged-b");
    expect(outcomeFor(result, agentId)?.failure).toBe(false);
  });

  // -- Non-regular-file guards ------------------------------------------------------

  it("config path is a directory → io-error, failure, left untouched", () => {
    seedPm(tmp, "pnpm");
    mkdirSync(configPath(tmp), { recursive: true });

    const result = runInit(tmp, { noScan: true, agents: [agentId] });

    expect(outcomeFor(result, agentId)?.action).toBe("io-error");
    expect(outcomeFor(result, agentId)?.failure).toBe(true);
    expect(statSync(configPath(tmp)).isDirectory()).toBe(true);
  });

  it("config path is a symlink → io-error, failure, symlink left untouched", () => {
    seedPm(tmp, "pnpm");
    mkdirSync(join(tmp, relPath[0]), { recursive: true });
    symlinkSync(join(tmp, "elsewhere-target.json"), configPath(tmp));

    const result = runInit(tmp, { noScan: true, agents: [agentId] });

    expect(outcomeFor(result, agentId)?.action).toBe("io-error");
    expect(outcomeFor(result, agentId)?.failure).toBe(true);
    expect(lstatSync(configPath(tmp)).isSymbolicLink()).toBe(true);
  });

  // -- Regression guards: non-conflicting hooks.Stop shapes --------------------------

  describe.each([
    ["empty array", []],
    ["empty object", {}],
    ["non-array number", 42],
  ] as const)("hooks.Stop = %s (not a populated array)", (_label, stopValue) => {
    it("is overwritten (Case B/C path), not treated as a conflict", () => {
      seedPm(tmp, "pnpm");
      mkdirSync(join(tmp, relPath[0]), { recursive: true });
      writeFileSync(
        configPath(tmp),
        JSON.stringify({ hooks: { Stop: stopValue, PreToolUse: [] } }),
      );

      const result = runInit(tmp, { noScan: true, force: true, agents: [agentId] });

      expect(outcomeFor(result, agentId)?.action).not.toBe("conflict");
      expect(outcomeFor(result, agentId)?.failure).toBeFalsy();
      const parsed = JSON.parse(readFileSync(configPath(tmp), "utf-8"));
      expect(parsed.hooks.Stop[0].hooks[0].command).toBe(
        `${execPrefix("pnpm")} check --gate --diff`,
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
    mkdirSync(join(tmp, relPath[0]), { recursive: true });
    writeFileSync(configPath(tmp), JSON.stringify({ hooks: { Stop: [] } }));

    const result = runInit(tmp, { noScan: true, force: true, agents: [agentId] });

    expect(outcomeFor(result, agentId)?.action).toBe("merged-b");
    expect(outcomeFor(result, agentId)?.failure).toBe(false);
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

      runInit(tmp, { noScan: true, agents: [agentId] });

      const parsed = JSON.parse(readFileSync(configPath(tmp), "utf-8"));
      const command: string = parsed.hooks.Stop[0].hooks[0].command;
      expect(command.startsWith(execPrefix(pm))).toBe(true);
      expect(command).toBe(`${execPrefix(pm)} check --gate --diff`);
    });
  });

  // -- PM detection failure -----------------------------------------------------------

  it("PM undetectable + default full setup → skipped-no-pm, not a failure", () => {
    // No package.json, no lockfile, no deno marker anywhere in tmp.
    const result = runInit(tmp, { noScan: true, agents: [agentId] });

    expect(existsSync(configPath(tmp))).toBe(false);
    expect(outcomeFor(result, agentId)?.action).toBe("skipped-no-pm");
    expect(outcomeFor(result, agentId)?.failure).toBe(false);
  });

  // -- .artgraph.json#packageManager fallback ------------------------------------------

  it("falls back to the stored .artgraph.json#packageManager once the lockfile/package.json are gone", () => {
    seedPm(tmp, "pnpm");

    // First run: live pnpm-lock.yaml → .artgraph.json records packageManager: "pnpm",
    // and the Stop hook is installed (Case A).
    runInit(tmp, { noScan: true, agents: [agentId] });
    expect(JSON.parse(readFileSync(join(tmp, ".artgraph.json"), "utf-8")).packageManager).toBe(
      "pnpm",
    );
    expect(existsSync(configPath(tmp))).toBe(true);

    // Remove every live PM signal AND the previously-installed config file
    // so the second run must fall back to the stored config value and hit
    // Case A again (not Case D).
    rmSync(join(tmp, "pnpm-lock.yaml"));
    rmSync(join(tmp, "package.json"));
    rmSync(configPath(tmp));

    const result = runInit(tmp, { noScan: true, force: true, agents: [agentId] });

    // config file was removed above, so this is a fresh Case A write — the
    // key assertion is that it used the *stored* PM (pnpm) rather than
    // failing outright now that live detection is inconclusive.
    expect(outcomeFor(result, agentId)?.action).toBe("created");
    expect(existsSync(configPath(tmp))).toBe(true);
    const parsed = JSON.parse(readFileSync(configPath(tmp), "utf-8"));
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe(`${execPrefix("pnpm")} check --gate --diff`);
  });

  // -- --no-hooks --------------------------------------------------------------------

  it("--no-hooks preserves an existing config byte-for-byte and reports no hooksInstall", () => {
    seedPm(tmp, "pnpm");
    mkdirSync(join(tmp, relPath[0]), { recursive: true });
    const before = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo x" }] }] },
    });
    writeFileSync(configPath(tmp), before);

    const result = runInit(tmp, { noScan: true, noHooks: true, force: true, agents: [agentId] });

    expect(readFileSync(configPath(tmp), "utf-8")).toBe(before);
    expect(result.hooksInstall).toBeUndefined();
  });

  // -- default mode in an empty dir -----------------------------------------------------

  it("default mode creates the config file when it doesn't exist yet", () => {
    seedPm(tmp, "pnpm");
    expect(existsSync(join(tmp, relPath[0]))).toBe(false);

    const result = runInit(tmp, { noScan: true, agents: [agentId] });

    expect(existsSync(configPath(tmp))).toBe(true);
    expect(outcomeFor(result, agentId)?.action).toBe("created");
    const parsed = JSON.parse(readFileSync(configPath(tmp), "utf-8"));
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe(`${execPrefix("pnpm")} check --gate --diff`);
  });

  // -- A3: Case D reason SSOT (rendered template body) -----------------------------

  it("A3: Case D reason mirrors the rendered template command (not a hard-coded literal)", () => {
    // The Case D warning tells the user which command to paste into their
    // hooks.Stop. If this reason string ever drifted from what Cases A/B/C
    // write, the user would be told to paste something different from what
    // artgraph actually wants — silently. Assert that the reason we emit is
    // literally the rendered template body, including whatever suffix the
    // current template carries.
    seedPm(tmp, "pnpm");
    mkdirSync(join(tmp, relPath[0]), { recursive: true });
    writeFileSync(
      configPath(tmp),
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: "command", command: "echo x" }] }] },
      }),
    );

    const result = runInit(tmp, { noScan: true, force: true, agents: [agentId] });

    expect(outcomeFor(result, agentId)?.action).toBe("conflict");
    expect(outcomeFor(result, agentId)?.reason).toBe(`${execPrefix("pnpm")} check --gate --diff`);
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
      mkdirSync(join(tmp, relPath[0]), { recursive: true });
      writeFileSync(configPath(tmp), JSON.stringify({ permissions: { allow: ["Bash"] } }));

      renameControl.shouldThrow = true;
      let result;
      try {
        result = runInit(tmp, { noScan: true, force: true, agents: [agentId] });
      } finally {
        renameControl.shouldThrow = false;
      }

      expect(outcomeFor(result, agentId)?.action).toBe("io-error");
      expect(outcomeFor(result, agentId)?.failure).toBe(true);
      expect(existsSync(`${configPath(tmp)}.tmp`)).toBe(false);
    });

    it("Case A: renameSync throw leaves no orphan .tmp file", () => {
      seedPm(tmp, "pnpm");

      renameControl.shouldThrow = true;
      let result;
      try {
        result = runInit(tmp, { noScan: true, agents: [agentId] });
      } finally {
        renameControl.shouldThrow = false;
      }

      expect(outcomeFor(result, agentId)?.action).toBe("io-error");
      expect(outcomeFor(result, agentId)?.failure).toBe(true);
      expect(existsSync(`${configPath(tmp)}.tmp`)).toBe(false);
    });

    it("Case A: pre-existing symlink at <config>.tmp is cleaned before write", () => {
      // Symlink-attack surface: if an attacker pre-plants a symlink at the
      // predictable `<config>.tmp` path pointing at a sensitive file,
      // `writeFileSync` would follow it and clobber the target. writeAtomic
      // must remove that symlink first (unlinkSync removes the link, not
      // the target).
      seedPm(tmp, "pnpm");
      mkdirSync(join(tmp, relPath[0]), { recursive: true });
      const attackTarget = join(tmp, "innocent-victim.txt");
      writeFileSync(attackTarget, "do not clobber me\n");
      symlinkSync(attackTarget, `${configPath(tmp)}.tmp`);

      const result = runInit(tmp, { noScan: true, agents: [agentId] });

      expect(outcomeFor(result, agentId)?.action).toBe("created");
      // The victim file is untouched — writeAtomic removed the symlink
      // instead of writing through it.
      expect(readFileSync(attackTarget, "utf-8")).toBe("do not clobber me\n");
      // And the real config file is a plain regular file, not a symlink.
      expect(lstatSync(configPath(tmp)).isSymbolicLink()).toBe(false);
    });
  });

  // -- D1: lstat "never throws" contract on EACCES ---------------------------------

  it("D1: lstat EACCES on parent dir → io-error, not an uncaught throw", () => {
    // The hooks writer's JSDoc guarantees "never throws". Before D1,
    // `lstatSync({ throwIfNoEntry: false })` still threw on EACCES / EPERM
    // / ELOOP because the option only suppresses ENOENT. On non-root Linux
    // we can reproduce EACCES by dropping execute permission on the parent
    // dir so lstat on a file inside it fails. When we can't simulate that
    // (root user / non-Unix FS), skip gracefully — the contract is still
    // enforced by the try/catch code path + tsc.
    //
    // Skips Skills distribution (`noSkills`) so the chmod'd parent dir
    // (which, for Claude, is also the Skills target `.claude/skills/`)
    // doesn't make the Skills stage throw before we can exercise the
    // hooks-writer lstat path.
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return;
    }
    seedPm(tmp, "pnpm");
    const parentDir = join(tmp, relPath[0]);
    mkdirSync(parentDir, { recursive: true });
    writeFileSync(configPath(tmp), "{}");
    chmodSync(parentDir, 0o000);

    let result;
    try {
      result = runInit(tmp, { noScan: true, force: true, agents: [agentId], noSkills: true });
    } finally {
      // Always restore so afterEach's rmSync can descend into the dir.
      chmodSync(parentDir, 0o755);
    }

    // Whatever the failure mode, it must be a structured `io-error` — not
    // an escaped exception that took down the whole init.
    expect(outcomeFor(result, agentId)?.action).toBe("io-error");
    expect(outcomeFor(result, agentId)?.failure).toBe(true);
  });
});
