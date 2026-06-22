# P2 ロードマップ — doc 統合・Skills・ID ライフサイクル・Spec Kit・テスト取り込み・PreToolUse

> P2 は機能ごとにブランチを分けて並行開発する。
> 各ブランチは main から分岐し、独立してマージ可能な単位にする。

---

## 全体像

| #   | 機能                                 | ブランチ名             | 依存 | 規模感 |
| --- | ------------------------------------ | ---------------------- | ---- | ------ |
| 1   | doc↔doc 統合 impact UX               | `p2/doc-impact-ux`     | なし | S      |
| 2   | Claude Code Skills 配布              | `p2/skills`            | なし | S      |
| 3   | rename / split / merge               | `p2/id-lifecycle`      | なし | M      |
| 4   | Spec Kit 残対応 (FR-007/008 + 層2/3) | `p2/speckit-remaining` | なし | S      |
| 5   | テスト結果取り込み                   | `p2/test-results`      | なし | S      |
| 6   | PreToolUse Hook (shell 版)           | `p2/pretool-hook`      | なし | S      |

全て独立して進められる。依存関係なし。

---

## 1. doc↔doc 統合 impact UX

設計 doc D7: depth/エッジ型で決定的に影響度を振る。

### 現状

- doc ノードと `depends_on` / `derives_from` エッジは既にパース・グラフ化済み
- `impact` の BFS トラバースも doc エッジを辿る
- 足りないのは出力の UX: 全ノードがフラットに並ぶだけで、直接依存/推移的依存の区別がない

### やること

- `ImpactResult` に影響度（depth / relation）を付与
  - depth=1 (直接依存) → 要レビュー
  - depth>=2 (推移的) → 参考
  - エッジ型（derives_from vs depends_on vs implements）を表示
- text 出力で depth をインデントやラベルで表現
- json 出力で各ノードに `depth` と `via` (経由エッジ型) フィールドを追加

### 変更対象

| ファイル                 | 変更内容                               |
| ------------------------ | -------------------------------------- |
| `src/types.ts`           | `ImpactResult` に depth/via 情報を追加 |
| `src/graph/traverse.ts`  | BFS で depth を記録                    |
| `src/cli.ts`             | text 出力フォーマットに depth 表示     |
| `tests/traverse.test.ts` | depth 付き impact テスト               |

---

## 2. Claude Code Skills 配布

CLI は既に完成しているので、MCP サーバは不要。
spectrace の CLI を適切なタイミングで呼び出す Skills を配布し、
エージェントのワークフローに組み込む。

### MCP ではなく Skills を選ぶ理由

- ワークフローの知識を埋め込める: 「Plan 前に impact を実行し結果をコンテキストに含めよ」のような指示は Skills でしか表現できない。MCP はツールを公開するだけで使い方は LLM 任せ
- 依存ゼロ: .md ファイルを配置するだけ。`@modelcontextprotocol/sdk` 等の依存が不要
- Hook との自然な共存: Stop hook (`check --gate`) と Skills が同じ CLI を叩く統一的な設計

### 配布する Skills

#### `spectrace-plan` — Plan 前のインパクト分析

- トリガー: ユーザーが Plan 策定を依頼した時
- 動作: `spectrace impact --diff --format json` を実行し、影響範囲をコンテキストに注入
- 狙い: エージェントが Plan を立てる際に「何に波及するか」を事前に把握

#### `spectrace-verify` — 実装後の整合性確認

- トリガー: ユーザーが実装完了を報告した時、またはコードレビュー前
- 動作: `spectrace check --diff --format text` を実行し、drift/orphan/uncovered を表示
- 狙い: Stop hook のゲートに引っかかる前にセルフチェック

#### `spectrace-coverage` — カバレッジ状況の確認

- トリガー: ユーザーが進捗確認を依頼した時
- 動作: `spectrace scan --format json` を実行し、req ごとの coverage 状態を表示
- 狙い: untagged / impl-only / verified の一覧で残作業を把握

### 変更対象

| ファイル                                      | 変更内容                    |
| --------------------------------------------- | --------------------------- |
| `.claude/skills/spectrace-plan.md` (新規)     | Plan 前インパクト分析 Skill |
| `.claude/skills/spectrace-verify.md` (新規)   | 整合性確認 Skill            |
| `.claude/skills/spectrace-coverage.md` (新規) | カバレッジ Skill            |
| `docs/skills-guide.md` (新規)                 | Skills の使い方ガイド       |

### スコープ外

- MCP サーバ: IDE 統合 (VS Code / Cursor 等) や他エージェントフレームワーク対応が必要になった時に検討
- HTTP デーモン: レイテンシが問題になった場合のみ（後述 #6 参照）

---

## 3. rename / split / merge

設計 doc D2, 7 節: ID ライフサイクル管理。

### やること

3 つのサブコマンドを `spectrace rename` 配下に実装する。

#### `spectrace rename --from REQ-xxxx --to REQ-yyyy`

