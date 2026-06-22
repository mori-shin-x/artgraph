# Feature Specification: Spec Kit 残対応（FR-007/008 + 層2/3）

Feature Branch: `005-speckit-remaining`

Created: 2026-06-20

Status: Draft

Input: Spec Kit パース対応の残タスク（設定可能な ID パターン、frontmatter メタデータ、plan.md/tasks.md 連携、パス規約認識）を完了する

## User Scenarios & Testing (mandatory)

### User Story 1 - 設定可能な ID パターン (Priority: P2)

ユーザが `.artgraph.json` の `reqPatterns` フィールドにカスタム正規表現を指定し、プロジェクト固有の要件 ID フォーマット（例: `JIRA-\d+`, `US\d+` など）を artgraph に認識させる。`ReqPatternConfig` 型は `types.ts` に定義済みだが、`markdown.ts` のパーサには未接続のため、この接続を確立する。

Why this priority: `ReqPatternConfig` 型とコンフィグ読み込みは実装済みで接続するだけの低コスト作業であり、カスタムパターンを使いたいユーザの即時ニーズに対応する。

Independent Test: `.artgraph.json` にカスタムパターンを設定し、そのパターンに合致する ID を含む Markdown ファイルをパースして、正しくノードが抽出されることを確認する。

Acceptance Scenarios:

1. Given `.artgraph.json` に `reqPatterns.listItem` が `"^(JIRA-\\d+)[:\\s]"` と設定されている, When `JIRA-123: ログイン機能` というリスト項目を含む Markdown をパースする, Then ID `JIRA-123` の `req` ノードが抽出される
2. Given `.artgraph.json` に `reqPatterns.heading` が `"^(US-?\\d+)\\s*:"` と設定されている, When `### US-42: ユーザ登録` という見出しを含む Markdown をパースする, Then ID `US-42`（キャプチャグループ 1 をそのまま使用）の `req` ノードが抽出される
3. Given `.artgraph.json` に `reqPatterns` が未設定, When Markdown をパースする, Then 現行の `LIST_ITEM_RE` と `KIRO_HEADING_RE` がデフォルトとして使用される
4. Given `.artgraph.json` に `reqPatterns.listItem` のみ設定されている, When Markdown をパースする, Then リスト項目にはカスタムパターンが、見出しにはデフォルトの `KIRO_HEADING_RE` が適用される
5. Given `reqPatterns.listItem` に無効な正規表現が設定されている, When 設定をロードする, Then 明確なエラーメッセージが表示され、パースが中断される

---

### User Story 2 - Spec Kit frontmatter メタデータの読み取り (Priority: P3)

Spec Kit 形式の Markdown ファイルの YAML frontmatter から `title`, `status`, `priority`, `owner` を読み取り、doc ノードの属性として保持する。これによりグラフ上でドキュメントの状態や責任者を参照可能になる。ただし `status` 値を coverage 判定のヒントとしては使用しない（Deterministic Integrity 原則）。

Why this priority: メタデータの読み取り自体は低リスクだが、downstream の活用シナリオが未確定のため、まずデータ保持のみに留める。

Independent Test: frontmatter に `title`, `status`, `priority`, `owner` を含む Markdown をパースし、生成された `GraphNode` の `metadata` フィールドにそれらの値が格納されていることを確認する。

Acceptance Scenarios:

1. Given frontmatter に `title: "認証設計"`, `status: "draft"`, `priority: "P1"`, `owner: "yamada"` が記載されている, When その Markdown をパースする, Then doc ノードの `metadata` に `{ title: "認証設計", status: "draft", priority: "P1", owner: "yamada" }` が格納される
2. Given frontmatter に `title` のみ存在する, When パースする, Then `metadata` に `{ title: "..." }` のみが格納され、未指定フィールドはキーとして存在しない
3. Given frontmatter が存在しない Markdown, When パースする, Then `metadata` フィールドは `undefined` のまま
4. Given frontmatter に `status: "implemented"` が設定されている, When coverage チェックを実行する, Then `status` 値は coverage 判定に影響せず、構造的な `@impl` / テストタグのみで判定される

