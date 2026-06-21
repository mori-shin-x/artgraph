# Feature Specification: PreToolUse Hook（spectrace hook-pretool サブコマンド）

Feature Branch: `007-pretool-hook`

Created: 2026-06-20

Status: Draft

Input: Claude Code の PreToolUse hook で Edit/Write/MultiEdit 前に spectrace impact を実行し、影響範囲をエージェントに助言として注入する

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Edit/Write/MultiEdit 時の影響範囲助言 (Priority: P1)

開発者が spectrace 導入済みのプロジェクトで Claude Code を使い、あるファイルを Edit/Write/MultiEdit しようとしている。
Claude Code の PreToolUse hook が発火し、`spectrace hook-pretool` が stdin から hook JSON を受け取り、
file_path を抽出して spectrace impact を内部的に実行する。
impact 結果が hookSpecificOutput の additionalContext として Claude Code エージェントに注入され、エージェントは
「このファイルは FR-001 に影響する」「doc:api-design が関連している」といった情報を編集前に把握できる。
これにより、仕様に影響する変更を見落とすリスクが低減される。

Why this priority: spectrace の中核価値は「仕様とコードのトレーサビリティ」であり、影響範囲の助言をエージェントのワークフローに自動統合することが、SDD 補完レイヤーとしての最も直接的な価値提供となる。手動で `spectrace impact` を実行する手間が不要になり、開発者の認知負荷を下げる。

Independent Test: spec.md と `@impl` タグ付きのコードファイルがあるプロジェクトで、Claude Code の PreToolUse hook に `spectrace hook-pretool` が設定された状態で対象ファイルを Edit しようとし、hookSpecificOutput の additionalContext に impact 情報が含まれることを確認する。

Acceptance Scenarios:

1. Given spec.md に FR-001 が定義されており、src/auth.ts に `@impl FR-001` がある, When Claude Code エージェントが src/auth.ts を Edit しようとする, Then PreToolUse hook が発火し、hookSpecificOutput の additionalContext に FR-001 への到達ノード情報が含まれる
2. Given doc:api-design が src/handler.ts に紐づいている, When Claude Code エージェントが src/handler.ts を Edit しようとする, Then hookSpecificOutput の additionalContext に doc:api-design の到達ノード情報が含まれる
3. Given spectrace のグラフ上でどの仕様にも紐づかないファイル（例: README.md）がある, When Claude Code エージェントがそのファイルを Edit しようとする, Then hookSpecificOutput の additionalContext は空または「影響なし」を示し、hook は正常終了する（exit 0）
4. Given src/handler.ts と src/auth.ts の両方に仕様が紐づいている, When Claude Code エージェントが MultiEdit でこれらのファイルを同時に編集しようとする, Then hookSpecificOutput の additionalContext に両ファイルの到達ノード情報が統合されて含まれる

---

### User Story 2 - hook の登録と有効化 (Priority: P1)

開発者が spectrace を導入済みのプロジェクトに PreToolUse hook を追加する。
`.claude/settings.json` の hooks 設定に `spectrace hook-pretool` コマンドを登録する。
以降、Claude Code が Edit/Write/MultiEdit ツールを呼ぶたびに hook が自動的に発火する。

Why this priority: US1 の前提条件であり、hook の登録がなければ機能しない。ユーザーが設定手順を理解し、自プロジェクトに導入できることが必要。

Independent Test: `.claude/settings.json` に `spectrace hook-pretool` を PreToolUse hook として登録した状態で Claude Code セッションを開始し、Edit/Write/MultiEdit 時に hook が発火することを確認する。

Acceptance Scenarios:

1. Given `.claude/settings.json` に PreToolUse hook として `spectrace hook-pretool` が登録されている, When Claude Code セッションで Edit ツールが呼ばれる, Then `spectrace hook-pretool` が実行される
2. Given spectrace がインストールされていない, When Claude Code セッションで Edit ツールが呼ばれる, Then hook は失敗するが、Claude Code のワークフロー自体はブロックされない（exit 1 で hook の結果は無視される）
3. Given `.claude/settings.json` に PreToolUse hook が登録されていない, When Claude Code セッションで Edit ツールが呼ばれる, Then hook は発火せず、通常どおり Edit が実行される

---

### User Story 3 - spectrace 未導入プロジェクトでの graceful degradation (Priority: P2)

開発者が hook 設定がされているが `.spectrace.json` が存在しないプロジェクトで作業している。
hook は正常終了（exit 0）し、hookSpecificOutput の additionalContext は空または不在となる。
Claude Code のワークフローに悪影響を与えない。

Why this priority: hook 設定がリポジトリの `.claude/settings.json` に含まれる場合、spectrace 未導入の開発者のマシンでも hook が発火する。その際にエラーや遅延が発生しないことが、チーム導入の障壁を下げるために重要。

Independent Test: `.spectrace.json` が存在しない環境で `spectrace hook-pretool` を実行し、exit 0 で終了すること、stderr にエラーが出力されないことを確認する。

Acceptance Scenarios:

1. Given spectrace はインストールされているが `.spectrace.json` が存在しない, When PreToolUse hook が発火する, Then hook は exit 0 で正常終了し、hookSpecificOutput の additionalContext は空または「設定なし」を示す
2. Given spectrace はインストールされているがグラフ構築に失敗する（例: spec ファイルが壊れている）, When PreToolUse hook が発火する, Then hook は exit 0 で正常終了し、エージェントのワークフローをブロックしない

---

### Edge Cases

