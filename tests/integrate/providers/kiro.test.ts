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
import { KiroProvider } from "../../../src/integrate/providers/kiro.js";

const FIXTURES = resolve(import.meta.dirname, "../../fixtures/integrate");

function copyFixture(src: string, dest: string): void {
  cpSync(src, dest, { recursive: true });
}

describe("KiroProvider", () => {
  let tmp: string;
  let provider: KiroProvider;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "artgraph-us2-prov-"));
    provider = new KiroProvider();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("detect", () => {
    it("returns true when .kiro/ exists", () => {
      mkdirSync(join(tmp, ".kiro"));
      expect(provider.detect(tmp)).toBe(true);
    });

    it("returns false when .kiro/ is absent", () => {
      expect(provider.detect(tmp)).toBe(false);
    });
  });

  describe("isInstalled", () => {
    it("returns false on an empty .kiro/ repo", () => {
      copyFixture(join(FIXTURES, "kiro-empty"), tmp);
      expect(provider.isInstalled(tmp)).toBe(false);
    });

    it("returns true when .kiro/steering/artgraph.md exists", () => {
      copyFixture(join(FIXTURES, "kiro-installed"), tmp);
      expect(provider.isInstalled(tmp)).toBe(true);
    });
  });

  describe("install", () => {
    it("creates .kiro/steering/artgraph.md on a fresh repo", () => {
      copyFixture(join(FIXTURES, "kiro-empty"), tmp);
      const result = provider.install(tmp, {});
      expect(result.noop).toBe(false);
      expect(result.providerId).toBe("kiro");
      expect(result.created).toContain(".kiro/steering/artgraph.md");
      expect(existsSync(join(tmp, ".kiro/steering/artgraph.md"))).toBe(true);
      const body = readFileSync(join(tmp, ".kiro/steering/artgraph.md"), "utf-8");
      expect(body).toMatch(/artgraph — Kiro integration/);
      expect(body).toMatch(/## When to run artgraph/);
      expect(body).toMatch(/\|\s+`artgraph impact <file>`\s+\|/);
      // trailing newline enforced by writeGuidanceFile
      expect(body.endsWith("\n")).toBe(true);
      expect(body.endsWith("\n\n")).toBe(false);
    });

    it("auto-creates the steering directory if .kiro/ exists but .kiro/steering/ does not", () => {
      mkdirSync(join(tmp, ".kiro"));
      const result = provider.install(tmp, {});
      expect(result.noop).toBe(false);
      expect(existsSync(join(tmp, ".kiro/steering/artgraph.md"))).toBe(true);
    });

    it("is idempotent: second install with same opts is noop and disk unchanged", () => {
      copyFixture(join(FIXTURES, "kiro-empty"), tmp);
      provider.install(tmp, {});
      const before = readFileSync(join(tmp, ".kiro/steering/artgraph.md"), "utf-8");
      const result2 = provider.install(tmp, {});
      expect(result2.noop).toBe(true);
      const after = readFileSync(join(tmp, ".kiro/steering/artgraph.md"), "utf-8");
      expect(after).toBe(before);
    });

    it("does not overwrite a hand-edited artgraph.md without --force (emits warning)", () => {
      copyFixture(join(FIXTURES, "kiro-empty"), tmp);
      const dest = join(tmp, ".kiro/steering/artgraph.md");
      writeFileSync(dest, "# manually edited steering\n");
      const result = provider.install(tmp, {});
      expect(result.noop).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      // disk unchanged
      expect(readFileSync(dest, "utf-8")).toBe("# manually edited steering\n");
    });

    it("--force overwrites a hand-edited artgraph.md", () => {
      copyFixture(join(FIXTURES, "kiro-empty"), tmp);
      const dest = join(tmp, ".kiro/steering/artgraph.md");
      writeFileSync(dest, "# manually edited steering\n");
      const result = provider.install(tmp, { force: true });
      expect(result.noop).toBe(false);
      expect(result.modified).toContain(".kiro/steering/artgraph.md");
      const body = readFileSync(dest, "utf-8");
      expect(body).not.toContain("manually edited");
      expect(body).toMatch(/artgraph — Kiro integration/);
    });

    it("throws when .kiro/ is not detected, leaving disk unchanged", () => {
      expect(() => provider.install(tmp, {})).toThrow(/not detected/i);
      expect(existsSync(join(tmp, ".kiro"))).toBe(false);
    });
  });

  describe("uninstall", () => {
    it("removes .kiro/steering/artgraph.md when present", () => {
      copyFixture(join(FIXTURES, "kiro-installed"), tmp);
      const result = provider.uninstall(tmp);
      expect(result.noop).toBe(false);
      expect(result.removed).toContain(".kiro/steering/artgraph.md");
      expect(existsSync(join(tmp, ".kiro/steering/artgraph.md"))).toBe(false);
    });

    it("is a no-op when artgraph was not installed", () => {
      copyFixture(join(FIXTURES, "kiro-empty"), tmp);
      const result = provider.uninstall(tmp);
      expect(result.noop).toBe(true);
      expect(result.removed).toEqual([]);
    });

    it("forward-compat: ignores unknown install option keys (e.g. future hook mode)", () => {
      copyFixture(join(FIXTURES, "kiro-empty"), tmp);
      // Cast through unknown so the test compiles even with strict InstallOptions
      const opts = {
        mode: "steering",
      } as unknown as import("../../../src/types.js").InstallOptions;
      const result = provider.install(tmp, opts);
      expect(result.noop).toBe(false);
      expect(existsSync(join(tmp, ".kiro/steering/artgraph.md"))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // T065 — FR-011 forward-compat / provider-boundary tests
  //
  // Resolved by issue #366 (scope A): the Kiro Stop-hook
  // (`.kiro/hooks/artgraph-check.kiro.hook`) is installed by the `src/hooks/`
  // layer, NOT KiroProvider — `install()` never grew a `mode` discriminator
  // and never will; KiroProvider stays steering-only permanently, not just
  // "for now". These tests are kept (reframed, not deleted) because they
  // still guard a real invariant: InstallOptions is not sealed against extra
  // keys, and the provider must keep ignoring ones it doesn't recognize
  // (e.g. a hypothetical unrelated future option) without ever coupling
  // itself to hook install logic or touching the steering file as a side
  // effect of an unknown key.
  // -------------------------------------------------------------------------
  describe("FR-011 forward-compat / hook-is-not-my-job (T065)", () => {
    // `mode` here stands in for "any option key KiroProvider doesn't
    // recognize" — it is deliberately NOT a real InstallOptions field (hook
    // mode is `src/hooks/`'s responsibility, never KiroProvider's), so this
    // cast is the only way to shape the test.
    type OptsWithUnknownKey = import("../../../src/types.js").InstallOptions & {
      mode?: "steering" | "hook";
    };

    it("(a) install ignores unrecognized option keys without breaking existing calls", () => {
      copyFixture(join(FIXTURES, "kiro-empty"), tmp);

      // Existing Steering-only callers — the field is absent.
      const opts1: OptsWithUnknownKey = {};
      const r1 = provider.install(tmp, opts1);
      expect(r1.providerId).toBe("kiro");
      expect(r1.noop).toBe(false);

      // Idempotent re-run with the unrecognized field present but undefined.
      const opts2: OptsWithUnknownKey = { mode: undefined };
      const r2 = provider.install(tmp, opts2);
      expect(r2.noop).toBe(true);

      // And with the unrecognized field set to a non-undefined value —
      // still ignored, same steady-state result.
      const opts3: OptsWithUnknownKey = { mode: "steering" };
      const r3 = provider.install(tmp, opts3);
      expect(r3.noop).toBe(true);
    });

    it("(b) an unrecognized 'hook' option value does not delete the existing steering file", () => {
      copyFixture(join(FIXTURES, "kiro-installed"), tmp);
      const steering = join(tmp, ".kiro/steering/artgraph.md");
      const before = readFileSync(steering, "utf-8");

      // KiroProvider has no hook-install branch and never will — passing a
      // `mode: "hook"`-shaped option must not be interpreted as one; the
      // provider stays in Steering mode and leaves the file untouched.
      const opts: OptsWithUnknownKey = { mode: "hook" };
      const r = provider.install(tmp, opts);
      // No content change is allowed.
      expect(readFileSync(steering, "utf-8")).toBe(before);
      // The result must still surface the steady-state cleanly.
      expect(r.providerId).toBe("kiro");
    });
  });
});
