---
name: "spectrace-rename"
description: "仕様 ID のリネーム・分割・統合の依頼時にトリガー。spectrace rename を使い、spec / @impl / テストタグ / frontmatter / lock を一括で安全に書き換える。破壊的操作のため必ず --dry-run で確認してから適用する。"
user-invocable: true
disable-model-invocation: false
---

## 目的

仕様 ID のライフサイクル（rename / split / merge）を `spectrace rename` で一括処理する。
5 種類の参照（spec のリスト項目・見出し、`@impl` タグ、テストの `[ID]` / `req:` タグ、
frontmatter の `depends_on` / `derives_from`、`.trace.lock` のキー）を横断的に書き換える。

## 重要な前提

- **破壊的操作**: git 追跡ファイルを直接書き換える。必ず作業ツリーをコミット済みにしてから実行する。
- **必ず `--dry-run` で確認**してから本適用する。
- ターゲット ID は再スキャン可能な形式（`REQ-001` / `auth/FR-2` / `doc:xxx`）のみ受理される。
  `REQ-COMBINED` や `REQ-001a` のような形式は拒否される。

## 実行手順

### 1. spectrace の存在確認

```bash
command -v spectrace || npx spectrace --version
```

### 2. dry-run で影響範囲を確認

```bash
# リネーム
spectrace rename --from REQ-001 --to REQ-100 --dry-run
# 分割（1 → 複数）
spectrace rename --split REQ-001 --into REQ-101 REQ-102 --dry-run
# 統合（複数 → 1）
spectrace rename --merge REQ-001 REQ-002 --into REQ-100 --dry-run
```

変更予定のファイル・行・lock キー変更が表示される。意図と一致するか確認する。

### 3. 本適用

`--dry-run` を外して実行する。適用後、lock は自動的に再 reconcile され、
書き換えたノードの contentHash・参照・specFile が最新化される。

### 4. 後処理

- **split**: 新しい ID には `@impl` が自動付与されない（手動割り当てが必要）。
  CLI が警告した対象ファイルで `@impl` を新 ID に割り当て、scaffold 行（`(TODO: ...)`）を記述する。
- 統合元の見出し直下にあった子箇条書きは残るため、必要に応じて整理する。
- 最後に必ず整合性を確認する:

```bash
spectrace check
```

rename / merge は後続の `check` がそのままパスする。split は新 ID が `uncovered`
として残るため、`@impl` 割り当て後に再度 `check` する。

## 出力形式

`--format json` を付けると結果が JSON で出力される（失敗時も `{ "error": "..." }` の JSON）。
スクリプトから扱う場合に利用する。