- グラフ内の全参照を書き換える:
  - .md 仕様の見出し (`#### REQ-xxxx ...` → `#### REQ-yyyy ...`)
  - コードの `@impl REQ-xxxx` → `@impl REQ-yyyy`
  - テストの `[REQ-xxxx]` → `[REQ-yyyy]`
  - frontmatter の `depends_on` 内の参照
- `.trace.lock` のキーを更新
- doc ID (`doc:xxx`) にも同じ操作を適用

#### `spectrace rename --split REQ-xxxx --into REQ-aaaa REQ-bbbb`

- 元の REQ を削除し、新しい 2 つの REQ を仕様ファイルに追記（見出し雛形）
- `@impl REQ-xxxx` を持つコードファイルに警告を出力（手動で振り分け必要）
- lock から元 ID を削除、新 ID のエントリを空で追加

#### `spectrace rename --merge REQ-aaaa REQ-bbbb --into REQ-cccc`

- 2 つの REQ を 1 つに統合
- 全参照を新 ID に書き換え
- lock を統合（impl / tests を合算）

### 変更対象

| ファイル                      | 変更内容                               |
| ----------------------------- | -------------------------------------- |
| `src/cli.ts`                  | `rename` サブコマンド + サブオプション |
| `src/rename.ts` (新規)        | ファイル書き換え + lock 更新ロジック   |
| `tests/rename.test.ts` (新規) | fixture ファイルで書き換え確認         |

### 実装上の注意

- ファイル書き換えは正規表現ベースで行う（AST 書き戻しはオーバーキル）
- 書き換え前に dry-run モード (`--dry-run`) で変更箇所を表示
- git で追跡中のファイルのみ対象（untracked は無視）

---

## 4. Spec Kit 残対応 (FR-007/008 + 層 2/3)

PR #6 (`001-speckit-spec-parse`) で主要な実装は完了済み。残りは deferred された 2 件と、
`docs/spec-kit-integration.md` の層 2/3。

### 実装済み (PR #6)

- US1: リスト項目 `PREFIX-NNN` パターン認識 (FR-001) — `LIST_ITEM_RE`
- US2: 見出し `Requirement N` パターン認識 (FR-002) — `KIRO_HEADING_RE` + `Requirement-N` 正規化
- US3: 2 パスビルドによる名前空間衝突の自動解決 (FR-004) — `specDir/ID` 修飾
- FR-003: content-hash による drift 検出
- FR-005: `@impl` タグの新 ID パターン対応
- FR-006: テストタグの新 ID パターン対応
- `ReqPatternConfig` 型定義（types.ts に存在するが未使用）

### 残タスク

#### 4a. FR-007: 設定可能な ID パターン (deferred → Phase 6)

- `.spectrace.json` の `reqPatterns` で認識対象のパターンを拡張・制限する
- `ReqPatternConfig` 型は定義済み (`types.ts`) だが、パーサに未接続
- `listItem` / `heading` フィールドにカスタム正規表現を指定可能にする
- デフォルトは現行の `LIST_ITEM_RE` / `KIRO_HEADING_RE` を維持

#### 4b. FR-008: Spec Kit frontmatter メタデータ (deferred → 将来)

- `title`, `status`, `priority`, `owner` を読み取り doc ノードの属性として保持
- `status: "implemented"` 等は coverage 判定のヒントにはしない（D5）
- GraphNode に `metadata?: Record<string, string>` を追加する案

#### 4c. 層 2: plan.md / tasks.md とコードの紐付き

- plan.md のタスクが `@impl` タグでコードに紐づく
- tasks.md の項目がテストの `[REQ-xxxx]` で検証される
- Spec Kit 側のフォーマットが安定してから着手（現時点では後回し推奨）

#### 4d. 層 3: `.spectrace.json` の Spec Kit パス規約認識

- `specs/` は既にデフォルトの `specDirs` に含まれているため、実質的に動作する
- `specs/NNN-feature/spec.md` の構造認識を明示的にする場合のみ追加対応が必要
- 現状でも `specDirs: ["specs"]` で十分機能するため、優先度は低い

### 変更対象

| ファイル                  | 変更内容                                                     |
| ------------------------- | ------------------------------------------------------------ |
| `src/types.ts`            | `GraphNode` に `metadata` 追加 (FR-008 時)                   |
| `src/parsers/markdown.ts` | `reqPatterns` の接続 (FR-007)、frontmatter 読み取り (FR-008) |
| `src/config.ts`           | `reqPatterns` のデフォルト値設定                             |
| `tests/markdown.test.ts`  | カスタムパターンのテスト                                     |

### 判断ポイント

- FR-007 / FR-008 は需要ドリブンで着手すればよい（現状のデフォルトパターンで主要 SDD ツールをカバー済み）
- 層 2/3 は Spec Kit 自体の仕様安定を待つ方が手戻りが少ない
- 他の P2 タスク（Skill / rename 等）を先に進める方が実用面で価値が高い

