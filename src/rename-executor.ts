import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  rewriteFile,
  rewriteImplTags,
  rewriteTestTags,
  rewriteFrontmatter,
  expandFrontmatterDependsOn,
  specDefinitionId,
  fencedLines,
  extOf,
  escapeRegExp,
  type RewriteChange,
  type RewriteOptions,
} from "./rename.js";
import { renameLockKey, splitLockKey, mergeLockKeys } from "./rename-lock.js";
import type { LockChange } from "./rename-lock.js";
import { readLock } from "./lock.js";
import { scan, reconcile } from "./scan.js";
import { loadConfig } from "./config.js";
import { getGitTrackedFiles } from "./diff.js";
import { assertValidTargetId } from "./id.js";
import type { ArtgraphConfig, LockFile } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────

export interface RenameOptions {
  dryRun: boolean;
  format: "json" | "text";
  rootDir: string;
}

export interface RenameWarning {
  type: "manual-assignment-needed";
  filePath: string;
  oldId: string;
  newIds: string[];
}

export interface RenameResult {
  operation: "rename" | "split" | "merge";
  // Structured identifiers so consumers/printers never have to reconstruct
  // them from change text (L1).
  from?: string;
  to?: string;
  sourceIds?: string[];
  intoIds?: string[];
  changes: RewriteChange[];
  lockChanges: LockChange[];
  warnings: RenameWarning[];
  applied: boolean;
}

// Scaffold placeholder appended for newly created requirements. Kept in English
// to match the rest of the CLI output (M6).
const SCAFFOLD_PLACEHOLDER = "(TODO: describe this requirement)";

// ── Helpers ──────────────────────────────────────────────────────────

const RELEVANT_EXTENSIONS = new Set([".md", ".ts", ".tsx", ".js", ".jsx"]);

function filterRelevantFiles(files: string[]): string[] {
  return files.filter((f) => RELEVANT_EXTENSIONS.has(extOf(f)));
}

function relevantTrackedFiles(rootDir: string): string[] {
  return filterRelevantFiles(getGitTrackedFiles(rootDir));
}

/**
 * Reject IDs that can never be a rename/split/merge *source*: `file:`/`symbol:`
 * nodes are derived from paths, not authored references, so the rewriter cannot
 * relocate them (F8).
 */
function assertRenameableSource(id: string): void {
  if (id.startsWith("file:") || id.startsWith("symbol:")) {
    throw new Error(
      `ID "${id}" refers to a ${id.startsWith("file:") ? "file" : "symbol"} node, ` +
        `which is derived from the filesystem and cannot be renamed.`,
    );
  }
}

/**
 * After files are written, rebuild the lock from a fresh scan so contentHashes,
 * cross-references and specFile entries reflect the new on-disk state. Without
 * this, `artgraph check` immediately reports drift for every rewritten node
 * (F1). Only runs when a lock file already existed.
 */
function reconcileAfterWrite(rootDir: string, config: ArtgraphConfig): void {
  const lockFilePath = resolve(rootDir, config.lockFile);
  if (!existsSync(lockFilePath)) return;
  const { graph } = scan(rootDir, config);
  reconcile(rootDir, config, graph);
}

interface ScanContext {
  config: ArtgraphConfig;
  existingIds: Set<string>;
  rewriteOpts: RewriteOptions;
}

function loadScanContext(rootDir: string): ScanContext {
  const config = loadConfig(rootDir);
  const { graph } = scan(rootDir, config);
  return {
    config,
    existingIds: new Set(graph.nodes.keys()),
    rewriteOpts: {
      reqPatterns: config.reqPatterns,
      taskConventions: config.taskConventions,
      disableBuiltinTaskConventions: config.disableBuiltinTaskConventions,
    },
  };
}

function applyWrites(
  rootDir: string,
  config: ArtgraphConfig,
  filesToWrite: Map<string, string>,
  dryRun: boolean,
): void {
  if (dryRun) return;
  for (const [absPath, content] of filesToWrite) {
    writeFileSync(absPath, content, "utf-8");
  }
  reconcileAfterWrite(rootDir, config);
}

