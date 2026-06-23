import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearProviders, registerProvider } from "../../src/integrate/registry.js";
import { getProviderStatuses } from "../../src/integrate/index.js";
import { SpecKitProvider } from "../../src/integrate/providers/speckit.js";
import { KiroProvider } from "../../src/integrate/providers/kiro.js";

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
});
