import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { rewriteFile, rewriteFrontmatter } from "./rename.js";
import type { RewriteChange } from "./rename.js";
import { renameLockKey, splitLockKey, mergeLockKeys } from "./rename-lock.js";
import type { LockChange } from "./rename-lock.js";
import { readLock, writeLock } from "./lock.js";
import { scan } from "./scan.js";
import { loadConfig } from "./config.js";
import { getGitTrackedFiles } from "./diff.js";

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
  changes: RewriteChange[];
  lockChanges: LockChange[];
  warnings: RenameWarning[];
  applied: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────

const RELEVANT_EXTENSIONS = new Set([".md", ".ts", ".tsx", ".js", ".jsx"]);

function extOf(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  return dot === -1 ? "" : filePath.slice(dot).toLowerCase();
}

function filterRelevantFiles(files: string[]): string[] {
  return files.filter((f) => RELEVANT_EXTENSIONS.has(extOf(f)));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── executeRename ───────────────────────────────────────────────────

export function executeRename(
  options: RenameOptions & { from: string; to: string },
): RenameResult {
  const { rootDir, dryRun, from, to } = options;

  // 1. Load config, scan, extract existing IDs
  const config = loadConfig(rootDir);
  const { graph } = scan(rootDir, config);
  const existingIds = new Set(graph.nodes.keys());

  // 2. Validate
  if (!existingIds.has(from)) {
    throw new Error(`ID "${from}" does not exist in the project.`);
  }
  if (existingIds.has(to)) {
    throw new Error(`ID "${to}" already exists in the project.`);
  }

  // 3. Get git tracked files, filter to relevant extensions
  const allFiles = getGitTrackedFiles(rootDir);
  const files = filterRelevantFiles(allFiles);

  // 4. Rewrite each file
  const allChanges: RewriteChange[] = [];
  const filesToWrite = new Map<string, string>();

  for (const relPath of files) {
    const absPath = resolve(rootDir, relPath);
    if (!existsSync(absPath)) continue;

    const content = readFileSync(absPath, "utf-8");
    const result = rewriteFile(relPath, content, from, to);

    if (result.changes.length > 0) {
      allChanges.push(...result.changes);
      filesToWrite.set(absPath, result.content);
    }
  }

  // 5. Update lock file
  const lockChanges: LockChange[] = [];
  const lockFilePath = resolve(rootDir, config.lockFile);
  let updatedLock;

  if (existsSync(lockFilePath)) {
    const lock = readLock(rootDir, config.lockFile);
    const lockResult = renameLockKey(lock, from, to);
    updatedLock = lockResult.lock;
    lockChanges.push(...lockResult.changes);
  }

  // 6. Apply changes if not dry run
  if (!dryRun) {
    for (const [absPath, content] of filesToWrite) {
      writeFileSync(absPath, content, "utf-8");
    }
    if (updatedLock) {
      writeLock(rootDir, config.lockFile, updatedLock);
    }
  }

  // 7. Return result
  return {
    operation: "rename",
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

  // 1. Load config, scan, validate
  const config = loadConfig(rootDir);
  const { graph } = scan(rootDir, config);
  const existingIds = new Set(graph.nodes.keys());

  if (!existingIds.has(splitId)) {
    throw new Error(`ID "${splitId}" does not exist in the project.`);
  }
  for (const newId of intoIds) {
    if (existingIds.has(newId)) {
      throw new Error(`ID "${newId}" already exists in the project.`);
    }
  }

  // 2. Get git tracked files, filter
  const allFiles = getGitTrackedFiles(rootDir);
  const files = filterRelevantFiles(allFiles);

  // 3. Process files
  const allChanges: RewriteChange[] = [];
  const warnings: RenameWarning[] = [];
  const filesToWrite = new Map<string, string>();

  const splitIdEscaped = escapeRegExp(splitId);
  // Pattern for spec list items: `- ID: description` or `- **ID**: description`
  const specListItemRe = new RegExp(
    `^(\\s*[-*]\\s+)(\\*\\*)?${splitIdEscaped}(\\*\\*)?(?=[:\\s])`,
  );
  // Pattern for @impl tags referencing the splitId
  const implRe = /\/\/[^\S\n]*@impl[^\S\n]+/;
  const idBoundaryRe = new RegExp(
    `(?<![A-Za-z0-9_/:-])${splitIdEscaped}(?![A-Za-z0-9_/:-])`,
  );

  for (const relPath of files) {
    const absPath = resolve(rootDir, relPath);
    if (!existsSync(absPath)) continue;

    const content = readFileSync(absPath, "utf-8");
    const ext = extOf(relPath);

    if (ext === ".md") {
      // For spec files: remove lines matching splitId, append scaffolds for new IDs,
      // and update depends_on references
      const lines = content.split("\n");
      let changed = false;

      // Remove list items that match the splitId
      const filteredLines: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (specListItemRe.test(lines[i])) {
          allChanges.push({
            filePath: relPath,
            line: i + 1,
            kind: "spec-list-item",
            before: lines[i],
            after: "(removed)",
          });
          changed = true;
        } else {
          filteredLines.push(lines[i]);
        }
      }

      // Append scaffold lines for each new ID
      for (const newId of intoIds) {
        const scaffoldLine = `- ${newId}: (TODO: 説明を記述)`;
        filteredLines.push(scaffoldLine);
        allChanges.push({
          filePath: relPath,
          line: filteredLines.length,
          kind: "spec-list-item",
          before: "",
          after: scaffoldLine,
        });
        changed = true;
      }

      // Update depends_on references: expand old ID to all new IDs
      let updatedContent = filteredLines.join("\n");
      for (const newId of intoIds) {
        const fmResult = rewriteFrontmatter(updatedContent, splitId, newId);
        if (fmResult.changes.length > 0) {
          updatedContent = fmResult.content;
          for (const change of fmResult.changes) {
            change.filePath = relPath;
          }
          allChanges.push(...fmResult.changes);
          changed = true;
        }
      }

      if (changed) {
        filesToWrite.set(absPath, updatedContent);
      }
    } else {
      // For code files: DO NOT rewrite @impl tags, only add warnings
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (implRe.test(lines[i]) && idBoundaryRe.test(lines[i])) {
          warnings.push({
            type: "manual-assignment-needed",
            filePath: relPath,
            oldId: splitId,
            newIds: intoIds,
          });
          break; // One warning per file is sufficient
        }
      }
    }
  }

  // 4. Update lock file
  const lockChanges: LockChange[] = [];
  const lockFilePath = resolve(rootDir, config.lockFile);
  let updatedLock;

  if (existsSync(lockFilePath)) {
    const lock = readLock(rootDir, config.lockFile);
    const lockResult = splitLockKey(lock, splitId, intoIds);
    updatedLock = lockResult.lock;
    lockChanges.push(...lockResult.changes);
  }

  // 5. Apply changes if not dry run
  if (!dryRun) {
    for (const [absPath, content] of filesToWrite) {
      writeFileSync(absPath, content, "utf-8");
    }
    if (updatedLock) {
      writeLock(rootDir, config.lockFile, updatedLock);
    }
  }

  // 6. Return result
  return {
    operation: "split",
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

  // 1. Load config, scan, validate
  const config = loadConfig(rootDir);
  const { graph } = scan(rootDir, config);
  const existingIds = new Set(graph.nodes.keys());

  for (const id of mergeIds) {
    if (!existingIds.has(id)) {
      throw new Error(`ID "${id}" does not exist in the project.`);
    }
  }
  // intoId must NOT exist UNLESS it equals one of mergeIds
  if (existingIds.has(intoId) && !mergeIds.includes(intoId)) {
    throw new Error(
      `ID "${intoId}" already exists in the project and is not one of the merge source IDs.`,
    );
  }

  // 2. Get git tracked files, filter
  const allFiles = getGitTrackedFiles(rootDir);
  const files = filterRelevantFiles(allFiles);

  // 3. Process files
  const allChanges: RewriteChange[] = [];
  const filesToWrite = new Map<string, string>();

  // IDs to rewrite: all mergeIds that are NOT the intoId
  const idsToRewrite = mergeIds.filter((id) => id !== intoId);

  for (const relPath of files) {
    const absPath = resolve(rootDir, relPath);
    if (!existsSync(absPath)) continue;

    let content = readFileSync(absPath, "utf-8");
    let changed = false;
    const ext = extOf(relPath);

    // Rewrite references from each old ID to intoId
    for (const oldId of idsToRewrite) {
      const result = rewriteFile(relPath, content, oldId, intoId);
      if (result.changes.length > 0) {
        content = result.content;
        allChanges.push(...result.changes);
        changed = true;
      }
    }

    // For spec files: remove old ID lines for merged IDs and append scaffold for intoId
    if (ext === ".md") {
      const lines = content.split("\n");
      const filteredLines: string[] = [];
      let removedAny = false;

      for (let i = 0; i < lines.length; i++) {
        let shouldRemove = false;
        for (const oldId of idsToRewrite) {
          const escaped = escapeRegExp(oldId);
          const re = new RegExp(
            `^(\\s*[-*]\\s+)(\\*\\*)?${escaped}(\\*\\*)?(?=[:\\s])`,
          );
          if (re.test(lines[i])) {
            shouldRemove = true;
            allChanges.push({
              filePath: relPath,
              line: i + 1,
              kind: "spec-list-item",
              before: lines[i],
              after: "(removed)",
            });
            break;
          }
        }
        if (shouldRemove) {
          removedAny = true;
        } else {
          filteredLines.push(lines[i]);
        }
      }

      // Append scaffold for intoId unless it is one of the mergeIds
      // (in that case the line already exists)
      if (!mergeIds.includes(intoId)) {
        const scaffoldLine = `- ${intoId}: (TODO: 説明を記述)`;
        filteredLines.push(scaffoldLine);
        allChanges.push({
          filePath: relPath,
          line: filteredLines.length,
          kind: "spec-list-item",
          before: "",
          after: scaffoldLine,
        });
        removedAny = true; // to trigger write
      }

      if (removedAny) {
        content = filteredLines.join("\n");
        changed = true;
      }
    }

    if (changed) {
      filesToWrite.set(absPath, content);
    }
  }

  // 4. Update lock file
  const lockChanges: LockChange[] = [];
  const lockFilePath = resolve(rootDir, config.lockFile);
  let updatedLock;

  if (existsSync(lockFilePath)) {
    const lock = readLock(rootDir, config.lockFile);
    const lockResult = mergeLockKeys(lock, mergeIds, intoId);
    updatedLock = lockResult.lock;
    lockChanges.push(...lockResult.changes);
  }

  // 5. Apply changes if not dry run
  if (!dryRun) {
    for (const [absPath, content] of filesToWrite) {
      writeFileSync(absPath, content, "utf-8");
    }
    if (updatedLock) {
      writeLock(rootDir, config.lockFile, updatedLock);
    }
  }

  // 6. Return result
  return {
    operation: "merge",
    changes: allChanges,
    lockChanges,
    warnings: [],
    applied: !dryRun,
  };
}