// ── executeRename ───────────────────────────────────────────────────

export function executeRename(
  options: RenameOptions & { from: string; to: string },
): RenameResult {
  const { rootDir, dryRun, from, to } = options;
  const { config, existingIds, rewriteOpts } = loadScanContext(rootDir);

  // Validate
  if (from === to) {
    throw new Error(`Source and target IDs are identical ("${from}"); nothing to rename.`);
  }
  assertRenameableSource(from);
  assertValidTargetId(
    to,
    config.reqPatterns,
    config.taskConventions,
    config.disableBuiltinTaskConventions,
  );
  if (!existingIds.has(from)) {
    throw new Error(`ID "${from}" does not exist in the project.`);
  }
  if (existingIds.has(to)) {
    throw new Error(`ID "${to}" already exists in the project.`);
  }

  // Rewrite each file
  const allChanges: RewriteChange[] = [];
  const filesToWrite = new Map<string, string>();

  for (const relPath of relevantTrackedFiles(rootDir)) {
    const absPath = resolve(rootDir, relPath);
    if (!existsSync(absPath)) continue;

    const content = readFileSync(absPath, "utf-8");
    const result = rewriteFile(relPath, content, from, to, rewriteOpts);
    if (result.changes.length > 0) {
      allChanges.push(...result.changes);
      filesToWrite.set(absPath, result.content);
    }
  }

  // Project lock changes (also the source of truth for dry-run reporting).
  const lockChanges = projectLockChanges(rootDir, config, (lock) => renameLockKey(lock, from, to));

  applyWrites(rootDir, config, filesToWrite, dryRun);

  return {
    operation: "rename",
    from,
    to,
    changes: allChanges,
    lockChanges,
    warnings: [],
    applied: !dryRun,
  };
}

// ── executeSplit ─────────────────────────────────────────────────────

export function executeSplit(
  options: RenameOptions & { splitId: string; intoIds: string[] },
): RenameResult {
  const { rootDir, dryRun, splitId, intoIds } = options;
  const { config, existingIds, rewriteOpts } = loadScanContext(rootDir);

  // Validate
  assertRenameableSource(splitId);
  if (!existingIds.has(splitId)) {
    throw new Error(`ID "${splitId}" does not exist in the project.`);
  }
  if (intoIds.length === 0) {
    throw new Error(`--split requires at least one target ID via --into.`);
  }
  const seen = new Set<string>();
  for (const newId of intoIds) {
    assertValidTargetId(
      newId,
      config.reqPatterns,
      config.taskConventions,
      config.disableBuiltinTaskConventions,
    );
    if (seen.has(newId)) {
      throw new Error(`Duplicate target ID "${newId}" in --into.`);
    }
    seen.add(newId);
    if (newId !== splitId && existingIds.has(newId)) {
      throw new Error(`ID "${newId}" already exists in the project.`);
    }
  }

  const allChanges: RewriteChange[] = [];
  const warnings: RenameWarning[] = [];
  const filesToWrite = new Map<string, string>();

  const implRe = /\/\/[^\S\n]*@impl[^\S\n]+/;

  for (const relPath of relevantTrackedFiles(rootDir)) {
    const absPath = resolve(rootDir, relPath);
    if (!existsSync(absPath)) continue;

    const content = readFileSync(absPath, "utf-8");
    const ext = extOf(relPath);

    if (ext === ".md") {
      const { content: next, changes } = splitMarkdown(
        relPath,
        content,
        splitId,
        intoIds,
        rewriteOpts,
      );
      if (changes.length > 0) {
        allChanges.push(...changes);
        filesToWrite.set(absPath, next);
      }
    } else {
      // Code files: @impl assignment is ambiguous on split, so warn instead of
      // rewriting (unchanged behaviour).
      const lines = content.split("\n");
      const fenced = fencedLines(content);
      for (let i = 0; i < lines.length; i++) {
        if (fenced.has(i)) continue;
        if (implRe.test(lines[i]) && referencesId(lines[i], splitId)) {
          warnings.push({
            type: "manual-assignment-needed",
            filePath: relPath,
            oldId: splitId,
            newIds: intoIds,
          });
          break;
        }
      }
    }
  }

  const lockChanges = projectLockChanges(rootDir, config, (lock) =>
    splitLockKey(lock, splitId, intoIds),
  );

  applyWrites(rootDir, config, filesToWrite, dryRun);

  return {
    operation: "split",
    from: splitId,
    sourceIds: [splitId],
    intoIds,
    changes: allChanges,
    lockChanges,
    warnings,
    applied: !dryRun,
  };
}

