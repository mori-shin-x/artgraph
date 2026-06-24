import { describe, it, expect, afterAll } from "vitest";
import { resolve } from "node:path";
import { writeFileSync, unlinkSync, mkdirSync, rmdirSync, rmSync } from "node:fs";
import { parseMarkdown, stripAnnotations, extractAnnotations } from "../src/parsers/markdown.js";

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

// ---------------------------------------------------------------------------
// req→req annotation helpers (specs/010-req-req-dependency)
// ---------------------------------------------------------------------------

describe("stripAnnotations", () => {
  it("is a no-op when there is no annotation", () => {
    expect(stripAnnotations("AUTH-002: セッション管理")).toBe("AUTH-002: セッション管理");
  });

  it("removes a single trailing annotation along with its leading whitespace", () => {
    expect(stripAnnotations("AUTH-002: セッション (depends_on: AUTH-001)")).toBe(
      "AUTH-002: セッション",
    );
  });

  it("removes annotations regardless of keyword", () => {
    expect(stripAnnotations("X (derives_from: Y)")).toBe("X");
  });

  it("removes multiple annotations on one line", () => {
    expect(stripAnnotations("X (depends_on: A)(derives_from: B)")).toBe("X");
  });

  it("tolerates whitespace variations inside annotations", () => {
    expect(stripAnnotations("X ( depends_on : A , B )")).toBe("X");
  });

  it("strips empty annotations so they do not affect the hash either", () => {
    expect(stripAnnotations("X (depends_on:)")).toBe("X");
    expect(stripAnnotations("X (depends_on: )")).toBe("X");
  });

  it("hash invariance: stripped text equals the unannotated original", () => {
    const original = "AUTH-002: セッション管理";
    const annotated = "AUTH-002: セッション管理 (depends_on: AUTH-001, AUTH-005)";
    expect(stripAnnotations(annotated)).toBe(original);
  });

  it("ignores `(depends on ...)` without underscore (no false positive)", () => {
    expect(stripAnnotations("text (depends on X) more")).toBe("text (depends on X) more");
  });
});

describe("extractAnnotations", () => {
  // Permissive ID pattern for unit-test readability. Validates that IDs start
  // with an uppercase letter — enough to reject `foo` while accepting terse
  // identifiers like `A`, `B`, `AUTH-001`.
  const opts = { filePath: "spec.md", codeIdRE: /^[A-Z][A-Za-z0-9-]*$/ };

  // Case 1: single ID
  it("extracts a single-ID depends_on annotation", () => {
    const { extracts, warnings } = extractAnnotations("(depends_on: A)", "X", 1, opts);
    expect(warnings).toEqual([]);
    expect(extracts).toEqual([{ reqId: "X", kind: "depends_on", targets: ["A"], sourceLine: 1 }]);
  });

  // Case 2: multiple IDs
  it("extracts multiple IDs from one annotation", () => {
    const { extracts, warnings } = extractAnnotations(
      "(depends_on: A, B, C)",
      "X",
      2,
      opts,
    );
    expect(warnings).toEqual([]);
    expect(extracts).toEqual([
      { reqId: "X", kind: "depends_on", targets: ["A", "B", "C"], sourceLine: 2 },
    ]);
  });

  // Case 3: derives_from
  it("extracts derives_from kind", () => {
    const { extracts } = extractAnnotations("(derives_from: A)", "X", 1, opts);
    expect(extracts[0].kind).toBe("derives_from");
  });

  // Case 4: **BOLD**
  it("strips surrounding **BOLD** from IDs", () => {
    const { extracts } = extractAnnotations("(depends_on: **A-1**)", "X", 1, opts);
    expect(extracts[0].targets).toEqual(["A-1"]);
  });

  // Case 5: whitespace variations
  it("tolerates whitespace around colon and commas", () => {
    const { extracts } = extractAnnotations(
      "( depends_on : A , B )",
      "X",
      1,
      opts,
    );
    expect(extracts[0].targets).toEqual(["A", "B"]);
  });

  // Case 6: same-keyword duplicated on one line → 2 extracts
  it("treats `(depends_on: A)(depends_on: B)` as two separate extracts", () => {
    const { extracts } = extractAnnotations(
      "(depends_on: A)(depends_on: B)",
      "X",
      1,
      opts,
    );
    expect(extracts).toHaveLength(2);
    expect(extracts.map((e) => e.targets)).toEqual([["A"], ["B"]]);
  });

  // Case 7: mixed keywords on one line
  it("treats mixed-keyword annotations as separate extracts", () => {
    const { extracts } = extractAnnotations(
      "(depends_on: A)(derives_from: B)",
      "X",
      1,
      opts,
    );
    expect(extracts).toHaveLength(2);
    expect(extracts[0].kind).toBe("depends_on");
    expect(extracts[1].kind).toBe("derives_from");
  });

  // Case 11: duplicate same-kind same-target produces 2 extracts (dedup is builder's job)
  it("does not dedup same source/target/kind at extract time (builder handles it)", () => {
    const { extracts } = extractAnnotations(
      "(depends_on: A)(depends_on: A)",
      "X",
      1,
      opts,
    );
    expect(extracts).toHaveLength(2);
    expect(extracts.every((e) => e.targets[0] === "A")).toBe(true);
  });

  // Case 14: underscore-less prose
  it("ignores `(depends on A)` without underscore (no extract, no warning)", () => {
    const { extracts, warnings } = extractAnnotations("(depends on A)", "X", 1, opts);
    expect(extracts).toEqual([]);
    expect(warnings).toEqual([]);
  });

  // Case 16: uppercase keyword
  it("ignores uppercase `DEPENDS_ON` (no extract, no warning)", () => {
    const { extracts, warnings } = extractAnnotations("(DEPENDS_ON: A)", "X", 1, opts);
    expect(extracts).toEqual([]);
    expect(warnings).toEqual([]);
  });

  // Case 17: empty annotation → empty-annotation warning
  it("emits empty-annotation warning for `(depends_on:)`", () => {
    const { extracts, warnings } = extractAnnotations("(depends_on:)", "X", 1, opts);
    expect(extracts).toEqual([]);
    expect(warnings).toEqual([
      { type: "empty-annotation", key: "depends_on", filePath: "spec.md" },
    ]);
  });

  it("emits empty-annotation warning for `(depends_on: )` (whitespace only)", () => {
    const { warnings } = extractAnnotations("(depends_on: )", "X", 1, opts);
    expect(warnings).toEqual([
      { type: "empty-annotation", key: "depends_on", filePath: "spec.md" },
    ]);
  });

  // Case 18: invalid ID → invalid-annotation-id warning
  it("emits invalid-annotation-id warning when ID does not match codeId pattern", () => {
    const { extracts, warnings } = extractAnnotations("(depends_on: foo)", "X", 1, opts);
    expect(extracts).toEqual([]);
    expect(warnings).toEqual([
      { type: "invalid-annotation-id", key: "foo", filePath: "spec.md" },
    ]);
  });

  it("keeps valid IDs alongside warnings for invalid siblings", () => {
    const { extracts, warnings } = extractAnnotations(
      "(depends_on: A, foo, B)",
      "X",
      1,
      opts,
    );
    expect(extracts).toEqual([
      { reqId: "X", kind: "depends_on", targets: ["A", "B"], sourceLine: 1 },
    ]);
    expect(warnings).toEqual([
      { type: "invalid-annotation-id", key: "foo", filePath: "spec.md" },
    ]);
  });
});

