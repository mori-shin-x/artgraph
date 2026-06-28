// spec 014 — Phase 4 (US1) tests for the REQ-ID mention detector.
// Mirrors the contract in
// `specs/014-reinvent-impact-cli/contracts/mention-semantics.md` — the 8-item
// "Test 戦略" section is the source of truth for the cases below.
//
// Boundary regex under test: `(?<![A-Za-z0-9_])<escaped_id>(?![A-Za-z0-9_])`.
// The detector is intentionally label-agnostic (no `Considered:` /
// `Affected:` keyword required) and case-sensitive (graph node IDs are
// case-sensitive).

import { describe, it, expect } from "vitest";
import { detectMentions } from "../src/plan-coverage/mention.js";

describe("detectMentions — basic match (戦略 1)", () => {
  it("plain REQ-3 occurrence in tasks is mentioned", () => {
    const result = detectMentions(["REQ-3"], { tasks: "We touch REQ-3 here." });
    expect(result.mentioned.has("REQ-3")).toBe(true);
    expect(result.implicit).toEqual([]);
  });

  it("returns implicit list for REQs that never appear", () => {
    const result = detectMentions(["REQ-1", "REQ-2"], { tasks: "REQ-1 mentioned." });
    expect(result.mentioned.has("REQ-1")).toBe(true);
    expect(result.mentioned.has("REQ-2")).toBe(false);
    expect(result.implicit).toEqual(["REQ-2"]);
  });
});

describe("detectMentions — false-positive guards (戦略 2)", () => {
  it.each([
    ["REQ-30", "REQ-30 is a longer numeric continuation"],
    ["REQ-300", "REQ-300 keeps going"],
    ["aREQ-3", "aREQ-3 has a word char before"],
    ["_REQ-3", "_REQ-3 has _ before"],
    ["REQ-3xyz", "REQ-3xyz continues with letters"],
    ["REQ-3_log", "REQ-3_log continues with underscore"],
  ])("does NOT match REQ-3 in %s", (_label, source) => {
    const result = detectMentions(["REQ-3"], { tasks: source });
    expect(result.mentioned.has("REQ-3")).toBe(false);
    expect(result.implicit).toEqual(["REQ-3"]);
  });
});

describe("detectMentions — boundary variations (戦略 3)", () => {
  it.each([
    ["[REQ-3] markdown bracket", "see [REQ-3] for details"],
    ["(REQ-3) parens", "we considered (REQ-3) in the audit"],
    ["<REQ-3> angle brackets", "tracked <REQ-3>"],
    ["`REQ-3` inline code", "the requirement `REQ-3` applies"],
    ["# REQ-3 heading", "# REQ-3 user auth"],
    ["Considered: REQ-3 colon prefix", "Considered: REQ-3 — no impact"],
    ["REQ-3-extended (dash continuation)", "REQ-3-extended also touched"],
    ["REQ-3.5 (period continuation)", "section REQ-3.5 is updated"],
  ])("matches REQ-3 in %s", (_label, source) => {
    const result = detectMentions(["REQ-3"], { tasks: source });
    expect(result.mentioned.has("REQ-3")).toBe(true);
  });
});

describe("detectMentions — multi-source union (戦略 4)", () => {
  it("REQ in tasks only is mentioned (plan/spec absent)", () => {
    const result = detectMentions(["REQ-1"], { tasks: "REQ-1 lives here" });
    expect(result.mentioned.has("REQ-1")).toBe(true);
  });

  it("REQ in plan only is mentioned (tasks/spec absent for it)", () => {
    const result = detectMentions(["REQ-2"], {
      tasks: "no req here",
      plan: "plan says REQ-2 matters",
    });
    expect(result.mentioned.has("REQ-2")).toBe(true);
  });

  it("REQ in spec only is mentioned", () => {
    const result = detectMentions(["REQ-7"], {
      tasks: "irrelevant",
      spec: "spec.md lists REQ-7 as core",
    });
    expect(result.mentioned.has("REQ-7")).toBe(true);
  });

  it("REQs distributed across all three sources are all mentioned", () => {
    const result = detectMentions(["REQ-1", "REQ-2", "REQ-3"], {
      tasks: "REQ-1",
      plan: "REQ-2",
      spec: "REQ-3",
    });
    expect(result.mentioned.size).toBe(3);
    expect(result.implicit).toEqual([]);
  });
});

