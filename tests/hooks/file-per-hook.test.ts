import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit, type InitResult } from "../../src/init.js";
import { execPrefix, type PackageManager } from "../../src/package-manager.js";
import type { AgentId } from "../../src/agents/descriptors.js";

// Coverage of the "file-per-hook" hook writer (`src/hooks/file-per-hook.ts`,
// issue #366 scope A) — Kiro IDE's `.kiro/hooks/artgraph-check.kiro.hook`.
// Unlike the json-event-array format there is no merge case: a pre-existing
// entry at the target path (regular file, symlink, or directory) is always a
// conflict, never overwritten even with --force (MEDIUM-2, Step 0-pre —
// symmetric with the Claude/Codex writer's Case D "never overwrite, even
// with --force").

const AGENT_ID: AgentId = "kiro";
const HOOK_REL_PATH = [".kiro", "hooks", "artgraph-check.kiro.hook"] as const;

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "artgraph-hooks-"));
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

function hookPath(tmp: string): string {
  return join(tmp, ...HOOK_REL_PATH);
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

function outcomeFor(result: InitResult) {
  return result.hooksInstall?.perAgent.find((o) => o.agentId === AGENT_ID);
}

describe("file-per-hook writer (kiro)", () => {
  let tmp: string;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = makeTmpDir();
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
    cleanup(tmp);
  });

  // -- (a) fresh install ------------------------------------------------------------

  it("fresh install writes .kiro/hooks/artgraph-check.kiro.hook", () => {
    seedPm(tmp, "pnpm");

    const result = runInit(tmp, { noScan: true, agents: [AGENT_ID] });

    const p = hookPath(tmp);
    expect(existsSync(p)).toBe(true);
    const raw = readFileSync(p, "utf-8");
    expect(raw).not.toContain("{{");
    const parsed = JSON.parse(raw);
    expect(parsed.then.command).toBe(`${execPrefix("pnpm")} check --gate --diff`);
    expect(parsed.when).toEqual({ type: "agentStop" });
    expect(outcomeFor(result)).toEqual({ agentId: AGENT_ID, action: "created", failure: false });
  });

  // -- (b) existing file (different content) → conflict, --force refuses too --------

  it("existing file with different content → conflict, --force still refuses", () => {
    seedPm(tmp, "pnpm");
    mkdirSync(join(tmp, ".kiro", "hooks"), { recursive: true });
    const before = "not the artgraph hook\n";
    writeFileSync(hookPath(tmp), before);

    const result = runInit(tmp, { noScan: true, force: true, agents: [AGENT_ID] });

    expect(readFileSync(hookPath(tmp), "utf-8")).toBe(before);
    expect(outcomeFor(result)?.action).toBe("conflict");
    expect(outcomeFor(result)?.failure).toBe(true);
  });

  // -- (c) symlink / directory at the target path → refused --------------------------

  it("symlink at the target path → conflict, symlink left untouched", () => {
    seedPm(tmp, "pnpm");
    mkdirSync(join(tmp, ".kiro", "hooks"), { recursive: true });
    symlinkSync(join(tmp, "elsewhere-target.json"), hookPath(tmp));

    const result = runInit(tmp, { noScan: true, agents: [AGENT_ID] });

    expect(outcomeFor(result)?.action).toBe("conflict");
    expect(outcomeFor(result)?.failure).toBe(true);
    expect(lstatSync(hookPath(tmp)).isSymbolicLink()).toBe(true);
  });

  it("directory at the target path → conflict, directory left untouched", () => {
    seedPm(tmp, "pnpm");
    mkdirSync(hookPath(tmp), { recursive: true });

    const result = runInit(tmp, { noScan: true, agents: [AGENT_ID] });

    expect(outcomeFor(result)?.action).toBe("conflict");
    expect(outcomeFor(result)?.failure).toBe(true);
    expect(lstatSync(hookPath(tmp)).isDirectory()).toBe(true);
  });

  // -- (d) EACCES → io-error, failure: true -------------------------------------------

  it("EACCES on the parent dir → io-error, not an uncaught throw", () => {
    // On non-root Linux we can reproduce EACCES by dropping execute
    // permission on the parent dir so lstat on a file inside it fails. When
    // we can't simulate that (root user / non-Unix FS), skip gracefully —
    // the contract is still enforced by the try/catch code path + tsc.
    //
    // Skips Skills distribution (`noSkills`) so the chmod'd `.kiro/hooks/`
    // ancestor doesn't make the Skills stage throw before we can exercise
    // the hooks-writer lstat path (Kiro's Skills target is `.kiro/skills/`,
    // a sibling of `.kiro/hooks/`, but `.kiro/` itself is also chmod'd here
    // since the hook lives one level deeper than settings.json/hooks.json).
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return;
    }
    seedPm(tmp, "pnpm");
    const hooksDir = join(tmp, ".kiro", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(hookPath(tmp), "{}");
    chmodSync(hooksDir, 0o000);

    let result;
    try {
      result = runInit(tmp, { noScan: true, force: true, agents: [AGENT_ID], noSkills: true });
    } finally {
      chmodSync(hooksDir, 0o755);
    }

    expect(outcomeFor(result)?.action).toBe("io-error");
    expect(outcomeFor(result)?.failure).toBe(true);
  });

  // -- LOW-1: rendered template must be valid JSON before writing (regression guard) --

  it("renders a well-formed JSON hook file (LOW-1 self-check)", () => {
    seedPm(tmp, "npm");

    runInit(tmp, { noScan: true, agents: [AGENT_ID] });

    // JSON.parse succeeding at all is the assertion — a malformed render
    // would have already surfaced as `io-error` above (writer catches its
    // own JSON.parse failure), so this is a happy-path confirmation that the
    // written bytes round-trip.
    expect(() => JSON.parse(readFileSync(hookPath(tmp), "utf-8"))).not.toThrow();
  });

  // -- --no-hooks --------------------------------------------------------------------

  it("--no-hooks reports no hooksInstall and writes nothing", () => {
    seedPm(tmp, "pnpm");

    const result = runInit(tmp, { noScan: true, noHooks: true, agents: [AGENT_ID] });

    expect(existsSync(hookPath(tmp))).toBe(false);
    expect(result.hooksInstall).toBeUndefined();
  });
});
