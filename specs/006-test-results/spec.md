# Feature Specification: テスト結果取り込み

Feature Branch: `006-test-results`

Created: 2026-06-20

Status: Draft

Input: Vitest JSON / JUnit XML のテスト結果を取り込み、テストの pass/fail 状態に基づいて coverage の verified 判定を強化する

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Vitest JSON レポートによる verified 判定の強化 (Priority: P1)

開発者が `vitest run --reporter=json` で出力された JSON レポートを持っている。
`artgraph check --test-results vitest-report.json` を実行すると、テスト名や describe ブロック名に含まれる `[REQ-xxxx]` タグが抽出され、対応する REQ ノードのテスト pass/fail 状態が判定に反映される。
`verifies` エッジが存在し、かつ対応テストが全て pass している場合にのみ `verified` となり、テストが fail していたり結果が見つからない場合は `impl-only` に降格される。

Why this priority: テスト結果の取り込みは本機能の中核であり、Vitest JSON は最も情報量が多く構造化されたフォーマット。ローカル開発で `vitest run --reporter=json` を実行するのは一般的なワークフローであり、最初にサポートすべき形式。

Independent Test: `[REQ-001]` タグを含むテストが pass/fail する Vitest JSON レポートを用意し、`artgraph check --test-results` で `verified` / `impl-only` が正しく判定されることを確認する。

Acceptance Scenarios:

1. Given Vitest JSON レポートに `[REQ-001]` を含むテストが pass で記録されており、グラフ上に REQ-001 への `verifies` エッジがある, When `artgraph check --test-results vitest-report.json` を実行する, Then REQ-001 のカバレッジ状態が `verified` と報告される
2. Given Vitest JSON レポートに `[REQ-001]` を含むテストが fail で記録されており、グラフ上に REQ-001 への `verifies` エッジがある, When `artgraph check --test-results vitest-report.json` を実行する, Then REQ-001 のカバレッジ状態が `impl-only` と報告される
3. Given `verifies` エッジが存在するが Vitest JSON レポートに対応するテスト結果が存在しない, When `artgraph check --test-results vitest-report.json` を実行する, Then REQ-001 のカバレッジ状態が `impl-only` と報告される
4. Given テスト名の describe ブロックに `[REQ-001]` があり、その describe 内の個別テストケースに REQ タグがない, When `artgraph check --test-results vitest-report.json` を実行する, Then describe ブロックの REQ タグが内部のテストケースに継承され、全テスト pass なら `verified` となる

---

### User Story 2 - JUnit XML レポートによる CI 連携 (Priority: P1)

CI 環境では JUnit XML 形式のテストレポートが広く使われている（GitHub Actions, Jenkins, CircleCI 等）。
開発者が `vitest run --reporter=junit` で出力された JUnit XML、または他のテストランナーが出力した JUnit XML を持っている場合、`artgraph check --test-results junit-report.xml` を実行すると、Vitest JSON と同じロジックでテスト結果が取り込まれる。

Why this priority: JUnit XML は CI パイプラインの事実上の標準フォーマット。CI 上で `artgraph check --gate` を実行する際、テスト結果の取り込みが JUnit XML 経由でできないと実用にならない。Vitest JSON と同等の優先度。

Independent Test: `[REQ-001]` タグを含む JUnit XML レポートを用意し、`artgraph check --test-results` で正しく判定されることを確認する。

Acceptance Scenarios:

1. Given JUnit XML レポートに `[REQ-001]` を含むテストケースが pass で記録されており、グラフ上に `verifies` エッジがある, When `artgraph check --test-results junit-report.xml` を実行する, Then REQ-001 のカバレッジ状態が `verified` と報告される
2. Given JUnit XML レポートに `[REQ-001]` を含むテストケースが failure で記録されている, When `artgraph check --test-results junit-report.xml` を実行する, Then REQ-001 のカバレッジ状態が `impl-only` と報告される
3. Given JUnit XML の testsuite name に `[REQ-002]` があり、内部の testcase に個別の REQ タグがない, When `artgraph check --test-results junit-report.xml` を実行する, Then testsuite の REQ タグが内部の testcase に継承される

