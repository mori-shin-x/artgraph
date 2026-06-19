import { describe, it, expect } from "vitest";
import { login } from "../src/auth/login.js";

describe("[REQ-7f3a] login", () => {
  it("should return session token for valid credentials", async () => {
    const token = await login({ email: "test@example.com", password: "pass" });
    expect(token).toContain("session_");
  });

  it("should throw for empty email", async () => {
    await expect(login({ email: "", password: "pass" })).rejects.toThrow();
  });
});