describe("detectMentions — optional source files (戦略 5)", () => {
  it("missing plan / spec does NOT throw — tasks-only search proceeds", () => {
    // Per contract: plan / spec are optional. `undefined` is fine; the
    // detector should treat the source set as just `tasks`.
    expect(() =>
      detectMentions(["REQ-1"], { tasks: "REQ-1" }),
    ).not.toThrow();
  });

  it("undefined optional sources are ignored", () => {
    const result = detectMentions(["REQ-1", "REQ-2"], {
      tasks: "REQ-1 mentioned",
      plan: undefined,
      spec: undefined,
    });
    expect(result.mentioned.has("REQ-1")).toBe(true);
    expect(result.mentioned.has("REQ-2")).toBe(false);
  });
});

describe("detectMentions — case sensitivity (戦略 6)", () => {
  it("req-3 is NOT a mention of REQ-3 (graph IDs are case-sensitive)", () => {
    const result = detectMentions(["REQ-3"], { tasks: "we discussed req-3 already" });
    expect(result.mentioned.has("REQ-3")).toBe(false);
    expect(result.implicit).toEqual(["REQ-3"]);
  });
});

describe("detectMentions — multiple matches collapse to one (戦略 7)", () => {
  it("a REQ that appears N times is mentioned exactly once", () => {
    const text = "REQ-3 here, [REQ-3] there, and Considered: REQ-3 again.";
    const result = detectMentions(["REQ-3"], { tasks: text });
    expect(result.mentioned.has("REQ-3")).toBe(true);
    // The Set has size 1 even though there are 3 textual hits — proves
    // the detector is set-based, not occurrence-counting.
    expect(result.mentioned.size).toBe(1);
  });
});

describe("detectMentions — hyphen-extended IDs (戦略 8)", () => {
  it("REQ-3 and REQ-3-extended are detected independently", () => {
    // Both IDs exist in the graph. The text mentions only REQ-3-extended.
    // REQ-3-extended → match; REQ-3 → also matches because `-` is a word
    // boundary on both sides of "REQ-3" inside "REQ-3-extended".
    // This is intentional per the contract: the two are evaluated
    // independently with the lookaround regex.
    const result = detectMentions(["REQ-3", "REQ-3-extended"], {
      tasks: "We will revisit REQ-3-extended next sprint.",
    });
    expect(result.mentioned.has("REQ-3")).toBe(true);
    expect(result.mentioned.has("REQ-3-extended")).toBe(true);
  });

  it("only REQ-3 in text — REQ-3-extended stays implicit", () => {
    const result = detectMentions(["REQ-3", "REQ-3-extended"], {
      tasks: "Only REQ-3 was investigated this round.",
    });
    expect(result.mentioned.has("REQ-3")).toBe(true);
    expect(result.mentioned.has("REQ-3-extended")).toBe(false);
    expect(result.implicit).toEqual(["REQ-3-extended"]);
  });
});

describe("detectMentions — regex escape safety", () => {
  it("does not crash on IDs containing regex meta characters (e.g. dots)", () => {
    // Future-proofing: the contract notes REQ-IDs are normally safe, but
    // `escapeRegex` should handle weird characters anyway.
    const result = detectMentions(["REQ.001"], { tasks: "REQ.001 mentioned" });
    expect(result.mentioned.has("REQ.001")).toBe(true);
  });

  it("REQ-1 does NOT match REQ-10 (numeric continuation)", () => {
    const result = detectMentions(["REQ-1"], { tasks: "REQ-10 is unrelated" });
    expect(result.mentioned.has("REQ-1")).toBe(false);
    expect(result.implicit).toEqual(["REQ-1"]);
  });
});