---

### User Story 3 - テスト結果なしでの後方互換動作 (Priority: P1)

既存ユーザーが `--test-results` オプションを指定せずに `artgraph check` を実行した場合、従来と全く同じ動作をする。`verifies` エッジの有無だけで `verified` を判定し、テスト pass/fail は考慮しない。

Why this priority: 後方互換性の保証は段階的導入（Incremental Adoption）の原則に基づき、既存ワークフローを壊さないために必須。

Independent Test: テスト結果オプションなしで `artgraph check` を実行し、現在の挙動と同一の結果が得られることを確認する。

Acceptance Scenarios:

1. Given `verifies` エッジが存在する REQ がある, When `artgraph check` を `--test-results` なしで実行する, Then REQ のカバレッジ状態は従来通り `verified` と報告される（テスト pass/fail は考慮されない）
2. Given `.artgraph.json` に `testResultPaths` が設定されていない, When `artgraph check` を実行する, Then テスト結果の取り込みは行われず、従来の判定ロジックで動作する

---

### User Story 4 - coverage コマンドでのテスト結果反映 (Priority: P1)

`artgraph coverage` コマンドは REQ ごとの verified/impl-only/untagged 状態を一覧表示する。`--test-results` オプションが指定された場合、テスト pass/fail を反映した coverage 状態を表示する。`artgraph check` と同じ判定ロジックを使用し、一貫した結果を返す。

Why this priority: `artgraph coverage` は coverage 状態の確認に特化したコマンドであり、テスト結果を反映しないと `artgraph check` と結果が食い違う。ユーザーの混乱を防ぐために `check` と同時にサポートすべき。

Independent Test: テスト結果ファイルを指定して `artgraph coverage --test-results` を実行し、`artgraph check --test-results` と同じ判定結果が得られることを確認する。

Acceptance Scenarios:

1. Given Vitest JSON レポートに `[REQ-001]` を含むテストが pass で記録されており、グラフ上に `verifies` エッジがある, When `artgraph coverage --test-results vitest-report.json` を実行する, Then REQ-001 の coverage 状態が `verified` と表示される
2. Given Vitest JSON レポートに `[REQ-001]` を含むテストが fail で記録されている, When `artgraph coverage --test-results vitest-report.json` を実行する, Then REQ-001 の coverage 状態が `impl-only` と表示される
3. Given `--test-results` オプションなしで `artgraph coverage` を実行する, When 既存の `verifies` エッジがある REQ がある, Then 従来通り `verifies` エッジの有無のみで判定される（後方互換）

---

### User Story 5 - 設定ファイルによるテスト結果パスの指定 (Priority: P2)

開発者が `.artgraph.json` に `testResultPaths` を設定することで、毎回 `--test-results` オプションを指定しなくても、テスト結果が自動的に取り込まれるようにする。glob パターンも利用可能。この設定は `artgraph check`、`artgraph coverage`、`artgraph scan` の全コマンドに適用される。

Why this priority: CLI オプションでの基本動作（US1, US2, US4）が確立された後の利便性向上。設定ファイルによる指定は日常的なワークフローで繰り返しオプションを書く手間を省く。

Independent Test: `.artgraph.json` に `testResultPaths` を設定し、`artgraph check` をオプションなしで実行して、テスト結果が取り込まれることを確認する。

Acceptance Scenarios:

