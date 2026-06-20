# Quickstart: Spec Kit spec.md パース対応の検証

## Prerequisites

- Node.js 20+
- pnpm
- spectrace がビルド可能な状態（`pnpm build` が通る）

## Setup

```bash
pnpm install
pnpm build
```

## 検証シナリオ 1: Spec Kit リスト項目の認識

テストフィクスチャ `tests/fixtures/specs/speckit-style.md` を使用:

```bash
# scan を実行し、リスト項目の FR-001 等が認識されることを確認
node dist/cli.js scan --format json

# 期待: reqCount >= 3（FR-001, FR-002, SC-001 等）
```

確認ポイント:
- `FR-001`, `FR-002`, `SC-001` が req ノードとして検出される
- 各ノードに contentHash が付与されている
- `- **FR-001**: ...`（太字）形式も認識される

## 検証シナリオ 2: Kiro 見出しの認識

テストフィクスチャ `tests/fixtures/specs/kiro-style.md` を使用:

```bash
node dist/cli.js scan --format json
```

確認ポイント:
- `Requirement 1`, `Requirement 2` が req ノードとして検出される
- 見出し配下のセクションコンテンツが contentHash に含まれている

## 検証シナリオ 3: @impl タグの紐づき

フィクスチャのソースファイルに `// @impl FR-001` を記述:

```bash
node dist/cli.js check --format json
```

確認ポイント:
- FR-001 のカバレッジ状態が `impl-only` または `verified`
- orphan（存在しない ID への @impl）が正しく検出される

## 検証シナリオ 4: 後方互換

既存フィクスチャ `tests/fixtures/specs/auth.md`（旧 REQ-xxxx 形式）:

```bash
pnpm test tests/markdown.test.ts
```

確認ポイント:
- 旧形式の REQ-7f3a 等が引き続き認識される
- 既存テストが全てパスする

## テスト実行

```bash
# 全テスト実行
pnpm test

# パーサーテストのみ
pnpm test tests/markdown.test.ts tests/typescript.test.ts

# カバレッジ付き
pnpm test -- --coverage
```
