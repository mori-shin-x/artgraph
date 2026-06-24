# Quickstart: Issue #28 (FR-009 / FR-010 / FR-012) 動作検証

**Date**: 2026-06-24
**Audience**: 実装後のレビュアー / QA / 統合テスト担当

実装完了後、本機能が end-to-end で動くことを確認するための最小手順。完全なテストは `packages/artgraph/tests/` 内のユニット・統合テスト（vitest）が担保する。本ドキュメントは **シナリオレベル** の手動検証に絞る。

---

## Prerequisites

- Node.js >= 20
- pnpm install 済み
- 本ブランチ (`feat/issue-28`) をビルド済み: `pnpm --filter artgraph build`

---

## Scenario 1: Spec Kit `plan.md` の `@impl(target)` から `implements` エッジ

### Setup

ワークディレクトリ `/tmp/qs-fr009` を作成:

```bash
mkdir -p /tmp/qs-fr009/specs/001-auth /tmp/qs-fr009/src
cat > /tmp/qs-fr009/.artgraph.json <<'EOF'
{
  "specDirs": ["specs"],
  "include": ["src/**/*.ts"],
  "testPatterns": ["**/*.test.ts"],
  "lockFile": ".trace.lock"
}
EOF
cat > /tmp/qs-fr009/specs/001-auth/plan.md <<'EOF'
# Plan: Auth

- [X] T001 implement login endpoint @impl(auth-login)
- [ ] T002 add session middleware @impl(auth-session)
EOF
```

### Run

```bash
cd /tmp/qs-fr009
pnpm exec artgraph scan --output json > graph.json
```

### Expected

`graph.json` に以下が含まれる:

```jsonc
{
  "nodes": [
    /* ... */
    { "id": "T001", "kind": "task", "filePath": "specs/001-auth/plan.md", /* ... */ },
    { "id": "T002", "kind": "task", "filePath": "specs/001-auth/plan.md", /* ... */ }
  ],
  "edges": [
    /* ... */
    { "source": "T001", "target": "auth-login", "kind": "implements" },
    { "source": "T002", "target": "auth-session", "kind": "implements" }
  ]
}
```

### Pass criteria

- `nodes` に `kind: "task"` の T001 / T002 が存在
- `edges` に T001/T002 → auth-login/auth-session の `implements` エッジが存在
- target (`auth-login` 等) は graph 内に対応 node が無い未解決状態だが、parser はエッジを生成する (FR-009 / 自由形式 ID)

---

## Scenario 2: Spec Kit `tasks.md` の `[REQ-xxx]` から `verifies` エッジ

### Setup

```bash
cat > /tmp/qs-fr009/specs/001-auth/spec.md <<'EOF'
# Spec: Auth

- FR-001: ユーザはメールアドレスとパスワードでログインできる
EOF
cat > /tmp/qs-fr009/specs/001-auth/tasks.md <<'EOF'
# Tasks

- [X] T010 verify login flow [REQ-FR-001]
- [ ] T011 verify session timeout [REQ-FR-002] [REQ-FR-003]
EOF
```

### Run

```bash
pnpm exec artgraph scan --output json > graph.json
```

### Expected

- `nodes` に T010 / T011 の `task` ノード + FR-001 の `req` ノード
- `edges` に:
  - `T010 → REQ-FR-001 → verifies`
  - `T011 → REQ-FR-002 → verifies`
  - `T011 → REQ-FR-003 → verifies`
- `T010 → REQ-FR-001` は target が `req` ノード `FR-001` と prefix 違い → 未解決 (orphan-doc 警告対象になる可能性、FR-010 仕様どおり)

### Pass criteria

- 上記 3 件の `verifies` エッジが存在
- target ID は bracket 内文字列をそのまま (`REQ-FR-001`、prefix 維持)

---

## Scenario 3: Kiro 階層数字 task ID

### Setup

```bash
mkdir -p /tmp/qs-fr009/specs/002-billing
cat > /tmp/qs-fr009/specs/002-billing/tasks.md <<'EOF'
# Tasks

- [X] 1 Set up billing module @impl(billing-init)
  - [X] 1.1 Stripe SDK integration @impl(stripe-client)
  - [ ] 1.2 webhook handler [REQ-BIL-001]
- [ ] 2 Invoice generation [REQ-BIL-002]
EOF
```

