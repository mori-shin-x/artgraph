import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearProviders, registerProvider } from "../../src/integrate/registry.js";
import { getProviderStatuses } from "../../src/integrate/index.js";
import { SpecKitProvider } from "../../src/integrate/providers/speckit.js";
import { KiroProvider } from "../../src/integrate/providers/kiro.js";
import type { IntegrateResult, IntegrationProvider } from "../../src/types.js";

describe("integrate/index — getProviderStatuses", () => {
  let tmp: string;

  beforeEach(() => {
    // Reset the registry so each test starts from a known state, then
    // register the built-ins directly (bypass registerBuiltinProviders's
    // one-shot guard which is meant for production CLI startup).
    clearProviders();
    registerProvider(new SpecKitProvider());
    registerProvider(new KiroProvider());
    tmp = mkdtempSync(join(tmpdir(), "artgraph-integrate-index-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns one IntegrationStatus per registered provider, in registration order", () => {
    const statuses = getProviderStatuses(tmp);
    expect(statuses.map((s) => s.providerId)).toEqual(["speckit", "kiro"]);
    for (const s of statuses) {
      expect(s).toHaveProperty("displayName");
      expect(s).toHaveProperty("marker");
      expect(typeof s.detected).toBe("boolean");
      expect(typeof s.installed).toBe("boolean");
    }
  });

  it("reports detected=false / installed=false on an empty repo", () => {
    const statuses = getProviderStatuses(tmp);
    for (const s of statuses) {
      expect(s.detected).toBe(false);
      expect(s.installed).toBe(false);
    }
  });

  it("reports detected=true when the marker directory exists", () => {
    mkdirSync(join(tmp, ".specify"));
    mkdirSync(join(tmp, ".kiro"));
    const statuses = getProviderStatuses(tmp);
    const speckit = statuses.find((s) => s.providerId === "speckit")!;
    const kiro = statuses.find((s) => s.providerId === "kiro")!;
    expect(speckit.detected).toBe(true);
    expect(speckit.installed).toBe(false);
    expect(kiro.detected).toBe(true);
    expect(kiro.installed).toBe(false);
  });

  it("carries displayName and marker straight from the provider instances", () => {
    const statuses = getProviderStatuses(tmp);
    const speckit = statuses.find((s) => s.providerId === "speckit")!;
    const kiro = statuses.find((s) => s.providerId === "kiro")!;
    expect(speckit.displayName).toBe("Spec Kit");
    expect(speckit.marker).toBe(".specify");
    expect(kiro.displayName).toBe("Kiro");
    expect(kiro.marker).toBe(".kiro");
  });

  describe("E3 — a throwing third-party provider must not crash the whole snapshot", () => {
    // Minimal IntegrationProvider whose detect()/isInstalled() misbehave by
    // throwing instead of returning a boolean, simulating a third-party
    // provider that doesn't uphold the "never throw" contract.
    class ThrowingProvider implements IntegrationProvider {
      readonly id = "throwing-test-provider" as IntegrationProvider["id"];
      readonly displayName = "Throwing Test Provider";
      readonly marker = ".throwing-test";

      detect(): boolean {
        throw new Error("boom: detect() exploded");
      }

      isInstalled(): boolean {
        throw new Error("boom: isInstalled() exploded");
      }

      install(): IntegrateResult {
        throw new Error("not used in this test");
      }

      uninstall(): IntegrateResult {
        throw new Error("not used in this test");
      }
    }

    it("falls back to detected:false / installed:false for the throwing provider while other providers still report correctly, and warns via console.error", () => {
      registerProvider(new ThrowingProvider());
      mkdirSync(join(tmp, ".specify"));

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const statuses = getProviderStatuses(tmp);

      const speckit = statuses.find((s) => s.providerId === "speckit")!;
      const throwing = statuses.find((s) => s.providerId === "throwing-test-provider")!;

      // Other providers are unaffected by the throwing one.
      expect(speckit.detected).toBe(true);
      expect(speckit.installed).toBe(false);

      // The throwing provider itself is folded to false rather than
      // propagating and crashing getProviderStatuses.
      expect(throwing.detected).toBe(false);
      expect(throwing.installed).toBe(false);

      // Note: assert on the spy *before* restoring it — mockRestore() also
      // clears recorded calls (like mockReset()), so asserting afterward
      // would always see zero calls.
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('provider "throwing-test-provider".detect() threw'),
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('provider "throwing-test-provider".isInstalled() threw'),
      );
      errorSpy.mockRestore();
    });
  });
});