// Integration tests through parseMarkdown — exercise list-item annotations as
// they flow from the actual fixture into nodes/edges/warnings.
describe("parseMarkdown — req→req annotations on list items (US1)", () => {
  const fixturePath = resolve(FIXTURE_DIR, "req-req-annotations/list-item.md");

  it("generates annotation edges for the 7 accepted patterns", () => {
    const { edges } = parseMarkdown(fixturePath);
    const annotationEdges = edges.filter((e) => e.provenance === "annotation");

    // 1 (AUTH-002→AUTH-001) + 1 (AUTH-003→AUTH-002) + 3 (AUTH-004→A1/A2/A3) +
    // 1 (AUTH-005→AUTH-001 via BOLD) + 2 (AUTH-006→A1/A2 via whitespace) +
    // 2 (AUTH-007: depends_on + derives_from parallel) = 10
    expect(annotationEdges).toHaveLength(10);

    expect(annotationEdges).toContainEqual({
      source: "AUTH-002",
      target: "AUTH-001",
      kind: "depends_on",
      provenance: "annotation",
    });
    expect(annotationEdges).toContainEqual({
      source: "AUTH-003",
      target: "AUTH-002",
      kind: "derives_from",
      provenance: "annotation",
    });
    expect(annotationEdges).toContainEqual({
      source: "AUTH-007",
      target: "AUTH-002",
      kind: "derives_from",
      provenance: "annotation",
    });
  });

  it("emits zero warnings for the prose / quoted / uppercase false-positive lines", () => {
    const { warnings } = parseMarkdown(fixturePath);
    // The fixture intentionally includes `(depends on AUTH-001)`, `(DEPENDS_ON: AUTH-001)`,
    // a quoted-block annotation, and a fenced-code annotation. None should
    // produce an annotation extract or warning.
    expect(warnings).toEqual([]);
  });

  it("AUTH-005 BOLD form resolves to the bare ID target", () => {
    const { edges } = parseMarkdown(fixturePath);
    const auth5 = edges.find(
      (e) => e.source === "AUTH-005" && e.provenance === "annotation",
    );
    expect(auth5).toBeDefined();
    expect(auth5?.target).toBe("AUTH-001");
  });
});

