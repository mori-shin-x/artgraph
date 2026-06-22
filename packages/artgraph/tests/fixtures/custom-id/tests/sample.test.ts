import { describe, it, expect } from "vitest";

// Fixture for codeId custom-pattern extraction (M1). The [123] tag should only
// produce a `verifies` edge to req "123" when reqPatterns.codeId is configured.
describe("[123] custom id sample", () => {
  it("works", () => {
    expect(true).toBe(true);
  });
});
