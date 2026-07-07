import { resolve, relative, basename, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { globSync } from "glob";
import {
  parseMarkdownContent,
  type ParseWarning,
  type InlineLinkRef,
} from "../parsers/markdown.js";
import { globCodeFiles, parseTSFilePaths } from "../parsers/typescript.js";
import {
  computeCacheFingerprint,
  hashContent,
  importTargetsExist,
  readParseCache,
  writeParseCache,
  type MdFragment,
  type TsFragment,
} from "../parse-cache.js";
import { dedupEdges, sortNodesById } from "./canonical.js";
import type { ArtifactGraph, GraphNode, GraphEdge, ArtgraphConfig } from "../types.js";

export interface BuildWarning {
  type:
    | "duplicate-id"
    | "ambiguous-id"
    | "orphan-doc"
    | "orphan-edge"
    | "invalid-relation"
    | "reserved-prefix"
    | "unresolved-link"
    | "out-of-scope-link"
    | "invalid-annotation-id"
    | "empty-annotation"
    | "self-reference-annotation";
  id: string;
  files: string[];
  message?: string;
}

interface CollectedReq {
  id: string;
  specDir: string;
  node: GraphNode;
  edges: GraphEdge[];
}

// Fixed convention presets (C-3). Each entry is a [from, to] pair of file-name
// stems (lower-cased, extension-stripped) within the *same directory*; when both
// files exist a `derives_from` edge is generated from the `from` doc to the `to`
// doc. A single flat list is sufficient because mixing SDD tools in one
// directory is rare.
//
//   kiro:     design→requirements, tasks→design
//   spec-kit: plan→spec, tasks→plan, research→spec
//
// Note: the shared `tasks` stem produces *both* `tasks→design` and `tasks→plan`
// when a directory happens to contain both `design.md` and `plan.md`. The dedup
// step (key: `source|target|kind`) does NOT collapse these, since the targets
// differ. This is intentional — a directory advertising both tools genuinely
// has two parent chains — but downstream consumers (e.g. `lock.ts`) will see
// `tasks` listed under both `design` and `plan`. See the `mixed dir` test in
// builder.test.ts for the locked-in behavior.
//
// User-defined presets are intentionally omitted (YAGNI) until there is demand.
const CONVENTION_EDGES: ReadonlyArray<readonly [from: string, to: string]> = [
  // kiro
  ["design", "requirements"],
  ["tasks", "design"],
  // spec-kit
  ["plan", "spec"],
  ["tasks", "plan"],
  ["research", "spec"],
];

export function buildGraph(
  rootDir: string,
  config: ArtgraphConfig,
): { graph: ArtifactGraph; warnings: BuildWarning[] } {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const warnings: BuildWarning[] = [];

  const autoNodes = config.docGraph?.autoNodes ?? true;
  const autoContains = config.docGraph?.autoContains ?? true;
  const inlineLinksEnabled = config.docGraph?.inlineLinks ?? true;
  const warnUnresolved = config.docGraph?.linkWarnings?.unresolved ?? true;
  const warnOutOfScope = config.docGraph?.linkWarnings?.outOfScope ?? false;
  const RESERVED_PREFIXES = ["doc:", "file:", "test:", "symbol:"];
  const parseWarnings: ParseWarning[] = [];

  // Incremental parse cache (see src/parse-cache.ts). Fragments are a pure
  // memo of per-file parser output; every assembly step below (collision
  // remap, dedup, sorting, warning conversion) still runs fresh each build,
  // so a warm build is structurally identical to a cold one.
  const cacheFingerprint = computeCacheFingerprint(config);
  const prevCache = readParseCache(rootDir, cacheFingerprint);
  const nextMd: Record<string, MdFragment> = {};

  // Pass 1: collect all req nodes and detect collisions
  const collected: CollectedReq[] = [];
  const nonReqNodes: GraphNode[] = [];
  const nonReqEdges: GraphEdge[] = [];
  const allInlineLinks: InlineLinkRef[] = [];

  for (const specDirName of config.specDirs) {
    const specFiles = globSync(resolve(rootDir, specDirName, "**/*.md"));
    for (const file of specFiles) {
      const relFile = relative(rootDir, file);
      const mdSource = readFileSync(file, "utf-8");
      const mdHash = hashContent(mdSource);
      // Key by specDir too: a file nested under two specDirs is parsed once
      // per dir with a different `specDirPrefix` (and thus a different doc id).
      const mdKey = `${specDirName}|${relFile}`;
      const mdHit = prevCache?.data.md[mdKey];
      const result =
        mdHit && mdHit.contentHash === mdHash
          ? mdHit
          : parseMarkdownContent(mdSource, file, {
              rootDir,
              specDirPrefix: specDirName,
              reqPatterns: config.reqPatterns,
              taskConventions: config.taskConventions,
              disableBuiltinTaskConventions: config.disableBuiltinTaskConventions,
            });
      nextMd[mdKey] = {
        contentHash: mdHash,
        nodes: result.nodes,
        edges: result.edges,
        warnings: result.warnings,
        inlineLinks: result.inlineLinks,
      };
      const specDir = extractSpecDir(relFile, config.specDirs);
      // Compute what the auto-generated doc ID would be for this file
      const specDirRelPath = relFile.startsWith(specDirName + "/")
        ? relFile.slice(specDirName.length + 1)
        : relFile;
      const expectedAutoDocId = `doc:${specDirRelPath}`;

      // Collect parse warnings and inline-link references
      parseWarnings.push(...result.warnings);
      if (inlineLinksEnabled) {
        allInlineLinks.push(...result.inlineLinks);
      }

      // Track reqs registered from THIS file so annotation/derives-from edges
      // emitted by the parser bind to the same (specDir, reqId) the parser saw.
      // Looking the source id up in the cross-file `collected` array would
      // mis-attribute edges across specDir collisions (issue: meta-review hash-F2).
      const fileReqs: CollectedReq[] = [];

      for (const node of result.nodes) {
        if (node.kind === "req" || node.kind === "task") {
          // T028: reserved-prefix warning
          if (RESERVED_PREFIXES.some((p) => node.id.startsWith(p))) {
            const prefix = RESERVED_PREFIXES.find((p) => node.id.startsWith(p))!;
            warnings.push({
              type: "reserved-prefix",
              id: node.id,
              files: [node.filePath],
              message: `${node.kind} ID uses reserved prefix "${prefix}". This may conflict with auto-generated node IDs`,
            });
          }
          const cr: CollectedReq = { id: node.id, specDir, node, edges: [] };
          collected.push(cr);
          fileReqs.push(cr);
        } else if (node.kind === "doc") {
          // T027: autoNodes filter - skip auto-generated doc nodes when disabled
          const isAutoGenerated = node.id === expectedAutoDocId;
          if (!autoNodes && isAutoGenerated) {
            continue;
          }
          nonReqNodes.push(node);
        } else {
          nonReqNodes.push(node);
        }
      }

      for (const edge of result.edges) {
        // Match the source against just this file's reqs/tasks so a same-raw-ID
        // entry in another spec dir (e.g. `T001` in two plan.md files) lands on
        // the right collision-qualified node. fileReqs is rebuilt per file above.
        const req = fileReqs.find((c) => c.node.id === edge.source || c.id === edge.source);
        if (req) {
          req.edges.push(edge);
        } else {
          nonReqEdges.push(edge);
        }
      }
    }
  }

  // Detect collisions: same raw ID in different spec dirs
  const idToDirs = new Map<string, Set<string>>();
  for (const req of collected) {
    const dirs = idToDirs.get(req.id) ?? new Set();
    dirs.add(req.specDir);
    idToDirs.set(req.id, dirs);
  }

  const collidingIds = new Set<string>();
  for (const [id, dirs] of idToDirs) {
    if (dirs.size > 1) {
      collidingIds.add(id);
    }
  }

  // Pass 2a: build idMapping up front so per-req edge remap below can resolve
  // forward references (e.g. `T001` referencing `T002` later in `collected`).
  // Without this the order of `collected` would silently decide whether a
  // colliding target gets requalified or stays as the bare ID.
  const idMapping = new Map<string, string>();
  for (const req of collected) {
    const finalId = collidingIds.has(req.id) ? `${req.specDir}/${req.id}` : req.id;
    idMapping.set(`${req.specDir}/${req.id}`, finalId);
  }

  // Pass 2b: register nodes and emit edges with collision-aware remapping for
  // BOTH source and target. Task-emitted edges (e.g. `T001 @impl(REQ-001)`)
  // live in `req.edges`, so without this they would stay pointing at the raw
  // colliding ID and silently orphan after qualification.
  for (const req of collected) {
    const finalId = idMapping.get(`${req.specDir}/${req.id}`)!;

    const node: GraphNode = {
      ...req.node,
      id: finalId,
    };

    const existing = nodes.get(finalId);
    if (existing && existing.filePath !== node.filePath) {
      warnings.push({
        type: "duplicate-id",
        id: finalId,
        files: [existing.filePath, node.filePath],
      });
    }
    nodes.set(finalId, node);

    for (const edge of req.edges) {
      const mappedSource = edge.source === req.id ? finalId : edge.source;
      let mappedTarget: string;
      if (edge.target === req.id) {
        // self-edge — author wrote their own ID as the target
        mappedTarget = finalId;
      } else {
        // Apply the same specDir-aware resolution to ALL req-emitted edges,
        // not just annotation provenance: a task `@impl(FR-001)` in dir authA
        // must bind to authA/FR-001 when FR-001 also exists in exportB, and
        // an ambiguous task→colliding-req with no same-dir match is dropped
        // (instead of leaking as a bare-ID orphan edge — meta-review #3).
        const resolved = resolveAnnotationTarget(edge.target, req.specDir, idMapping, collidingIds);
        if (resolved.ambiguous) {
          // research.md R6 / meta-review #3: ambiguous targets do NOT produce
          // an edge. Emitting `ambiguous-id` warning is sufficient — a stray
          // bare-id edge would otherwise trigger a duplicate orphan-edge warning.
          const dirs = idToDirs.get(edge.target) ?? new Set<string>();
          warnings.push({
            type: "ambiguous-id",
            id: edge.target,
            files: [...dirs].sort(),
          });
          continue;
        }
        mappedTarget = resolved.target;
      }
      edges.push({ ...edge, source: mappedSource, target: mappedTarget });
    }
  }

  for (const node of nonReqNodes) {
    addNodeWithDupCheck(nodes, node, warnings);
  }

  // Remap non-req edge targets that reference colliding IDs
  for (const edge of nonReqEdges) {
    const remappedTarget = remapId(edge.target, idMapping, collidingIds);
    if (collidingIds.has(edge.target) && remappedTarget === edge.target) {
      const dirs = idToDirs.get(edge.target) ?? new Set<string>();
      warnings.push({
        type: "ambiguous-id",
        id: edge.target,
        files: [...dirs].sort(),
      });
    }
    edges.push({ ...edge, target: remappedTarget });
  }

  // Parse TypeScript files — incrementally when the parse cache holds valid
  // fragments. The file set comes from globCodeFiles (the same fast-glob
  // call the parser's own file enumeration is built on), so hit and miss
  // paths see the same files a full scan would. Only changed files are
  // handed to the oxc parser; a fully-warm run never loads it at all.
  const codePatterns = [...config.include, ...config.testPatterns];
  const tsMode = config.mode ?? "file";
  const codeId = config.reqPatterns?.codeId;
  const codeFiles = globCodeFiles(rootDir, codePatterns);
  const relCodeFiles = codeFiles.map((f) => relative(rootDir, f));

  // TS fragments are only reusable while the import-resolution environment is
  // unchanged: tsconfig content (the parser's specifier resolver reads jsx /
  // allowJs / resolveJsonModule from it — see parsers/typescript.ts), analysis
  // mode, codeId token, and the matched file set (an added/removed file can
  // change how an UNCHANGED file's import specifier resolves). Any difference
  // invalidates every TS fragment.
  const tsconfigPath = resolve(rootDir, "tsconfig.json");
  const tsconfigHash = existsSync(tsconfigPath)
    ? hashContent(readFileSync(tsconfigPath, "utf-8"))
    : "no-tsconfig";
  const tsEnvKey = hashContent(
    JSON.stringify([tsconfigHash, tsMode, codeId ?? null, [...relCodeFiles].sort()]),
  );
  const tsFragmentsValid = prevCache !== undefined && prevCache.data.tsEnvKey === tsEnvKey;

  const nextTs: Record<string, TsFragment> = {};
  const fragmentByFile = new Map<string, TsFragment>();
  const missPaths: string[] = [];
  const missHashes = new Map<string, string>();
  for (let i = 0; i < codeFiles.length; i++) {
    const content = readFileSync(codeFiles[i], "utf-8");
    const contentHash = hashContent(content);
    const hit = tsFragmentsValid ? prevCache!.data.ts[relCodeFiles[i]] : undefined;
    if (hit && hit.contentHash === contentHash && importTargetsExist(hit.edges, rootDir)) {
      fragmentByFile.set(codeFiles[i], hit);
    } else {
      missPaths.push(codeFiles[i]);
      missHashes.set(codeFiles[i], contentHash);
    }
  }
  if (missPaths.length > 0) {
    const parsed = parseTSFilePaths(rootDir, missPaths, tsMode, codeId);
    for (const [abs, frag] of parsed) {
      fragmentByFile.set(abs, {
        contentHash: missHashes.get(abs)!,
        nodes: frag.nodes,
        edges: frag.edges,
      });
    }
  }
  const tsResult: { nodes: GraphNode[]; edges: GraphEdge[] } = { nodes: [], edges: [] };
  for (let i = 0; i < codeFiles.length; i++) {
    const frag = fragmentByFile.get(codeFiles[i])!;
    tsResult.nodes.push(...frag.nodes);
    tsResult.edges.push(...frag.edges);
    nextTs[relCodeFiles[i]] = frag;
  }

  for (const node of tsResult.nodes) {
    addNodeWithDupCheck(nodes, node, warnings);
  }

  // Remap @impl/@verifies edge targets for colliding IDs
  for (const edge of tsResult.edges) {
    if ((edge.kind === "implements" || edge.kind === "verifies") && collidingIds.has(edge.target)) {
      const dirs = idToDirs.get(edge.target) ?? new Set<string>();
      warnings.push({
        type: "ambiguous-id",
        id: edge.target,
        files: [...dirs].sort(),
      });
    } else if (
      (edge.kind === "implements" || edge.kind === "verifies") &&
      edge.target.includes("/")
    ) {
      if (!nodes.has(edge.target)) {
        warnings.push({
          type: "ambiguous-id",
          id: edge.target,
          files: [],
        });
      }
      edges.push(edge);
    } else {
      edges.push(edge);
    }
  }

  // Issue #177 — fail-safe repair for residual dangling symbol-import edges.
  // A named import through an `export *` barrel (`import { x } from "./barrel"`
  // where the barrel does `export * from "./origin"`) leaves
  // `file:consumer --imports--> symbol:barrel#x` pointing at a symbol node the
  // parser never materialized (star re-exports have no enumerable names at
  // parse time). The same shape arises from a typo'd import name or a
  // re-export of a name the origin does not actually export. Degrade any such
  // dangling `symbol:M#name` import target to `file:M` (when that file node
  // exists) so forward BFS reaches the barrel's file-grain re-export chain
  // instead of dead-ending — closing the fail-open at file granularity.
  // Per-symbol `export *` precision is deferred to a follow-up issue. Runs only
  // in symbol mode (file mode never emits `symbol:` targets).
  if (tsMode === "symbol") {
    // Reassign into `edges[i]` (not `edge.target = fileId`) because this edge
    // object is shared with the parse-cache fragment persisted via `nextTs[..]
    // = frag` above; an in-place mutation would leak the file-grain degrade
    // into the cached fragment and drift warm builds off cold (INV-L4).
    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i];
      if (edge.kind !== "imports" || !edge.target.startsWith("symbol:")) continue;
      if (nodes.has(edge.target)) continue;
      const body = edge.target.slice("symbol:".length);
      const hashIdx = body.lastIndexOf("#");
      const rel = hashIdx === -1 ? body : body.slice(0, hashIdx);
      const fileId = `file:${rel}`;
      if (nodes.has(fileId)) edges[i] = { ...edge, target: fileId };
    }
  }

  // T045 / Issue #28: Generate contains edges (doc -> req|task within the same file).
  // Use autoContains alone; doc nodes with explicit node_id exist even when autoNodes=false.
  if (autoContains) {
    const docNodes = [...nodes.values()].filter((n) => n.kind === "doc");
    for (const doc of docNodes) {
      for (const [childId, childNode] of nodes) {
        if (
          (childNode.kind === "req" || childNode.kind === "task") &&
          childNode.filePath === doc.filePath
        ) {
          edges.push({
            source: doc.id,
            target: childId,
            kind: "contains",
            provenances: ["structural"],
          });
        }
      }
    }
  }

  // C-3: Infer doc→doc derives_from edges from folder/file-name conventions.
  // Runs at builder level (not the parser) since it needs all doc nodes across
  // directories. Duplicates of frontmatter-declared edges are collapsed by the
  // dedup step below.
  if (config.docGraph?.autoConventions ?? true) {
    edges.push(...inferConventionEdges(nodes));
  }

  // T036: Convert ParseWarnings to BuildWarnings
  for (const pw of parseWarnings) {
    if (pw.type === "invalid-relation") {
      warnings.push({
        type: "invalid-relation",
        id: pw.key,
        files: [pw.filePath],
        message: `unknown relation key. Use "derives_from" or "depends_on"`,
      });
    } else if (pw.type === "invalid-annotation-id") {
      warnings.push({
        type: "invalid-annotation-id",
        id: pw.key,
        files: [pw.filePath],
        message: `annotation ID "${pw.key}" does not match reqPatterns.codeId`,
      });
    } else if (pw.type === "empty-annotation") {
      warnings.push({
        type: "empty-annotation",
        id: pw.key,
        files: [pw.filePath],
        message: `empty (${pw.key}: …) annotation — no edge generated`,
      });
    }
  }

  // T014: drop self-referential annotation edges and warn. Runs AFTER req id
  // remap so we compare final IDs (a collision-renamed `010-a/AUTH-001` cannot
  // self-reference an annotation written as `(depends_on: AUTH-001)` from the
  // same file).
  for (let i = edges.length - 1; i >= 0; i--) {
    const edge = edges[i];
    if (edge.provenances.includes("annotation") && edge.source === edge.target) {
      const sourceNode = nodes.get(edge.source);
      warnings.push({
        type: "self-reference-annotation",
        id: edge.source,
        files: sourceNode ? [sourceNode.filePath] : [],
        message: `annotation on "${edge.source}" depends on itself — edge dropped`,
      });
      edges.splice(i, 1);
    }
  }

  // C1: orphan-edge for annotation edges whose target is not in the graph.
  // doc→req emits its own orphan handling above; this fires for req→req edges
  // generated from inline annotations (provenance: "annotation") where the
  // target ID was never registered as a req or doc.
  for (const edge of edges) {
    if (!edge.provenances.includes("annotation")) continue;
    if (nodes.has(edge.target)) continue;
    const sourceNode = nodes.get(edge.source);
    warnings.push({
      type: "orphan-edge",
      id: edge.target,
      files: sourceNode ? [sourceNode.filePath] : [],
      message: `annotation on "${edge.source}" references unknown id "${edge.target}"`,
    });
  }

  // T035: orphan-doc warning - check that doc->doc edge targets exist
  // Only fire when the target is missing AND the target would be a doc node.
  // Skip when the target exists as a non-doc node (e.g. req) — that's a valid cross-kind reference.
  for (const edge of edges) {
    if (
      (edge.kind === "derives_from" || edge.kind === "depends_on") &&
      nodes.get(edge.source)?.kind === "doc"
    ) {
      const targetNode = nodes.get(edge.target);
      if (targetNode && targetNode.kind !== "doc") {
        // Target exists but is not a doc node (e.g. req) — not an orphan-doc situation
        continue;
      }
      if (!targetNode) {
        const sourceNode = nodes.get(edge.source)!;
        warnings.push({
          type: "orphan-doc",
          id: edge.target,
          files: [sourceNode.filePath],
          message: `referenced from ${sourceNode.filePath} but not found in graph`,
        });
      }
    }
  }

  // Issue #11: Convert collected inline markdown links into depends_on edges.
  // This must run AFTER all doc nodes are registered (so we can resolve
  // targets) and AFTER frontmatter edges land (so we can suppress inline
  // edges that conflict with an explicit relation), but BEFORE dedup so the
  // existing (source|target|kind) dedup naturally collapses redundant inline
  // links to the same target.
  if (inlineLinksEnabled && allInlineLinks.length > 0) {
    const docNodesByFilePath = new Map<string, GraphNode>();
    for (const node of nodes.values()) {
      if (node.kind === "doc") {
        // node.filePath is `relative(rootDir, file)`, which yields
        // back-slashes on Windows; targetRelPath from the parser is
        // already forward-slash-normalized. Normalize the key so lookups
        // succeed on both platforms.
        docNodesByFilePath.set(node.filePath.split(/[\\/]/).join("/"), node);
      }
    }

    // Pairs (source, target) already covered by a stronger relationship —
    // either an author's frontmatter `derives_from` / `depends_on` or a
    // convention-inferred `derives_from` (kiro / spec-kit presets). Inline
    // links pointing at the same pair are dropped regardless of kind: a
    // frontmatter `derives_from` and a convention `derives_from` both express
    // a clearer dependency than an inferred `depends_on` from prose. Note
    // this means inline links between e.g. `design.md` and `requirements.md`
    // in the same dir are silently suppressed in favor of the convention
    // edge — by design (see README "Doc graph"). Tests asserting inline-link
    // edges must use file stems outside the convention preset.
    const explicitPairs = new Set<string>();
    for (const edge of edges) {
      if (edge.kind !== "derives_from" && edge.kind !== "depends_on") continue;
      const sourceNode = nodes.get(edge.source);
      if (sourceNode?.kind === "doc") {
        explicitPairs.add(`${edge.source}|${edge.target}`);
      }
    }

    // Suppress duplicate warnings when an author writes the same broken /
    // out-of-scope target multiple times in one file. Edges get deduped at the
    // end of buildGraph; warnings need their own bookkeeping because the same
    // (source, target) never reaches the edges array.
    const warnedLinks = new Set<string>();

    for (const link of allInlineLinks) {
      const sourceNode = nodes.get(link.sourceDocId);
      if (!sourceNode) continue; // source doc was filtered out (autoNodes=false)

      const targetNode = docNodesByFilePath.get(link.targetRelPath);
      if (targetNode) {
        if (explicitPairs.has(`${link.sourceDocId}|${targetNode.id}`)) continue;
        edges.push({
          source: link.sourceDocId,
          target: targetNode.id,
          kind: "depends_on",
          provenances: ["inline-link"],
        });
        continue;
      }

      // No matching doc node — decide between unresolved (file missing) and
      // out-of-scope (file present but not under specDirs).
      const targetExists = existsSync(resolve(rootDir, link.targetRelPath));
      const warnType = targetExists ? "out-of-scope-link" : "unresolved-link";
      if (warnType === "out-of-scope-link" && !warnOutOfScope) continue;
      if (warnType === "unresolved-link" && !warnUnresolved) continue;

      const dedupKey = `${warnType}|${sourceNode.filePath}|${link.targetRelPath}`;
      if (warnedLinks.has(dedupKey)) continue;
      warnedLinks.add(dedupKey);

      if (warnType === "out-of-scope-link") {
        warnings.push({
          type: "out-of-scope-link",
          id: link.targetRelPath,
          files: [sourceNode.filePath],
          message: `inline link "${link.rawHref}" targets ${link.targetRelPath} which is outside specDirs`,
        });
      } else {
        warnings.push({
          type: "unresolved-link",
          id: link.targetRelPath,
          files: [sourceNode.filePath],
          message: `inline link "${link.rawHref}" → ${link.targetRelPath} not found`,
        });
      }
    }
  }

  // Edge dedup + deterministic edge/node ordering (INV-T2/T3, INV-L4,
  // INV-O1) are owned by canonical.ts — see dedupEdges / sortNodesById there
  // for the full rationale (T037 / Issue #35, PR#94 review B3).
  const dedupedEdges = dedupEdges(edges);
  const sortedNodes = sortNodesById(nodes);

  // Persist the fragments BEFORE returning so later mutation of the returned
  // graph by a caller can never leak into the cache file. No-ops when the
  // cache is disabled or nothing changed; never throws.
  writeParseCache(
    rootDir,
    { fingerprint: cacheFingerprint, tsEnvKey, md: nextMd, ts: nextTs },
    prevCache?.raw,
  );

  return { graph: { nodes: sortedNodes, edges: dedupedEdges }, warnings };
}

