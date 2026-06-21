# Feature Specification: Claude Code Skills 配布

Feature Branch: `003-skills`

Created: 2026-06-20

Status: Draft

Input: spectrace の CLI を適切なタイミングで呼び出す Claude Code Skills を配布し、エージェントのワークフローに spectrace を組み込む

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Plan 前のインパクト分析 (Priority: P1)

開発者が新機能の Plan 策定をエージェントに依頼する。
エージェントは spectrace-plan スキルにより `spectrace impact` を自動実行し、
変更対象の仕様に波及する既存の仕様・実装・テストの影響範囲をコンテキストに注入する。
エージェントはこの情報を踏まえて、既存仕様との矛盾や影響漏れを考慮した Plan を立てる。

Why this priority: Plan の質はエージェントが持つコンテキストに直結する。影響範囲を事前に把握せずに Plan を立てると、既存仕様への矛盾や実装の破壊が発生する。spectrace の中核価値である「仕様と実装の整合性」をエージェントワークフローに最初に組み込むべきポイント。

Independent Test: 仕様と実装が紐づいたプロジェクトで Plan 策定を依頼し、spectrace-plan スキルが発火して影響範囲がコンテキストに含まれることを確認する。

Acceptance Scenarios:

1. Given spectrace が導入済みのプロジェクトで仕様と実装が紐づいている, When ユーザーが Plan 策定を依頼する, Then spectrace-plan スキルが発火し `spectrace impact --diff --format json` の結果がエージェントのコンテキストに注入される
2. Given impact の結果に影響を受ける仕様が存在する, When エージェントが Plan を立てる, Then Plan 内に影響を受ける仕様への言及が含まれる
3. Given spectrace がインストールされていない環境, When ユーザーが Plan 策定を依頼する, Then スキルはエラーを適切にハンドリングし、spectrace のセットアップを案内する

---

### User Story 2 - 実装後の整合性セルフチェック (Priority: P1)

開発者が実装を完了し、コードレビュー前にエージェントへ確認を依頼する。
エージェントは spectrace-verify スキルにより `spectrace check` を自動実行し、
drift（仕様変更の未反映）、orphan（実装タグの宙ぶらりん）、uncovered（未実装の仕様）を検出する。
Stop hook のゲートに引っかかる前にセルフチェックできる。

Why this priority: Stop hook（`spectrace check --gate`）はコミット時にブロックするが、そこで初めて問題に気づくと手戻りが大きい。実装完了時点でセルフチェックできれば、手戻りコストを削減できる。Plan スキルと並び、ワークフローの両端（計画と検証）を押さえる。

Independent Test: 意図的に drift/orphan/uncovered を含むプロジェクトで実装完了を報告し、spectrace-verify スキルが問題を検出・表示することを確認する。

Acceptance Scenarios:

1. Given drift が存在する（仕様が変更されたが実装が未更新）, When ユーザーが実装完了を報告する, Then spectrace-verify スキルが発火し、drift の詳細がエージェントに表示される
2. Given orphan が存在する（`@impl` タグが存在するが対応する仕様がない）, When ユーザーが実装完了を報告する, Then orphan の一覧がエージェントに表示される
3. Given 全ての仕様が正しく実装されている（問題なし）, When ユーザーが実装完了を報告する, Then 「全ての仕様が整合しています」という旨のメッセージが表示される
4. Given spectrace がインストールされていない環境, When ユーザーが実装完了を報告する, Then スキルはエラーを適切にハンドリングし、spectrace のセットアップを案内する

---

### User Story 3 - カバレッジ状況の確認 (Priority: P2)

開発者がフィーチャーの進捗確認をエージェントに依頼する。
エージェントは spectrace-coverage スキルにより `spectrace scan` を自動実行し、
各仕様の coverage 状態（untagged / impl-only / verified）を一覧表示する。
残作業の把握と優先順位付けに活用する。

Why this priority: Plan と Verify が P1 として動作した後に、進捗の可視化として価値が出る。カバレッジ確認は任意のタイミングで行えるため、ワークフローの必須ステップではないが、残作業の把握に有用。

Independent Test: 仕様が複数ある状態で進捗確認を依頼し、各仕様の coverage 状態が一覧表示されることを確認する。

Acceptance Scenarios:

1. Given 仕様が複数あり、一部のみ実装されている, When ユーザーが進捗確認を依頼する, Then spectrace-coverage スキルが発火し、各仕様の coverage 状態（untagged / impl-only / verified）が一覧表示される
2. Given 全仕様が verified 状態, When ユーザーが進捗確認を依頼する, Then 全仕様が verified であることが明示される
3. Given spectrace がインストールされていない環境, When ユーザーが進捗確認を依頼する, Then スキルはエラーを適切にハンドリングし、spectrace のセットアップを案内する

