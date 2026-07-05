import { describe, expect, it } from "vitest";
import { signIn } from "../src/auth";

describe("auth", () => {
  it("accepts non-empty credentials", () => {
    expect(signIn("a@b.c", "pw")).toBe(true);
  });
});
