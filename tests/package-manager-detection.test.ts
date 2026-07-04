import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    expect(buildExecCommand("pnpm", "check --diff")).toBe("pnpm exec artgraph check --diff");
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
    expect(buildExecCommand("npm", "  check --diff  ")).toBe("npx artgraph check --diff");
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

describe("detectPackageManager — packageManager field edge cases", () => {
  // Bare "<pm>" (no @version) is not a valid Corepack-style spec; the TS
  // detector requires `^([a-z]+)@`, and bash matches via the same regex via
  // `node -e`, so both must fall through to lockfile sniffing. Without the
  // fallthrough, `{ "packageManager": "npm" }` on a pnpm project would
  // mis-route the user to npm install commands.
  for (const bare of ["npm", "pnpm", "bun", "yarn"] as const) {
    it(`bare "${bare}" (no @version) falls through to default pnpm`, () => {
      pkg({ packageManager: bare });
      expect(detectPackageManager(dir)).toBe("pnpm");
      // Yarn fallthrough must NOT log the yarn warning — the field is
      // malformed, not a recognized yarn signal.
      expect(errSpy).not.toHaveBeenCalledWith(expect.stringMatching(/yarn is not supported/i));
    });
  }

  it("BOM-prefixed package.json still parses packageManager", () => {
    writeFileSync(
      join(dir, "package.json"),
      "﻿" + JSON.stringify({ name: "x", packageManager: "npm@10.0.0" }),
    );
    expect(detectPackageManager(dir)).toBe("npm");
  });

  it("BOM-prefixed package.json with no field still detects pnpm default", () => {
    writeFileSync(join(dir, "package.json"), "﻿" + JSON.stringify({ name: "x" }));
    expect(detectPackageManager(dir)).toBe("pnpm");
  });

  for (const value of ['"hello"', "[]", "null", "42"]) {
    it(`non-object JSON ${value} as package.json falls through`, () => {
      writeFileSync(join(dir, "package.json"), value);
      // No lockfile / deno marker, package.json is a "file" (statSync.isFile),
      // but it's non-object so packageManager parse returns null AND the
      // fallback `hasPkgJson` branch fires → pnpm default.
      expect(detectPackageManager(dir)).toBe("pnpm");
    });
  }
});

describe("detectPackageManager — directory-named lockfiles", () => {
  it("a directory named bun.lockb is NOT detected as bun (isFile guard)", () => {
    pkg();
    mkdirSync(join(dir, "bun.lockb"));
    // Falls through to pnpm default (package.json present, no real lockfile).
    expect(detectPackageManager(dir)).toBe("pnpm");
  });

  it("a directory named package-lock.json is NOT detected as npm", () => {
    pkg();
    mkdirSync(join(dir, "package-lock.json"));
    expect(detectPackageManager(dir)).toBe("pnpm");
  });

  it("a directory named package.json on its own is not treated as a Node project", () => {
    mkdirSync(join(dir, "package.json"));
    // No real package.json, no lockfile, no deno marker → null.
    expect(detectPackageManager(dir)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// SC-007 parity meta-test: extract the bash detect_package_manager function
// from templates/skills/_shared/package-manager.md and run it under bash on the
// same fixtures the TS detector sees. The two implementations MUST agree.
// -----------------------------------------------------------------------------

function extractBashDetect(): string {
  const md = readFileSync(
    join(__dirname, "..", "templates", "skills", "_shared", "package-manager.md"),
    "utf-8",
  );
  // The SSOT bash snippet sits inside a ```bash fenced block whose first
  // non-blank line is `detect_package_manager() {`. Pull the block body.
  const match = md.match(/```bash\n(detect_package_manager\(\)[\s\S]*?)\n```/);
  if (!match) throw new Error("could not find bash detect_package_manager in template");
  return match[1];
}

function runBashDetect(cwd: string): { stdout: string; status: number; stderr: string } {
  const fn = extractBashDetect();
  const script = `${fn}\ndetect_package_manager\n`;
  try {
    const stdout = execFileSync("bash", ["-c", script], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout: stdout.trim(), status: 0, stderr: "" };
  } catch (e) {
    const err = e as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    return {
      stdout: (err.stdout?.toString() ?? "").trim(),
      stderr: err.stderr?.toString() ?? "",
      status: err.status ?? 1,
    };
  }
}

describe("SC-007 bash↔TS parity (meta-test)", () => {
  // Each row: a fixture builder + the shared expectation for both runtimes.
  // `null` means: bash must exit non-zero with empty stdout; TS must return null.
  const fixtures: { label: string; build: () => void; expected: string | null }[] = [
    {
      label: "packageManager pnpm@9 → pnpm",
      build: () => pkg({ packageManager: "pnpm@9.0.0" }),
      expected: "pnpm",
    },
    {
      label: "packageManager npm@10 → npm",
      build: () => pkg({ packageManager: "npm@10.0.0" }),
      expected: "npm",
    },
    {
      label: "packageManager yarn@4 → pnpm (warn)",
      build: () => pkg({ packageManager: "yarn@4.0.0" }),
      expected: "pnpm",
    },
    {
      label: "bare 'npm' (no @) → pnpm default",
      build: () => pkg({ packageManager: "npm" }),
      expected: "pnpm",
    },
    {
      label: "bun.lockb only → bun",
      build: () => {
        pkg();
        write("bun.lockb");
      },
      expected: "bun",
    },
    {
      label: "no package.json + deno.json → deno",
      build: () => write("deno.json", "{}"),
      expected: "deno",
    },
    {
      label: "pnpm-lock.yaml only → pnpm",
      build: () => {
        pkg();
        write("pnpm-lock.yaml");
      },
      expected: "pnpm",
    },
    {
      label: "package-lock.json only → npm",
      build: () => {
        pkg();
        write("package-lock.json");
      },
      expected: "npm",
    },
    {
      label: "yarn.lock only → pnpm (warn)",
      build: () => {
        pkg();
        write("yarn.lock");
      },
      expected: "pnpm",
    },
    {
      label: "package.json only → pnpm default",
      build: () => pkg(),
      expected: "pnpm",
    },
    {
      label: "empty dir → null/error",
      build: () => {},
      expected: null,
    },
  ];

  for (const fx of fixtures) {
    it(`bash and TS agree: ${fx.label}`, () => {
      fx.build();
      const bash = runBashDetect(dir);
      const ts = detectPackageManager(dir);
      if (fx.expected === null) {
        expect(ts).toBeNull();
        expect(bash.status).not.toBe(0);
        expect(bash.stdout).toBe("");
      } else {
        expect(ts).toBe(fx.expected);
        expect(bash.status).toBe(0);
        expect(bash.stdout).toBe(fx.expected);
      }
    });
  }
});
