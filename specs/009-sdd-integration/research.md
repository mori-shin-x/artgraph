# Phase 0: Research — SDD ツールワークフロー統合

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Date**: 2026-06-23

Phase 0 は plan の Technical Context・FR・Clarifications を読んで未確定だった事項を解決し、設計判断の根拠を残す。各 item は **Decision** / **Rationale** / **Alternatives considered** の 3 部構成。

---

## R0. CLI 名前統一: `artgraph` vs `spectrace`

**Decision**: 実装・テスト・slash command 名前空間はすべて **`artgraph`** に統一する。`spectrace` は次の 2 箇所にのみ残す：(a) Spec Kit Extension のディレクトリ名 `.specify/extensions/spectrace/`、(b) Kiro Steering file 名 `.kiro/steering/spectrace.md`。

**Rationale**:
- 本リポジトリの実バイナリは `artgraph`（`packages/artgraph/package.json#bin`）であり、constitution §技術基盤と制約 も `artgraph` を正としている。spec 本文の `spectrace` は GitHub Issue #16 由来のコードネームで、コードベースでは未採用。
- 一方、`spectrace` を完全に消すと spec 文言（FR-001 / FR-008）との一致を取れず、対応関係が見えにくくなる。Extension/Steering の「成果物識別子」としてのみ残せば、内部の slash command 命名や CLI コマンドはすべて `artgraph` で揃えられる。
- 結果として、Spec Kit Hook の slash command は `artgraph.scan-reconcile` / `artgraph.check-diff` / `artgraph.check-gate` となり、内部で `artgraph scan && artgraph reconcile` を呼ぶ自然な構造になる。

**Alternatives considered**:
- すべて `spectrace` に統一: 既存 CLI 全体のリネームが必要で本機能のスコープを大きく超える。
- すべて `artgraph` に統一（Extension ディレクトリ名も含む）: spec 文言との対応が見えにくくなり、レビュー摩擦が増える。

---

## R1. Spec Kit Extension の確定スキーマ（schema_version "1.0"）

**Decision**: 本機能リリース時点での Spec Kit Extension スキーマを以下の固定形に凍結し、`src/integrate/schemas/speckit-1.0.ts` にコード内定数として持つ。実行時に `agent-context/extension.yml` 等を参照して追従しない（Clarification Q3 で確定）。

`extension.yml` 必須トップレベルキー：
```yaml
schema_version: "1.0"
extension:
  id: string             # 例: "spectrace"
  name: string
  version: string        # SemVer
  description: string
  author: string
  repository: string     # URL
  license: string
requires:
  speckit_version: string  # range, 例: ">=0.11.0"
provides:
  commands:
    - name: string         # 例: "artgraph.scan-reconcile"
      file: string         # 例: "commands/artgraph.scan-reconcile.md"
      description: string
hooks:                     # トリガー名 → 単一 entry または entry 配列
  after_tasks:
    command: string
    optional: boolean
    description: string
  after_implement:
    command: string
    optional: boolean
    description: string
  before_implement:        # --gate モード時のみ生成
    command: string
    optional: boolean
    description: string
tags:
  - string
```

`.specify/extensions.yml` 側の hook entry（Spec Kit が `installed` リスト + `hooks.<event>` 配列で正規化）：
```yaml
installed:
- agent-context
- spectrace            # 本機能で追記
settings:
  auto_execute_hooks: true
hooks:
  after_tasks:
  - extension: spectrace
    command: artgraph.scan-reconcile
    enabled: true
    optional: false
    priority: 50
    prompt: "Run artgraph scan && reconcile to refresh trace baseline?"
    description: "Refresh artgraph baseline after tasks"
    condition: null
  after_implement:
  - extension: spectrace
    command: artgraph.check-diff
    enabled: true
    optional: false
    priority: 50
    prompt: "Run artgraph check --diff to verify coverage/orphan/drift?"
    description: "Verify artgraph traceability after implementation"
    condition: null
  before_implement:        # --gate モード時のみ
  - extension: spectrace
    command: artgraph.check-gate
    enabled: true
    optional: false
    priority: 50
    prompt: "Gate: run artgraph check --gate before implementing?"
    description: "Gate implementation on artgraph traceability"
    condition: null
```

**Rationale**:
- `.specify/extensions/agent-context/extension.yml` および `.specify/extensions.yml` の実物を観察した結果、上記が現行 Spec Kit 0.11.5 で受け入れられる形式と判明。
- `priority: 50` は agent-context の `10` より大きく、artgraph hooks が後段で発火するようにしている（既存 Extension の prep を待ってから検証する自然な順序）。
- hook entry の `optional: false` は本機能では意図的な選択：trace baseline / 検証は SDD ワークフローの正規ステップであり、ユーザー確認なしで自動実行するのが期待値（spec FR-002）。`--gate` モードでも同じ。ユーザーが煩雑と感じた場合は extensions.yml の `enabled: false` で個別無効化できる。
- 命名 `artgraph.scan-reconcile` 等は dot-separated convention で、Spec Kit が slash command 化する際に `artgraph-scan-reconcile` となる（dot→hyphen ルール、`/speckit-clarify` で確認済み）。

**Alternatives considered**:
- すべて `optional: true` にしてユーザー確認を入れる: SDD ワークフローのリズムを乱し、SC-001（追加手動コマンド ゼロ）に反する。
- `priority: 10` で agent-context と同じ: 順序が不定になる。10 と 50 で明確に分ける。

---

## R2. Spec Kit Extension `commands/*.md` の確定フォーマット

**Decision**: `commands/*.md` は YAML frontmatter + Markdown 本文で構成。本文は `# Title` / `## Behavior` / `## Execution` の 3 セクション固定。本機能で生成する 3 ファイル（scan-reconcile / check-diff / check-gate）はそれぞれ対応する artgraph サブコマンドを呼ぶ。

