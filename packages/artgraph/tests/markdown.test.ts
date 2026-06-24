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
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/doc-chain/design.md"), { rootDir: FIXTURE_DIR });
      const edges = result.edges.filter((e) => e.kind === "derives_from");

      expect(edges).toHaveLength(1);
      expect(edges[0].source).toBe("design");
      expect(edges[0].target).toBe("requirements");
    });
  });

  describe("T020: doc node auto-generation", () => {
    it("should generate doc node for prose-only markdown (no frontmatter)", () => {
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/prose-only.md"), { rootDir: FIXTURE_DIR, specDirPrefix: "specs" });
      const docNodes = result.nodes.filter((n) => n.kind === "doc");

      expect(docNodes).toHaveLength(1);
      expect(docNodes[0].id).toBe("doc:prose-only.md");
      expect(docNodes[0].kind).toBe("doc");
    });

    it("should use rootDir-relative path when specDirPrefix is not provided", () => {
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/prose-only.md"), { rootDir: FIXTURE_DIR });
      const docNodes = result.nodes.filter((n) => n.kind === "doc");
      expect(docNodes[0].id).toBe("doc:specs/prose-only.md");
    });
  });

  describe("T021: frontmatter node_id override", () => {
    it("should use node_id from frontmatter when specified", () => {
      const result = parseMarkdown(
        resolve(FIXTURE_DIR, "specs/doc-chain/requirements.md"),
        { rootDir: FIXTURE_DIR },
      );
      const docNodes = result.nodes.filter((n) => n.kind === "doc");

      expect(docNodes).toHaveLength(1);
      expect(docNodes[0].id).toBe("requirements");
    });
  });

  describe("T022: doc node contentHash", () => {
    it("should compute contentHash from entire file content", () => {
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/prose-only.md"), { rootDir: FIXTURE_DIR });
      const doc = result.nodes.find((n) => n.kind === "doc");

      expect(doc?.contentHash).toBeDefined();
      expect(doc!.contentHash.length).toBe(16);
    });
  });

  describe("T023: doc + req coexistence", () => {
    it("should generate both doc and req nodes for md with requirement IDs", () => {
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/doc-with-reqs.md"), { rootDir: FIXTURE_DIR });
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
    it("should generate warning for unknown artgraph keys", () => {
      const tmpRoot = resolve(import.meta.dirname, "fixtures/tmp-invalid-key");
      const tmpSpecs = resolve(tmpRoot, "specs");
      mkdirSync(tmpSpecs, { recursive: true });
      const tmpPath = resolve(tmpSpecs, "invalid-key-test.md");
      writeFileSync(
        tmpPath,
        `---
artgraph:
  node_id: "test-doc"
  extends:
    - some-doc
---
# Test
`,
      );

      try {
        const result = parseMarkdown(tmpPath, { rootDir: tmpRoot });
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

  describe("opening fence tolerance", () => {
    it("should accept frontmatter whose opening fence has trailing whitespace", () => {
      const tmpRoot = resolve(import.meta.dirname, "fixtures/tmp-fence-trailing-ws");
      const tmpSpecs = resolve(tmpRoot, "specs");
      mkdirSync(tmpSpecs, { recursive: true });
      const tmpPath = resolve(tmpSpecs, "fence.md");
      // `---` followed by one space then `\t`, then a normal closing fence.
      writeFileSync(
        tmpPath,
        "--- \t\nartgraph:\n  node_id: \"doc:fence-trailing\"\n---\n# Body\n",
      );
      try {
        const result = parseMarkdown(tmpPath, { rootDir: tmpRoot });
        const doc = result.nodes.find((n) => n.kind === "doc");
        expect(doc?.id).toBe("doc:fence-trailing");
      } finally {
        unlinkSync(tmpPath);
        rmdirSync(tmpSpecs);
        rmdirSync(tmpRoot);
      }
    });
  });

  describe("YAML tag hardening", () => {
    it("should not inject a Buffer into node.id via !!binary", () => {
      const tmpRoot = resolve(import.meta.dirname, "fixtures/tmp-binary-tag");
      const tmpSpecs = resolve(tmpRoot, "specs");
      mkdirSync(tmpSpecs, { recursive: true });
      const tmpPath = resolve(tmpSpecs, "binary.md");
      writeFileSync(
        tmpPath,
        `---
artgraph:
  node_id: !!binary "ZG9jOmJhZA=="
---
# Body
`,
      );
      try {
        const result = parseMarkdown(tmpPath, { rootDir: tmpRoot });
        const doc = result.nodes.find((n) => n.kind === "doc");
        expect(typeof doc?.id).toBe("string");
        // !!binary is not resolved → typeof string guard at the consumption site
        // also keeps a Buffer out of node.id even if a future yaml version
        // changed the default.
        expect(Buffer.isBuffer(doc?.id)).toBe(false);
      } finally {
        unlinkSync(tmpPath);
        rmdirSync(tmpSpecs);
        rmdirSync(tmpRoot);
      }
    });

    it("should fall back to the default doc id when node_id is not a string (e.g. circular alias)", () => {
      const tmpRoot = resolve(import.meta.dirname, "fixtures/tmp-circular-anchor");
      const tmpSpecs = resolve(tmpRoot, "specs");
      mkdirSync(tmpSpecs, { recursive: true });
      const tmpPath = resolve(tmpSpecs, "circular.md");
      writeFileSync(
        tmpPath,
        `---
artgraph: &a
  node_id: *a
---
# Body
`,
      );
      try {
        const result = parseMarkdown(tmpPath, { rootDir: tmpRoot });
        const doc = result.nodes.find((n) => n.kind === "doc");
        expect(typeof doc?.id).toBe("string");
        // graph output must remain JSON-serializable
        expect(() => JSON.stringify(doc)).not.toThrow();
      } finally {
        unlinkSync(tmpPath);
        rmdirSync(tmpSpecs);
        rmdirSync(tmpRoot);
      }
    });
  });

  describe("malformed YAML frontmatter", () => {
    it("should not crash on invalid YAML and fall back to treating content as body", () => {
      const tmpRoot = resolve(import.meta.dirname, "fixtures/tmp-malformed-yaml");
      const tmpSpecs = resolve(tmpRoot, "specs");
      mkdirSync(tmpSpecs, { recursive: true });
      const tmpPath = resolve(tmpSpecs, "malformed.md");
      writeFileSync(
        tmpPath,
        `---
artgraph:
  node_id: "test
  bad_indent
    - broken: [unclosed
---
# Malformed frontmatter
`,
      );

      try {
        const result = parseMarkdown(tmpPath, { rootDir: tmpRoot });
        expect(result.nodes.length).toBeGreaterThanOrEqual(1);
        const docNode = result.nodes.find((n) => n.kind === "doc");
        expect(docNode).toBeDefined();
      } finally {
        unlinkSync(tmpPath);
        rmdirSync(tmpSpecs);
        rmdirSync(tmpRoot);
      }
    });
  });

  describe("custom reqPatterns (FR-007)", () => {
    it("should extract IDs with custom listItem pattern", () => {
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/custom-ids.md"), {
        reqPatterns: { listItem: "^#(\\d+)[:\\s]" },
      });
      const reqIds = result.nodes.filter((n) => n.kind === "req").map((n) => n.id);
      // Assert the exact set so stray/duplicate nodes are caught.
      expect(reqIds).toEqual(["123", "456"]);
    });

    it("should not extract custom IDs with default pattern", () => {
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/custom-ids.md"));
      const reqNodes = result.nodes.filter((n) => n.kind === "req");
      expect(reqNodes).toHaveLength(0);
    });

    it("should extract IDs with custom heading pattern", () => {
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/custom-heading.md"), {
        reqPatterns: { heading: "^(US\\d+)\\s*:" },
      });
      const reqIds = result.nodes.filter((n) => n.kind === "req").map((n) => n.id);
      expect(reqIds).toContain("US42");
      expect(reqIds).toContain("US99");
    });

    it("should fall back to default listItem when only heading is customized", () => {
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/auth.md"), {
        reqPatterns: { heading: "^(Custom\\d+)\\s*:" },
      });
      const reqIds = result.nodes.filter((n) => n.kind === "req").map((n) => n.id);
      expect(reqIds).toContain("AUTH-001");
    });

    it("should fall back to default heading when only listItem is customized", () => {
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/kiro-style.md"), {
        reqPatterns: { listItem: "^(CUSTOM-\\d+)[:\\s]" },
      });
      const reqIds = result.nodes.filter((n) => n.kind === "req").map((n) => n.id);
      expect(reqIds).toContain("Requirement-1");
    });
  });

  describe("frontmatter metadata (FR-008)", () => {
    it("should extract all metadata fields from frontmatter", () => {
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/with-metadata.md"));
      const doc = result.nodes.find((n) => n.kind === "doc");
      expect(doc).toBeDefined();
      expect(doc!.metadata).toEqual({
        title: "認証設計",
        status: "draft",
        priority: "P1",
        owner: "yamada",
      });
    });

    it("should include only present metadata fields", () => {
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/metadata-partial.md"));
      const doc = result.nodes.find((n) => n.kind === "doc");
      expect(doc).toBeDefined();
      expect(doc!.metadata).toEqual({ title: "タイトルのみ" });
    });

    it("should leave metadata undefined when no metadata fields exist in frontmatter", () => {
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/auth.md"));
      const doc = result.nodes.find((n) => n.kind === "doc");
      expect(doc).toBeDefined();
      expect(doc!.metadata).toBeUndefined();
    });

    it("should not attach metadata to req nodes", () => {
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/with-metadata.md"));
      const reqNodes = result.nodes.filter((n) => n.kind === "req");
      expect(reqNodes.length).toBeGreaterThan(0);
      for (const req of reqNodes) {
        expect(req.metadata).toBeUndefined();
      }
    });

    it("should coerce non-string metadata values to strings", () => {
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/metadata-coerce.md"));
      const doc = result.nodes.find((n) => n.kind === "doc");
      expect(doc).toBeDefined();
      expect(doc!.metadata).toEqual({
        title: "123",
        status: "true",
        priority: "2",
      });
    });

    it("should leave metadata undefined when frontmatter is entirely absent", () => {
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/prose-only.md"));
      const doc = result.nodes.find((n) => n.kind === "doc");
      expect(doc).toBeDefined();
      expect(doc!.metadata).toBeUndefined();
    });
  });

  describe("issue #11: inline markdown links", () => {
    it("extracts a plain inline link as an inlineLinks ref", () => {
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/inline-links/source.md"), {
        rootDir: FIXTURE_DIR,
        specDirPrefix: "specs",
      });
      const targets = result.inlineLinks.map((l) => l.targetRelPath);
      expect(targets).toContain("specs/inline-links/target.md");
    });

    it("strips fragment and query before resolving the target", () => {
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/inline-links/source.md"), {
        rootDir: FIXTURE_DIR,
        specDirPrefix: "specs",
      });
      // 5 links in source.md hit target.md after normalization:
      //   plain, #section, ?v=1, ?v=1#x, percent-encoded ./target%2Emd
      const toTarget = result.inlineLinks.filter(
        (l) => l.targetRelPath === "specs/inline-links/target.md",
      );
      expect(toTarget.length).toBe(5);
    });

    it("ignores images, external URLs, mailto, non-md, empty href and pure fragments", () => {
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/inline-links/source.md"), {
        rootDir: FIXTURE_DIR,
        specDirPrefix: "specs",
      });
      // None of the inline links should target external/non-md/etc.
      for (const link of result.inlineLinks) {
        expect(link.targetRelPath.endsWith(".md")).toBe(true);
        expect(link.targetRelPath.startsWith("http")).toBe(false);
      }
      // The image and external/mailto/.ts entries should not appear
      const raws = result.inlineLinks.map((l) => l.rawHref);
      expect(raws).not.toContain("https://example.com/design.md");
      expect(raws).not.toContain("mailto:foo@example.com");
      expect(raws).not.toContain("./source.ts");
      expect(raws).not.toContain("#section");
      expect(raws).not.toContain("");
    });

    it("decodes percent-encoded paths", () => {
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/inline-links/source.md"), {
        rootDir: FIXTURE_DIR,
        specDirPrefix: "specs",
      });
      const encoded = result.inlineLinks.find((l) => l.rawHref === "./target%2Emd");
      expect(encoded).toBeDefined();
      expect(encoded!.targetRelPath).toBe("specs/inline-links/target.md");
    });

    it("resolves reference-style links (full, collapsed, shortcut)", () => {
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/inline-links/ref-source.md"), {
        rootDir: FIXTURE_DIR,
        specDirPrefix: "specs",
      });
      const toTarget = result.inlineLinks.filter(
        (l) => l.targetRelPath === "specs/inline-links/target.md",
      );
      // Three resolvable references: [target full][ref-target], [ref-target][], [ref-target]
      expect(toTarget.length).toBe(3);
    });

    it("does not resolve reference-style links with unknown definition", () => {
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/inline-links/ref-source.md"), {
        rootDir: FIXTURE_DIR,
        specDirPrefix: "specs",
      });
      // Only the 3 resolvable references to target.md (full, collapsed,
      // shortcut) survive — the `[missing][nope]` line cites an undefined
      // label and must produce no entry. Pinning the total count catches
      // both directions: undefined labels leaking through, or resolvable
      // references being dropped by mistake.
      expect(result.inlineLinks).toHaveLength(3);
      for (const link of result.inlineLinks) {
        expect(link.targetRelPath).toBe("specs/inline-links/target.md");
      }
    });

    it("ignores links inside fenced and indented code blocks and inline code", () => {
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/inline-links/code-fence.md"), {
        rootDir: FIXTURE_DIR,
        specDirPrefix: "specs",
      });
      // Only the trailing [real](./target.md) link should be picked up
      expect(result.inlineLinks).toHaveLength(1);
      expect(result.inlineLinks[0].targetRelPath).toBe("specs/inline-links/target.md");
    });

    it("populates sourceDocId from the source file's doc node id", () => {
      const result = parseMarkdown(resolve(FIXTURE_DIR, "specs/inline-links/source.md"), {
        rootDir: FIXTURE_DIR,
        specDirPrefix: "specs",
      });
      for (const link of result.inlineLinks) {
        expect(link.sourceDocId).toBe("doc:inline-links/source.md");
      }
    });

    it("does not mistake a Windows drive letter `C:/...` for a URL scheme", () => {
      // Regression: URL_SCHEME_RE used to match single-letter prefixes, so
      // `[w](C:/foo.md)` would be silently dropped as if it were `mailto:` etc.
      const tmpRoot = resolve(import.meta.dirname, "fixtures/tmp-win-drive");
      const tmpSpecs = resolve(tmpRoot, "specs");
      mkdirSync(tmpSpecs, { recursive: true });
      const src = resolve(tmpSpecs, "win.md");
      writeFileSync(src, `# Windows drive letter\n\n[w](C:/proj/specs/target.md)\n`);

      try {
        const result = parseMarkdown(src, { rootDir: tmpRoot });
        // The link is captured (not rejected as a URL). The target path won't
        // resolve to a real doc node on Linux/macOS, but that's the builder's
        // problem — what we're asserting here is the scheme-check no longer
        // trips on `C:`.
        expect(result.inlineLinks).toHaveLength(1);
        expect(result.inlineLinks[0].rawHref).toBe("C:/proj/specs/target.md");
      } finally {
        unlinkSync(src);
        rmdirSync(tmpSpecs);
        rmdirSync(tmpRoot);
      }
    });

    it("does not parse links with rootDir-escaping `..` (returns no inlineLinks)", () => {
      // M7: parser drops links that resolve outside rootDir silently.
      const tmpRoot = resolve(import.meta.dirname, "fixtures/tmp-rootdir-escape");
      const tmpSpecs = resolve(tmpRoot, "specs");
      mkdirSync(tmpSpecs, { recursive: true });
      const src = resolve(tmpSpecs, "escape.md");
      writeFileSync(src, `# Escape\n\nUp two dirs: [esc](../../outside.md).\n`);

      try {
        const result = parseMarkdown(src, { rootDir: tmpRoot });
        expect(result.inlineLinks).toEqual([]);
      } finally {
        unlinkSync(src);
        rmdirSync(tmpSpecs);
        rmdirSync(tmpRoot);
      }
    });

    it("survives malformed percent-encoding without throwing", () => {
      // M7: decodeURIComponent throws on `%G9` etc.; parser must catch and skip.
      const tmpRoot = resolve(import.meta.dirname, "fixtures/tmp-bad-percent");
      const tmpSpecs = resolve(tmpRoot, "specs");
      mkdirSync(tmpSpecs, { recursive: true });
      const src = resolve(tmpSpecs, "bad.md");
      writeFileSync(src, `# Bad percent\n\nMalformed: [bad](./target%G9.md).\n`);

      try {
        const result = parseMarkdown(src, { rootDir: tmpRoot });
        // The malformed link is silently dropped from inlineLinks; parse did
        // not throw. No other links exist in this file.
        expect(result.inlineLinks).toEqual([]);
      } finally {
        unlinkSync(src);
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
