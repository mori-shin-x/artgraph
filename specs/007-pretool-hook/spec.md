# Feature Specification: PreToolUse Hook（shell 版）

Feature Branch: `007-pretool-hook`

Created: 2026-06-20

Status: Draft

Input: Claude Code の PreToolUse hook で Edit/Write 前に spectrace impact を実行し、影響範囲をエージェントに助言として注入する

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Edit/Write 時の影響範囲助言 (Priority: P1)

開発者が spectrace 導入済みのプロジェクトで Claude Code を使い、あるファイルを Edit/Write しようとしている。
Claude Code の PreToolUse hook が発火し、`spectrace impact <filePath> --format json` を自動実行する。
impact 結果が `additionalContext` として Claude Code エージェントに注入され、エージェントは
「このファイルは REQ-xxx に影響する」「doc:yyy が drift している」といった情報を編集前に把握できる。
これにより、仕様に影響する変更を見落とすリスクが低減される。

Why this priority: spectrace の中核価値は「仕様とコードのトレーサビリティ」であり、影響範囲の助言をエージェントのワークフローに自動統合することが、SDD 補完レイヤーとしての最も直接的な価値提供となる。手動で `spectrace impact` を実行する手間が不要になり、開発者の認知負荷を下げる。

Independent Test: spec.md と `@impl` タグ付きのコードファイルがあるプロジェクトで、Claude Code の PreToolUse hook が設定された状態で対象ファイルを Edit しようとし、`additionalContext` に impact 情報が含まれることを確認する。

Acceptance Scenarios:

1. Given spec.md に FR-001 が定義されており、src/auth.ts に `@impl FR-001` がある, When Claude Code エージェントが src/auth.ts を Edit しようとする, Then PreToolUse hook が発火し、additionalContext に FR-001 への影響情報が含まれる
2. Given doc:api-design が src/handler.ts に紐づいており drift 状態にある, When Claude Code エージェントが src/handler.ts を Edit しようとする, Then additionalContext に doc:api-design の drift 情報が含まれる
3. Given spectrace のグラフ上でどの仕様にも紐づかないファイル（例: README.md）がある, When Claude Code エージェントがそのファイルを Edit しようとする, Then additionalContext は空または「影響なし」を示し、hook は正常終了する（exit 0）

---

### User Story 2 - hook の登録と有効化 (Priority: P1)

開発者が spectrace を導入済みのプロジェクトに PreToolUse hook を追加する。
`.claude/settings.json` に hook 設定を記述し、`.claude/hooks/pretool-impact.sh` を配置する。
以降、Claude Code が Edit/Write ツールを呼ぶたびに hook が自動的に発火する。

Why this priority: US1 の前提条件であり、hook の登録がなければ機能しない。ユーザーが設定手順を理解し、自プロジェクトに導入できることが必要。

Independent Test: `.claude/settings.json` に hook 設定を追加し、`.claude/hooks/pretool-impact.sh` を配置した状態で Claude Code セッションを開始し、Edit/Write 時に hook が発火することを確認する。

Acceptance Scenarios:

1. Given `.claude/settings.json` に PreToolUse hook が登録されており、`.claude/hooks/pretool-impact.sh` が存在する, When Claude Code セッションで Edit ツールが呼ばれる, Then pretool-impact.sh が実行される
2. Given `.claude/hooks/pretool-impact.sh` が存在しない, When Claude Code セッションで Edit ツールが呼ばれる, Then hook は失敗するが、Claude Code のワークフロー自体はブロックされない（hook 失敗でツール実行を止めない）
3. Given `.claude/settings.json` に PreToolUse hook が登録されていない, When Claude Code セッションで Edit ツールが呼ばれる, Then hook は発火せず、通常どおり Edit が実行される

---

### User Story 3 - spectrace 未導入プロジェクトでの graceful degradation (Priority: P2)

開発者が hook スクリプトだけ配置されているが spectrace がインストールされていないプロジェクト、
または `.spectrace.json` が存在しないプロジェクトで作業している。
hook は正常終了（exit 0）し、additionalContext は空または不在となる。
Claude Code のワークフローに悪影響を与えない。

Why this priority: hook スクリプトがリポジトリに含まれる場合、spectrace 未導入の開発者のマシンでも hook が発火する。その際にエラーや遅延が発生しないことが、チーム導入の障壁を下げるために重要。

Independent Test: spectrace がインストールされていない環境で hook スクリプトを実行し、exit 0 で終了すること、stderr にエラーが出力されないことを確認する。

Acceptance Scenarios:

