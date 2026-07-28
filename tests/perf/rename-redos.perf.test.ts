// Perf regression for the two rename-path ReDoS fixes: the parser-driven
// node_id rewrite and the linear annotation scanner. Attack strings are the
// corrected constructions confirmed to reproduce catastrophic backtracking
// on the OLD regex-based implementations (the originally reported strings
// did not — they completed in ~0ms):
//   - FM_NODE_ID_RE measured ~1.3-1.8s at n=40000 (O(n^2) backtracking)
//   - ANNOTATION_RE_LINE measured ~2.5-2.8s at n=2000
// Runs in the dedicated perf config (singleFork, no fileParallelism,
// retry: 1) so the wall-clock assertions own the CPU during measurement.
import { describe, it, expect } from "vitest";
import { rewriteAnnotationIds, rewriteFrontmatter } from "../../src/rename.js";

describe("rename rewriters — ReDoS perf regression", () => {
  it("rewriteFrontmatter completes well under the old quadratic-backtracking blowup", () => {
    const n = 40000;
    const attackLine = "node_id:a" + " ".repeat(n) + "b";
    const content = ["---", attackLine, "---", "# Body"].join("\n");

    const start = performance.now();
    rewriteFrontmatter(content, "doc:old", "doc:new");
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(500);
  });

  it("rewriteAnnotationIds completes well under the old super-linear backtracking blowup", () => {
    const n = 2000;
    const attackLine = "(depends_on: " + " ".repeat(n) + "a".repeat(n); // no closing paren
    const content = ["# spec", "", `- X: y ${attackLine}`].join("\n");

    const start = performance.now();
    rewriteAnnotationIds(content, "AUTH-001", "AUTH-100");
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(500);
  });
});
