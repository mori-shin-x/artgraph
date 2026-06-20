# Contract: ID パターン認識

## Markdown パーサー入出力

入力: .md ファイルパス

出力: `{ nodes: GraphNode[], edges: GraphEdge[] }`

パース手法: remark AST を使用。`listItem` ノードと `heading` ノードを走査する。

### リスト項目パターン（Pattern A: Spec Kit / BMAD 互換）

AST の `listItem` ノードのテキストに対してマッチ:
```
/^(?:\*\*)?([A-Z][A-Za-z]*-\d+)(?:\*\*)?[:\s]/
```

入力例:
```markdown
- FR-001: ユーザーはメールでログインできる
  - メールとパスワードで認証
  - 成功時にトークンを返す
- **SC-001**: ログイン完了まで2分以内
+ NFR-1: レスポンスタイム 200ms 以内
1. REQ-001: セッション管理
```

出力:
```json
{
  "nodes": [
    {
      "id": "FR-001",
      "kind": "req",
      "filePath": "specs/001-auth/spec.md",
      "label": "FR-001: ユーザーはメールでログインできる",
      "contentHash": "a1b2c3d4e5f6g7h8"
    },
    {
      "id": "SC-001",
      "kind": "req",
      "filePath": "specs/001-auth/spec.md",
      "label": "SC-001: ログイン完了まで2分以内",
      "contentHash": "b2c3d4e5f6g7h8i9"
    }
  ]
}
```

content-hash の範囲: `listItem` ノードの全テキスト（ネストした子項目を含む）。

リストマーカーの種類（`-`, `*`, `+`, `1.`）は remark AST が吸収するため、正規表現で扱わない。

### 見出しパターン（Pattern B: Kiro 互換）

AST の `heading` ノードのテキストに対してマッチ:
```
/^Requirement\s+(\d+)\s*:/
```

ID 正規化: `Requirement 1` → `Requirement-1`（ハイフン区切り）

入力例:
```markdown
### Requirement 1: ユーザー登録

WHEN a user submits valid data THEN the system SHALL create an account
```

出力:
```json
{
  "nodes": [
    {
      "id": "Requirement-1",
      "kind": "req",
      "filePath": "specs/002-registration/spec.md",
      "label": "Requirement 1: ユーザー登録",
      "contentHash": "c3d4e5f6g7h8i9j0"
    }
  ]
}
```

## TypeScript パーサー: @impl タグ

認識パターン:
```
// @impl FR-001
// @impl FR-001 SC-001          ← スペース区切りで複数 ID
// @impl 001-auth/FR-001        ← 名前空間修飾形式
// @impl Requirement-1          ← Kiro 正規化形式
```

ID 抽出パターン:
```
/(?:[\w-]+\/)?(?:[A-Z][A-Za-z]*-\d+|Requirement-\d+)/g
```

出力: `{ source: "file:src/auth/login.ts", target: "FR-001", kind: "implements" }` エッジ

## TypeScript パーサー: テストタグ

認識パターン:
```
describe("[FR-001] login", () => { ... })
test(name, { annotations: { req: "FR-001" } })
describe("[Requirement-1] registration", () => { ... })
```

出力: `{ source: "file:tests/login.test.ts", target: "FR-001", kind: "verifies" }` エッジ

## 名前空間解決（2パスビルド）

パス1 — 収集:
- 全 spec ファイルをパース → `{ id, specDir, node, edges }` リスト
- ID ごとにグループ化、衝突（同一 ID が異なる specDir に存在）を検出

パス2 — 登録:

衝突なし（プロジェクト内で ID が一意）:
- Map キー: `"FR-001"`
- @impl 解決: `"FR-001"` → 一意にマッチ

衝突あり（複数 spec に同一 ID）:
- Map キー: `"001-auth/FR-001"`, `"002-payments/FR-001"`
- @impl `FR-001` → `*/FR-001` でワイルドカード検索 → 複数マッチ → 警告: "FR-001 is ambiguous, found in 001-auth and 002-payments. Use 001-auth/FR-001"
- @impl `001-auth/FR-001` → `"001-auth/FR-001"` に直接マッチ