### Run

```bash
pnpm exec artgraph scan --output json > graph.json
```

### Expected

- `nodes`: `1`, `1.1`, `1.2`, `2` の 4 task ノード
- `edges`:
  - `1 → billing-init → implements`
  - `1.1 → stripe-client → implements`
  - `1.2 → REQ-BIL-001 → verifies`
  - `2 → REQ-BIL-002 → verifies`
- 名前空間衝突なし (single specDir)

### Pass criteria

- 階層数字 ID (`1`, `1.1`, `1.2`, `2`) がそれぞれ独立した task ノードとして抽出されている

---

## Scenario 4: 同一 task ID が複数 specDir で衝突

### Setup

```bash
mkdir -p /tmp/qs-fr009/specs/003-export
cat > /tmp/qs-fr009/specs/003-export/plan.md <<'EOF'
# Plan: Export

- [X] T001 CSV export @impl(csv-writer)
EOF
```

### Run

```bash
pnpm exec artgraph scan --output json > graph.json
```

### Expected

T001 は **001-auth** と **003-export** の両方に存在するため、衝突解決ロジック (R7 参照) により以下のように修飾される:

- `nodes`: `001-auth/T001`, `003-export/T001`（修飾済）
- `edges`: `001-auth/T001 → auth-login → implements`, `003-export/T001 → csv-writer → implements`

### Pass criteria

- 両方の T001 が修飾 ID で別ノード化されている
- 各エッジの source が修飾 ID になっている

---

## Scenario 5: ユーザ定義 OpenSpec プリセット

### Setup

```bash
cat > /tmp/qs-fr009/.artgraph.json <<'EOF'
{
  "specDirs": ["specs"],
  "include": ["src/**/*.ts"],
  "testPatterns": ["**/*.test.ts"],
  "lockFile": ".trace.lock",
  "taskConventions": [
    {
      "name": "openspec",
      "fileStems": ["tasks"],
      "taskIdRe": "^(?:\\[[xX ]\\][\\s\\u00A0]+)?(OS-\\d+)\\b"
    }
  ]
}
EOF
mkdir -p /tmp/qs-fr009/specs/004-openspec-demo
cat > /tmp/qs-fr009/specs/004-openspec-demo/tasks.md <<'EOF'
# Tasks

- [X] OS-100 OpenSpec-format task @impl(openspec-target)
EOF
```

### Run

```bash
pnpm exec artgraph scan --output json > graph.json
```

### Expected

- `nodes`: `OS-100` の task ノード
- `edges`: `OS-100 → openspec-target → implements`

### Pass criteria

- 追加プリセット 1 件で OpenSpec 形式が認識される（FR-012 拡張性検証）

---

## Scenario 6: `doc → contains → task` エッジ

### Run

Scenario 1 の状態で:

```bash
pnpm exec artgraph scan --output json > graph.json
```

### Expected

`edges` に:
```jsonc
{ "source": "doc:001-auth/plan.md", "target": "T001", "kind": "contains" }
{ "source": "doc:001-auth/plan.md", "target": "T002", "kind": "contains" }
```

### Pass criteria

- `autoContains` デフォルト有効時、plan.md doc ノードから同ファイル内の task ノードへ `contains` エッジが張られる

---

## Cleanup

```bash
rm -rf /tmp/qs-fr009
```

---

## 統合テストカバレッジ補完

上記シナリオに加え、以下は vitest で自動化する（Phase 2 tasks.md の対象）:

- 既存 565 件のテスト全件 PASS（後方互換性）
- 空 `tasks.md` / `plan.md` で task ノード ゼロ
- 不正 `taskConventions` 設定でのエラー UX
- mixed-tools fixture（既存 C-3 テスト）で spec-kit と kiro の preset が並列適用された場合の dedup
- `[REQ-namespace/FR-001]` のような名前空間修飾 ID を target にした verifies エッジ
- `@impl(  white-space-padded  )` の trim 挙動
- `[REQ-]` 空 bracket 不適合（generates no edge, no warn）
