import { resolve, relative, basename, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  parseMarkdownContent,
  type ParseWarning,
  type InlineLinkRef,
} from "../parsers/markdown.js";
import {
  discoverCodeFiles,
  parseTSFilePaths,
  takeResolverResourceExhaustedWarning,
} from "../parsers/typescript.js";
import { listFilesGuarded } from "../glob-utils.js";
import {
  computeCacheFingerprint,
  fragmentTestKindMatches,
  hashContent,
  importTargetsExist,
  readParseCache,
  writeParseCache,
  type MdFragment,
  type TsFragment,
} from "../parse-cache.js";
import { dedupEdges, sortNodesById } from "./canonical.js";
import { expandStarReexports } from "./star-expansion.js";
import {
  ingestTrace,
  hasTraceShards,
  resolveTraceGraphNodeId,
  type IngestedTrace,
} from "../trace/ingest.js";
import type { ArtifactGraph, GraphNode, GraphEdge, ArtgraphConfig } from "../types.js";
import { missingNodeModulesProtection, formatPoolProtectionMessage } from "../config.js";

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
    | "self-reference-annotation"
    // issue #189 — observability for symbol-mode fail-safe. Emitted only in
    // symbol mode; the phantom-repair pass in `buildGraph` rewrites dangling
    // `symbol:M#name` import targets to `file:M` (repaired) or leaves them
    // as-is when the file node itself is out of scope (dangling). Neither
    // trips gates or fails the build. Suppressed from the default stderr
    // presenter — surfaced in `scan --format json` `warnings[]` for tooling.
    | "phantom-import-repaired"
    | "dangling-import"
    // PR #242 review A/C, spec 021 follow-up — symbol-mode class-member id
    // collisions (a class member's synthesized name colliding with an
    // existing export of the same literal name, or a class/class-member
    // silently losing the parser's own `seen`-name dedup). Converted from
    // the TS parser's `TsParseWarning[]` (see parse-cache.ts's
    // `TsFragment.warnings`) below. NOT silent — shown by default, unlike
    // the two `phantom-import-repaired` / `dangling-import` types above.
    | "class-member-collision"
    // issue #247 — a file whose bracket nesting exceeds
    // MAX_BRACKET_NESTING_DEPTH was skipped for AST-based extraction (no
    // symbols or imports) to avoid a native oxc-parser crash. extractImplTags
    // is a plain-text regex scan independent of the AST, so `@impl` comments
    // and `[REQ-…]` test titles in the same file are still extracted — only
    // symbol/import edges are lost. Rare and still worth surfacing when it
    // fires, so NOT silent — shown by default like `class-member-collision`
    // above.
    | "pathological-bracket-nesting"
    // issue #264 — a file `parseTSFile` could not even READ (permission
    // errors, e.g. chmod 000; distinct from `pathological-bracket-nesting`,
    // which reads the file fine but skips handing it to the native parser).
    // No symbols/imports/@impl edges are extracted from this file until it
    // becomes readable again, but scanning continues for every other file
    // and a bare file node is still synthesized (see `parseTSFile`). NOT
    // silent — a scan silently missing a whole file's coverage is exactly
    // the kind of thing the author needs to see.
    | "unreadable-file"
    // issue #295 — a DIFFERENT unreadable-file failure mode than the one
    // above: `EMFILE`/`ENFILE` (the process, or the whole system, ran out
    // of file descriptors) rather than a per-file permission/existence
    // problem. Unlike `unreadable-file`, this is a scan-wide condition (any
    // subsequent read may fail the same way), so `buildGraph` emits it at
    // most ONCE per scan even when both the TS and markdown loops observe
    // it (see the dedup guard around `warnings.push` below and in the TS
    // warning-conversion loop). NOT silent — the user needs to act (raise
    // the ulimit), so it is shown by default like `unreadable-file`.
    | "system-resource-exhausted"
    // issue #287 — fired when the `include` / `testPatterns` globs matched
    // at least one file under a node_modules directory (any depth).
    // fast-glob does not exclude node_modules by default, so pre-#287
    // configs (which lack a `"!**/node_modules/**"` entry in `include`)
    // silently ingest vendored files into the graph. NOT silent — shown by
    // default, to guide the user toward adding the exclusion. Non-fatal:
    // does not affect exit codes.
    //
    // issue #350 (HIGH-2) — since `include` and `testPatterns` are two
    // independent discovery pools (see `discoverCodeFiles` in
    // `parsers/typescript.ts`), a node_modules hit can come from either
    // pool, or both. The remediation text below is computed per-scan from
    // which pool(s) actually matched the offending files, rather than always
    // pointing at `include` — see the emission site further down.
    | "node-modules-in-scan"
    // issue #333 — a re-export (`export { x } from`, `export * from`,
    // `export * as ns from`, or the S3-C3/S3-C4 source-null forms) whose
    // specifier did not resolve to a file on disk. Converted 1:1 from the TS
    // parser's own `TsParseWarning` (see `parsers/typescript.ts`'s
    // `extractImports`). Previously a silent skip with NO diagnostic at all
    // (docs/architecture.md §11 known-limitation (g), specs/018's "Out of
    // scope" list) — `phantom-import-repaired` / `dangling-import` above
    // only ever fire from the BUILDER side (a resolved but dangling target),
    // never for a specifier that never resolved in the first place. SILENT
    // (like the two `phantom-import-repaired` / `dangling-import` types
    // above): observable via `scan --format json` `warnings[]`, not the
    // default stderr presenter — the CLI has no `--verbose` flag, so JSON is
    // the only observation path (issue #189's established convention).
    | "unresolved-reexport"
    // issue #333 — same silent-skip bug, scoped to an ordinary (non
    // re-export) `import ... from "./missing"` statement. SILENT, same
    // rationale as `unresolved-reexport` above.
    | "unresolved-import"
    // issue #356 — `include` has a `"!**/node_modules/**"`-style negation but
    // `testPatterns` doesn't (or vice versa): a purely structural config-shape
    // check, independent of whether either pool has actually matched a
    // node_modules file yet (contrast `node-modules-in-scan` above, which only
    // fires once a match is observed). SILENT: unlike `node-modules-in-scan`,
    // this fires on EVERY scan of an asymmetric config regardless of whether
    // the project even has a node_modules directory — the stderr default
    // presenter would otherwise be noisy on a healthy, node_modules-free repo.
    // Observable via `scan --format json` `warnings[]` only, same convention
    // as `unresolved-reexport` / `unresolved-import` above. See
    // `missingNodeModulesProtection` (`../config.js`) for the shared judge
    // this warning and `artgraph doctor`'s advisory finding of the same name
    // both call into. A pool where both `include` and `testPatterns` are
    // silently unprotected (no mention of node_modules at all) stays silent,
    // as before — indistinguishable from a deliberate symmetric choice. PR
    // #359 review (H2) added a second trigger, independent of symmetry: a
    // pool whose negative pattern MENTIONS node_modules but, per real glob
    // semantics, doesn't actually cover every nesting depth (a "broken
    // exclusion") is reported regardless of the other pool's state — see
    // `missingNodeModulesProtection`'s own doc comment for why that case is
    // never ambiguous with an intentional choice the way silence is.
    | "config-pool-protection-asymmetry";
  id: string;
  files: string[];
  message?: string;
}

