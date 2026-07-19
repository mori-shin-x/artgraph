import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHooks } from "../../src/hooks/index.js";
import { runCli } from "../../src/cli.js";

// Dispatch-layer coverage (`src/hooks/index.ts`, issue #366 scope A) —
// exercised directly rather than through `runInit`, since these are unit
// concerns about the dispatch loop itself (which agents get an outcome, how
// per-agent outcomes aggregate into `anyFailure`), not the per-format
// writers' merge/conflict logic (covered in `json-event-array.test.ts` /
// `file-per-hook.test.ts`).

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "artgraph-hooks-dispatch-"));
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

describe("installHooks dispatch", () => {
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

  it("empty agentsList → perAgent: [], anyFailure: false", () => {
    const result = installHooks(tmp, [], "pnpm");
    expect(result).toEqual({ perAgent: [], anyFailure: false });
  });

  it("agentsList filters — only listed agents appear in perAgent, in the given order", () => {
    const result = installHooks(tmp, ["claude"], "pnpm");
    expect(result.perAgent.map((o) => o.agentId)).toEqual(["claude"]);
  });

  it("agents without a hook config (cursor, copilot) → skipped-no-hook-config", () => {
    const result = installHooks(tmp, ["cursor", "copilot"], "pnpm");
    expect(result.perAgent).toEqual([
      { agentId: "cursor", action: "skipped-no-hook-config", failure: false },
      { agentId: "copilot", action: "skipped-no-hook-config", failure: false },
    ]);
    expect(result.anyFailure).toBe(false);
  });

  it("execPrefix === null → every listed agent (with a hook config) is skipped-no-pm", () => {
    const result = installHooks(tmp, ["claude", "codex", "kiro"], null);
    expect(result.perAgent).toEqual([
      { agentId: "claude", action: "skipped-no-pm", failure: false },
      { agentId: "codex", action: "skipped-no-pm", failure: false },
      { agentId: "kiro", action: "skipped-no-pm", failure: false },
    ]);
    expect(result.anyFailure).toBe(false);
  });

  it("execPrefix === null still reports skipped-no-hook-config (not skipped-no-pm) for hookless agents", () => {
    // The `execPrefix === null` early-out only applies to agents that HAVE a
    // hook config to skip; an agent with no hook mechanism at all reports
    // its own reason regardless of PM detection.
    const result = installHooks(tmp, ["cursor"], null);
    expect(result.perAgent).toEqual([
      { agentId: "cursor", action: "skipped-no-hook-config", failure: false },
    ]);
  });

  it("HIGH-1: anyFailure aggregates across agents — one conflict flips the whole result", () => {
    // Pre-seed a claude settings.json with a populated hooks.Stop so its
    // outcome is a Case D conflict (failure: true); codex gets a fresh
    // install (failure: false). Before the per-agent shape (HIGH-1,
    // Step 0-pre), a single-outcome result let the later successful agent
    // silently overwrite the earlier failure.
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "t", type: "module" }));
    writeFileSync(join(tmp, "pnpm-lock.yaml"), "");
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(
      join(tmp, ".claude", "settings.json"),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo x" }] }] } }),
    );

    const result = installHooks(tmp, ["claude", "codex"], "pnpm");

    const claude = result.perAgent.find((o) => o.agentId === "claude");
    const codex = result.perAgent.find((o) => o.agentId === "codex");
    expect(claude?.action).toBe("conflict");
    expect(claude?.failure).toBe(true);
    expect(codex?.action).toBe("created");
    expect(codex?.failure).toBe(false);
    expect(result.anyFailure).toBe(true);
  });

  it("anyFailure stays false when every agent's outcome is non-failing", () => {
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "t", type: "module" }));
    writeFileSync(join(tmp, "pnpm-lock.yaml"), "");

    const result = installHooks(tmp, ["claude", "codex", "kiro"], "pnpm");

    expect(result.perAgent.every((o) => o.failure !== true)).toBe(true);
    expect(result.anyFailure).toBe(false);
  });
});

// MEDIUM-3 (Step 0-pre) — CLI × multiple-agents integration coverage. The
// tests above call `installHooks()` directly (data layer only); the
// `json-event-array.test.ts` runCli test exercises a single agent. Neither
// covers `commands/init.ts`'s per-agent `for` loop + `process.exitCode`
// aggregation end-to-end through `runCli`, so a regression there (e.g. a
// stray `break`/`continue`, or the exit-code check landing before the loop
// finishes) would not be caught. Style follows the runCli test in
// `tests/hooks/json-event-array.test.ts` (Case D via CLI --force).
describe("runCli init — multiple agents (MEDIUM-3)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-hooks-cli-multi-"));
  });

  afterEach(() => {
    cleanup(tmp);
  });

  it("claude conflict + codex created: exitCode 1, per-agent stdout/stderr both surface", async () => {
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "t", type: "module" }));
    writeFileSync(join(tmp, "pnpm-lock.yaml"), "");
    // claude: pre-seed an existing Stop hook so its install is a Case D conflict.
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(
      join(tmp, ".claude", "settings.json"),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo x" }] }] } }),
    );
    // codex: no existing .codex/hooks.json — install should succeed (created).
    expect(existsSync(join(tmp, ".codex", "hooks.json"))).toBe(false);

    const r = await runCli(["init", "--force", "--agents=claude,codex", "--no-scan"], {
      cwd: tmp,
    });

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("[WARN] [claude]");
    expect(r.stdout).toContain("[codex] Created");
    // claude's file must be untouched by the conflict (never overwritten,
    // even with --force); codex's file must now exist.
    expect(
      JSON.parse(readFileSync(join(tmp, ".claude", "settings.json"), "utf-8")).hooks.Stop[0]
        .hooks[0].command,
    ).toBe("echo x");
    expect(existsSync(join(tmp, ".codex", "hooks.json"))).toBe(true);
  });
});
