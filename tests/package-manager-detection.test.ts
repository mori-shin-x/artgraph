import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectPackageManager,
  buildExecCommand,
  buildInstallCommand,
} from "../src/package-manager.js";

// Truth table fixtures per
// specs/015-pkg-mgr-agnostic/contracts/package-manager.md §1 (SC-001).

let dir: string;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pm-detect-"));
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, content = "") => writeFileSync(join(dir, name), content);
const pkg = (extra: Record<string, unknown> = {}) =>
  write("package.json", JSON.stringify({ name: "x", ...extra }));

describe("detectPackageManager — truth table (SC-001)", () => {
  it("1a: packageManager field pnpm@* → pnpm", () => {
    pkg({ packageManager: "pnpm@9.0.0" });
    expect(detectPackageManager(dir)).toBe("pnpm");
  });

  it("1b: packageManager field bun@* → bun", () => {
    pkg({ packageManager: "bun@1.1.0" });
    expect(detectPackageManager(dir)).toBe("bun");
  });

  it("1c: packageManager field npm@* → npm", () => {
    pkg({ packageManager: "npm@10.0.0" });
    expect(detectPackageManager(dir)).toBe("npm");
  });

  it("1d: packageManager field yarn@* → pnpm + warn", () => {
    pkg({ packageManager: "yarn@4.0.0" });
    expect(detectPackageManager(dir)).toBe("pnpm");
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/yarn/i));
  });

  it("2a: bun.lockb → bun", () => {
    pkg();
    write("bun.lockb");
    expect(detectPackageManager(dir)).toBe("bun");
  });

  it("2a: bun.lock (text) → bun", () => {
    pkg();
    write("bun.lock");
    expect(detectPackageManager(dir)).toBe("bun");
  });

  it("2b: no package.json + deno.json → deno", () => {
    write("deno.json", "{}");
    expect(detectPackageManager(dir)).toBe("deno");
  });

  it("2b: no package.json + deno.lock → deno", () => {
    write("deno.lock");
    expect(detectPackageManager(dir)).toBe("deno");
  });

  it("2c: pnpm-lock.yaml → pnpm", () => {
    pkg();
    write("pnpm-lock.yaml");
    expect(detectPackageManager(dir)).toBe("pnpm");
  });

  it("2d: yarn.lock → pnpm + warn", () => {
    pkg();
    write("yarn.lock");
    expect(detectPackageManager(dir)).toBe("pnpm");
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/yarn/i));
  });

  it("2e: package-lock.json → npm (explicit npm signal)", () => {
    pkg();
    write("package-lock.json");
    expect(detectPackageManager(dir)).toBe("npm");
  });

  it("3: package.json only (no signal) → pnpm default", () => {
    pkg();
    expect(detectPackageManager(dir)).toBe("pnpm");
  });

  it("4: empty dir (no package.json / lockfile / deno) → null + warn", () => {
    expect(detectPackageManager(dir)).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/cannot detect/i));
  });

  it("deno is ignored when package.json is present (Node project wins)", () => {
    pkg();
    write("deno.json", "{}");
    // No deno lockfile branch fires; falls through to pnpm default.
    expect(detectPackageManager(dir)).toBe("pnpm");
  });

  it("first-match: bun.lockb beats pnpm-lock.yaml", () => {
    pkg();
    write("bun.lockb");
    write("pnpm-lock.yaml");
    expect(detectPackageManager(dir)).toBe("bun");
  });

  it("malformed packageManager field falls through to lockfile sniff", () => {
    pkg({ packageManager: "not-a-pm" });
    write("pnpm-lock.yaml");
    expect(detectPackageManager(dir)).toBe("pnpm");
  });

  it("field wins over a conflicting lockfile (corepack convention)", () => {
    pkg({ packageManager: "pnpm@9" });
    write("package-lock.json");
    expect(detectPackageManager(dir)).toBe("pnpm");
  });
});

describe("buildExecCommand (SC-003, contracts §2)", () => {
  it("maps each PM to its exec prefix", () => {
    expect(buildExecCommand("npm", "check --diff")).toBe("npx artgraph check --diff");
    expect(buildExecCommand("pnpm", "check --diff")).toBe(
      "pnpm exec artgraph check --diff",
    );
    expect(buildExecCommand("bun", "check --diff")).toBe("bunx artgraph check --diff");
    expect(buildExecCommand("deno", "check --diff")).toBe(
      "deno run -A npm:artgraph/cli check --diff",
    );
  });

  it("omits trailing space when subcommand is empty", () => {
    expect(buildExecCommand("pnpm")).toBe("pnpm exec artgraph");
    expect(buildExecCommand("pnpm", "  ")).toBe("pnpm exec artgraph");
    // Empty subcommand with a multi-word prefix must not leave a trailing space.
    expect(buildExecCommand("deno")).toBe("deno run -A npm:artgraph/cli");
  });

  it("trims surrounding whitespace around the subcommand", () => {
    expect(buildExecCommand("npm", "  check --diff  ")).toBe(
      "npx artgraph check --diff",
    );
  });
});

describe("buildInstallCommand (contracts §3)", () => {
  it("maps each PM to its dev-dep install command", () => {
    expect(buildInstallCommand("npm")).toBe("npm install -D artgraph");
    expect(buildInstallCommand("pnpm")).toBe("pnpm add -D artgraph");
    expect(buildInstallCommand("bun")).toBe("bun add -d artgraph");
    expect(buildInstallCommand("deno")).toBe("deno add npm:artgraph");
  });
});
