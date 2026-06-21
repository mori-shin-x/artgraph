import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { writeFileSync, unlinkSync, mkdirSync, rmdirSync } from "node:fs";
import { parseMarkdown } from "../src/parsers/markdown.js";

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures");

describe("parseMarkdown", () => {
  describe("auth.md (list-item format)", () => {
    it("should extract req nodes from list items", () => {
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/auth.md"));
      const reqNodes = result.nodes.filter((n) => n.kind === "req");

      expect(reqNodes).toHaveLength(3);
      expect(reqNodes[0].id).toBe("AUTH-001");
      expect(reqNodes[1].id).toBe("AUTH-002");
      expect(reqNodes[2].id).toBe("AUTH-003");
    });

    it("should extract doc node from frontmatter", () => {
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/auth.md"));
      const docNodes = result.nodes.filter((n) => n.kind === "doc");

      expect(docNodes).toHaveLength(1);
      expect(docNodes[0].id).toBe("doc:auth-design");
    });

    it("should extract edges from frontmatter depends_on", () => {
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/auth.md"));
      const depEdges = result.edges.filter((e) => e.kind === "depends_on");

      expect(depEdges).toHaveLength(1);
      expect(depEdges[0].source).toBe("doc:auth-design");
      expect(depEdges[0].target).toBe("AUTH-001");
    });

    it("should compute content hash including nested list items", () => {
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/auth.md"));
      const req = result.nodes.find((n) => n.id === "AUTH-001");

      expect(req?.contentHash).toBeDefined();
      expect(req!.contentHash.length).toBe(16);
    });
  });

  describe("US1: speckit-style.md (list-item format)", () => {
    it("should extract req nodes from list items", () => {
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/speckit-style.md"));
      const reqNodes = result.nodes.filter((n) => n.kind === "req");
      const reqIds = reqNodes.map((n) => n.id);

      expect(reqIds).toContain("FEAT-001");
      expect(reqIds).toContain("FEAT-002");
      expect(reqIds).toContain("SC-001");
      expect(reqIds).toContain("NFR-1");
    });

    it("should recognize bold-formatted SC-001", () => {
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/speckit-style.md"));
      const sc = result.nodes.find((n) => n.id === "SC-001");

      expect(sc).toBeDefined();
      expect(sc!.kind).toBe("req");
    });

    it("should compute 16-char content hash for list-item reqs", () => {
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/speckit-style.md"));
      const req = result.nodes.find((n) => n.id === "FEAT-001");

      expect(req?.contentHash).toBeDefined();
      expect(req!.contentHash.length).toBe(16);
    });
  });

  describe("US2: kiro-style.md (heading format)", () => {
    it("should extract req nodes from headings", () => {
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/kiro-style.md"));
      const reqNodes = result.nodes.filter((n) => n.kind === "req");
      const reqIds = reqNodes.map((n) => n.id);

      expect(reqIds).toContain("Requirement-1");
      expect(reqIds).toContain("Requirement-2");
    });

    it("should compute 16-char content hash for heading reqs", () => {
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/kiro-style.md"));
      const req = result.nodes.find((n) => n.id === "Requirement-1");

      expect(req?.contentHash).toBeDefined();
      expect(req!.contentHash.length).toBe(16);
    });
  });

  describe("T014: frontmatter flat format", () => {
    it("should generate derives_from edge from flat frontmatter", () => {
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/doc-chain/design.md"), FIXTURE_DIR);
      const edges = result.edges.filter((e) => e.kind === "derives_from");

      expect(edges).toHaveLength(1);
      expect(edges[0].source).toBe("design");
      expect(edges[0].target).toBe("requirements");
    });
  });

  describe("T020: doc node auto-generation", () => {
    it("should generate doc node for prose-only markdown (no frontmatter)", () => {
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/prose-only.md"), FIXTURE_DIR);
      const docNodes = result.nodes.filter((n) => n.kind === "doc");

      expect(docNodes).toHaveLength(1);
      expect(docNodes[0].id).toBe("doc:specs/prose-only.md");
      expect(docNodes[0].kind).toBe("doc");
    });
  });

  describe("T021: frontmatter node_id override", () => {
    it("should use node_id from frontmatter when specified", () => {
      const result = parseMarkdown(
        resolve(FIXTURE_DIR, "specs/doc-chain/requirements.md"),
        FIXTURE_DIR,
      );
      const docNodes = result.nodes.filter((n) => n.kind === "doc");

      expect(docNodes).toHaveLength(1);
      expect(docNodes[0].id).toBe("requirements");
    });
  });

  describe("T022: doc node contentHash", () => {
    it("should compute contentHash from entire file content", () => {
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/prose-only.md"), FIXTURE_DIR);
      const doc = result.nodes.find((n) => n.kind === "doc");

      expect(doc?.contentHash).toBeDefined();
      expect(doc!.contentHash.length).toBe(16);
    });
  });

  describe("T023: doc + req coexistence", () => {
    it("should generate both doc and req nodes for md with requirement IDs", () => {
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/doc-with-reqs.md"), FIXTURE_DIR);
      const docNodes = result.nodes.filter((n) => n.kind === "doc");
      const reqNodes = result.nodes.filter((n) => n.kind === "req");

      expect(docNodes).toHaveLength(1);
      expect(docNodes[0].id).toBe("auth-spec");
      expect(reqNodes.length).toBeGreaterThanOrEqual(2);
      expect(reqNodes.map((n) => n.id)).toContain("FR-001");
      expect(reqNodes.map((n) => n.id)).toContain("FR-002");
    });
  });

  describe("T018: invalid-relation warning", () => {
    it("should generate warning for unknown spectrace keys", () => {
      const tmpRoot = resolve(import.meta.dirname, "fixtures/tmp-invalid-key");
      const tmpSpecs = resolve(tmpRoot, "specs");
      mkdirSync(tmpSpecs, { recursive: true });
      const tmpPath = resolve(tmpSpecs, "invalid-key-test.md");
      writeFileSync(
        tmpPath,
        `---
spectrace:
  node_id: "test-doc"
  extends:
    - some-doc
---
# Test
`,
      );

      try {
        const result = parseMarkdown(tmpPath, tmpRoot);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0].type).toBe("invalid-relation");
        expect(result.warnings[0].key).toBe("extends");
      } finally {
        unlinkSync(tmpPath);
        rmdirSync(tmpSpecs);
        rmdirSync(tmpRoot);
      }
    });
  });

  describe("mixed format coverage", () => {
    it("should recognize both list-item and heading formats across fixtures", () => {
      const speckitResult = parseMarkdown(resolve(FIXTURE_DIR, "specs/speckit-style.md"));
      const kiroResult = parseMarkdown(resolve(FIXTURE_DIR, "specs/kiro-style.md"));

      const listReqs = speckitResult.nodes.filter((n) => n.kind === "req");
      const headingReqs = kiroResult.nodes.filter((n) => n.kind === "req");

      expect(listReqs.length).toBeGreaterThan(0);
      expect(headingReqs.length).toBeGreaterThan(0);
    });
  });
});
