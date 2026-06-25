import { beforeEach, describe, expect, it } from "vitest";
import type { IntegrationProvider, IntegrationProviderId } from "../../src/types.js";
import {
  clearProviders,
  getProvider,
  listProviders,
  registerProvider,
} from "../../src/integrate/registry.js";

function makeStub(id: IntegrationProviderId, displayName: string): IntegrationProvider {
  return {
    id,
    displayName,
    marker: `.${id}`,
    detect: () => false,
    isInstalled: () => false,
    install: () => ({
      providerId: id,
      created: [],
      modified: [],
      removed: [],
      noop: true,
      nextSteps: [],
      warnings: [],
    }),
    uninstall: () => ({
      providerId: id,
      created: [],
      modified: [],
      removed: [],
      noop: true,
      nextSteps: [],
      warnings: [],
    }),
  };
}

describe("integrate/registry", () => {
  beforeEach(() => {
    clearProviders();
  });

  it("preserves the order in which providers were registered", () => {
    const a = makeStub("speckit", "Spec Kit");
    const b = makeStub("kiro", "Kiro");
    registerProvider(a);
    registerProvider(b);
    const ids = listProviders().map((p) => p.id);
    expect(ids).toEqual(["speckit", "kiro"]);
  });

  it("returns undefined for an unknown id", () => {
    expect(getProvider("speckit")).toBeUndefined();
  });

  it("throws when the same id is registered twice", () => {
    const a = makeStub("speckit", "Spec Kit");
    registerProvider(a);
    expect(() => registerProvider(makeStub("speckit", "duplicate"))).toThrow();
  });

  it("retrieves a registered provider by id", () => {
    const a = makeStub("kiro", "Kiro");
    registerProvider(a);
    expect(getProvider("kiro")).toBe(a);
  });
});
