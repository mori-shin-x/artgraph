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
import { parse as parseYaml } from "yaml";
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

    it("returns false when extension.yml is unparseable (M-M5)", () => {
      copyFixture(join(FIXTURES, "specify-already-installed"), tmp);
      // Garbage YAML that the parser rejects outright.
      writeFileSync(
        join(tmp, ".specify/extensions/spectrace/extension.yml"),
        "schema_version: '1.0'\nthis is: : : not valid yaml ][[}\n",
      );
      expect(provider.isInstalled(tmp)).toBe(false);
    });

    it("returns false when extension.yml has a wrong schema_version (M-M5)", () => {
      copyFixture(join(FIXTURES, "specify-already-installed"), tmp);
      // Valid YAML but the frozen v1.0 contract is violated → integration is
      // effectively broken; init Tip must surface so the user can recover.
      writeFileSync(
        join(tmp, ".specify/extensions/spectrace/extension.yml"),
        [
          'schema_version: "9.9"',
          "extension:",
          "  id: spectrace",
          '  name: "x"',
          '  version: "0.0.0"',
          '  description: "x"',
          "  author: artgraph",
          "  repository: https://example.com",
          "  license: MIT",
          "requires:",
          '  speckit_version: ">=0.0.0"',
          "provides:",
          "  commands: []",
          "hooks: {}",
          "tags: []",
          "",
        ].join("\n"),
      );
      expect(provider.isInstalled(tmp)).toBe(false);
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
      // M-H5: structural assertion — the regex `extension: spectrace[\s\S]*
      // command: artgraph.check-gate` crosses trigger boundaries, so even a
      // bug that wiped the entire before_implement array would pass. Parse
      // the YAML and assert the precise shape we want.
      const parsed = parseYaml(yml) as {
        hooks: {
          before_implement?: Array<{ extension: string; command: string }>;
          after_tasks?: Array<{ extension: string; command: string }>;
          after_implement?: Array<{ extension: string; command: string }>;
        };
      };
      // before_implement: exactly the agent-context entry, no spectrace.
      expect(parsed.hooks.before_implement).toBeDefined();
      expect(parsed.hooks.before_implement).toHaveLength(1);
      expect(parsed.hooks.before_implement![0]!.extension).toBe("agent-context");
      expect(parsed.hooks.before_implement![0]!.command).toBe("speckit.agent-context.warm");
      // The other spectrace triggers must still be present after `gate=false`
      // (the bug would silently drop them along with before_implement).
      expect(parsed.hooks.after_tasks?.some((e) => e.extension === "spectrace")).toBe(true);
      expect(parsed.hooks.after_implement?.some((e) => e.extension === "spectrace")).toBe(true);
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

    // M-H4 regression: previously every rollback test started from a fresh
    // fixture where no `prev` content existed, so the `prev → restore`
    // branch (speckit.ts:171-179) was uncovered. This case overwrites an
    // existing user-edited extension.yml with --force, fails halfway, and
    // asserts the byte-for-byte restoration of the user's edits.
    it("restores hand-edited extension.yml byte-for-byte when --force install rolls back", () => {
      copyFixture(join(FIXTURES, "specify-already-installed"), tmp);
      const extYmlPath = join(tmp, ".specify/extensions/spectrace/extension.yml");
      const sentinel = "# USER EDITED — must survive rollback\nfoo: bar\n";
      writeFileSync(extYmlPath, sentinel);

      // Fail the *second* atomic write so at least one earlier overwrite
      // recorded a `prev` rollback op. With EXT_FILES = [extension.yml,
      // README.md, ...3 commands] all 5 are first overwritten under --force,
      // so call==2 reliably exercises the `prev` restore branch on
      // extension.yml (call==1 was its overwrite, and the rollback runs in
      // reverse order so the prev-restore for the first file fires).
      let call = 0;
      const real = atomicWriteMod.atomicWriteFile;
      const spy = vi
        .spyOn(atomicWriteMod, "atomicWriteFile")
        .mockImplementation((dest: string, content: string) => {
          call++;
          if (call === 2) {
            throw new Error("simulated EACCES on second overwrite");
          }
          return real(dest, content);
        });

      expect(() => provider.install(tmp, { force: true })).toThrow(/simulated|EACCES/);
      spy.mockRestore();

      // The user's sentinel content must be back on disk byte-for-byte.
      expect(readFileSync(extYmlPath, "utf-8")).toBe(sentinel);
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
