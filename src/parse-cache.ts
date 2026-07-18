import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { atomicWriteFile } from "./integrate/atomic-write.js";
import type { ArtgraphConfig, GraphEdge, GraphNode } from "./types.js";
import type { InlineLinkRef, ParseWarning } from "./parsers/markdown.js";
import type { TsParseWarning } from "./parsers/typescript.js";

// Incremental parse cache: memoizes per-file parser output (markdown fragments
// and TypeScript fragments) keyed by content hash, so `scan`/`check`/`impact`
// only re-parse files that actually changed. The cache is a pure memo of
// parser results — graph assembly (collision remap, dedup, sorting) always
// runs fresh in buildGraph, so a warm build is structurally identical to a
// cold one (INV-L4 lock byte-identity is preserved by construction).
//
// Storage: <root>/node_modules/.cache/artgraph/parse-cache.json. The cache is
// only written when <root>/node_modules already exists — a project without it
// (Deno layouts, test fixtures copied to tmp dirs) silently runs the cold
// path every time, exactly as before this cache existed. Set ARTGRAPH_CACHE=0
// to disable reads and writes entirely.
//
// Invalidation:
//   - whole cache: artgraph version / parser-relevant config fingerprint
//   - all TS fragments: tsconfig.json content, mode, codeId, or the matched
//     file set changing (add/remove can change import resolution of files
//     whose own content did not change)
//   - single fragment: content hash mismatch, or (TS) an import-edge target
//     that no longer exists on disk
//
// Known limit (documented, vanishingly rare with explicit-extension ESM
// specifiers): creating a NEW file outside the include/testPatterns set that
// shadows how an unchanged file's import specifier resolves is not detected.
// Deletions are caught by the existsSync validation; additions/removals
// inside the matched set are caught by the file-set key.

export interface MdFragment {
  contentHash: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  warnings: ParseWarning[];
  inlineLinks: InlineLinkRef[];
}

export interface TsFragment {
  contentHash: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  // specs/018 §3 side-channel — rootDir-relative resolved targets of every
  // plain `export * from` in this file (symbol mode + non-test only, source
  // order, deduped by first occurrence). Consumed by the builder star-
  // expansion pass to compute exported-name providers per barrel. Only the
  // owning file's parse can compute this — the resolved rel path depends on
  // the resolver context this file's parse used — so it MUST travel with
  // the fragment; recomputing from edges alone would lose the plain-star vs.
  // `export * as ns` distinction (both are `file:B → file:O` edges).
  starExports?: string[];
  // PR #242 review A — parser-level structured warnings (currently just
  // class-member id collisions), mirroring `MdFragment.warnings` above. MUST
  // travel with the fragment: before this field existed, the collision
  // warning was a bare `console.warn` call inside the parser itself, so a
  // warm cache hit reused the fragment's nodes/edges but never re-ran the
  // parser — the warning silently vanished on every build after the first.
  warnings: TsParseWarning[];
}

export interface ParseCacheData {
  schemaVersion: number;
  fingerprint: string;
  tsEnvKey: string;
  /** key: `${specDirName}|${relPath}` (a file nested under two specDirs parses per-dir) */
  md: Record<string, MdFragment>;
  /** key: rootDir-relative path */
  ts: Record<string, TsFragment>;
}