1. Given `.artgraph.json` に `"testResultPaths": ["test-results/*.json"]` が設定されている, When `artgraph check` をオプションなしで実行する, Then 指定パスのテスト結果ファイルが自動的に読み込まれ、判定に反映される
2. Given `.artgraph.json` に `testResultPaths` が設定されており、かつ `--test-results` オプションも指定されている, When `artgraph check` を実行する, Then CLI オプションの指定が設定ファイルを上書きする
3. Given `testResultPaths` で指定されたパスにファイルが存在しない, When `artgraph check` を実行する, Then テスト結果なしとして従来の判定で動作する（エラーにはならない）

---

### User Story 6 - 複数テスト結果ファイルの統合 (Priority: P2)

開発者がモノレポや分割テスト実行で複数のテスト結果ファイルを持っている場合、`--test-results` に複数のパスまたは glob パターンを指定すると、全てのファイルが統合されて判定に使用される。

Why this priority: 複数ファイルの統合はモノレポや並列テスト実行で必要になるが、単一ファイルの基本動作が安定してから対応すべき。

Independent Test: 複数の Vitest JSON / JUnit XML ファイルを指定し、それぞれ異なる REQ のテスト結果が全て反映されることを確認する。

Acceptance Scenarios:

1. Given 2つのテスト結果ファイルがあり、ファイル A に `[REQ-001]` の pass、ファイル B に `[REQ-002]` の pass が記録されている, When `artgraph check --test-results fileA.json --test-results fileB.json` を実行する, Then REQ-001 と REQ-002 の両方が `verified` と報告される
2. Given 2つのテスト結果ファイルに同じ `[REQ-001]` のテストがあり、一方が pass で他方が fail, When 両ファイルを指定して `artgraph check` を実行する, Then REQ-001 は `impl-only` と報告される（1つでも fail があれば verified にならない）
3. Given Vitest JSON ファイルと JUnit XML ファイルが混在している, When 両方を `--test-results` で指定する, Then フォーマットが自動判別され、両方のテスト結果が統合される

---

### Edge Cases

- テスト結果ファイルが不正なフォーマット（JSON でも XML でもない）の場合 → パースエラーとして警告を出し、そのファイルはスキップする。他のファイルの処理は継続する
- テスト名に複数の REQ タグがある場合（例: `[REQ-001][REQ-002] should ...`）→ 全ての REQ に対してそのテストの結果を適用する
- 名前空間修飾された REQ タグ（例: `[001-auth/FR-001]`）がテスト名に含まれる場合 → 修飾形式を正しくパースし、対応する名前空間付き REQ にマッチさせる
- テスト結果ファイルのパスが相対パスで指定された場合 → プロジェクトルートからの相対パスとして解決する
- REQ タグを含むテストが skip/pending 状態の場合 → pass として扱わない（`impl-only` に分類される）
- Vitest JSON と JUnit XML の両方に同じテストの結果がある場合 → 後から読み込まれたファイルの結果で上書きせず、いずれかが fail なら fail として扱う

## Requirements *(mandatory)*

### Functional Requirements