// ── executeMerge ─────────────────────────────────────────────────────

export function executeMerge(
  options: RenameOptions & { mergeIds: string[]; intoId: string },
): RenameResult {
  const { rootDir, dryRun, mergeIds, intoId } = options;
  const { config, existingIds, rewriteOpts } = loadScanContext(rootDir);

  // Validate
  if (mergeIds.length < 1) {
    throw new Error(`--merge requires at least one source ID.`);
  }
  assertValidTargetId(
    intoId,
    config.reqPatterns,
    config.taskConventions,
    config.disableBuiltinTaskConventions,
  );
  for (const id of mergeIds) {
    assertRenameableSource(id);
    if (!existingIds.has(id)) {
      throw new Error(`ID "${id}" does not exist in the project.`);
    }
  }
  // intoId must NOT exist UNLESS it equals one of mergeIds.
  if (existingIds.has(intoId) && !mergeIds.includes(intoId)) {
    throw new Error(
      `ID "${intoId}" already exists in the project and is not one of the merge source IDs.`,
    );
  }

  // IDs whose references/definitions collapse into intoId.
  const idsToRewrite = mergeIds.filter((id) => id !== intoId);
  const intoIsExisting = mergeIds.includes(intoId);

  const allChanges: RewriteChange[] = [];
  const filesToWrite = new Map<string, string>();

  for (const relPath of relevantTrackedFiles(rootDir)) {
    const absPath = resolve(rootDir, relPath);
    if (!existsSync(absPath)) continue;

    const content = readFileSync(absPath, "utf-8");
    const ext = extOf(relPath);

    if (ext === ".md") {
      const { content: next, changes } = mergeMarkdown(
        relPath,
        content,
        idsToRewrite,
        intoId,
        intoIsExisting,
        rewriteOpts,
      );
      if (changes.length > 0) {
        allChanges.push(...changes);
        filesToWrite.set(absPath, next);
      }
    } else {
      // Code/test files: collapse @impl and test references onto intoId.
      let next = content;
      const fileChanges: RewriteChange[] = [];
      for (const oldId of idsToRewrite) {
        const implRes = rewriteImplTags(next, oldId, intoId);
        next = implRes.content;
        const testRes = rewriteTestTags(next, oldId, intoId);
        next = testRes.content;
        for (const c of [...implRes.changes, ...testRes.changes]) {
          c.filePath = relPath;
          fileChanges.push(c);
        }
      }
      if (fileChanges.length > 0) {
        allChanges.push(...fileChanges);
        filesToWrite.set(absPath, next);
      }
    }
  }

  const lockChanges = projectLockChanges(rootDir, config, (lock) =>
    mergeLockKeys(lock, mergeIds, intoId),
  );

  applyWrites(rootDir, config, filesToWrite, dryRun);

  return {
    operation: "merge",
    to: intoId,
    sourceIds: mergeIds,
    intoIds: [intoId],
    changes: allChanges,
    lockChanges,
    warnings: [],
    applied: !dryRun,
  };
}

// ── Markdown split/merge primitives ──────────────────────────────────

/**
 * Whether `line` references `id` as a standalone token (not as a definition).
 */