// issue #189 — warning types that surface only in structured JSON output.
// The default stderr presenter hides them so a healthy repo with several
// `export *` fail-safe hits stays quiet on the terminal.
const SILENT_WARNING_TYPES: ReadonlySet<BuildWarning["type"]> = new Set([
  "phantom-import-repaired",
  "dangling-import",
  // issue #333 — see the `BuildWarning["type"]` union's own doc comments for
  // both types above.
  "unresolved-reexport",
  "unresolved-import",
  // issue #356 — see the `BuildWarning["type"]` union's own doc comment above.
  "config-pool-protection-asymmetry",
]);

export function isSilentWarning(type: BuildWarning["type"]): boolean {
  return SILENT_WARNING_TYPES.has(type);
}

// issue #277 — placeholder hash for a bare doc node synthesized when its
// source .md is unreadable. Never collides with a real hashContent() output
// (which is 64-hex sha256), so buildLockFromGraph can safely skip nodes
// carrying this sentinel and check() will not compare against it. Chosen to
// include a colon so it is trivially unmistakable for a hash.
export const UNREADABLE_DOC_CONTENT_HASH = "unreadable-file:no-content";

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

// issue #216 — `ignoreIdPrefixes` matcher. Returns a predicate that is true
// when `id`'s bare token (after an optional `namespace/` or collision
// qualifier, i.e. the segment after the last `/`) is exactly
// `<prefix>-<digits>` for one of the configured prefixes. The exact-shape
// match (`-\d+$` anchor) keeps non-requirement ids like `doc:SC-overview.md`
// or a hypothetical `SCX-001` from false-matching a `"SC"` entry. Prefixes
// are regex-escaped defensively — loadConfig already restricts them to
// `[A-Z][A-Za-z]*`, but buildGraph is also called with hand-built configs
// from tests/programmatic use.
function buildIgnoredIdMatcher(prefixes: string[] | undefined): (id: string) => boolean {
  if (!prefixes || prefixes.length === 0) return () => false;
  const escaped = prefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`^(?:${escaped.join("|")})-\\d+$`);
  return (id: string) => re.test(id.slice(id.lastIndexOf("/") + 1));
}