describe("parseMarkdown — req→req annotations on Kiro headings (US2)", () => {
  const fixturePath = resolve(FIXTURE_DIR, "req-req-annotations/heading-kiro.md");

  it("recognises annotations on the first paragraph head/tail and single-line paragraphs", () => {
    const { edges } = parseMarkdown(fixturePath);
    const annEdges = edges.filter((e) => e.provenance === "annotation");
    // Req 2: head line, Req 3: tail line, Req 4: single-line head=tail. = 3 edges.
    expect(annEdges).toHaveLength(3);
    expect(annEdges).toContainEqual({
      source: "Requirement-2",
      target: "Requirement-1",
      kind: "depends_on",
      provenance: "annotation",
    });
    expect(annEdges).toContainEqual({
      source: "Requirement-3",
      target: "Requirement-2",
      kind: "depends_on",
      provenance: "annotation",
    });
    expect(annEdges).toContainEqual({
      source: "Requirement-4",
      target: "Requirement-1",
      kind: "depends_on",
      provenance: "annotation",
    });
  });

  it("does NOT generate edges for heading-line or mid-paragraph parens (silent skip)", () => {
    const { edges, warnings } = parseMarkdown(fixturePath);
    const annEdges = edges.filter((e) => e.provenance === "annotation");
    // Requirement-X (heading-line paren) and Requirement-Y (mid-paragraph) must NOT appear.
    expect(annEdges.find((e) => e.target === "Requirement-X")).toBeUndefined();
    expect(annEdges.find((e) => e.target === "Requirement-Y")).toBeUndefined();
    // And silent — no parser warnings for those misplaced parens.
    expect(warnings).toEqual([]);
  });
});

// US3: hash invariance under annotation add/change/remove (SC-003, Constitution I)
describe("parseMarkdown — contentHash invariance under annotation churn (US3)", () => {
  // Helper: write a tiny spec.md and return the req's contentHash.
  const tmpRoot = resolve(import.meta.dirname, "fixtures/_tmp-hash-invariance");

  function hashOf(spec: string, reqId: string): string {
    mkdirSync(tmpRoot, { recursive: true });
    const file = resolve(tmpRoot, "spec.md");
    writeFileSync(file, spec);
    const { nodes } = parseMarkdown(file);
    const node = nodes.find((n) => n.id === reqId);
    if (!node) throw new Error(`req ${reqId} not found in parsed result`);
    return node.contentHash;
  }

  afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

  // T019: list-item — add / change / remove annotation, hash unchanged
  describe("list-item req", () => {
    const baseline = "# Spec\n\n- AUTH-002: セッション管理\n";
    const added = "# Spec\n\n- AUTH-002: セッション管理 (depends_on: AUTH-001)\n";
    const changed = "# Spec\n\n- AUTH-002: セッション管理 (depends_on: AUTH-001, AUTH-005)\n";
    const removed = baseline;

    it("hash is unchanged when an annotation is added", () => {
      expect(hashOf(added, "AUTH-002")).toBe(hashOf(baseline, "AUTH-002"));
    });

    it("hash is unchanged when annotation IDs are changed", () => {
      expect(hashOf(changed, "AUTH-002")).toBe(hashOf(baseline, "AUTH-002"));
    });

    it("hash is unchanged when an annotation is removed", () => {
      expect(hashOf(removed, "AUTH-002")).toBe(hashOf(added, "AUTH-002"));
    });
  });

  // T020: heading — same invariants
  describe("heading req (Kiro)", () => {
    const baseline = "# Spec\n\n## Requirement 2: セッション管理\n\nセッションは 24 時間有効。\n";
    const addedHead =
      "# Spec\n\n## Requirement 2: セッション管理\n\n(depends_on: Requirement-1)\nセッションは 24 時間有効。\n";
    const addedTail =
      "# Spec\n\n## Requirement 2: セッション管理\n\nセッションは 24 時間有効。 (depends_on: Requirement-1)\n";

    it("hash is unchanged when a head-line annotation is added", () => {
      expect(hashOf(addedHead, "Requirement-2")).toBe(hashOf(baseline, "Requirement-2"));
    });

    it("hash is unchanged when a tail-line annotation is added", () => {
      expect(hashOf(addedTail, "Requirement-2")).toBe(hashOf(baseline, "Requirement-2"));
    });
  });

  // T021: regression — body text changes MUST flip the hash (strip is not over-eager)
  it("body text changes still flip the hash (strip is not over-greedy)", () => {
    const before = "# Spec\n\n- AUTH-002: セッション管理 (depends_on: AUTH-001)\n";
    const after = "# Spec\n\n- AUTH-002: セッション維持 (depends_on: AUTH-001)\n";
    expect(hashOf(before, "AUTH-002")).not.toBe(hashOf(after, "AUTH-002"));
  });
});
