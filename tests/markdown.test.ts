import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { parseMarkdown } from "../src/parsers/markdown.js";

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures");

describe("parseMarkdown", () => {
  it("should extract REQ nodes from headings", () => {
    const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/auth.md"));
    const reqNodes = result.nodes.filter((n) => n.kind === "req");

    expect(reqNodes).toHaveLength(3);
    expect(reqNodes[0].id).toBe("REQ-7f3a");
    expect(reqNodes[0].slug).toBe("auth-login");
    expect(reqNodes[1].id).toBe("REQ-a1b2");
    expect(reqNodes[1].slug).toBe("auth-session");
    expect(reqNodes[2].id).toBe("REQ-c3d4");
    expect(reqNodes[2].slug).toBe("auth-logout");
  });

  it("should extract doc node from frontmatter", () => {
    const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/auth.md"));
    const docNodes = result.nodes.filter((n) => n.kind === "doc");

    expect(docNodes).toHaveLength(1);
    expect(docNodes[0].id).toBe("doc:auth-design");
  });

  it("should extract edges from frontmatter depends_on", () => {
    const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/auth.md"));
    const implEdges = result.edges.filter((e) => e.kind === "implements");

    expect(implEdges).toHaveLength(1);
    expect(implEdges[0].source).toBe("doc:auth-design");
    expect(implEdges[0].target).toBe("REQ-7f3a");
  });

  it("should compute content hash for each REQ", () => {
    const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/auth.md"));
    const req = result.nodes.find((n) => n.id === "REQ-7f3a");

    expect(req?.contentHash).toBeDefined();
    expect(req!.contentHash.length).toBe(16);
  });
});