1. Given spectrace コマンドが PATH に存在しない, When PreToolUse hook が発火する, Then hook は exit 0 で正常終了し、additionalContext は空である
2. Given spectrace はインストールされているが `.spectrace.json` が存在しない, When PreToolUse hook が発火する, Then hook は exit 0 で正常終了し、additionalContext は空または「設定なし」を示す
3. Given spectrace はインストールされているがグラフ構築に失敗する（例: spec ファイルが壊れている）, When PreToolUse hook が発火する, Then hook は exit 0 で正常終了し、エージェントのワークフローをブロックしない

---

### Edge Cases

- Edit/Write の `tool_input` に `file_path` が含まれない場合（通常はありえないが防御的に処理） → hook は exit 0 で正常終了し、additionalContext は空
- `file_path` が相対パスの場合と絶対パスの場合 → hook スクリプトはどちらも処理できる
- 同一セッションで同じファイルに対して複数回 Edit が呼ばれる場合 → 毎回 impact を再計算する（shell 版ではキャッシュしない）
- `spectrace impact` の実行に時間がかかる場合（大規模プロジェクト） → shell 版ではタイムアウト制御は行わない。レイテンシが問題になる場合は P3 のデーモン化で対応
- hook スクリプトの実行権限がない場合 → Claude Code が hook 失敗として処理する（spectrace の責務外）
- impact 結果に多数のノードが含まれる場合 → additionalContext の文字列長に制限は設けないが、人間が読める要約形式で出力する

## Requirements *(mandatory)*

### Functional Requirements

- FR-001: PreToolUse hook スクリプトは、Claude Code の Edit/Write ツール呼び出し時に `tool_input` から `file_path` を取得し、`spectrace impact <filePath> --format json` を実行する
- FR-002: hook スクリプトは、spectrace impact の結果を Claude Code が解釈可能な JSON 形式（`{"additionalContext": "..."}` ）で stdout に出力し、exit 0 で終了する
- FR-003: impact 結果が空（影響なし）の場合、additionalContext は空文字列または省略とし、exit 0 で正常終了する
- FR-004: spectrace コマンドが利用不可、設定ファイルが存在しない、または impact 実行が失敗した場合、hook は exit 0 で正常終了し、エージェントのワークフローをブロックしない
- FR-005: `.claude/settings.json` に PreToolUse hook の設定エントリを登録し、Edit および Write ツールに対して hook を発火させる
- FR-006: additionalContext の内容は、影響を受ける仕様 ID（例: REQ-FR-001）とそのカバレッジ状態（例: impl-only）、および影響を受けるドキュメント ID（例: doc:api-design）とその drift 状態を含む、人間が読める要約形式とする

### Key Entities

- PreToolUse hook: Claude Code が Edit/Write ツールを実行する前に発火するフック機構。外部スクリプトを実行し、その stdout を additionalContext としてエージェントに注入する
- additionalContext: PreToolUse hook の stdout から取得される JSON フィールド。エージェントがツール実行前に参照できる追加コンテキスト情報
- hook スクリプト: `.claude/hooks/pretool-impact.sh` に配置されるシェルスクリプト。`tool_input` を受け取り、spectrace impact を実行して結果を返す
- impact 結果: `spectrace impact` コマンドの出力。影響を受ける仕様ノード、ドキュメントノード、およびそれらの状態（drift, impl-only 等）を含む

## Success Criteria *(mandatory)*

### Measurable Outcomes

- SC-001: PreToolUse hook が設定された状態で、仕様に紐づくファイルを Edit/Write しようとすると、additionalContext に影響を受ける仕様 ID とその状態が含まれる
- SC-002: 仕様に紐づかないファイルを Edit/Write した場合、hook は exit 0 で正常終了し、エージェントのワークフローに遅延やエラーを生じさせない
- SC-003: spectrace が未導入または利用不可の環境で hook が発火しても、exit 0 で正常終了し、Claude Code のワークフローに影響しない
- SC-004: hook スクリプトと settings.json の設定のみで機能が有効化され、spectrace 本体のコード変更は不要である

## Assumptions

- Claude Code の PreToolUse hook は、hook スクリプトの stdout を JSON としてパースし、`additionalContext` フィールドをエージェントに注入する仕組みを提供している
- PreToolUse hook は `tool_name` および `tool_input` を環境変数または stdin として hook スクリプトに渡す
- hook スクリプトが exit 0 以外で終了した場合、Claude Code はツール実行をブロックせず続行する（hook 失敗がワークフローを止めない）
- `spectrace impact` コマンドは既に実装済みであり、`--format json` オプションで JSON 出力が可能である
- shell 版の hook は Node.js 起動 + ts-morph 初期化のコストを毎回支払うが、小〜中規模プロジェクトでは許容範囲のレイテンシ（数秒以内）に収まる
- 大規模プロジェクトでレイテンシが問題になった場合は P3 の HTTP デーモン化（`spectrace daemon`）で対応し、本機能のスコープでは対処しない
