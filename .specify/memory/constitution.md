<!--
Sync Impact Report
- Version change: N/A (template) → 1.0.0
- Modified principles: N/A (initial creation from template)
- Added sections: Core Principles (5), Technology Constraints, Development Workflow, Governance
- Removed sections: None
- Templates requiring updates:
  - .specify/templates/plan-template.md ✅ compatible (Constitution Check section aligns)
  - .specify/templates/spec-template.md ✅ compatible (FR/SC structure aligns)
  - .specify/templates/tasks-template.md ✅ compatible (phase structure aligns)
- Follow-up TODOs: None
-->

# spectrace Constitution

## Core Principles

### I. Deterministic Integrity

spectrace は構造的整合性のみを保証する。リンクが解決するか、未承認 drift が無いか、
claim 済み未カバーが無いか、依存元を特定できるか — これらは全て決定的に検証可能。
意味的正しさ（コードが要求を本当に満たすか、ドキュメントの内容が正しいか）は
人または AI の判断に委ね、ツールは関与しない。

- LLM 伝播や確率的判定をコアパスに入れてはならない
- 「正しいか」ではなく「整合しているか」を問う

### II. Declarative Links — Spec Owns ID

仕様が ID を所有し、コードは `@impl REQ-xxxx` で claim する。
ID は不変コア（`REQ-7f3a`）＋ 任意 slug（`auth-login`）。

- 網羅性チェック: 各 REQ-ID に `@impl` が1つ以上あるか
- 妥当性チェック: `@impl` が実在の ID を指すか
- 確信度の二段化: `impl-only`（タグのみ）/ `verified`（タグ＋緑テスト）
- doc 間リンクは frontmatter `depends_on` で宣言、同じ ID スキームに従う

### III. JS/TS Native

TS/JS エコシステムをファーストクラスで扱う。

- コード解析は TS AST（ts-morph / TS language service）を使用
- .md パースは remark
- Node.js で常駐デーモンとして動作（PreToolUse のレイテンシ予算を償却）
- npm 配布で `npx` 実行可能（Rust/Go コアを将来導入しても UX は維持）
- Rust/Go は profiling で律速と判明してからの最適化手段

### IV. CLI-First Interface

全機能を CLI コマンドとして公開し、Claude Code Hook / MCP で統合する。

- テキスト入出力プロトコル: args → stdout（構造化データ）、stderr（人間向けメッセージ）
- `--format json|text` で機械/人間の両方に対応
- Claude Code 統合: PreToolUse（助言）、PostToolUse（増分更新）、Stop（検証ゲート）
- MCP サーバで Plan 時のエージェント呼び出しに対応

### V. Incremental Adoption

既存プロジェクトにタグゼロの状態から段階的に導入できなければならない。

- `@impl` タグ無しでも import グラフだけで file-level impact を提供
- 新しく書く仕様から徐々にタグを付与していける設計
- file-level（高速）と symbol-level（精密）の2モードを共通スキーマで持ち、
  解決不能エッジは file-level にフォールバック
- 粒度は使う側に委ねる — ツールは ID フォーマット強制のみ

## Technology Constraints

- 言語: TypeScript（Node.js ランタイム）
- テスト: Vitest
- パッケージマネージャ: pnpm
- コード解析: ts-morph + TS language service（symbol-level）、将来 tsgo
- Markdown パース: remark (unified)
- テスト結果取り込み: Vitest JSON レポーター / JUnit XML
- drift 検出: content-hash（SHA-256）+ `.trace.lock` ファイル
- 配布: npm パッケージ（プリビルドバイナリ同梱の可能性あり）

## Development Workflow

- TDD を推奨: テストを先に書き、失敗を確認してから実装
- Spec Kit でフィーチャー仕様を管理し、spectrace 自身で整合性を検証（ドッグフーディング）
- フェーズ分割: P1（code↔spec の core）→ P2（doc↔doc 統合）→ P3（高速化・可視化）
- 変更時は `spectrace check --gate --diff` で drift / orphan / 未カバーを検証してからマージ

## Governance

- この Constitution はプロジェクトの設計判断（spectrace-design.md D1-D7）を運用原則として表現したもの
- 原則の追加・変更は spectrace-design.md との整合性を維持した上で行う
- 変更時はセマンティックバージョニングに従い version を更新する
  - MAJOR: 原則の削除・根本的再定義
  - MINOR: 原則の追加・大幅な拡張
  - PATCH: 文言の明確化・誤字修正
- 全 PR は Constitution への準拠を確認する

Version: 1.0.0 | Ratified: 2026-06-20 | Last Amended: 2026-06-20