- Edit/Write の `tool_input` に `file_path` が含まれない場合（通常はありえないが防御的に処理） → hook は exit 0 で正常終了し、hookSpecificOutput の additionalContext は空
- tool_input.file_path が絶対パスの場合、プロジェクトルートからの相対パスに変換してから spectrace impact に渡す
- シンボリックリンクの解決は行わない（実パスのまま処理）
- 同一セッションで同じファイルに対して複数回 Edit が呼ばれる場合 → 毎回 impact を再計算する（v1 ではキャッシュしない）
- `spectrace impact` の実行に時間がかかる場合（大規模プロジェクト） → v1 ではタイムアウト制御は行わない。レイテンシが問題になる場合は P3 のデーモン化で対応
- hook の実行権限がない場合 → Claude Code が hook 失敗として処理する（spectrace の責務外）
- impact 結果に多数のノードが含まれる場合 → additionalContext の文字列長に制限は設けないが、人間が読める要約形式で出力する
- MultiEdit の tool_input に複数ファイルが含まれる場合（`{"edits": [{"file_path": "...", ...}, ...]}` 形式） → 各ファイルの impact を統合して出力する

## Requirements *(mandatory)*

### Functional Requirements

- FR-001: `spectrace hook-pretool` サブコマンドは、Claude Code の Edit/Write/MultiEdit ツール呼び出し時に stdin から hook JSON（`{"tool_name": "Edit", "tool_input": {"file_path": "...", ...}}`）を受け取り、`tool_input.file_path` を取得して spectrace impact を実行する。MultiEdit も `tool_input.file_path` で取得する（MultiEdit は単一ファイル内の複数箇所編集であり、file_path は 1 つ）
- FR-002: `spectrace hook-pretool` は、spectrace impact の結果を Claude Code の hookSpecificOutput 形式で stdout に出力し、exit 0 で終了する。出力フォーマットは以下の通り:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": "spectrace impact: FR-001 (req), doc:api-design (doc)"
  }
}
```
- FR-003: impact 結果が空（影響なし）の場合、additionalContext は空文字列または省略とし、exit 0 で正常終了する
- FR-004: spectrace コマンドが利用不可、設定ファイルが存在しない、または impact 実行が失敗した場合、hook は exit 0 で正常終了し、エージェントのワークフローをブロックしない
- FR-005: ドキュメントで `.claude/settings.json` への hook 設定方法を案内し、Edit、Write、および MultiEdit ツールに対して hook を発火させる手順を説明する
- FR-006: additionalContext の内容は、影響を受ける到達ノードの ID（例: FR-001）とノード種別（例: req, doc）を含む、人間が読める要約形式とする
- FR-007: tool_input.file_path が絶対パスの場合、プロジェクトルートからの相対パスに変換してから spectrace impact に渡す

### Key Entities

- PreToolUse hook: Claude Code が Edit/Write/MultiEdit ツールを実行する前に発火するフック機構。外部コマンドを実行し、その stdout の hookSpecificOutput を additionalContext としてエージェントに注入する
- additionalContext: PreToolUse hook の hookSpecificOutput から取得されるフィールド。エージェントがツール実行前に参照できる追加コンテキスト情報
- spectrace hook-pretool: spectrace CLI のサブコマンド。Node.js で実装され、stdin から hook JSON を受け取り、file_path 抽出、impact 実行、hookSpecificOutput 生成を全て CLI 内で完結する。jq 等の外部コマンドへの依存はない
- impact 結果: `spectrace impact` コマンドの出力。影響を受ける仕様ノード、ドキュメントノード、およびそれらの到達ノード情報（ID とノード種別）を含む

## Success Criteria *(mandatory)*

### Measurable Outcomes

- SC-001: PreToolUse hook が設定された状態で、仕様に紐づくファイルを Edit/Write/MultiEdit しようとすると、hookSpecificOutput の additionalContext に影響を受ける到達ノードの ID とノード種別が含まれる
- SC-002: 仕様に紐づかないファイルを Edit/Write した場合、hook は exit 0 で正常終了し、エージェントのワークフローに遅延やエラーを生じさせない
- SC-003: spectrace が未導入または利用不可の環境で hook が発火しても、exit 0 で正常終了し、Claude Code のワークフローに影響しない
- SC-004: `.claude/settings.json` に `spectrace hook-pretool` を登録するだけで機能が有効化される

## Assumptions

- Claude Code の PreToolUse hook は、hook コマンドの stdout を JSON としてパースし、`hookSpecificOutput` 内の `additionalContext` フィールドをエージェントに注入する仕組みを提供している
- PreToolUse hook は `tool_name` および `tool_input` を stdin として JSON 形式（`{"tool_name": "...", "tool_input": {...}}`）で hook コマンドに渡す
- exit code のセマンティクス: exit 0 は正常終了（stdout の JSON がエージェントに渡される）、exit 1 は hook 失敗（Claude Code はワークフローを続行し hook の結果は無視する）、exit 2 はブロッキングエラー（Claude Code はアクションをブロックし stderr をフィードバックする）
- v1 では常に exit 0 で返す（情報提供のみ行い、ツール実行のブロックは行わない）
- v1 では permissionDecision は返さない（デフォルトの defer 動作）。情報提供（additionalContext）のみ行い、ツール実行の許可/拒否は行わない。drift 検出時のブロック機能は将来の拡張として検討する
- `spectrace impact` コマンドは既に実装済みであり、`--format json` オプションで JSON 出力が可能である
- Node.js 起動 + ts-morph 初期化のレイテンシは小規模プロジェクトで 1-3 秒程度を想定。5 秒を超える場合は P3 のデーモン化を検討する
- 大規模プロジェクトでレイテンシが問題になった場合は P3 の HTTP デーモン化（`spectrace daemon`）で対応し、本機能のスコープでは対処しない