---

### User Story 3 - plan.md / tasks.md とコードの紐付き (Priority: P3)

Spec Kit の plan.md に記載されたタスクが `@impl` タグでソースコードに紐づき、tasks.md の項目がテストの `[REQ-xxxx]` タグで検証される関係をグラフに表現する。Spec Kit 側のフォーマットが安定してから着手する前提。

Why this priority: Spec Kit の plan.md / tasks.md フォーマットがまだ流動的なため、フォーマット安定後に着手する。現行のグラフモデルの拡張性を確認する意味合いが強い。

Independent Test: plan.md 内の `@impl(SRC-xxx)` タグと tasks.md 内の `[REQ-xxx]` タグを含むフィクスチャを用意し、パース後のグラフに `implements` / `verifies` エッジが正しく生成されることを確認する。

Acceptance Scenarios:

1. Given plan.md に `@impl(auth-login)` タグ付きのタスクが存在する, When plan.md をパースする, Then タスクノードから `auth-login` への `implements` エッジが生成される
2. Given tasks.md に `[REQ-AUTH-001]` タグ付きの項目が存在する, When tasks.md をパースする, Then タスクノードから `AUTH-001` への `verifies` エッジが生成される
3. Given plan.md と tasks.md の両方が存在する, When グラフを構築する, Then spec.md の要件 → plan.md のタスク → コードファイル、および tasks.md の項目 → テストファイルの完全なトレーサビリティチェーンが形成される

---

### User Story 4 - .artgraph.json の Spec Kit パス規約認識 (Priority: P4)

`specs/NNN-feature/spec.md` というディレクトリ構造を `.artgraph.json` のパス規約として認識し、番号付きフィーチャーディレクトリ内のファイルを自動的にスキャン対象に含める。`specs/` は既にデフォルトの `specDirs` に含まれているため、ディレクトリ構造のパターンマッチングを追加する。

Why this priority: `specDirs` に `specs` が既に含まれており、現状でもサブディレクトリは再帰的にスキャンされる。明示的なパターン認識はフィーチャー単位のフィルタリングが必要になったときに対応すればよい。

Independent Test: `specs/001-auth/spec.md` と `specs/002-billing/spec.md` が存在する状態でグラフを構築し、両方のファイルからノードが抽出されることを確認する。フィーチャー番号による選択的スキャンの動作もテストする。

Acceptance Scenarios:

1. Given `specDirs` に `specs` が含まれている, When `specs/001-auth/spec.md` と `specs/002-billing/spec.md` が存在する, Then 両方のファイルが自動的にパース対象になる
2. Given `.artgraph.json` にフィーチャーフィルタ設定が追加されている, When 特定のフィーチャー番号（例: `001`）を指定してスキャンする, Then そのフィーチャーディレクトリのファイルのみがパースされる
3. Given `specs/` ディレクトリに `spec.md`, `plan.md`, `tasks.md` が存在するフィーチャーディレクトリがある, When グラフを構築する, Then 各ファイルが適切な種別（spec → doc/req, plan → doc, tasks → doc）で認識される

---

### Edge Cases

- `reqPatterns.listItem` に空文字列が指定された場合、エラーとして扱いデフォルトにフォールバックしない（明示的な設定ミスを見逃さない）
- frontmatter の `status` フィールドに任意の文字列が入る可能性があるが、バリデーションは行わずそのまま保持する（Spec Kit 側の責務）
- `reqPatterns` のカスタム正規表現にキャプチャグループが含まれない場合、エラーメッセージでキャプチャグループの必要性を示す
- plan.md / tasks.md が Spec Kit フォーマットに従わない場合、通常の Markdown としてパースし、タグ未検出でもエラーにしない（Incremental Adoption 原則）
- 同一フィーチャーディレクトリ内の spec.md と plan.md で同名の ID が定義された場合、既存の名前空間衝突解決（`specDir/ID` 修飾）が適用される
- frontmatter に `artgraph.node_id` と Spec Kit メタデータ（`title` 等）の両方が存在する場合、両方を独立して処理する