- FR-001: `artgraph check` コマンドは `--test-results <path>` オプションを受け付け、指定されたテスト結果ファイルを読み込んで coverage 判定に使用する
- FR-002: Vitest JSON レポーター形式（`vitest run --reporter=json` の出力）をパースし、各テストケースの名前から `[REQ-xxxx]` パターンを抽出し、pass/fail 状態を取得する
- FR-003: JUnit XML 形式をパースし、各 testcase の名前から `[REQ-xxxx]` パターンを抽出し、pass/fail 状態を取得する
- FR-004: coverage 判定において、`verifies` エッジが存在し、かつ対応する全てのテストが pass している場合にのみ `verified` とする。テストが fail、skip、または結果が見つからない場合は `impl-only` とする
- FR-005: `--test-results` オプションが指定されない場合、従来の判定ロジック（`verifies` エッジの有無のみ）で動作する（後方互換性）
- FR-006: `ArtgraphConfig` に `testResultPaths` フィールドを追加し、設定ファイルでテスト結果ファイルのパスを指定できるようにする
- FR-007: テスト結果ファイルのフォーマット（Vitest JSON / JUnit XML）はファイル内容から自動判別する
- FR-008: 複数のテスト結果ファイルを指定した場合、全ファイルの結果を統合して判定する。同一 REQ に対して複数のテスト結果がある場合、1つでも fail があれば pass としない
- FR-009: `artgraph scan` コマンドも `--test-results` オプションを受け付け、テスト結果の統計情報を出力に含める
- FR-010: テスト名の describe ブロック（Vitest JSON の ancestorTitles / JUnit XML の testsuite name）に `[REQ-xxxx]` がある場合、その REQ タグを内部のテストケースに継承する
- FR-011: `artgraph coverage` コマンドも `--test-results` オプションを受け付け、テスト pass/fail を反映した coverage 状態を表示する。判定ロジックは `artgraph check` と同一とする
- FR-012: `--test-results` が指定されている場合、`verifies` エッジを持つ REQ のテストが fail/skip して `impl-only` に降格したとき、`artgraph check --gate` はその REQ を「テスト失敗」として gate 判定（exit code 2）の対象に含める。`--test-results` が指定されない場合は従来通りテスト pass/fail を gate 判定に反映しない（後方互換）

### Key Entities

- テスト結果ファイル: Vitest JSON レポーターまたは JUnit XML 形式で出力されたファイル。テストケースごとの名前と pass/fail 状態を含む
- REQ タグ: テスト名や describe ブロック名に含まれる `[REQ-xxxx]` 形式のタグ。テスト結果と REQ ノードを紐づけるために使用される
- テスト結果レコード: パースされた個々のテスト結果。REQ ID、テスト名、pass/fail 状態を持つ
- testResultPaths: `ArtgraphConfig` に追加される設定フィールド。テスト結果ファイルのパスまたは glob パターンの配列

## Success Criteria *(mandatory)*

### Measurable Outcomes

- SC-001: `[REQ-xxxx]` タグを含むテストが全て pass している Vitest JSON レポートを指定した場合、対応する REQ の coverage 状態が `verified` と判定される
- SC-002: `[REQ-xxxx]` タグを含むテストに 1 つでも fail がある場合、対応する REQ の coverage 状態が `impl-only` と判定される
- SC-003: JUnit XML レポートでも Vitest JSON と同一の判定結果が得られる
- SC-004: `--test-results` オプションなしの場合、従来と同一の判定結果が得られる（回帰なし）
- SC-005: テスト結果ファイルが存在しないまたは読み込めない場合、エラーで停止せず、従来の判定にフォールバックする
- SC-006: `artgraph coverage --test-results` と `artgraph check --test-results` が同一のテスト結果ファイルに対して一貫した coverage 判定を返す
- SC-007: `--test-results` 指定時に `verifies` エッジを持つ REQ のテストが fail した場合、`artgraph check --gate` が exit code 2 で終了する。`--test-results` を指定しない場合は同条件でも exit code 0 となる（後方互換）

## Assumptions

- テスト名や describe ブロック名に `[REQ-xxxx]` 形式でタグを埋め込むのは開発者の責務であり、artgraph はタグの存在を前提に join を行う
- Vitest JSON レポーターの出力形式は `{ testResults: [{ name, assertionResults: [{ ancestorTitles, title, status }] }] }` に準拠する
- JUnit XML の形式は `<testsuites><testsuite name="..."><testcase name="..." classname="..."><failure/></testcase></testsuite></testsuites>` に準拠する
- テスト結果ファイルはビルド時に生成される一時的なアーティファクトであり、Git にコミットされることは想定しない
- 既存の `verifies` エッジの仕組みは変更しない。テスト結果の取り込みは `verifies` エッジに追加の情報を付与するものであり、エッジの有無自体の判定は変えない
- テスト結果ファイルのパースは決定的であり、同じファイルを入力すれば常に同じ結果を返す（Deterministic Integrity の原則に合致）