---

### Edge Cases

- spectrace がインストールされていない、またはパスが通っていない場合 → 各スキルはコマンド実行前に存在確認を行い、未インストール時はセットアップ手順を案内する
- `spectrace impact --diff` の実行対象となる差分が存在しない場合（初回コミット等）→ 「差分なし」として正常終了し、Plan 策定を続行する
- spectrace の設定ファイル（`.spectrace.json`）が存在しない場合 → `spectrace init` の実行を案内する
- スキルのトリガー判定が誤発火する場合（例: Plan という言葉がコンテキストに出現するが Plan 策定ではない）→ スキルの description で発火条件を厳密に定義し、誤発火を最小化する
- `spectrace check` の出力が非常に大きい場合（大規模プロジェクト）→ サマリーを先に表示し、詳細は必要に応じて展開する構成にする
- 複数のスキルが同時にトリガーされる場合（例: Plan 策定時に Verify も発火）→ 各スキルは独立して動作し、競合しない設計にする

## Requirements *(mandatory)*

### Functional Requirements

- FR-001: spectrace-plan スキルは、ユーザーが Plan 策定を依頼した際に `spectrace impact --diff --format json` を実行し、影響範囲をエージェントのコンテキストに注入する
- FR-002: spectrace-verify スキルは、ユーザーが実装完了を報告した際またはコードレビュー前に `spectrace check --diff --format text` を実行し、drift/orphan/uncovered をエージェントに表示する
- FR-003: spectrace-coverage スキルは、ユーザーが進捗確認を依頼した際に `spectrace scan --format json` を実行し、仕様ごとの coverage 状態を一覧表示する
- FR-004: 各スキルは spectrace コマンドの存在を事前に確認し、未インストール時はセットアップ手順を案内する
- FR-005: 各スキルは `.claude/skills/` ディレクトリに `.md` ファイルとして配置され、外部依存なしで動作する
- FR-006: 各スキルの description にトリガー条件を明記し、適切なタイミングでのみ発火するようにする
- FR-007: `docs/skills-guide.md` にスキルの概要、セットアップ手順、各スキルの詳細を記述し、ユーザーが導入・カスタマイズできるようにする
- FR-008: 各スキルは spectrace CLI の Stop hook（`spectrace check --gate`）と同じ CLI を使用し、ツールチェーンを統一する

### Key Entities

- Claude Code Skill: `.claude/skills/` に配置される Markdown ファイル。description でトリガー条件を定義し、エージェントのワークフローに組み込まれる
- spectrace-plan スキル: Plan 策定前に影響分析を実行するスキル。`spectrace impact` コマンドを呼び出す
- spectrace-verify スキル: 実装後に整合性チェックを実行するスキル。`spectrace check` コマンドを呼び出す
- spectrace-coverage スキル: 進捗確認時にカバレッジ状況を表示するスキル。`spectrace scan` コマンドを呼び出す
- Stop Hook: Git の pre-commit/pre-push で `spectrace check --gate` を実行するフック。スキルと同じ CLI を共有する

## Success Criteria *(mandatory)*

### Measurable Outcomes

- SC-001: spectrace-plan スキルが Plan 策定依頼時に発火し、`spectrace impact` の結果がエージェントコンテキストに含まれる
- SC-002: spectrace-verify スキルが実装完了報告時に発火し、drift/orphan/uncovered が検出・表示される
- SC-003: spectrace-coverage スキルが進捗確認依頼時に発火し、全仕様の coverage 状態が一覧表示される
- SC-004: 全スキルが `.md` ファイルのみで構成され、`@modelcontextprotocol/sdk` 等の外部依存がゼロである
- SC-005: spectrace 未インストール環境でスキルが発火した場合、エラーではなくセットアップ案内が表示される
- SC-006: `docs/skills-guide.md` を読んだユーザーが、追加の説明なしにスキルを導入・利用開始できる

## Assumptions

- spectrace CLI が npm パッケージとしてインストール済み、または npx 経由で実行可能である
- Claude Code が `.claude/skills/` ディレクトリ内の `.md` ファイルをスキルとして認識する（Claude Code の標準機能）
- スキルの発火判定は Claude Code のエージェントが description を参照して行う。発火条件の精度はエージェントの判断に依存する
- Stop hook（pre-commit / pre-push）は別途設定済み、またはユーザーが独立して設定する。スキルと hook は補完関係であり、両方の導入は必須ではない
- `spectrace impact --diff`, `spectrace check --diff`, `spectrace scan` の各コマンドは既に実装済みで、JSON/text 出力に対応している
