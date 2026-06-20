# Data Model: ドキュメント間グラフ構造

## 変更対象のエンティティ

### EdgeKind（既存、変更）

現状（`src/types.ts` L3）:
```ts
export type EdgeKind = "depends_on" | "derives_from" | "implements" | "verifies" | "imports";
```

変更:
```ts
export type EdgeKind = "depends_on" | "derives_from" | "implements" | "verifies" | "imports" | "contains";
```

- `contains` 追加: doc ノードとその中で定義された req ノードの間の所属関係を表す

### SpectraceConfig（既存、拡張）

現状（`src/types.ts` L64-77）:
```ts
export interface SpectraceConfig {
  include: string[];
  specDirs: string[];
  testPatterns: string[];
  lockFile: string;
  reqPatterns?: ReqPatternConfig;
}
```

変更:
```ts
export interface SpectraceConfig {
  include: string[];
  specDirs: string[];
  testPatterns: string[];
  lockFile: string;
  reqPatterns?: ReqPatternConfig;
  docGraph?: DocGraphConfig;  // 新規
}

export interface DocGraphConfig {
  autoNodes?: boolean;      // デフォルト: true。false で doc ノードの自動生成を無効化
  autoContains?: boolean;   // デフォルト: true。false で contains エッジの自動生成を無効化
}
```

- `docGraph.autoNodes`: FR-008 に基づく設定。false にすると frontmatter に `node_id` がない md ファイルからは doc ノードが生成されない
- `docGraph.autoContains`: FR-008 に基づく設定。false にすると doc→req の contains エッジが生成されない

### ImpactResult（既存、拡張）

現状（`src/types.ts` L38-42）:
```ts
export interface ImpactResult {
  affectedFiles: string[];
  affectedDocs: string[];
  affectedReqs: string[];
  drifted: DriftEntry[];
}
```

変更:
```ts
export interface ImpactResult {
  affectedFiles: string[];
  affectedDocs: string[];
  affectedReqs: string[];
  drifted: DriftEntry[];
  summary?: ImpactSummary;  // 新規: FR-009 の到達内訳
}

export interface ImpactSummary {
  docs: number;
  reqs: number;
  files: number;
}
```

- `summary`: impact 結果の到達ノード数の内訳。`affectedDocs.length`, `affectedReqs.length`, `affectedFiles.length` をまとめた便利フィールド

### BuildWarning（既存、拡張）

現状（`src/graph/builder.ts` L7-10）:
```ts
export interface BuildWarning {
  type: "duplicate-id" | "ambiguous-id";
  id: string;
  files: string[];
}
```

変更:
```ts
export interface BuildWarning {
  type: "duplicate-id" | "ambiguous-id" | "orphan-doc" | "invalid-relation" | "reserved-prefix";
  id: string;
  files: string[];
  message?: string;
}
```

- `orphan-doc`: 依存先ドキュメントが存在しない（FR-005）
- `invalid-relation`: frontmatter の relation キーが不正（FR-002）
- `reserved-prefix`: req ID が予約プレフィクスを使用（FR-007）
- `message`: 各警告に固有の説明テキスト

### ParsedSpec（既存、拡張）

現状（`src/parsers/markdown.ts` L14-17）:
```ts
interface ParsedSpec {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
```

変更:
```ts
interface ParsedSpec {
  nodes: GraphNode[];
  edges: GraphEdge[];
  warnings: ParseWarning[];  // 新規
}

interface ParseWarning {
  type: "invalid-relation" | "reserved-prefix";
  key: string;
  filePath: string;
}
```

- パーサレベルの警告を返し、builder で BuildWarning に変換する

## 新規エンティティ

### DocGraphConfig（設定、新規）

```ts
export interface DocGraphConfig {
  autoNodes?: boolean;      // デフォルト: true
  autoContains?: boolean;   // デフォルト: true
}
```

バリデーション:
- `autoNodes` が false の場合、`autoContains` も暗黙的に false として扱う（doc ノードが無ければ contains エッジも張れない）

関連: `src/config.ts` L7-26 の `loadConfig` で `raw.docGraph` を読み込む

### ImpactSummary（impact 結果の内訳、新規）

```ts
export interface ImpactSummary {
  docs: number;
  reqs: number;
  files: number;
}
```

関連: `src/graph/traverse.ts` L4-59 の `impact` 関数の戻り値に含める

## frontmatter スキーマ（入力データ）

### 現行スキーマ

`src/parsers/markdown.ts` L40-42 の型定義:
```ts
const spectraceMeta = frontmatter?.spectrace as
  | { node_id?: string; depends_on?: Array<{ id: string; relation: string }> }
  | undefined;
```

### 新スキーマ

```ts
interface SpectraceFrontmatter {
  node_id?: string;           // doc ノードのカスタム ID
  derives_from?: string[];    // 派生元ドキュメントの ID リスト
  depends_on?: string[];      // 依存先ドキュメントの ID リスト
}
```

入力例:
```yaml
---
spectrace:
  node_id: "design-doc"
  derives_from:
    - doc:requirements.md
  depends_on:
    - doc:shared-types.md
---
```

バリデーション:
- `spectrace` ブロック内の `node_id` / `derives_from` / `depends_on` 以外のキーは `invalid-relation` 警告
- `derives_from` / `depends_on` の値は文字列の配列。文字列でない場合はパースエラーとしてスキップ

## 変更の影響範囲

影響あり:
- `src/types.ts`: EdgeKind に `contains` 追加、SpectraceConfig に `docGraph` 追加、ImpactResult に `summary` 追加
- `src/parsers/markdown.ts`: doc ノード常時生成、frontmatter フラット化対応、ParseWarning 返却
- `src/graph/builder.ts`: contains エッジ自動生成、エッジデデュープ、新 BuildWarning タイプ
- `src/graph/traverse.ts`: impact に depth 制限、resolveStartIds に doc: プレフィクス対応
- `src/config.ts`: docGraph 設定の読み込み
- `src/cli.ts`: graph コマンド追加、impact に --depth/内訳、警告表示の拡張
- `src/graph/format.ts`: 新規（graph フォーマッタ）

影響なし（ロジックが EdgeKind / doc ノードに依存しない、または既に対応済み）:
- `src/scan.ts`: buildGraph を呼ぶだけ。doc カウントは既に実装済み（L28-30）
- `src/lock.ts`: doc ノードの lock 書き出しは既に実装済み（L29 の `node.kind !== "req" && node.kind !== "doc"` チェック）。contains エッジは lock に含めない（spec Assumption）
- `src/check.ts`: orphan-doc は BuildWarning として builder から報告。check の pass フラグには影響しない
- `src/coverage.ts`: req ノードのみ対象（L13）。doc ノードは対象外
- `src/diff.ts`: git diff のファイルパス取得のみ