---

## 5. テスト結果取り込み

設計 doc 9 節: Vitest JSON / JUnit XML を読み、REQ-ID で join → verified 判定。

### 現状

coverage.ts の `verified` 判定は「`verifies` エッジが存在するか」だけで判定している。
テストが実際に通ったかどうかは見ていない。

### やること

- Vitest の JSON レポーター出力 (`vitest run --reporter=json`) をパース
- JUnit XML (`vitest run --reporter=junit`) もパース（CI 互換）
- テスト名 / describe 名から `[REQ-xxxx]` を抽出し、pass/fail 状態を取得
- coverage の判定に組み込む:
  - `verified` → `verifies` エッジあり AND 対応テストが全て pass
  - `impl-only` → `verifies` エッジあり だが テスト fail / テスト結果なし
  - `untagged` → 変更なし

### 変更対象

| ファイル                            | 変更内容                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `src/types.ts`                      | `SpectraceConfig` に `testResultPaths` 追加、`CoverageStatus` に状態追加検討 |
| `src/test-results.ts` (新規)        | Vitest JSON / JUnit XML パーサ                                               |
| `src/coverage.ts`                   | テスト結果を参照した verified 判定                                           |
| `src/cli.ts`                        | `check` / `scan` でテスト結果パスを受け取るオプション                        |
| `tests/test-results.test.ts` (新規) | パーサのユニットテスト                                                       |
| `tests/fixtures/`                   | サンプル JSON / XML レポート                                                 |

### 実装メモ

- Vitest JSON: `{ testResults: [{ name, status, assertionResults: [...] }] }` 形式
- JUnit XML: `<testsuites><testsuite><testcase name="..." status="passed"/></testsuite></testsuites>`
- XML パースは軽量ライブラリ (`fast-xml-parser` など) か正規表現で十分
- テスト結果ファイルはオプショナル — 存在しなければ従来の振る舞い（エッジ有無のみ）

---

## 6. PreToolUse Hook (shell 版)

設計 doc 8 節: PreToolUse で Edit/Write 前に影響範囲を助言。
まず shell コマンド版で実装し、レイテンシが問題になってからデーモン化を検討する。

### 仕組み

Claude Code の PreToolUse hook は Edit/Write ツールが実行される前に発火する。
spectrace の impact 結果を `additionalContext` として注入し、
エージェントに「このファイルは REQ-xxx / doc:yyy に影響する」と伝える。

### やること

- PreToolUse hook スクリプト: `spectrace impact <filePath> --format json` を実行
- 出力: exit 0 + stdout に Claude Code が解釈する JSON 形式
  ```json
  {
    "additionalContext": "Impact: REQ-FR-001 (impl-only), doc:api-design (drifted)"
  }
  ```
- `.claude/settings.json` に PreToolUse hook を登録

### 変更対象

| ファイル                                 | 変更内容                   |
| ---------------------------------------- | -------------------------- |
| `.claude/hooks/pretool-impact.sh` (新規) | PreToolUse hook スクリプト |
| `.claude/settings.json`                  | PreToolUse hook 登録       |

### 実装メモ

- `tool_input` から `file_path` を取得し、`spectrace impact` に渡す
- グラフ構築のレイテンシ（Node.js 起動 + ts-morph 初期化）は小規模プロジェクトなら許容範囲
- 大規模プロジェクトでレイテンシが問題になった場合は HTTP デーモン化を検討（P3）

### スコープ外 (P3 以降)

- HTTP デーモン (`spectrace daemon`): グラフをメモリ保持して ~50ms で応答
- fs.watch による増分再構築
- PID ファイルによるプロセス管理

---

## 推奨作業順序

依存関係なし。実用価値と規模で優先順を決める:

```
先行: #2 Skills 配布 + #6 PreToolUse Hook (Claude Code 統合の要、S)
次:   #1 doc impact UX + #5 テスト結果取り込み (early win、S)
後:   #3 rename/split/merge (独立、M)
保留: #4 Spec Kit 残対応 (需要ドリブン、後回し可)
```

- #2 + #6 は Claude Code との統合を完成させる核心。Skills と Hook で spectrace がワークフローに組み込まれる
- #1 と #5 は小さく、impact / coverage の出力品質を上げる
- #3 は独立して進められるが規模がある
- #4 は PR #6 で主要部分が完了済み。残りは需要が出てから

## 完了基準（P2 全体）

- Skills (`spectrace-plan`, `spectrace-verify`, `spectrace-coverage`) が Claude Code から呼べる
- `spectrace impact` で depth/relation 付きの影響が表示される
- `spectrace rename --from/--to` で全ファイルの ID が一括書き換えされる
- (完了済み) Spec Kit の spec.md が `spectrace scan` で REQ ノードとして認識される
- Vitest JSON を食わせて `verified` / `impl-only` が正しく判定される
- PreToolUse hook で Edit 前に影響範囲が助言として表示される
