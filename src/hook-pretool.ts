import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ImpactResult } from "./types.js";
import { loadConfig, CONFIG_FILE } from "./config.js";
import { scan } from "./scan.js";
import { impact, resolveStartIds } from "./graph/traverse.js";
import { readLock } from "./lock.js";

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
 * 両方空なら "spectrace impact: (none)" を返す。
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
    return "spectrace impact: (none)";
  }

  return `spectrace impact: ${parts.join(", ")}`;
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

/**
 * hook-pretool のメインロジック。
 * stdin パース → file_path 抽出 → config ロード → scan → impact → 出力生成の全フローを担う。
 */
export function runHookPretool(
  stdin: string,
  rootDir: string,
): HookOutput {
  const startTime = process.hrtime.bigint();

  // JSON パース
  const input = parseHookInput(stdin);
  if (!input) {
    process.stderr.write("spectrace: failed to parse hook input\n");
    return buildHookOutput("");
  }

  // file_path 抽出
  const filePaths = extractFilePaths(input);
  if (filePaths.length === 0) {
    return buildHookOutput("");
  }

  // 相対パスに変換
  const relativePaths = filePaths.map((fp) => toRelativePath(fp, rootDir));

  // .spectrace.json 不在時は空で返す（graceful degradation）
  // loadConfig は不在時にデフォルト設定を返すが、contracts では
  // .spectrace.json 不在時は additionalContext を空と規定している。
  // CONFIG_FILE 定数を config.ts から import して使用。
  if (!existsSync(resolve(rootDir, CONFIG_FILE))) {
    return buildHookOutput("");
  }

  // 設定読み込み
  const config = loadConfig(rootDir);

  // グラフ構築
  let graph;
  try {
    const scanResult = scan(rootDir, config);
    graph = scanResult.graph;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`spectrace: scan failed: ${msg}\n`);
    return buildHookOutput("");
  }

  // 開始ノード解決
  const startIds = resolveStartIds(graph, relativePaths);
  if (startIds.length === 0) {
    const output = buildHookOutput("spectrace impact: (none)");
    const elapsed = Number(process.hrtime.bigint() - startTime) / 1_000_000;
    process.stderr.write(`spectrace: hook-pretool completed in ${Math.round(elapsed)}ms\n`);
    return output;
  }

  // impact 計算（個別 try-catch で contracts 規定のエラーメッセージを出力）
  let result: ImpactResult;
  try {
    const lock = readLock(rootDir, config.lockFile);
    result = impact(graph, startIds, lock);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`spectrace: impact failed: ${msg}\n`);
    return buildHookOutput("");
  }

  // 出力生成
  const additionalContext = formatAdditionalContext(result);
  const output = buildHookOutput(additionalContext);

  const elapsed = Number(process.hrtime.bigint() - startTime) / 1_000_000;
  process.stderr.write(`spectrace: hook-pretool completed in ${Math.round(elapsed)}ms\n`);

  return output;
}
