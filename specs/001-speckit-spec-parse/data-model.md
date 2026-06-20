# Data Model: Spec Kit spec.md パース対応

## 変更対象のエンティティ

### GraphNode（既存、変更）

現状:
```ts
interface GraphNode {
  id: string;
  kind: NodeKind;
  filePath: string;
  slug?: string;
  label?: string;
  contentHash: string;
}
```

変更:
```ts
interface GraphNode {
  id: string;           // "FR-001" or "001-auth/FR-001"（衝突時の修飾形式）
  kind: NodeKind;
  filePath: string;     // "specs/001-auth/spec.md"
  label?: string;       // リスト項目 or 見出しのテキスト全体
  contentHash: string;
}
```

- `slug` フィールド削除: SDD ツール ID を直接使用するため不要

### LockEntry（既存、変更）

現状:
```ts
interface LockEntry {
  slug?: string;
  contentHash: string;
  impl?: string[];
  tests?: string[];
  dependsOn?: string[];
  lastReconciled: string;
}
```

変更:
```ts
interface LockEntry {
  specFile?: string;     // 新規: "specs/001-auth/spec.md"（名前空間解決の参照用）
  contentHash: string;
  impl?: string[];
  tests?: string[];
  dependsOn?: string[];
  lastReconciled: string;
}
```

- `slug` フィールド削除

### CoverageEntry / CheckResult（既存、変更）

```ts
// coverage.ts
interface CoverageEntry {
  reqId: string;
  // slug?: string;  ← 削除
  status: CoverageStatus;
  implFiles: string[];
  testFiles: string[];
}

// types.ts の CheckResult 内
coverage: { reqId: string; status: CoverageStatus }[];
// slug フィールド削除
```

### SpectraceConfig（既存、拡張）

現状:
```ts
interface SpectraceConfig {
  include: string[];
  specDirs: string[];
  testPatterns: string[];
  lockFile: string;
}
```

変更:
```ts
interface SpectraceConfig {
  include: string[];
  specDirs: string[];
  testPatterns: string[];
  lockFile: string;
  reqPatterns?: ReqPatternConfig;  // 新規
}

interface ReqPatternConfig {
  listItem?: string;    // デフォルト: PREFIX-NNN パターン
  heading?: string;     // デフォルト: Requirement N パターン
}
```

## 新規エンティティ

### ParsedReq（パーサー内部）

```ts
interface ParsedReq {
  id: string;           // "FR-001" or "Requirement-1"（正規化済み）
  label: string;        // リスト項目 or 見出しのテキスト全体
  contentHash: string;  // リスト項目/セクションの AST コンテンツのハッシュ
  source: "list" | "heading";
}
```

### CollectedReq（builder 内部、2パスビルド用）

```ts
interface CollectedReq {
  id: string;           // パーサーが返した raw ID
  specDir: string;      // spec ディレクトリ名（例: "001-auth"）
  node: GraphNode;
  edges: GraphEdge[];
}
```

## 変更の影響範囲

影響あり:
- `src/parsers/markdown.ts`: リスト項目の AST 走査追加、ID パターン変更、Requirement N 正規化
- `src/parsers/typescript.ts`: IMPL_RE, REQ_ID_RE, TEST_REQ_RE, TEST_ANNOTATION_RE の更新
- `src/types.ts`: GraphNode から slug 削除、LockEntry に specFile 追加・slug 削除、CheckResult から slug 削除
- `src/config.ts`: reqPatterns の読み込み
- `src/graph/builder.ts`: 2パスビルド（収集→衝突検出→登録）、@impl の ID 解決
- `src/coverage.ts`: CoverageEntry から slug 削除
- `src/check.ts`: coverage 出力から slug 削除
- `src/lock.ts`: slug 書き出し削除、specFile 書き出し追加
- `src/cli.ts`: printCheckText の slug 表示削除

影響なし（ID 形式非依存のロジック）:
- `src/graph/traverse.ts`: impact / findOrphans / findUncovered は ID 文字列を透過的に扱う
- `src/scan.ts`: buildGraph を呼ぶだけ
- `src/diff.ts`: git diff のファイルパス取得のみ