// v2 (issue #177): symbol-mode parser output changed (leading-comment @impl
// now binds to symbols; named/aliased barrel re-exports materialize
// per-symbol nodes/edges). Bumping the version cold-invalidates every cached
// fragment so a warm cache from a pre-fix build cannot serve stale edges.
// v3 (issue #187): `extractImports` now emits a file-grain import edge for
// `import = require(...)` / `export import = require(...)` — previously
// these produced no edges at all. Bump so a warm cache from a pre-fix
// build cannot serve stale empty edges for files that use CJS-style TS.
// v4 (issues #179 / #188, specs/018): parser now materializes per-symbol
// nodes for `export * as ns from` (S2) and source-null re-exports of
// imported identifiers (`export default X` / `export { X }` — S3), and
// carries a `starExports` side-channel on TsFragment consumed by the
// builder's star-expansion pass (S1). Two independent reasons to bump:
// (a) old fragments lack `starExports`, so a warm cache from a pre-fix
// build would silently skip star expansion in the builder and diverge
// from a cold rebuild (INV-L4); (b) parser node/edge output itself
// changed for S2/S3 files.
// v5 (issue #218, spec 021 — class method grain): symbol-mode parser now
// emits per-member symbol nodes (`symbol:<path>#ClassName.memberName`) for
// inline exported ClassDeclarations, plus class -> method `contains` edges
// (provenance "structural"). A warm fragment from a pre-fix build has
// neither — reusing it would silently omit every member node/edge and the
// class's own leading-trivia attribution range would stay unbounded (member
// widening did not exist yet), diverging from a cold rebuild (INV-L4).
// v6 (PR #242 review A, spec 021 follow-up): `TsFragment` gained a
// `warnings` field carrying the parser's structured class-member-collision
// warnings (previously a bare `console.warn` call in extractSymbols, which
// vanished on a warm cache hit and never appeared in `--format json`). A
// pre-v6 cached fragment has no `warnings` key at all — reusing it would
// silently drop any collision warning for that file forever (until its
// content changes again), which is exactly the bug this bump fixes. No
// migration cost: v5 was never released.
// v7 (PR #261): the parser gained a pathological-bracket-nesting depth guard
// (safeParseSync / MAX_BRACKET_NESTING_DEPTH) that skips parsing a file whose
// bracket nesting is deep enough to SIGSEGV oxc-parser natively. A fragment
// written by the OLD (pre-guard) code for such a file was produced by a
// successful parse — it has real edges/symbols and no warning. Reusing that
// fragment on a warm hit would silently reproduce the old (edges, no
// warning) result forever, diverging from a COLD rebuild on the new code
// (which takes the guard's skip-with-warning path for the very same file
// content) — exactly the warm ≡ cold invariant (INV-L4) this version bump
// exists to protect. Bumping forces one cold reparse per pathological
// fragment so warm and cold agree again.
// v8 — two independent reasons, bumped together:
//   (a) issue #323: `isTest` (node kind "test"/"file", and the `[REQ-x]`
//       test-title extraction gate) is now derived from `testPatterns`
//       instead of a hardcoded filename regex. A pre-fix fragment's `kind`
//       reflects the OLD regex's answer, which can differ from what the new
//       testPatterns-derived logic would produce for the same file — the
//       per-file `fragmentTestKindMatches` guard (below) catches this going
//       forward for a testPatterns-only edit AFTER this migration, but the
//       one-time migration itself (pre-#323 cache -> post-#323 code) still
//       needs the blanket cold-invalidate a schema bump gives, since an old
//       fragment carries no record of which testPatterns produced it.
//   (b) issue #333: the parser now emits `unresolved-reexport` /
//       `unresolved-import` warnings for specifiers that fail to resolve
//       (previously a silent `continue`, no warning at all). A pre-fix
//       fragment for such a file has none of these warnings recorded in its
//       `warnings` field — reusing it on a warm hit would silently keep
//       hiding the same unresolved specifier forever, diverging from a cold
//       rebuild on the new code (INV-L4), exactly like v7's rationale above.
const SCHEMA_VERSION = 8;
const CACHE_RELDIR = join("node_modules", ".cache", "artgraph");
const CACHE_FILENAME = "parse-cache.json";

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function cacheEnabled(rootDir: string): boolean {
  if (process.env.ARTGRAPH_CACHE === "0") return false;
  return existsSync(resolve(rootDir, "node_modules"));
}

function cachePath(rootDir: string): string {
  return resolve(rootDir, CACHE_RELDIR, CACHE_FILENAME);
}

// Version stamp for the whole-cache fingerprint. Reading package.json (one
// level above dist/) beats hardcoding a second copy of the version string;
// on any read failure fall back to a constant that still yields a stable
// fingerprint for this installation.
function artgraphVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

