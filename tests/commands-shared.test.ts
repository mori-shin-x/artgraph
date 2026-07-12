// issue #265 — unit tests for `reportGraphWarnings` (src/commands/shared.ts),
// the shared helper that centralizes "when do we print BuildWarning[] to
// stderr" for every command that builds the graph (`impact`/`trace`/
// `reconcile`/`rename`, alongside `scan`/`init`/`check`'s pre-existing
// direct `printWarnings` wiring). Two representative CLI integration tests
// (tests/impact-cli.test.ts, tests/trace-cli.test.ts) cover the end-to-end
// wiring; this file pins the helper's own text/json/empty-input contract in
// isolation.

import { describe, it, expect, vi } from "vitest";
import { reportGraphWarnings } from "../src/commands/shared.js";
import type { BuildWarning } from "../src/graph/builder.js";

const collisionWarning: BuildWarning = {
  type: "class-member-collision",
  id: "symbol:src/x.ts#Sample.methodA",
  files: ["src/x.ts"],
  message: "class-member-collision: some class member context.",
};

describe("reportGraphWarnings", () => {
  it("format omitted (text default): prints via printWarnings to stderr", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      reportGraphWarnings([collisionWarning]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]![0])).toContain("class-member-collision");
    } finally {
      spy.mockRestore();
    }
  });

  it('format: "text": prints via printWarnings to stderr', () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      reportGraphWarnings([collisionWarning], "text");
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('format: "json": no-op — the caller is responsible for folding warnings into its JSON payload instead', () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      reportGraphWarnings([collisionWarning], "json");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("empty warnings array: no-op regardless of format", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      reportGraphWarnings([]);
      reportGraphWarnings([], "text");
      reportGraphWarnings([], "json");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
