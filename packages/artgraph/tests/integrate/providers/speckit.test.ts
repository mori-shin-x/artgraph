import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SpecKitProvider } from "../../../src/integrate/providers/speckit.js";
import * as atomicWriteMod from "../../../src/integrate/atomic-write.js";

const FIXTURES = resolve(import.meta.dirname, "../../fixtures/integrate");

function copyFixture(src: string, dest: string): void {
  cpSync(src, dest, { recursive: true });
}

describe("SpecKitProvider", () => {
  let tmp: string;
  let provider: SpecKitProvider;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-us1-prov-"));
    provider = new SpecKitProvider();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("detect", () => {
    it("returns true when .specify/ exists", () => {
      mkdirSync(join(tmp, ".specify"));
      expect(provider.detect(tmp)).toBe(true);
    });

    it("returns false when .specify/ is absent", () => {
      expect(provider.detect(tmp)).toBe(false);
    });
  });

  describe("isInstalled", () => {
    it("returns false on a fresh .specify/ repo", () => {
      copyFixture(join(FIXTURES, "specify-empty"), tmp);
      expect(provider.isInstalled(tmp)).toBe(false);
    });

    it("returns false when installed list has spectrace but extension.yml missing (partial)", () => {
      copyFixture(join(FIXTURES, "specify-empty"), tmp);
      writeFileSync(
        join(tmp, ".specify/extensions.yml"),
        `installed:\n- agent-context\n- spectrace\nsettings:\n  auto_execute_hooks: true\nhooks: {}\n`,
      );
      expect(provider.isInstalled(tmp)).toBe(false);
    });

    it("returns true when both installed list and extension.yml exist", () => {
      copyFixture(join(FIXTURES, "specify-already-installed"), tmp);
      expect(provider.isInstalled(tmp)).toBe(true);
    });
  });

  describe("install", () => {
    it("throws when .specify/ is not detected, leaving disk unchanged", () => {
      expect(() => provider.install(tmp, {})).toThrow(/not detected/i);
      // tmpdir should remain empty
      expect(existsSync(join(tmp, ".specify"))).toBe(false);
    });

    it("creates the extension directory and updates extensions.yml on fresh install", () => {
      copyFixture(join(FIXTURES, "specify-empty"), tmp);
      const result = provider.install(tmp, {});
      expect(result.noop).toBe(false);
      expect(existsSync(join(tmp, ".specify/extensions/spectrace/extension.yml"))).toBe(true);
      expect(existsSync(join(tmp, ".specify/extensions/spectrace/README.md"))).toBe(true);
      expect(
        existsSync(join(tmp, ".specify/extensions/spectrace/commands/artgraph.scan-reconcile.md")),
      ).toBe(true);
      const yml = readFileSync(join(tmp, ".specify/extensions.yml"), "utf-8");
      expect(yml).toMatch(/installed:[\s\S]*- spectrace/);
      expect(yml).toMatch(/after_tasks:/);
      expect(yml).toMatch(/after_implement:/);
    });

    it("is idempotent: second install with same opts is noop and disk unchanged", () => {
      copyFixture(join(FIXTURES, "specify-empty"), tmp);
      provider.install(tmp, {});
      const yml1 = readFileSync(join(tmp, ".specify/extensions.yml"), "utf-8");
      const ext1 = readFileSync(join(tmp, ".specify/extensions/spectrace/extension.yml"), "utf-8");
      const result2 = provider.install(tmp, {});
      expect(result2.noop).toBe(true);
      const yml2 = readFileSync(join(tmp, ".specify/extensions.yml"), "utf-8");
      const ext2 = readFileSync(join(tmp, ".specify/extensions/spectrace/extension.yml"), "utf-8");
      expect(yml2).toBe(yml1);
      expect(ext2).toBe(ext1);
    });

    it("--force overwrites existing extension files", () => {
      copyFixture(join(FIXTURES, "specify-already-installed"), tmp);
      writeFileSync(
        join(tmp, ".specify/extensions/spectrace/extension.yml"),
        'schema_version: "1.0"\n# manually edited\n',
      );
      const result = provider.install(tmp, { force: true });
      expect(result.noop).toBe(false);
      const content = readFileSync(
        join(tmp, ".specify/extensions/spectrace/extension.yml"),
        "utf-8",
      );
      expect(content).not.toContain("# manually edited");
      expect(content).toMatch(/spectrace/);
    });

    it("--gate=true adds before_implement spectrace hook entry", () => {
      copyFixture(join(FIXTURES, "specify-empty"), tmp);
      provider.install(tmp, { gate: true });
      const yml = readFileSync(join(tmp, ".specify/extensions.yml"), "utf-8");
      expect(yml).toMatch(/before_implement:/);
      expect(yml).toMatch(/command: artgraph\.check-gate/);
    });

    it("--gate=false removes only spectrace's before_implement entry, preserving others", () => {
      copyFixture(join(FIXTURES, "specify-empty"), tmp);
      // Seed: add another extension's before_implement entry + spectrace's via gate=true
      const ymlPath = join(tmp, ".specify/extensions.yml");
      writeFileSync(
        ymlPath,
        `installed:\n- agent-context\nsettings:\n  auto_execute_hooks: true\nhooks:\n  before_implement:\n  - extension: agent-context\n    command: speckit.agent-context.warm\n    enabled: true\n    optional: true\n    priority: 10\n    prompt: warm?\n    description: x\n    condition: null\n`,
      );
      provider.install(tmp, { gate: true });
      // Now run with gate=false
      provider.install(tmp, { gate: false });
      const yml = readFileSync(ymlPath, "utf-8");
      expect(yml).toMatch(/extension: agent-context[\s\S]*command: speckit\.agent-context\.warm/);
      expect(yml).not.toMatch(/extension: spectrace[\s\S]*command: artgraph\.check-gate/);
    });

    it("--gate=undefined does not touch before_implement", () => {
      copyFixture(join(FIXTURES, "specify-empty"), tmp);
      provider.install(tmp, { gate: true });
      const before = readFileSync(join(tmp, ".specify/extensions.yml"), "utf-8");
      // gate undefined → should not add nor remove
      provider.install(tmp, {});
      const after = readFileSync(join(tmp, ".specify/extensions.yml"), "utf-8");
      expect(after).toBe(before);
    });

    it("rolls back created files when a mid-install disk error occurs", () => {
      copyFixture(join(FIXTURES, "specify-empty"), tmp);
      // Spy on the atomic-write namespace import; fail on the 3rd call so
      // some files are already on disk when the throw happens. The provider
      // must reverse every previous mutation before re-throwing.
      let call = 0;
      const real = atomicWriteMod.atomicWriteFile;
      const spy = vi
        .spyOn(atomicWriteMod, "atomicWriteFile")
        .mockImplementation((dest: string, content: string) => {
          call++;
          if (call === 3) {
            throw new Error("simulated EACCES");
          }
          return real(dest, content);
        });
      expect(() => provider.install(tmp, {})).toThrow(/simulated|EACCES/);
      spy.mockRestore();
      // All files that would have been created should be gone
      expect(existsSync(join(tmp, ".specify/extensions/spectrace"))).toBe(false);
      // extensions.yml should be back to the original fixture content (no spectrace)
      const yml = readFileSync(join(tmp, ".specify/extensions.yml"), "utf-8");
      expect(yml).not.toMatch(/- spectrace/);
    });
  });

  describe("uninstall", () => {
    it("removes installed marker, extension dir, and hook entries", () => {
      copyFixture(join(FIXTURES, "specify-already-installed"), tmp);
      const result = provider.uninstall(tmp);
      expect(result.noop).toBe(false);
      const yml = readFileSync(join(tmp, ".specify/extensions.yml"), "utf-8");
      expect(yml).not.toMatch(/- spectrace/);
      expect(yml).not.toMatch(/extension: spectrace/);
      expect(existsSync(join(tmp, ".specify/extensions/spectrace"))).toBe(false);
    });

    it("preserves other extensions' hook entries", () => {
      copyFixture(join(FIXTURES, "specify-already-installed"), tmp);
      // Seed an agent-context entry under after_tasks to verify it survives.
      const ymlPath = join(tmp, ".specify/extensions.yml");
      const orig = readFileSync(ymlPath, "utf-8");
      const augmented = orig.replace(
        /after_tasks:\n/,
        `after_tasks:\n  - extension: agent-context\n    command: speckit.agent-context.update\n    enabled: true\n    optional: true\n    priority: 10\n    prompt: warm?\n    description: x\n    condition: null\n`,
      );
      writeFileSync(ymlPath, augmented);
      provider.uninstall(tmp);
      const yml = readFileSync(ymlPath, "utf-8");
      expect(yml).toMatch(/command: speckit\.agent-context\.update/);
    });

    it("is no-op when artgraph was not installed", () => {
      copyFixture(join(FIXTURES, "specify-empty"), tmp);
      const result = provider.uninstall(tmp);
      expect(result.noop).toBe(true);
    });
  });
});
