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

  describe("US3: spec-kit task extraction (FR-009 / FR-010)", () => {
    it("extracts T### task nodes from plan.md", () => {
      const file = resolve(
        FIXTURE_DIR,
        "tasks/speckit-plan/specs/auth/plan.md",
      );
      const result = parseMarkdown(file);
      const taskNodes = result.nodes.filter((n) => n.kind === "task");
      const ids = taskNodes.map((n) => n.id).sort();
      expect(ids).toEqual(["T001", "T002"]);
      for (const node of taskNodes) {
        expect(node.contentHash.length).toBe(16);
      }
    });

    it("generates implements edges from plan.md @impl(target)", () => {
      const file = resolve(
        FIXTURE_DIR,
        "tasks/speckit-plan/specs/auth/plan.md",
      );
      const result = parseMarkdown(file);
      const implEdges = result.edges
        .filter((e) => e.kind === "implements")
        .sort((a, b) => a.source.localeCompare(b.source));
      expect(implEdges).toEqual([
        { source: "T001", target: "auth-login", kind: "implements" },
        { source: "T002", target: "auth-session", kind: "implements" },
      ]);
    });

    it("generates verifies edges from tasks.md [REQ-FR-xxx] preserving prefix", () => {
      const file = resolve(
        FIXTURE_DIR,
        "tasks/speckit-tasks/specs/auth/tasks.md",
      );
      const result = parseMarkdown(file);
      const verifies = result.edges
        .filter((e) => e.kind === "verifies")
        .sort((a, b) => a.target.localeCompare(b.target));
      expect(verifies).toEqual([
        { source: "T010", target: "REQ-FR-001", kind: "verifies" },
        { source: "T011", target: "REQ-FR-002", kind: "verifies" },
        { source: "T011", target: "REQ-FR-003", kind: "verifies" },
      ]);
    });
  });

  describe("US3: kiro hierarchical task extraction (FR-012)", () => {
    it("extracts hierarchical numeric IDs as independent task nodes", () => {
      const file = resolve(
        FIXTURE_DIR,
        "tasks/kiro-tasks/specs/billing/tasks.md",
      );
      const result = parseMarkdown(file);
      const taskNodes = result.nodes.filter((n) => n.kind === "task");
      const ids = taskNodes.map((n) => n.id).sort();
      expect(ids).toEqual(["1", "1.1", "1.2", "2"]);
    });

    it("emits no implements edges (kiro has no @impl tag convention)", () => {
      const file = resolve(
        FIXTURE_DIR,
        "tasks/kiro-tasks/specs/billing/tasks.md",
      );
      const result = parseMarkdown(file);
      expect(result.edges.filter((e) => e.kind === "implements")).toEqual([]);
    });

    it("extracts verifies edges from `_Requirements: X, Y_` italic lists", () => {
      const file = resolve(
        FIXTURE_DIR,
        "tasks/kiro-tasks/specs/billing/tasks.md",
      );
      const result = parseMarkdown(file);
      const verifies = result.edges
        .filter((e) => e.kind === "verifies")
        .sort((a, b) =>
          a.source === b.source
            ? a.target.localeCompare(b.target)
            : a.source.localeCompare(b.source),
        );
      expect(verifies).toEqual([
        { source: "1", target: "7.1", kind: "verifies" },
        { source: "1", target: "7.2", kind: "verifies" },
        { source: "1.1", target: "7.3", kind: "verifies" },
        { source: "1.2", target: "8.1", kind: "verifies" },
        { source: "2", target: "8.2", kind: "verifies" },
        { source: "2", target: "9.1", kind: "verifies" },
      ]);
    });

    it("does NOT inherit nested-task _Requirements: into the parent task's scope", () => {
      // Parent task `1` has its own `_Requirements: 7.1, 7.2_`. Nested task
      // `1.1` (indented under `1`) has its own `_Requirements: 7.3_`. The
      // parent must NOT pick up `7.3` — otherwise a 3-deep Kiro plan would
      // bubble every leaf requirement to the root task and pollute traversals.
      const file = resolve(
        FIXTURE_DIR,
        "tasks/kiro-tasks/specs/billing/tasks.md",
      );
      const result = parseMarkdown(file);
      const task1Targets = result.edges
        .filter((e) => e.kind === "verifies" && e.source === "1")
        .map((e) => e.target)
        .sort();
      expect(task1Targets).toEqual(["7.1", "7.2"]);
      expect(task1Targets).not.toContain("7.3");
    });
  });

  describe("US3: cross-cutting tag behavior", () => {
    it("accepts [X], [x], and [ ] checkbox variants", () => {
      const tmpDir = resolve(FIXTURE_DIR, "tasks-tmp");
      mkdirSync(tmpDir, { recursive: true });
      const file = resolve(tmpDir, "tasks.md");
      writeFileSync(
        file,
        [
          "# Tasks",
          "",
          "- [X] T100 upper @impl(uX)",
          "- [x] T101 lower @impl(uL)",
          "- [ ] T102 empty @impl(uE)",
          "",
        ].join("\n"),
      );
      try {
        const result = parseMarkdown(file);
        const ids = result.nodes
          .filter((n) => n.kind === "task")
          .map((n) => n.id)
          .sort();
        expect(ids).toEqual(["T100", "T101", "T102"]);
      } finally {
        unlinkSync(file);
        rmdirSync(tmpDir);
      }
    });

    it("emits multiple verifies edges when one task carries multiple [REQ-] tags", () => {
      const file = resolve(
        FIXTURE_DIR,
        "tasks/speckit-tasks/specs/auth/tasks.md",
      );
      const result = parseMarkdown(file);
      const t011 = result.edges.filter(
        (e) => e.kind === "verifies" && e.source === "T011",
      );
      expect(t011).toHaveLength(2);
      expect(t011.map((e) => e.target).sort()).toEqual(["REQ-FR-002", "REQ-FR-003"]);
    });

    it("skips edge generation when @impl() target is empty", () => {
      const tmpDir = resolve(FIXTURE_DIR, "tasks-tmp-empty");
      mkdirSync(tmpDir, { recursive: true });
      const file = resolve(tmpDir, "tasks.md");
      writeFileSync(
        file,
        ["# Tasks", "", "- [X] T200 no target @impl()", ""].join("\n"),
      );
      try {
        const result = parseMarkdown(file);
        const impl = result.edges.filter((e) => e.kind === "implements");
        expect(impl).toHaveLength(0);
        const taskNodes = result.nodes.filter((n) => n.kind === "task");
        expect(taskNodes.map((n) => n.id)).toEqual(["T200"]);
      } finally {
        unlinkSync(file);
        rmdirSync(tmpDir);
      }
    });

    it("recognizes [REQ-] inside plan.md and @impl() inside tasks.md (symmetric U1)", () => {
      const tmpDir = resolve(FIXTURE_DIR, "tasks-tmp-symmetric");
      mkdirSync(tmpDir, { recursive: true });
      const planFile = resolve(tmpDir, "plan.md");
      const tasksFile = resolve(tmpDir, "tasks.md");
      writeFileSync(
        planFile,
        ["# Plan", "", "- [X] T300 review login [REQ-FR-100]", ""].join("\n"),
      );
      writeFileSync(
        tasksFile,
        ["# Tasks", "", "- [X] T301 wire login @impl(login-handler)", ""].join("\n"),
      );
      try {
        const planResult = parseMarkdown(planFile);
        const tasksResult = parseMarkdown(tasksFile);
        expect(
          planResult.edges.some(
            (e) =>
              e.kind === "verifies" &&
              e.source === "T300" &&
              e.target === "REQ-FR-100",
          ),
        ).toBe(true);
        expect(
          tasksResult.edges.some(
            (e) =>
              e.kind === "implements" &&
              e.source === "T301" &&
              e.target === "login-handler",
          ),
        ).toBe(true);
      } finally {
        unlinkSync(planFile);
        unlinkSync(tasksFile);
        rmdirSync(tmpDir);
      }
    });

    it("kiro preset requires a checkbox — prose numbered lists do NOT become tasks (H1)", () => {
      const tmpDir = resolve(FIXTURE_DIR, "tasks-tmp-h1");
      mkdirSync(tmpDir, { recursive: true });
      const file = resolve(tmpDir, "tasks.md");
      writeFileSync(
        file,
        [
          "# Tasks",
          "",
          "- 1 release shipped in Q2",
          "- 2 hot-fixes planned",
          "- 3.14 GB free space",
          "- [X] 4 actual kiro task",
          "  - _Requirements: 1.2_",
          "",
        ].join("\n"),
      );
      try {
        const result = parseMarkdown(file);
        const taskIds = result.nodes
          .filter((n) => n.kind === "task")
          .map((n) => n.id);
        // Only the checkbox-prefixed entry should be a task.
        expect(taskIds).toEqual(["4"]);
        // And its _Requirements: must reach via kiro's verifiesTagRe.
        const verifies = result.edges.find(
          (e) => e.kind === "verifies" && e.source === "4",
        );
        expect(verifies?.target).toBe("1.2");
      } finally {
        unlinkSync(file);
        rmdirSync(tmpDir);
      }
    });

    it("@impl target is single-line — newline inside parens does NOT escape (M1)", () => {
      const tmpDir = resolve(FIXTURE_DIR, "tasks-tmp-m1");
      mkdirSync(tmpDir, { recursive: true });
      const file = resolve(tmpDir, "tasks.md");
      // Soft-wrapped paragraph: an unclosed `@impl(...` on line 1 followed by
      // text on line 2. Pre-fix, `[^)]+` would capture across the newline; now
      // the regex requires the target to stay on one line and the malformed
      // tag emits no edge.
      writeFileSync(
        file,
        [
          "# Tasks",
          "",
          "- [X] T500 something @impl(broken-target",
          "  continuation line) more text",
          "",
        ].join("\n"),
      );
      try {
        const result = parseMarkdown(file);
        const impl = result.edges.filter((e) => e.kind === "implements");
        // The malformed multi-line @impl must NOT produce an edge with an
        // embedded newline. (It may produce zero edges, which is the intended
        // safe behaviour — better to drop than to emit garbage.)
        for (const e of impl) {
          expect(e.target).not.toContain("\n");
        }
      } finally {
        unlinkSync(file);
        rmdirSync(tmpDir);
      }
    });
  });
});