## Requirements (mandatory)

### Functional Requirements

- FR-007: `.artgraph.json` の `reqPatterns` フィールドで、リスト項目パターン（`listItem`）と見出しパターン（`heading`）をカスタム正規表現で指定できる。未設定時は現行の `LIST_ITEM_RE` / `KIRO_HEADING_RE` をデフォルトとして使用する。
- FR-008: Spec Kit 形式の frontmatter から `title`, `status`, `priority`, `owner` フィールドを読み取り、`GraphNode` の `metadata` フィールドに `Record<string, string>` として格納する。`status` 値は coverage 判定に使用しない。
- FR-009: plan.md 内の `@impl` タグを認識し、タスクノードから実装先への `implements` エッジを生成する。
- FR-010: tasks.md 内の `[REQ-xxxx]` タグを認識し、タスクノードからテスト対象要件への `verifies` エッジを生成する。
- FR-011: `specs/NNN-feature/` ディレクトリ構造をフィーチャー単位として認識し、特定フィーチャーに限定したスキャンを可能にする。

### Non-Functional Requirements

- NFR-001: カスタム正規表現に無効なパターンが指定された場合、パース開始前にバリデーションエラーを発生させ、エラー箇所を特定可能なメッセージを出力する。
- NFR-002: frontmatter メタデータの読み取りは既存のパース処理に 5% 以上のパフォーマンス劣化を与えない。
- NFR-003: FR-007 / FR-008 は既存テストを破壊しない（後方互換性の維持）。

### Key Entities

- ReqPatternConfig: カスタム要件 ID パターンの設定を保持する型。`listItem` と `heading` フィールドに正規表現文字列を格納する。`types.ts` に定義済み。
- GraphNode.metadata: doc ノードに付与される Spec Kit frontmatter メタデータ。`Record<string, string>` 型のオプショナルフィールド。
- ArtgraphConfig.reqPatterns: `.artgraph.json` から読み込まれるパターン設定。`config.ts` で読み込み済みだがパーサに未接続。
- FeatureDirectory: `specs/NNN-feature/` 形式のディレクトリ。spec.md, plan.md, tasks.md を含むフィーチャー単位のまとまり。

## Success Criteria (mandatory)

### Measurable Outcomes

- SC-001: `reqPatterns` にカスタムパターンを設定した場合、そのパターンに合致する ID がパース結果に含まれる（FR-007 の検証）
- SC-002: Spec Kit frontmatter の `title`, `status`, `priority`, `owner` が `GraphNode.metadata` に正しく格納される（FR-008 の検証）
- SC-003: `reqPatterns` 未設定時に既存の全テストが変更なしで通過する（後方互換性）
- SC-004: plan.md の `@impl` タグから `implements` エッジが正しく生成される（FR-009 の検証）
- SC-005: tasks.md の `[REQ-xxxx]` タグから `verifies` エッジが正しく生成される（FR-010 の検証）
- SC-006: `specs/NNN-feature/` ディレクトリ構造内のファイルが自動的にスキャン対象に含まれる（FR-011 の検証）

## Assumptions

- Spec Kit の spec.md フォーマット（frontmatter + Markdown body）は安定しており、大幅な変更は想定しない
- plan.md / tasks.md のフォーマットは現時点で流動的であり、FR-009/010 の実装時にフォーマット仕様が確定している前提
- `ReqPatternConfig` 型と `config.ts` の `reqPatterns` 読み込みは PR #6 の成果物としてそのまま使用可能
- カスタム正規表現のキャプチャグループ位置（1 番目）は固定とし、ユーザがグループ位置を指定する機能は含めない
- `GraphNode` への `metadata` フィールド追加は TypeScript のオプショナルプロパティとして行い、既存コードへの影響を最小化する
- `specs/` ディレクトリは既に `specDirs` のデフォルトに含まれているため、サブディレクトリの再帰スキャンは現行動作で対応済み