// Generate `derives_from` edges by matching known file-name conventions within
// each directory. Doc nodes are grouped by their containing directory so that a
// Spec Kit `specs/NNN-feature/` subdir is treated as its own unit. File-name
// matching is case-insensitive (the stem is lower-cased before lookup). Only
// `.md` files participate, because doc-node collection itself globs `**/*.md`.
//
// PR#94 review Meta-C blind-spot 2: the internal `byDir` Map and inner CONVENTION_EDGES
// loop emit edges in insertion order (dir -> file -> preset). That order is OS-
// and traversal-dependent, but it is intentionally NOT defended here — every
// pushed edge is folded into the post-dedup sort owned by `dedupEdges`
// (canonical.ts), so the final `graph.edges` array is deterministic regardless
// of which order this helper emits in. Adding a local sort would be dead code.
function inferConventionEdges(nodes: Map<string, GraphNode>): GraphEdge[] {
  // dir -> (file-name stem -> doc node id). The actual node id is used (honoring
  // frontmatter `node_id` overrides), not the raw path.
  const byDir = new Map<string, Map<string, string>>();
  for (const node of nodes.values()) {
    if (node.kind !== "doc") continue;
    const dir = dirname(node.filePath);
    const stem = basename(node.filePath)
      .replace(/\.(md|markdown)$/i, "")
      .toLowerCase();
    let stems = byDir.get(dir);
    if (!stems) {
      stems = new Map();
      byDir.set(dir, stems);
    }
    // If two files share a stem (collision via casing, e.g. Design.md +
    // design.md), keep the first encountered — generating edges for both
    // would be ambiguous.
    if (!stems.has(stem)) stems.set(stem, node.id);
  }

  const edges: GraphEdge[] = [];
  for (const stems of byDir.values()) {
    for (const [fromStem, toStem] of CONVENTION_EDGES) {
      const source = stems.get(fromStem);
      const target = stems.get(toStem);
      // Only emit when both endpoints exist, so no orphan-doc is ever produced.
      if (source && target && source !== target) {
        edges.push({ source, target, kind: "derives_from", provenances: ["convention"] });
      }
    }
  }
  return edges;
}

