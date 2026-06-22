import { isAbsolute, relative } from "node:path";
import type { ImpactResult } from "./types.js";

/** stdin から読み取った hook JSON の型 */
export interface HookInput {
  tool_name: string;
  tool_input: {
    file_path?: string;
    edits?: Array<{ file_path?: string }>;
    [key: string]: unknown;
  };
}

/** stdout に出力する hook JSON の型 */
export interface HookOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    additionalContext: string;
  };
}

/**
 * stdin の JSON 文字列を HookInput にパースする。
 * パース失敗時、または tool_name が string でない、tool_input が object でない場合は null を返す。
 */
export function parseHookInput(json: string): HookInput | null {
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return null;
    if (Array.isArray(parsed)) return null;
    if (typeof parsed.tool_name !== "string") return null;
    if (typeof parsed.tool_input !== "object" || parsed.tool_input === null) return null;
    if (Array.isArray(parsed.tool_input)) return null;
    return parsed as HookInput;
  } catch {
    return null;
  }
}

/**
 * HookInput の tool_input から file_path を抽出して配列で返す。
 * tool_input や file_path が存在しない場合は空配列を返す。
 */
export function extractFilePaths(input: HookInput): string[] {
  if (!input.tool_input) return [];
  const filePath = input.tool_input.file_path;
  if (typeof filePath === "string" && filePath.length > 0) {
    return [filePath];
  }
  return [];
}

/**
 * 絶対パスをプロジェクトルートからの相対パスに変換する。
 * 相対パスはそのまま返す。
 */
export function toRelativePath(filePath: string, rootDir: string): string {
  if (isAbsolute(filePath)) {
    return relative(rootDir, filePath);
  }
  return filePath;
}

/**
 * ImpactResult を人間向けテキストに変換する。
 * affectedReqs を (req) 形式、affectedDocs を (doc) 形式で列挙。
 * 両方空なら "artgraph impact: (none)" を返す。
 */
export function formatAdditionalContext(result: ImpactResult): string {
  const parts: string[] = [];

  for (const req of result.affectedReqs) {
    parts.push(`${req} (req)`);
  }
  for (const doc of result.affectedDocs) {
    parts.push(`${doc} (doc)`);
  }

  if (parts.length === 0) {
    return "artgraph impact: (none)";
  }

  return `artgraph impact: ${parts.join(", ")}`;
}

/**
 * hookSpecificOutput JSON を構築する。
 */
export function buildHookOutput(additionalContext: string): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext,
    },
  };
}