function referencesId(line: string, id: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_/:-])${escapeRegExp(id)}(?![A-Za-z0-9_/:-])`).test(line);
}

/**
 * Split a markdown spec: remove the definition line(s) for `splitId`, append a
 * scaffold list item per new ID, and expand any frontmatter dependency on the
 * split ID to all new IDs (F5). Fenced code blocks are never touched (F6).
 */
function splitMarkdown(
  relPath: string,
  content: string,
  splitId: string,
  intoIds: string[],
  opts: RewriteOptions,
): { content: string; changes: RewriteChange[] } {
  const lines = content.split("\n");
  const fenced = fencedLines(content);
  const changes: RewriteChange[] = [];

  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!fenced.has(i) && specDefinitionId(lines[i], opts) === splitId) {
      changes.push({
        filePath: relPath,
        line: i + 1,
        kind: "spec-list-item",
        before: lines[i],
        after: "(removed)",
      });
      continue;
    }
    kept.push(lines[i]);
  }

  for (const newId of intoIds) {
    const scaffold = `- ${newId}: ${SCAFFOLD_PLACEHOLDER}`;
    kept.push(scaffold);
    changes.push({
      filePath: relPath,
      line: kept.length,
      kind: "spec-list-item",
      before: "",
      after: scaffold,
    });
  }

  // Expand frontmatter dependency references.
  let next = kept.join("\n");
  const fm = expandFrontmatterDependsOn(next, splitId, intoIds);
  if (fm.changes.length > 0) {
    next = fm.content;
    for (const c of fm.changes) {
      c.filePath = relPath;
      changes.push(c);
    }
  }

  return { content: next, changes };
}

/**
 * Merge markdown specs: remove the definition lines for the merged-away IDs,
 * collapse frontmatter dependency references onto intoId, and append a single
 * scaffold for intoId only when it is a brand-new requirement. Crucially the
 * definition lines are removed *instead of* being rewritten, so intoId is never
 * duplicated (C1).
 */
function mergeMarkdown(
  relPath: string,
  content: string,
  idsToRewrite: string[],
  intoId: string,
  intoIsExisting: boolean,
  opts: RewriteOptions,
): { content: string; changes: RewriteChange[] } {
  const lines = content.split("\n");
  const fenced = fencedLines(content);
  const changes: RewriteChange[] = [];
  const removeSet = new Set(idsToRewrite);

  const kept: string[] = [];
  let removedAnyDefinition = false;
  for (let i = 0; i < lines.length; i++) {
    const defId = fenced.has(i) ? null : specDefinitionId(lines[i], opts);
    if (defId != null && removeSet.has(defId)) {
      changes.push({
        filePath: relPath,
        line: i + 1,
        kind: "spec-list-item",
        before: lines[i],
        after: "(removed)",
      });
      removedAnyDefinition = true;
      continue;
    }
    kept.push(lines[i]);
  }

  let next = kept.join("\n");

  // Collapse frontmatter dependency references onto intoId.
  for (const oldId of idsToRewrite) {
    const fm = rewriteFrontmatter(next, oldId, intoId);
    if (fm.changes.length > 0) {
      next = fm.content;
      for (const c of fm.changes) {
        c.filePath = relPath;
        changes.push(c);
      }
    }
  }

  // Append a scaffold for a brand-new intoId, but only in a file that actually
  // hosted one of the merged definitions.
  if (!intoIsExisting && removedAnyDefinition) {
    const scaffold = `- ${intoId}: ${SCAFFOLD_PLACEHOLDER}`;
    const outLines = next.split("\n");
    outLines.push(scaffold);
    changes.push({
      filePath: relPath,
      line: outLines.length,
      kind: "spec-list-item",
      before: "",
      after: scaffold,
    });
    next = outLines.join("\n");
  }

  return { content: next, changes };
}

// ── Lock projection ──────────────────────────────────────────────────

/**
 * Compute the projected lock-key changes for reporting / dry-run. The actual
 * on-disk lock is rebuilt by reconcileAfterWrite, so this only needs the change
 * log, not the resulting lock.
 */
function projectLockChanges(
  rootDir: string,
  config: ArtgraphConfig,
  op: (lock: LockFile) => { changes: LockChange[] },
): LockChange[] {
  const lockFilePath = resolve(rootDir, config.lockFile);
  if (!existsSync(lockFilePath)) return [];
  const lock = readLock(rootDir, config.lockFile);
  return op(lock).changes;
}