function extractSpecDir(relFilePath: string, specDirs: string[]): string {
  for (const specDir of specDirs) {
    if (relFilePath.startsWith(specDir + "/")) {
      const rest = relFilePath.slice(specDir.length + 1);
      const parts = rest.split("/");
      if (parts.length > 1) {
        return parts[0];
      }
    }
  }
  return basename(dirname(relFilePath));
}

function remapId(id: string, idMapping: Map<string, string>, collidingIds: Set<string>): string {
  if (!collidingIds.has(id)) return id;

  // Try to find a unique mapping
  const matches: string[] = [];
  for (const [qualifiedKey, finalId] of idMapping) {
    if (qualifiedKey.endsWith(`/${id}`)) {
      matches.push(finalId);
    }
  }

  // If ambiguous, return as-is (warning already emitted or will be)
  return matches.length === 1 ? matches[0] : id;
}

// specDir-aware variant of remapId used by req→req annotation edges so a
// `(depends_on: AUTH-001)` from a 010-a req prefers 010-a/AUTH-001 over
// 010-b/AUTH-001. Returns `ambiguous: true` only when the target collides
// and is NOT present in the same specDir as the source req.
function resolveAnnotationTarget(
  target: string,
  reqSpecDir: string,
  idMapping: Map<string, string>,
  collidingIds: Set<string>,
): { target: string; ambiguous: boolean } {
  const sameDirFinal = idMapping.get(`${reqSpecDir}/${target}`);
  if (collidingIds.has(target)) {
    if (sameDirFinal) return { target: sameDirFinal, ambiguous: false };
    return { target, ambiguous: true };
  }
  if (sameDirFinal) return { target: sameDirFinal, ambiguous: false };
  // Not colliding, not in same specDir — find the unique mapping anywhere.
  for (const [key, finalId] of idMapping) {
    if (key.endsWith(`/${target}`)) return { target: finalId, ambiguous: false };
  }
  // Not registered at all → leave as-is; orphan-edge will be raised downstream.
  return { target, ambiguous: false };
}

function addNodeWithDupCheck(
  nodes: Map<string, GraphNode>,
  node: GraphNode,
  warnings: BuildWarning[],
) {
  const existing = nodes.get(node.id);
  if (existing && existing.filePath !== node.filePath) {
    warnings.push({
      type: "duplicate-id",
      id: node.id,
      files: [existing.filePath, node.filePath],
    });
  }
  nodes.set(node.id, node);
}
