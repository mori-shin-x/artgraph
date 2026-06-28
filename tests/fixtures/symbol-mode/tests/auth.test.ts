// Verifies the three exports cited by REQ-001 / REQ-005 / REQ-009. Imported
// by the symbol-mode scanner so `symbol:src/auth.ts#<name>` nodes are
// registered for spec 016 fixture tests.

import { describe, it, expect } from "vitest";
import { validateToken, issueToken, revokeToken } from "../src/auth.js";

describe("auth", () => {
  it("validateToken rejects empty (REQ-001)", () => {
    expect(validateToken("")).toBe(false);
  });

  it("issueToken mints a token (REQ-005)", () => {
    expect(issueToken("u1")).toMatch(/^token:/);
  });

  it("revokeToken runs without throwing (REQ-009)", () => {
    expect(() => revokeToken("token:u1")).not.toThrow();
  });
});