// Hash of every config field that changes PARSER output (graph-assembly-only
// options like docGraph.* are deliberately excluded — they are re-applied to
// the fragments on every build). mode/codeId/file-set live in the TS env key.
export function computeCacheFingerprint(config: ArtgraphConfig): string {
  return hashContent(
    JSON.stringify([
      SCHEMA_VERSION,
      artgraphVersion(),
      config.reqPatterns ?? null,
      config.taskConventions ?? null,
      config.disableBuiltinTaskConventions ?? null,
    ]),
  );
}

export interface LoadedParseCache {
  data: ParseCacheData;
  /** raw file text, kept so an unchanged cache skips the disk write */
  raw: string;
}

export function readParseCache(rootDir: string, fingerprint: string): LoadedParseCache | undefined {
  if (!cacheEnabled(rootDir)) return undefined;
  try {
    const raw = readFileSync(cachePath(rootDir), "utf-8");
    const data = JSON.parse(raw) as ParseCacheData;
    if (data.schemaVersion !== SCHEMA_VERSION) return undefined;
    if (data.fingerprint !== fingerprint) return undefined;
    if (typeof data.tsEnvKey !== "string" || !data.md || !data.ts) return undefined;
    return { data, raw };
  } catch {
    // Missing or corrupt cache — cold path. Never let the cache break a scan.
    return undefined;
  }
}

export function writeParseCache(
  rootDir: string,
  cache: Omit<ParseCacheData, "schemaVersion">,
  prevRaw?: string,
): void {
  if (!cacheEnabled(rootDir)) return;
  try {
    const serialized = JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...cache });
    if (serialized === prevRaw) return; // nothing changed — skip the write
    mkdirSync(resolve(rootDir, CACHE_RELDIR), { recursive: true });
    atomicWriteFile(cachePath(rootDir), serialized);
  } catch {
    // Cache persistence is best-effort; a failed write must not fail the scan.
  }
}

// issue #323 — `isTest` (and therefore a TS fragment's own `file:<relPath>`
// node `kind`, "test" vs "file") is now DERIVED from `testPatterns`, a
// config value, rather than a property of the file's own bytes (see
// `src/parsers/typescript.ts`'s `computeTestFileSet` / `parseTSFile`). A
// warm fragment is keyed only by content hash, so changing `testPatterns`
// ALONE (file content unchanged) would otherwise replay the OLD `kind`
// forever — a new staleness path SCHEMA_VERSION bumps do not catch, since
// they only guard the initial migration, not every later `testPatterns`
// edit. Checked per-file (alongside `importTargetsExist`, at each fragment's
// reuse decision in `graph/builder.ts`) rather than folding `testPatterns`
// into `tsEnvKey` and invalidating every TS fragment on any edit — this is
// the narrower, more targeted fix: only files whose testPatterns membership
// actually flips need a cold reparse.
export function fragmentTestKindMatches(
  fragment: TsFragment,
  relPath: string,
  isTest: boolean,
): boolean {
  const fileNode = fragment.nodes.find((n) => n.id === `file:${relPath}`);
  // No file-kind node found (should not happen for a well-formed fragment —
  // `parseTSFile` always emits exactly one) — fail open (treat as matching)
  // rather than force every such fragment cold; `importTargetsExist` and the
  // content-hash check remain the primary validity gates.
  if (!fileNode) return true;
  return (fileNode.kind === "test") === isTest;
}

// Validate a cached TS fragment's import edges against the file system: a
// deleted import target changes what the parser would emit for this file even
// though the file's own content is unchanged. `imports` edge targets are
// `file:<rel>` or `symbol:<rel>#<name>`.
export function importTargetsExist(edges: GraphEdge[], rootDir: string): boolean {
  for (const edge of edges) {
    if (edge.kind !== "imports") continue;
    let rel: string;
    if (edge.target.startsWith("file:")) {
      rel = edge.target.slice("file:".length);
    } else if (edge.target.startsWith("symbol:")) {
      const body = edge.target.slice("symbol:".length);
      const hashIdx = body.lastIndexOf("#");
      rel = hashIdx === -1 ? body : body.slice(0, hashIdx);
    } else {
      continue;
    }
    if (!existsSync(resolve(rootDir, rel))) return false;
  }
  return true;
}