```markdown
---
description: "Refresh artgraph baseline after tasks"
---

# artgraph: scan && reconcile

## Behavior
This hook rebuilds the artifact graph and updates the lock file to establish a fresh baseline after `/speckit-tasks` completes.

## Execution
- **Bash**: `artgraph scan && artgraph reconcile`
```

**Rationale**:
- `.specify/extensions/agent-context/commands/speckit.agent-context.update.md` の実物を観察し、frontmatter `description` のみが必須で他は Markdown 本文として扱われると判明。
- 本機能で生成する 3 commands は Bash 一発の単純な実行なので、`Execution` セクションに Bash one-liner を 1 行書くだけで十分。

**Alternatives considered**:
- スクリプトファイル（`scripts/bash/*.sh`）を生成して `Execution` から呼ぶ: agent-context は scripts/ を使うが、本機能は単一コマンドの実行で十分。スクリプト経由は YAGNI。

---

## R3. YAML ライブラリ選定

**Decision**: [`yaml`](https://www.npmjs.com/package/yaml) v4.x を `packages/artgraph/package.json` の `dependencies` に追加する。

**Rationale**:
- `.specify/extensions.yml` の編集は既存ファイルへの追記（installed リスト末尾追加、hooks 配列追加・削除）が中心で、コメント保持と既存キー順序の維持が必須。
- `yaml` (eemeli/yaml) は AST 操作 API（`Document` クラス、`addIn`/`deleteIn` 等）を持ち、コメント・空行を保持しながら部分編集できる。
- `js-yaml` は load → modify → dump で comments と一部の formatting が失われる。本機能の冪等性要件（FR-004）と相性が悪い。
- 単一依存追加で他に副作用がない（外部 fetch なし、約 200KB minified）。

**Alternatives considered**:
- `js-yaml`: コメント喪失。本機能の reviewability を損ねる。
- 自前パーサ: 工数過大、エッジケース未網羅のリスク。

---

## R4. Kiro Steering file の慣習フォーマット

**Decision**: Kiro Steering file（`.kiro/steering/spectrace.md`）は frontmatter なしの純 Markdown を採用し、以下の構造で生成する：

```markdown
# artgraph (spectrace) integration for Kiro

This steering file tells the Kiro agent how to use artgraph to keep code, specs, and tests in sync.

## When to run artgraph

- **Before implementation** — run `artgraph impact <path>` to see which requirements/docs are affected.
- **After implementation** — run `artgraph check --diff` to verify coverage / orphan / drift.
- **On drift detection** — run `artgraph reconcile` to refresh the lock baseline (only after human review of the drift).

## Commands

| Command | Use |
|---|---|
| `artgraph impact <file>` | List affected REQs/docs/files for a given path |
| `artgraph check --diff` | Validate the current git diff against the trace graph |
| `artgraph reconcile` | Update `.trace.lock` to current graph (use with care) |
| `artgraph coverage` | Inspect per-requirement coverage status |
```

**Rationale**:
- Kiro の `.kiro/steering/` は Markdown ファイルを自動読み込みする仕様で、追加メタデータは不要。実物の Kiro リポジトリのサンプル（公開ドキュメント上）でも frontmatter なしの素 Markdown が標準。
- FR-008 の 3 つの運用指示（impact / check / reconcile）を「When to run」見出しで明示し、表で参照しやすくする。
- frontmatter を入れない選択は Kiro 側の仕様変更耐性を最大化する（仕様外フィールドで弾かれない）。

**Alternatives considered**:
- `inclusion: always` の frontmatter を入れる: Kiro の公開仕様で安定しているかが確認できず、本機能のリリース時点では避ける。将来必要なら拡張時に追加。
- YAML frontmatter で commands を構造化: Steering は「エージェント向けの自然言語」が前提。構造化メタデータは Spec Kit 側の責務。

---

## R5. Atomic 書き込み戦略

**Decision**: 自前の `atomicWriteFile(path, content)` ユーティリティを `src/integrate/atomic-write.ts` に置く。実装は以下：

```
1. 同じディレクトリに `<basename>.<crypto-random>.tmp` を作成
2. tmp に content を書き込み + fsync
3. tmp → target に `fs.renameSync`
4. エラー時は tmp を `fs.unlinkSync` で除去（既存 target は不変）
```

**Rationale**:
- Spec Kit `extensions.yml` のような共有設定ファイルは、書き込み途中の crash で空・破損状態が残ると Spec Kit 自体が起動不能になる。POSIX `rename(2)` は同 FS 内では atomic で、これを使えば「全成功 or 全失敗」が保証できる。
- `node:fs.writeFileSync` 単体だと中断時に target が部分書き込みのまま残る。
- 既存 npm の atomic-write 系ライブラリ（`write-file-atomic` 等）は依存を増やすが、本機能ではこの util だけ自前 30 行程度で完結するため、依存追加せず自前化する。
- multi-file 書き込み（Extension ディレクトリ生成）は「失敗時に作成済みファイルを巻き戻す」逆操作リストを provider 側で持つことで、edge case「途中失敗時の巻き戻し」を満たす。

**Alternatives considered**:
- `write-file-atomic` ライブラリ: 機能はぴったりだが依存を増やす理由が薄い。yaml ライブラリと違って自前実装が容易。
- 単純な `writeFileSync`: atomicity を満たさず FR-007 に反する。

---

## まとめ

Phase 0 で 6 件すべてを Decision として確定。Phase 1（data-model + contracts + quickstart）は本 research の結論を前提に進められる。新規依存は `yaml` 1 件のみ。Constitution Check 後評価は plan.md 末尾の表に記載済み。
