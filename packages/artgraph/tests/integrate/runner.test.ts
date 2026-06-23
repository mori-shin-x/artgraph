import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  IntegrateResult,
  IntegrationProvider,
  IntegrationProviderId,
} from "../../src/types.js";
import { clearProviders, registerProvider } from "../../src/integrate/registry.js";
import { runIntegrate } from "../../src/integrate/runner.js";

function emptyResult(id: IntegrationProviderId): IntegrateResult {
  return {
    providerId: id,
    created: [],
    modified: [],
    removed: [],
    noop: true,
    nextSteps: [],
    warnings: [],
  };
}

describe("runIntegrate", () => {
  beforeEach(() => {
    clearProviders();
  });

  it("throws when the tool id is not registered", () => {
    expect(() => runIntegrate("/tmp/nope", "speckit", {})).toThrow(/unknown/i);
  });

  it("dispatches install on the registered provider", () => {
    const install = vi.fn().mockReturnValue(emptyResult("speckit"));
    const uninstall = vi.fn().mockReturnValue(emptyResult("speckit"));
    const stub: IntegrationProvider = {
      id: "speckit",
      displayName: "Spec Kit",
      marker: ".specify",
      detect: () => true,
      isInstalled: () => false,
      install,
      uninstall,
    };
    registerProvider(stub);
    const result = runIntegrate("/tmp/x", "speckit", { force: true });
    expect(install).toHaveBeenCalledWith("/tmp/x", { force: true });
    expect(uninstall).not.toHaveBeenCalled();
    expect(result.providerId).toBe("speckit");
  });

  it("dispatches uninstall when opts.uninstall is true", () => {
    const install = vi.fn().mockReturnValue(emptyResult("kiro"));
    const uninstall = vi.fn().mockReturnValue(emptyResult("kiro"));
    const stub: IntegrationProvider = {
      id: "kiro",
      displayName: "Kiro",
      marker: ".kiro",
      detect: () => true,
      isInstalled: () => true,
      install,
      uninstall,
    };
    registerProvider(stub);
    const result = runIntegrate("/tmp/x", "kiro", { uninstall: true });
    expect(uninstall).toHaveBeenCalledWith("/tmp/x");
    expect(install).not.toHaveBeenCalled();
    expect(result.providerId).toBe("kiro");
  });
});
