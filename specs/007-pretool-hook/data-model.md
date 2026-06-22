# Data Model: PreToolUse Hook (hook-pretool サブコマンド)

## 入力データモデル（stdin JSON）

### HookInput

Claude Code の PreToolUse hook が stdin に渡す JSON。

```ts
interface HookInput {
  tool_name: string;    // "Edit" | "Write" | "MultiEdit" 等
  tool_input: ToolInput;
}
```

### ToolInput バリアント

Edit の tool_input:
```ts
interface EditToolInput {
  file_path: string;    // "src/auth.ts" または "/home/user/project/src/auth.ts"
  old_string: string;
  new_string: string;
}
```

Write の tool_input:
```ts
interface WriteToolInput {
  file_path: string;    // "src/new-file.ts"
  content: string;
}
```

MultiEdit の tool_input:
```ts
interface MultiEditToolInput {
  file_path: string;    // "src/auth.ts"（単一ファイル内の複数箇所編集）
  edits: Array<{
    old_string: string;
    new_string: string;
  }>;
}
```

全バリアントで `tool_input.file_path` が存在する。
MultiEdit は単一ファイルに対する複数箇所の編集であり、ファイルパスは 1 つ。

## 出力データモデル（hookSpecificOutput JSON）

### HookOutput

stdout に出力する JSON。

```ts
interface HookOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    additionalContext: string;
  };
}
```

additionalContext のフォーマット:

影響あり:
```
artgraph impact: FR-001 (req), SC-001 (req), doc:api-design (doc)
```

影響なし:
```
artgraph impact: (none)
```

設定なし（.artgraph.json 不在）:
- additionalContext は空文字列 `""`

## 内部で利用する既存の型

### ImpactResult（src/types.ts）

`impact()` 関数の戻り値。additionalContext の生成に使用する。

```ts
interface ImpactResult {
  affectedFiles: string[];   // hook-pretool では使用しない（冗長なため）
  affectedDocs: string[];    // "doc:api-design" 等 → additionalContext に含める
  affectedReqs: string[];    // "FR-001" 等 → additionalContext に含める
  drifted: DriftEntry[];     // v1 では additionalContext に含めない
}
```

### ArtifactGraph（src/types.ts）

`scan()` で構築されるグラフ。`impact()` の入力。

```ts
interface ArtifactGraph {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
}
```

### GraphNode（src/types.ts）

```ts
interface GraphNode {
  id: string;          // "FR-001", "doc:api-design", "file:src/auth.ts"
  kind: NodeKind;      // "req" | "doc" | "file" | "symbol" | "test"
  filePath: string;
  label?: string;
  contentHash: string;
}
```

## 新規エンティティ

### 型定義（src/hook-pretool.ts 内部）

```ts
/** stdin から読み取った hook JSON の型 */
interface HookInput {
  tool_name: string;
  tool_input: {
    file_path?: string;
    edits?: Array<{ file_path?: string }>;
    [key: string]: unknown;
  };
}

/** stdout に出力する hook JSON の型 */
interface HookOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    additionalContext: string;
  };
}
```

## データフロー

```text
stdin (JSON) ──→ HookInput
                    │
                    ├─ tool_input.file_path を抽出
                    │   └─ 絶対パスの場合、相対パスに変換
                    │
                    ├─ loadConfig(rootDir)
                    │   └─ .artgraph.json が無ければ空出力で exit 0
                    │
                    ├─ scan(rootDir, config) → ArtifactGraph
                    │
                    ├─ resolveStartIds(graph, [filePath]) → startIds
                    │   └─ startIds が空なら影響なしで exit 0
                    │
                    ├─ readLock(rootDir, config.lockFile) → lock
                    │
                    ├─ impact(graph, startIds, lock) → ImpactResult
                    │
                    └─ additionalContext を生成
                        ├─ affectedReqs → "FR-001 (req), SC-001 (req)"
                        ├─ affectedDocs → "doc:api-design (doc)"
                        └─ 結合して hookSpecificOutput を stdout に出力
```

## 変更の影響範囲

影響あり:
- `src/cli.ts`: `hook-pretool` サブコマンドの commander 定義を追加
- `src/hook-pretool.ts`: 新規ファイル。hook-pretool のメインロジック

影響なし（既存コードの変更不要）:
- `src/graph/traverse.ts`: impact / resolveStartIds は既存 API をそのまま呼び出す
- `src/scan.ts`: scan は既存 API をそのまま呼び出す
- `src/config.ts`: loadConfig は既存 API をそのまま呼び出す
- `src/lock.ts`: readLock は既存 API をそのまま呼び出す
- `src/types.ts`: ImpactResult, ArtifactGraph 等は既存の型をそのまま使用
- `src/parsers/`: パーサーの変更は不要