export function buildGraph(
  rootDir: string,
  config: ArtgraphConfig,
): { graph: ArtifactGraph; warnings: BuildWarning[]; trace?: IngestedTrace } {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const warnings: BuildWarning[] = [];

  // issue #356 — purely structural config-shape check, computed up front
  // (scan start, before file discovery) since it only reads `config.include`
  // / `config.testPatterns` — no filesystem access, no dependency on what
  // discovery actually matches. See `missingNodeModulesProtection`'s own doc
  // comment (`../config.js`) for the shared judge this warning and
  // `artgraph doctor`'s advisory finding of the same name both call into.
  // PR #359 review (M2) — the message text itself is also shared
  // (`formatPoolProtectionMessage`), so `scan` and `doctor` can never
  // describe the same issue differently. Only the first issue is surfaced
  // here (matches the pre-existing single-warning contract of this warning
  // type); `missingNodeModulesProtection` orders `include` before
  // `testPatterns` deterministically.
  const poolProtectionIssues = missingNodeModulesProtection(config);
  if (poolProtectionIssues.length > 0) {
    const issue = poolProtectionIssues[0];
    warnings.push({
      type: "config-pool-protection-asymmetry",
      id: issue.pool,
      files: [],
      message: formatPoolProtectionMessage(issue),
    });
  }

  // issue #295 (PR #334 meta-review LOW-1 wording fix) — `system-resource-
  // exhausted` (EMFILE/ENFILE) is a scan-wide condition, not a per-file one:
  // the markdown loop below, the `discoverCodeFiles` guard (issue #350 —
  // covers BOTH the `include` and `testPatterns` pools symmetrically in one
  // guard, see that call site's own comment), the tsconfig read guard, and
  // the TS warning-conversion loop further down can each independently
  // observe it in the same `buildGraph()` call. This flag makes all of those
  // sites agree on "has this scan already reported it" so at most one
  // warning of this type ever lands in `warnings`, regardless of how many
  // files hit it. Which site actually sets the flag is NOT a race:
  // `buildGraph` runs synchronously, single-threaded, and every guarded site
  // below executes in a fixed, deterministic order (markdown loop, then the
  // `discoverCodeFiles` guard, then the tsconfig read guard, then the TS
  // warning-conversion loop, which surfaces failures from `parseTSFile`'s own
  // guarded read) for any given call — which one reports it is fully
  // determined by which sites this particular scan happens to hit, not by
  // timing.
  let systemResourceExhaustedReported = false;

  // issue #216 — ids with an ignored prefix are excluded at assembly time (no
  // req node, no edges touching them). Filtering here rather than inside the
  // parsers keeps parse-cache fragments a pure memo of parser output: toggling
  // `ignoreIdPrefixes` changes the assembled graph without invalidating the
  // cache, mirroring how collision remap / dedup already run fresh per build.
  const isIgnoredId = buildIgnoredIdMatcher(config.ignoreIdPrefixes);

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
    // issue #335 (Step 0-pre HIGH-1) — this used to call the `glob` package's
    // `globSync` directly, which silently swallows an EMFILE/ENFILE readdir
    // failure (via path-scurry's `#readdirFail` falling into its `else`
    // branch) and returns an EMPTY match list with NO warning — an entire
    // specDir's REQ/task/doc nodes could vanish from the graph without a
    // trace. Routed through `listFilesGuarded` (`../glob-utils.js`, shared
    // with the TS side's `globCodeFiles`) so this loop gets the SAME
    // EMFILE/ENFILE fail-safe treatment (warn once per scan via
    // `systemResourceExhaustedReported`, continue with an empty file list)
    // every other guarded read site in this function already has. Also picks
    // up fast-glob's `followSymbolicLinks: true` default (the `glob` package
    // defaulted to `follow: false`) and a deterministic `.sort()` — both
    // intentional, documented behavior changes (see docs/commands.md).
    const { files: specFiles, resourceExhaustedCode } = listFilesGuarded(
      resolve(rootDir, specDirName, "**/*.md"),
    );
    if (resourceExhaustedCode && !systemResourceExhaustedReported) {
      systemResourceExhaustedReported = true;
      warnings.push({
        type: "system-resource-exhausted",
        id: `glob:${specDirName}`,
        files: [],
        message:
          `file descriptor exhaustion (${resourceExhaustedCode}) while enumerating spec files ` +
          `under "${specDirName}" during this scan; the process ran out of open file ` +
          "descriptors. Consider raising the OS file-descriptor limit (e.g. `ulimit -n`) and " +
          "re-running — other file reads in this scan may also be failing the same way. Shown " +
          "once per scan regardless of how many files were affected.",
      });
    }
    for (const file of specFiles) {
      const relFile = relative(rootDir, file);

      // issue #277 — `readFileSync` throws on a markdown/spec file that exists
      // (the glob above already enumerated it) but cannot be READ (chmod 000 /
      // other permission errors; the same failure mode fixed for the TS side
      // in issue #264's `parseTSFile`, mirrored here). Pre-fix, this uncaught
      // throw took down the ENTIRE scan/check/impact command — there is no
      // per-file isolation in this loop, so a single unreadable .md anywhere
      // under any specDir made every command that builds the graph fail
      // outright with a raw stack trace. Fixed fail-SAFE, matching #264's
      // pattern exactly: warn, synthesize a bare `doc:` node (unless
      // `docGraph.autoNodes` is off, matching the existing opt-out already
      // honored below for auto-generated doc nodes) so the file still shows
      // up in the graph instead of silently vanishing, and skip to the next
      // file — no cache write, no parse, no edge collection for this file.
      // Deliberate side-effect: every REQ/task this file would have defined
      // disappears from the graph until it becomes readable again, so any
      // `@impl REQ-X` pointing at one of them becomes an orphan-edge warning
      // in the meantime — this is expected and surfaces the real problem
      // (the file is unreadable) rather than a confusing crash.
      let mdSource: string;
      try {
        mdSource = readFileSync(file, "utf-8");
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const docRelPath =
          specDirName && relFile.startsWith(specDirName + "/")
            ? relFile.slice(specDirName.length + 1)
            : relFile;
        // issue #295 — same errno branching as the TS side
        // (`parsers/typescript.ts`'s `parseTSFile`): EACCES/EISDIR/ENOENT
        // keep the #277 behavior byte-for-byte; EMFILE/ENFILE report the
        // scan-wide `system-resource-exhausted` type instead, deduped
        // against the TS loop's own occurrences via
        // `systemResourceExhaustedReported`; every other code (or none)
        // keeps the #277 generic message, with the code appended when
        // present.
        const code = (e as NodeJS.ErrnoException)?.code;
        const baseMessage =
          `could not read "${relFile}" (${message}); skipped req/task/edge extraction for ` +
          "this file. A bare doc node was still created so it stays visible in the graph, " +
          "but it carries none of its usual reqs/tasks/edges until the file becomes readable " +
          "again.";
        if (code === "EMFILE" || code === "ENFILE") {
          if (!systemResourceExhaustedReported) {
            systemResourceExhaustedReported = true;
            warnings.push({
              type: "system-resource-exhausted",
              id: `doc:${docRelPath}`,
              files: [relFile],
              message:
                `file descriptor exhaustion (${code}) while reading files during this scan; ` +
                "the process ran out of open file descriptors. Consider raising the OS " +
                "file-descriptor limit (e.g. `ulimit -n`) and re-running — other file reads " +
                "in this scan may also be failing the same way. Shown once per scan " +
                "regardless of how many files were affected.",
            });
          }
        } else if (code === "EACCES" || code === "EISDIR" || code === "ENOENT") {
          warnings.push({
            type: "unreadable-file",
            id: `doc:${docRelPath}`,
            files: [relFile],
            message: baseMessage,
          });
        } else {
          warnings.push({
            type: "unreadable-file",
            id: `doc:${docRelPath}`,
            files: [relFile],
            message: code ? `${baseMessage} [${code}]` : baseMessage,
          });
        }
        // meta-review (PR #293, issue #277 follow-up) — asymmetry with the
        // readable path: for a readable doc, `autoNodes: false` only
        // suppresses nodes whose id equals `expectedAutoDocId` (a doc with
        // a frontmatter `node_id` override survives). Here the file could
        // not be read at all, so we cannot know whether it would have
        // declared a custom `node_id` — there is no frontmatter to parse.
        // We gate this synthesis unconditionally on `autoNodes`, on the
        // assumption that the user opted out of ALL auto-generated doc
        // nodes and would rather see nothing than a possibly-wrong auto id.
        // The documented cost: a file that WOULD have declared a custom
        // `node_id` produces ZERO graph node while unreadable — a real
        // divergence from the readable path, where a custom-`node_id` doc
        // is immune to `autoNodes: false`. See the "documents the
        // autoNodes=false asymmetry" test below.
        if (autoNodes) {
          nonReqNodes.push({
            id: `doc:${docRelPath}`,
            kind: "doc",
            filePath: relFile,
            label: `doc:${docRelPath}`,
            contentHash: UNREADABLE_DOC_CONTENT_HASH,
          });
        }
        continue;
      }
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
        // issue #216 — an ignored-prefix ID never becomes a req node (Spec
        // Kit's SC-NNN Success Criteria are outcome statements, not
        // implementation-trackable requirements).
        if (node.kind === "req" && isIgnoredId(node.id)) continue;
        // F1 (meta-review, issue #243 follow-up) — `_meta` is the lock file's
        // reserved top-level stamp key (see lock.ts's `writeLock` /
        // `readLockWithMeta`). A node whose id is EXACTLY `_meta` — whether
        // from a user-defined `reqPatterns` match (req/task) or a frontmatter
        // `artgraph: { node_id: _meta }` (doc, checked here before the
        // doc/nonReqNodes split below) — would overwrite the stamp on the
        // next lock write and become invisible on the next read
        // (`writeLock` now hard-fails on this instead of silently
        // corrupting the lock, but warning here catches it at scan time,
        // before a write is ever attempted).
        if (node.id === "_meta") {
          warnings.push({
            type: "reserved-prefix",
            id: node.id,
            files: [node.filePath],
            message: `${node.kind} ID "_meta" collides with the lock file's reserved _meta key; this entry would be lost when the lock is written. Rename it.`,
          });
        }
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
        // issue #216 — drop spec-side edges touching an ignored id on either
        // end: annotation edges from/to a skipped req, task-tag
        // `@impl(SC-001)` / `[SC-001]` pointers, and frontmatter relations
        // naming an ignored id. Without this they would surface as
        // orphan-edge / orphan-doc noise for a node we intentionally removed.
        if (isIgnoredId(edge.source) || isIgnoredId(edge.target)) continue;
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
  // fragments. The file set comes from `discoverCodeFiles` (the same
  // pool-separated glob discovery the parser's own file enumeration is built
  // on — see its doc comment in `parsers/typescript.ts`, issue #350), so hit
  // and miss paths see the same files a full scan would. Only changed files
  // are handed to the oxc parser; a fully-warm run never loads it at all.
  // Deliberate constraint: because oxc never loads on a fully-warm run, a
  // broken environment (see `OxcLoadError`, issue #263's fail-fast) still
  // succeeds as long as the cache stays valid — the output is just a memo of
  // a parse that already ran successfully, so this is correct, not a bug.
  // `OxcLoadError` only fires on the first cache miss that actually needs
  // oxc. This is an intentional trade-off: it avoids paying the cost of an
  // unconditional oxc dlopen probe on every command just to fail fast
  // earlier.
  const tsMode = config.mode ?? "file";
  const codeId = config.reqPatterns?.codeId;
  // issue #350 — `include` and `testPatterns` are two independent glob pools
  // (see `discoverCodeFiles`'s own doc comment): each pool's negative
  // patterns apply only to that pool's own positive patterns, then the
  // matches are unioned. Pre-#350 this was ONE integrated glob over
  // `[...include, ...testPatterns]`, which folded both lists' negative
  // patterns into a single shared `ignore` — a `!`-prefixed `testPatterns`
  // entry therefore used to exclude matching files from the WHOLE scan, not
  // just from test classification (PR #349's now-retired
  // `testpatterns-negative-pattern` warning existed to surface that surprise
  // until this real fix landed).
  //
  // issue #335 (Step 0-pre HIGH-1) — both this file's markdown loop above
  // and `discoverCodeFiles` below (via `globCodeFiles`) route through
  // `../glob-utils.js`, so both enumeration passes share one fixed fast-glob
  // option set and one deterministic sort. They still have DIFFERENT
  // external failure contracts on EMFILE/ENFILE, by design: the markdown
  // loop calls `listFilesGuarded` (swallow + `resourceExhaustedCode`,
  // matching the fail-safe behavior a scan-wide degradation needs there —
  // see that call site's own comment), while `discoverCodeFiles` still
  // throws on EMFILE/ENFILE from either of its two underlying
  // `globCodeFiles` calls (exactly like the single raw `globCodeFiles` call
  // it replaces) so this try/catch below keeps working unchanged and
  // symmetrically covers BOTH pools (Step 0-pre MEDIUM-1 — previously the
  // `codePatterns` glob and the separate `computeTestFileSet` glob each
  // needed their own independent guard; a single `discoverCodeFiles` call
  // means a single guard here can never leave one pool unguarded). Do not
  // assume the markdown and code call sites fail the same way.
  let codeFiles: string[];
  let testFiles: Set<string>;
  let includeFiles: Set<string>;
  try {
    ({
      files: codeFiles,
      testFiles,
      includeFiles,
    } = discoverCodeFiles(rootDir, config.include, config.testPatterns));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "EMFILE" || code === "ENFILE") {
      if (!systemResourceExhaustedReported) {
        systemResourceExhaustedReported = true;
        warnings.push({
          type: "system-resource-exhausted",
          id: "glob:code-files",
          files: [],
          message:
            `file descriptor exhaustion (${code}) while globbing code files during this scan; ` +
            "the process ran out of open file descriptors. Consider raising the OS " +
            "file-descriptor limit (e.g. `ulimit -n`) and re-running — other file reads " +
            "in this scan may also be failing the same way. Shown once per scan " +
            "regardless of how many files were affected.",
        });
      }
      codeFiles = [];
      testFiles = new Set();
      includeFiles = new Set();
    } else {
      // Any other glob failure (e.g. a malformed pattern) is a real problem
      // the user needs to see, not something to silently paper over with an
      // empty code-file set — rethrow.
      throw e;
    }
  }
  const relCodeFiles = codeFiles.map((f) => relative(rootDir, f));

  // issue #287 — surface configs that still ingest node_modules (pre-#287
  // configs lack the `"!**/node_modules/**"` negation added to
  // DEFAULT_CONFIG.include). Segment-based check (split on both path
  // separators) rather than a substring test, so a file literally named
  // `node_modules.ts` doesn't false-positive and Windows backslash paths
  // still match. `files` is capped at 5 entries to keep `scan --format
  // json` output bounded on repos with thousands of vendored files.
  //
  // issue #350 (HIGH-2) — `include` and `testPatterns` are now independent
  // discovery pools, so a node_modules hit can come from either pool, or
  // both — the remediation text is computed dynamically from which pool(s)
  // actually matched the offending files (via `includeFiles`/`testFiles`
  // membership, both already computed by `discoverCodeFiles` above at no
  // extra glob-call cost) rather than always pointing at `include`, which
  // would be silently wrong advice for a `testPatterns`-only leak.
  const nodeModulesFiles = relCodeFiles.filter((f) => f.split(/[\\/]/).includes("node_modules"));
  if (nodeModulesFiles.length > 0) {
    let fromInclude = false;
    let fromTestPatterns = false;
    // issue #356 — same single pass as before, but no longer breaks early:
    // the pool membership booleans above still need every offending file
    // visited, and now so does per-pool sample collection below (a pool with
    // offending files must contribute at least one entry to `files`, which an
    // early "stop once both flags are true" break could miss for whichever
    // pool's first hit comes later in iteration order). No extra glob call —
    // this reuses the same `includeFiles`/`testFiles` membership sets already
    // computed by `discoverCodeFiles` above.
    const includeSamples: string[] = [];
    const testPatternsSamples: string[] = [];
    for (let i = 0; i < codeFiles.length; i++) {
      if (!relCodeFiles[i].split(/[\\/]/).includes("node_modules")) continue;
      if (includeFiles.has(codeFiles[i])) {
        fromInclude = true;
        includeSamples.push(relCodeFiles[i]);
      }
      if (testFiles.has(codeFiles[i])) {
        fromTestPatterns = true;
        testPatternsSamples.push(relCodeFiles[i]);
      }
    }
    const configKeys =
      fromInclude && fromTestPatterns
        ? '"include" and "testPatterns"'
        : fromTestPatterns
          ? '"testPatterns"'
          : '"include"';
    // issue #356 — `files` (cap 5, unchanged) is now sampled per-pool rather
    // than taken unconditionally off the front of `nodeModulesFiles`: a
    // pool's SOLE offending file could previously fall outside the first 5
    // entries in discovery order and never appear in the sample at all, even
    // though the warning's own remediation text names that pool. Seed with
    // one entry from each pool that actually has offending files (order:
    // include's first hit, then testPatterns'), then backfill any remaining
    // slots (up to 5 total) from the full offending-file list in its
    // original discovery order, skipping anything already seeded.
    const files: string[] = [];
    if (includeSamples.length > 0) files.push(includeSamples[0]);
    if (testPatternsSamples.length > 0 && !files.includes(testPatternsSamples[0])) {
      files.push(testPatternsSamples[0]);
    }
    for (const f of nodeModulesFiles) {
      if (files.length >= 5) break;
      if (!files.includes(f)) files.push(f);
    }
    warnings.push({
      type: "node-modules-in-scan",
      id: "node_modules",
      files,
      message: `${nodeModulesFiles.length} scanned file(s) are under node_modules/ — add "!**/node_modules/**" to ${configKeys} in .artgraph.json to exclude them`,
    });
  }

  // TS fragments are only reusable while the import-resolution environment is
  // unchanged: tsconfig content (the parser's specifier resolver reads jsx /
  // allowJs / resolveJsonModule from it — see parsers/typescript.ts), analysis
  // mode, codeId token, and the matched file set (an added/removed file can
  // change how an UNCHANGED file's import specifier resolves). Any difference
  // invalidates every TS fragment.
  const tsconfigPath = resolve(rootDir, "tsconfig.json");
  // PR #334 meta-review HIGH-2 — `existsSync` never throws (any error, e.g.
  // EMFILE, just yields `false`), but the file can still become unreadable
  // or trip EMFILE/ENFILE on the read itself, in the gap between that check
  // and this line, or simply because the fd budget is already exhausted by
  // the time we get here. Pre-fix, an uncaught throw here crashed the WHOLE
  // build — worse than a missing tsconfig, which `existsSync` returning
  // `false` already handles fine via the `"no-tsconfig"` sentinel. Fail-safe:
  // EMFILE/ENFILE report the scan-wide `system-resource-exhausted` type
  // (deduped via `systemResourceExhaustedReported`, same as every other
  // guarded read in this module); any other error falls back to the
  // `"no-tsconfig"` sentinel plus a generic `unreadable-file` warning so the
  // user knows tsconfig-driven import resolution (jsx/allowJs/
  // resolveJsonModule) silently did not apply this run.
  let tsconfigHash: string;
  if (!existsSync(tsconfigPath)) {
    tsconfigHash = "no-tsconfig";
  } else {
    try {
      tsconfigHash = hashContent(readFileSync(tsconfigPath, "utf-8"));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      const message = e instanceof Error ? e.message : String(e);
      if (code === "EMFILE" || code === "ENFILE") {
        if (!systemResourceExhaustedReported) {
          systemResourceExhaustedReported = true;
          warnings.push({
            type: "system-resource-exhausted",
            id: "tsconfig.json",
            files: ["tsconfig.json"],
            message:
              `file descriptor exhaustion (${code}) while reading files during this scan; ` +
              "the process ran out of open file descriptors. Consider raising the OS " +
              "file-descriptor limit (e.g. `ulimit -n`) and re-running — other file reads " +
              "in this scan may also be failing the same way. Shown once per scan " +
              "regardless of how many files were affected.",
          });
        }
      } else {
        warnings.push({
          type: "unreadable-file",
          id: "tsconfig.json",
          files: ["tsconfig.json"],
          message:
            `could not read "tsconfig.json" (${message})${code ? ` [${code}]` : ""}; continuing ` +
            "as if no tsconfig.json was present. TS import resolution (jsx/allowJs/" +
            "resolveJsonModule) may differ from a run where it is readable.",
        });
      }
      tsconfigHash = "no-tsconfig";
    }
  }
  const tsEnvKey = hashContent(
    JSON.stringify([tsconfigHash, tsMode, codeId ?? null, [...relCodeFiles].sort()]),
  );
  const tsFragmentsValid = prevCache !== undefined && prevCache.data.tsEnvKey === tsEnvKey;

  // issue #323 — `testFiles` (the `testPatterns` pool's own match set) is
  // reused for both (a) the parse-cache kind-mismatch guard below (a warm
  // fragment's `kind` can go stale when ONLY testPatterns changes, content
  // unchanged — see `fragmentTestKindMatches`'s doc comment in
  // parse-cache.ts) and (b) the `isTest` classification `parseTSFilePaths`
  // needs for any file that misses the cache. issue #350 — this is now the
  // SAME `testFiles` `discoverCodeFiles` already computed above (as part of
  // discovering `codeFiles` itself), not a second, independent glob call:
  // the two call sites below can never see a different testPatterns match
  // for the same file within one build, and no extra glob call is spent
  // getting it (Step 0-pre MEDIUM-1).

  const nextTs: Record<string, TsFragment> = {};
  const fragmentByFile = new Map<string, TsFragment>();
  const missPaths: string[] = [];
  const missHashes = new Map<string, string>();
  // PR #334 meta-review HIGH-1 — content for every miss path whose read
  // (below) actually succeeded, handed straight through to `parseTSFilePaths`
  // so it never re-reads the file. See that function's doc comment for why a
  // second, independent read here was dangerous (an asymmetric hash-succeeds
  // / parse-fails race could poison the cache with a broken fragment under a
  // real, correct hash). A path is deliberately ABSENT from this map when its
  // own read (below) failed — `parseTSFile`'s guarded read is still the only
  // thing that attempts (and diagnoses) that file's read, unchanged from
  // before this fix.
  const missContents = new Map<string, string>();
  for (let i = 0; i < codeFiles.length; i++) {
    // issue #264 — this read (done purely to compute a cache-validity hash)
    // can throw for exactly the same reason `parseTSFile`'s own read can
    // (permission errors, e.g. chmod 000). Before this fix that uncaught
    // throw crashed the WHOLE build here, before a miss path ever even
    // reached `parseTSFilePaths` / `parseTSFile`'s own (now-guarded) read.
    // On failure: force this file to always miss the cache (never treat a
    // stale/sentinel hash as a legitimate match) using a fixed non-hash
    // sentinel that can never collide with a real `hashContent` output (a
    // 16-hex-char string) — including the degenerate case of a genuinely
    // empty-but-READABLE file, which would otherwise coincide with
    // `hashContent("")` if that were used as the sentinel instead. The
    // actual "can't read, warn, synthesize a bare node" handling — and the
    // ONLY place the `unreadable-file` warning is emitted from — lives in
    // `parseTSFile`, which independently attempts (and, for this one path,
    // fails) the same read; this catch only needs to avoid crashing and
    // route the file there, not duplicate that diagnostic.
    let content: string | undefined;
    try {
      content = readFileSync(codeFiles[i], "utf-8");
    } catch {
      content = undefined;
    }
    if (content === undefined) {
      missPaths.push(codeFiles[i]);
      missHashes.set(codeFiles[i], "unreadable-file:cannot-hash");
      continue;
    }
    const contentHash = hashContent(content);
    const hit = tsFragmentsValid ? prevCache!.data.ts[relCodeFiles[i]] : undefined;
    // issue #323 — a fragment whose content hash still matches can still be
    // STALE if `testPatterns` changed since it was cached: `isTest` (and
    // therefore the file node's `kind`) is now config-derived, not a
    // property of the file's bytes, so the byte-identity check above cannot
    // see this kind of drift on its own. `fragmentTestKindMatches` compares
    // the cached fragment's own `kind` against today's testPatterns-derived
    // answer and forces a cold reparse on mismatch — see its doc comment.
    if (
      hit &&
      hit.contentHash === contentHash &&
      importTargetsExist(hit.edges, rootDir) &&
      fragmentTestKindMatches(hit, relCodeFiles[i], testFiles.has(codeFiles[i]))
    ) {
      fragmentByFile.set(codeFiles[i], hit);
    } else {
      missPaths.push(codeFiles[i]);
      missHashes.set(codeFiles[i], contentHash);
      // This read succeeded (we're past the `content === undefined` branch
      // above) — hand it to `parseTSFilePaths` so `parseTSFile` reuses it
      // instead of reading `codeFiles[i]` a second time (HIGH-1).
      missContents.set(codeFiles[i], content);
    }
  }
  if (missPaths.length > 0) {
    const parsed = parseTSFilePaths(rootDir, missPaths, tsMode, codeId, missContents, testFiles);
    // issue #335 (Step 0-pre HIGH-2) — `parseTSFilePaths` internally calls
    // `createResolverContext`, which reads tsconfig.json (and its "extends"
    // chain) a SECOND, independent time from the cache-hash read a few lines
    // above. A resolver-context-level EMFILE/ENFILE is deliberately NOT
    // folded into any file's `ParsedTS.warnings` (see
    // `takeResolverResourceExhaustedWarning`'s doc comment in
    // parsers/typescript.ts for why that would poison the parse cache) —
    // drained here instead and pushed straight into this scan's `warnings`,
    // subject to the same `systemResourceExhaustedReported` per-scan dedup
    // every other guarded site in this function uses.
    const resolverWarning = takeResolverResourceExhaustedWarning();
    if (resolverWarning && !systemResourceExhaustedReported) {
      systemResourceExhaustedReported = true;
      warnings.push({
        type: "system-resource-exhausted",
        id: resolverWarning.symbolId,
        files: [resolverWarning.filePath],
        message: resolverWarning.message,
      });
    }
    for (const [abs, frag] of parsed) {
      // Preserve the parser's `starExports` side-channel (specs/018 §3) on the
      // freshly-parsed fragment so the builder's star-expansion pass below
      // can see plain-`export *` sources on cold builds too. Warm builds get
      // the field back from the cache automatically. Omit the key when the
      // parser did not emit any (typical for non-barrel files) so the
      // fragment stays byte-identical to a pre-018 shape.
      const next: TsFragment = {
        contentHash: missHashes.get(abs)!,
        nodes: frag.nodes,
        edges: frag.edges,
        // PR #242 review A — parser warnings travel WITH the fragment (the
        // MdFragment.warnings precedent) so a warm cache hit replays them:
        // the conversion to BuildWarnings below runs per build over ALL
        // fragments, warm and cold alike.
        warnings: frag.warnings,
      };
      if (frag.starExports && frag.starExports.length > 0) {
        next.starExports = frag.starExports;
      }
      fragmentByFile.set(abs, next);
    }
  }
  const tsResult: { nodes: GraphNode[]; edges: GraphEdge[] } = { nodes: [], edges: [] };
  for (let i = 0; i < codeFiles.length; i++) {
    const frag = fragmentByFile.get(codeFiles[i])!;
    tsResult.nodes.push(...frag.nodes);
    tsResult.edges.push(...frag.edges);
    nextTs[relCodeFiles[i]] = frag;
    // PR #242 review A — convert TS parser warnings to BuildWarnings, the TS
    // counterpart of the markdown "T036" conversion loop below. Runs on the
    // fragment (not inside the parser) so warm cache hits emit the same
    // warnings a cold parse does — the pre-fix `console.warn` inside
    // extractSymbols disappeared on every warm build and never reached
    // `--format json` `warnings[]`. The `?? []` guards a hand-written or
    // cross-version fragment that predates the field (SCHEMA_VERSION 6
    // normally cold-invalidates those, but conversion must never crash).
    for (const tw of frag.warnings ?? []) {
      // issue #295 — `system-resource-exhausted` is scan-wide, not per-file
      // (see `systemResourceExhaustedReported`'s declaration above): a warm
      // cache hit can replay one of these per fragment, and the TS side can
      // hit EMFILE/ENFILE on many files in the same scan, so without this
      // guard the conversion would emit one `system-resource-exhausted`
      // warning per affected file/fragment instead of one per scan. Every
      // other warning type is unaffected and still converts 1:1.
      if (tw.type === "system-resource-exhausted") {
        if (systemResourceExhaustedReported) continue;
        systemResourceExhaustedReported = true;
      }
      warnings.push({ type: tw.type, id: tw.symbolId, files: [tw.filePath], message: tw.message });
    }
  }

  for (const node of tsResult.nodes) {
    addNodeWithDupCheck(nodes, node, warnings);
  }

  // Remap @impl/@verifies edge targets for colliding IDs
  for (const edge of tsResult.edges) {
    // issue #216 — code-side `@impl SC-001` / test markers `[SC-001]`
    // (including namespaced `013-foo/SC-001`) referencing an ignored prefix
    // emit no edge, so `check` never reports them as orphans. Skipped here at
    // assembly (not in the TS parser) for the same cache-purity reason as the
    // spec-side filter above.
    if ((edge.kind === "implements" || edge.kind === "verifies") && isIgnoredId(edge.target)) {
      continue;
    }
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

  // specs/018 §5 — `export *` per-symbol expansion. Runs AFTER the parser
  // fragments have populated `nodes` with every locally-declared and
  // #177/S2/S3 synth symbol (ownNames wins over star per §7 D3), and BEFORE
  // the phantom-repair pass below so any name a star chain materializes
  // resolves to a real node rather than getting degraded to `file:M`.
  // Symbol mode only; file mode never emits `symbol:` nodes.
  //
  // Reads plain-`export *` targets from each fragment's `starExports` side-
  // channel (populated by extractImports on non-test symbol-mode parses),
  // dedups defensively across the cache boundary — the parser also dedups
  // per-file, but a fragment that survived from an older SCHEMA_VERSION or
  // was hand-written by a test can drift — then hands the map to the pure
  // `expandStarReexports`. The result is additive: nodes go through
  // `addNodeWithDupCheck` (so a shadow collision with a same-id local decl
  // would surface as a `duplicate-id` warning — expansion already excludes
  // ownNames so this should never happen, but the check is cheap
  // defence-in-depth) and edges get pushed straight into `edges`. Neither
  // side mutates the parser fragments persisted via `nextTs[..] = frag`
  // above (the fragments are the SSOT the warm-vs-cold parity depends on;
  // synth nodes/edges must live in the assembly layer only).
  if (tsMode === "symbol") {
    const starMap = new Map<string, string[]>();
    for (let i = 0; i < codeFiles.length; i++) {
      const frag = fragmentByFile.get(codeFiles[i])!;
      if (!frag.starExports || frag.starExports.length === 0) continue;
      const seen = new Set<string>();
      const targets: string[] = [];
      for (const t of frag.starExports) {
        if (seen.has(t)) continue;
        seen.add(t);
        targets.push(t);
      }
      starMap.set(relCodeFiles[i], targets);
    }
    if (starMap.size > 0) {
      const { nodes: starNodes, edges: starEdges } = expandStarReexports(nodes, starMap);
      for (const node of starNodes) addNodeWithDupCheck(nodes, node, warnings);
      for (const edge of starEdges) edges.push(edge);
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
      // Source file the consumer's import lives in — the `file:<consumer>`
      // side of the edge — is the useful location for the observability
      // warning ("this file's import of X was rewritten / left dangling").
      const sourceFile = edge.source.startsWith("file:")
        ? edge.source.slice("file:".length)
        : edge.source.startsWith("symbol:")
          ? edge.source.slice("symbol:".length).split("#")[0]
          : edge.source;
      if (nodes.has(fileId)) {
        edges[i] = { ...edge, target: fileId };
        warnings.push({
          type: "phantom-import-repaired",
          id: edge.target,
          files: [sourceFile],
          message: `named import of "${body.slice(hashIdx + 1)}" through re-export barrel resolved to file grain (target file: ${rel})`,
        });
      } else {
        // File node itself is out of scan scope (target under an exclude
        // glob, or otherwise unregistered). Repair cannot degrade to
        // `file:M` because that node does not exist either — the edge
        // stays dangling. `orphan-edge` warnings elsewhere in this module
        // only fire on `implements|verifies`, so without this branch a
        // symbol-mode import silently dies in BFS with no diagnostic.
        warnings.push({
          type: "dangling-import",
          id: edge.target,
          files: [sourceFile],
          message: `import target unresolved and its file node is out of scan scope (target rel: ${rel})`,
        });
      }
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

  // spec 020 (T015, data-model.md §4, FR-006〜011) — coverage-derived
  // `exercises` edges. Fully opt-in: `hasTraceShards` is a glob-only
  // existence probe, so a trace-absent project never pays for
  // `ingestTrace`'s `buildSymbolNameTable` re-parse and the graph this
  // function returns is byte-identical to pre-spec-020 output (FR-010,
  // US1-3) — `ingestedTrace` below stays `undefined` and the `trace` key is
  // omitted from this function's return value entirely (not merely
  // `undefined`-valued) in that case, so a trace-absent scan's returned
  // object is unchanged. Runs AFTER every other edge-producing pass (so the
  // claim/evidence cross-check below sees the FINAL set of declared
  // `implements` edges) and BEFORE dedup/sort (so the merge output goes
  // through the same canonicalization as everything else — INV-T2/T3).
  //
  // issue #351 ("Window B" elimination) — this is now the ONLY call to
  // `ingestTrace` in the whole process for a given `scan()`/`buildGraph()`
  // invocation: `src/commands/check.ts` / `src/commands/impact.ts` /
  // `src/commands/trace.ts` used to each call `ingestTrace` a SECOND time
  // independently (their own `hasTraceShards` + `ingestTrace` pair), which —
  // besides the redundant `buildSymbolNameTable` re-parse — meant an
  // EMFILE/ENFILE hit inside `ingestTrace` had NO guard at all on that
  // second call site (a genuine, uncaught crash — see `ingestTrace`'s own
  // doc comment and `buildSymbolNameTable`'s). Those commands now read the
  // `trace` field this function returns instead (via `scan()`), so
  // `ingestTrace`'s own EMFILE/ENFILE fail-safety (routed through
  // `buildSymbolNameTable`) is this function's problem to surface, exactly
  // like every other guarded read in this module: its `warnings` are folded
  // into this scan's `warnings` via the SAME convert+`systemResourceExhaustedReported`
  // dedup pattern the TS-fragment conversion loop above uses.
  //
  // issue #351 (H1) — `hasTraceShards` itself can now hit EMFILE/ENFILE
  // (`present: false, resourceExhausted: true`): a false `present` in that
  // case is NOT "no trace", it is "couldn't tell" — `ingestTrace` is still
  // skipped (nothing reliable to ingest; `ingestedTrace` stays `undefined`,
  // same as a genuinely trace-absent project), but the resource-exhaustion
  // signal must still surface so `check --gate` / `impact` can refuse to
  // treat a silently-degraded `exercises`-edge graph as trustworthy. Folds
  // into the SAME per-scan `systemResourceExhaustedReported` dedup as every
  // other guarded site in this module.
  let ingestedTrace: IngestedTrace | undefined;
  const shardProbe = hasTraceShards(config, rootDir);
  if (shardProbe.present) {
    const { trace: ingested, warnings: traceWarnings } = ingestTrace(config, rootDir);
    for (const tw of traceWarnings) {
      if (tw.type === "system-resource-exhausted") {
        if (systemResourceExhaustedReported) continue;
        systemResourceExhaustedReported = true;
      }
      warnings.push({ type: tw.type, id: tw.symbolId, files: [tw.filePath], message: tw.message });
    }
    mergeTraceEdges(nodes, edges, ingested);
    ingestedTrace = ingested;
  } else if (shardProbe.resourceExhausted && !systemResourceExhaustedReported) {
    systemResourceExhaustedReported = true;
    warnings.push({
      type: "system-resource-exhausted",
      id: "glob:trace-shards",
      files: [],
      message:
        "file descriptor exhaustion (EMFILE/ENFILE) while probing for trace shards during this " +
        "scan; the process ran out of open file descriptors. Consider raising the OS " +
        "file-descriptor limit (e.g. `ulimit -n`) and re-running — other file reads in this " +
        "scan may also be failing the same way. Trace ingest was skipped this run (`exercises` " +
        "edges may be missing).",
    });
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

  const result: { graph: ArtifactGraph; warnings: BuildWarning[]; trace?: IngestedTrace } = {
    graph: { nodes: sortedNodes, edges: dedupedEdges },
    warnings,
  };
  if (ingestedTrace) result.trace = ingestedTrace;
  return result;
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

// spec 020 (data-model.md §3, FR-007) — `ingestTrace`'s SymbolNameTable
// always resolves hits at "symbol" grain internally, independent of THIS
// graph's own `config.mode`. In a file-mode graph no `symbol:` nodes exist
// at all, so a resolved `symbol:<rel>#<name>` id would otherwise dangle.
// `resolveTraceGraphNodeId` (issue #275: moved to `src/trace/ingest.ts` and
// re-exported from there so `filterTraceToGraph` shares the EXACT same
// degrade-to-file-grain rule — see that function's doc for why a naive
// `graph.nodes.has(id)` in either caller would over-filter) degrades to the
// owning file's `file:<rel>` node when it exists — the same fail-safe
// fallback FR-007 already applies to name-ambiguity, just at a different
// failure point (mode mismatch, not name resolution). Returns `undefined`
// only when neither the symbol nor its owning file is a real node in THIS
// graph (out of `include` for this build, or a stale/mismatched symbol
// table) — mergeTraceEdges below drops the pair rather than emit a
// dangling-target edge.

// spec 020 (T015, data-model.md §4, FR-008) — fold `IngestedTrace`'s
// per-REQ coverage into the graph's edge list. For every (reqId, node) pair
// the ingest layer's evidence reaches:
//
//   - a declared `implements` edge already exists for that EXACT pair
//     (source: node, target: reqId) -> push a duplicate-key `implements`
//     edge carrying only `["coverage"]`. `dedupEdges` (canonical.ts) unions
//     provenances by (source, target, kind), so this is merged into the
//     existing edge — no separate `exercises` edge for a corroborated pair
//     (FR-008 "証拠のみの対は独立した exercises エッジとして生成し、
//     implements として扱わないこと" — the inverse: a CLAIMED pair with
//     evidence stays `implements`, evidence alone never becomes one).
//   - otherwise -> push a new forward-only `exercises` edge (req -> node,
//     data-model.md §4), provenance `["coverage"]`.
//
// Mutates `edges` in place (append-only) — the caller runs this BEFORE
// `dedupEdges`/`sortNodesById` so the merge output is canonicalized exactly
// like every other edge source in this file.
function mergeTraceEdges(
  nodes: Map<string, GraphNode>,
  edges: GraphEdge[],
  trace: IngestedTrace,
): void {
  const implementsPairs = new Set<string>();
  for (const edge of edges) {
    if (edge.kind === "implements") implementsPairs.add(`${edge.source}|${edge.target}`);
  }

  for (const reqId of [...trace.perReq.keys()].sort()) {
    const coverage = trace.perReq.get(reqId)!;
    // US1-4 (N:M union): `coverage.symbols`/`coverage.files` are already the
    // ingest layer's per-REQ union across every green tagged test — no
    // further union needed here. Combine both grains into one sorted,
    // deduped target set so a name that resolved to BOTH a symbol id (one
    // test) and its file-grain fallback (another, ambiguous, test) doesn't
    // silently pick one.
    const targetIds = new Set<string>([...coverage.symbols, ...coverage.files]);
    for (const rawNodeId of [...targetIds].sort()) {
      const nodeId = resolveTraceGraphNodeId(rawNodeId, nodes);
      if (nodeId === undefined) continue; // fail-safe: never emit a dangling-target edge
      if (implementsPairs.has(`${nodeId}|${reqId}`)) {
        edges.push({
          source: nodeId,
          target: reqId,
          kind: "implements",
          provenances: ["coverage"],
        });
      } else {
        edges.push({ source: reqId, target: nodeId, kind: "exercises", provenances: ["coverage"] });
      }
    }
  }
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
