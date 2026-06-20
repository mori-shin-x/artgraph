# Feature Specification: Spec Kit spec.md パース対応

Feature Branch: `001-speckit-spec-parse`

Created: 2026-06-20

Status: Draft

Input: spectrace の Markdown パーサーを根本的に見直し、SDD ツール（Spec Kit, Kiro 等）の仕様記法をネイティブに認識できるようにする。加えて、Spec Kit テンプレートとの統合を整備する。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - リスト項目の仕様 ID 認識 (Priority: P1)

開発者が Spec Kit 形式の spec.md（`- FR-001: System MUST ...` のようなリスト項目）を持っている。
`spectrace scan` を実行すると、リスト項目内の PREFIX-NNN パターン（FR-001, SC-001, NFR-1 等）が
仕様 ID として認識され、各項目が `req` ノードとしてアーティファクトグラフに登録される。
コード内の `// @impl FR-001` がこの ID に紐づき、カバレッジと orphan が検証できる。

Why this priority: SDD ツール群で最も普及している記法がリスト項目の PREFIX-NNN 形式（Spec Kit, BMAD-METHOD, cc-sdd）。現パーサーは見出しのみ走査しており、この形式を認識できない。spectrace が「既存 SDD ツールの補完レイヤー」として機能するための前提条件。

Independent Test: PREFIX-NNN 形式のリスト項目を含む spec.md を配置し、`spectrace scan` で REQ ノードとして認識されること、`// @impl FR-001` で紐づきが成立することを確認する。

Acceptance Scenarios:

1. Given spec.md に `- FR-001: ユーザーはメールでログインできる` というリスト項目がある, When `spectrace scan` を実行する, Then FR-001 が `req` ノードとしてグラフに登録される
2. Given spec.md に FR-001 があり、コード内に `// @impl FR-001` がある, When `spectrace check` を実行する, Then FR-001 のカバレッジ状態が `impl-only` と報告される
3. Given spec.md に FR-001, FR-002, SC-001 がリスト項目で記述されている, When `spectrace scan` を実行する, Then 3つ全てが個別の `req` ノードとして登録される
4. Given `- **FR-001**: ...`（太字）形式で書かれている, When `spectrace scan` を実行する, Then FR-001 が認識される（太字の有無に依存しない）

---

### User Story 2 - 見出しの仕様 ID 認識 (Priority: P2)

開発者が Kiro 形式の requirements.md（`### Requirement 1: ...` のような見出し）を持っている。
`spectrace scan` を実行すると、見出し内の Requirement N パターンが仕様 ID として認識され、
`req` ノードとしてグラフに登録される。

Why this priority: Kiro は AWS が提供する主要 SDD ツールで、見出しベースの記法を使う。Spec Kit のリスト形式（US1）と並び、主要な SDD 記法への対応として必要。

Independent Test: Kiro 形式の見出しを含む .md ファイルを配置し、`spectrace scan` で認識されることを確認する。

Acceptance Scenarios:

1. Given spec.md に `### Requirement 1: ユーザー登録` という見出しがある, When `spectrace scan` を実行する, Then `Requirement 1` が `req` ノードとしてグラフに登録される
2. Given `### Requirement 1` と `### Requirement 2` がある, When `spectrace scan` を実行する, Then 2つが個別の `req` ノードとして登録される
3. Given Kiro 形式の見出しと Spec Kit 形式のリスト項目が同じ spec.md に混在している, When `spectrace scan` を実行する, Then 両方の形式が認識される

---

### User Story 3 - 名前空間による ID 衝突の解決 (Priority: P3)

プロジェクト内に複数の spec.md があり、それぞれに FR-001 が存在する
（Spec Kit はフィーチャーごとに連番を振るため、これは一般的な状況）。
spectrace は spec ディレクトリ名で名前空間を自動的に分離し、衝突を防ぐ。
`@impl FR-001` が曖昧な場合は警告し、`@impl 001-auth/FR-001` のような修飾形式を要求する。

Why this priority: US1, US2 の基本認識が動作した上で必要になる機能。単一 spec の場合は不要だが、複数 spec を持つ実プロジェクトでは必須。

Independent Test: 同じ FR-001 を持つ2つの spec.md を配置し、名前空間が正しく分離されること、曖昧な `@impl` に対して警告が出ることを確認する。

Acceptance Scenarios:

1. Given `specs/001-auth/spec.md` と `specs/002-payments/spec.md` の両方に FR-001 がある, When `spectrace scan` を実行する, Then それぞれが別の `req` ノードとして登録される（ID の衝突なし）
2. Given 上記の状態でコード内に `// @impl FR-001` がある, When `spectrace check` を実行する, Then 「FR-001 が複数の spec に存在するため修飾が必要」という警告が出る
3. Given コード内に `// @impl 001-auth/FR-001` がある, When `spectrace check` を実行する, Then `specs/001-auth/spec.md` の FR-001 に正しく紐づく

---

### Edge Cases

- リスト項目に PREFIX-NNN パターンがあるが、Requirements セクション外にある場合（例: Assumptions セクション内の参照）→ セクションコンテキストを考慮するか、全てのリスト項目をスキャンするかは設定で制御
- `FR-001` と `fr-001` のような大文字小文字の違い → 大文字小文字を区別する（SDD ツールの慣例に従う）
- `- FR-001: ...` の後にネストしたリスト項目がある場合 → ネスト部分は FR-001 のコンテンツとして content-hash に含める
- PREFIX が未知の場合（例: `- CUST-001: ...`）→ デフォルトの PREFIX-NNN パターンにマッチすれば認識する。設定で認識対象のプレフィックスを制限可能
- 見出し内に `Requirement` というテキストがあるが番号が無い場合 → 仕様 ID として認識しない

## Requirements *(mandatory)*

### Functional Requirements

- FR-001: spectrace のパーサーは、Markdown リスト項目内の PREFIX-NNN パターン（FR-001, SC-001, NFR-1, REQ-001 等）を仕様 ID として認識し、`req` ノードとしてグラフに登録する
- FR-002: spectrace のパーサーは、Markdown 見出し内の `Requirement N` パターンを仕様 ID として認識し、`req` ノードとしてグラフに登録する
- FR-003: 各仕様 ID に対して、リスト項目のコンテンツ（またはセクションのコンテンツ）を content-hash の対象とし、drift 検出に使用する
- FR-004: 同一 ID が複数の spec ファイルに存在する場合、spec ディレクトリ名で名前空間を分離する。`@impl` タグが曖昧な場合は警告を出し、修飾形式（`specDirName/ID`、例: `001-auth/FR-001`）を要求する
- FR-005: `@impl` タグの ID パターンを、新しい仕様 ID 形式（PREFIX-NNN, Requirement-N, 修飾形式）に対応させる。Kiro の `Requirement N` は `Requirement-N`（ハイフン区切り）に正規化する
- FR-006: テストタグの ID パターン（`[FR-001]`, `annotations: { req: "FR-001" }`）を新しい形式に対応させる
- FR-007: 認識する ID パターンは設定（`.spectrace.json`）で拡張・制限できる
- FR-008: Spec Kit frontmatter（title, status, priority, owner）を読み取り、仕様ノードのメタデータとして保持する

### Key Entities

- 仕様 ID: SDD ツールが付与する ID（FR-001, Requirement 1 等）。.md ファイル内のリスト項目または見出しに記述され、source of truth となる
- ID パターン: 仕様 ID を認識するための正規表現パターン。デフォルトで PREFIX-NNN（リスト項目）と Requirement N（見出し）を含み、設定で拡張可能
- 名前空間修飾: 複数 spec で同一 ID が存在する場合の解決形式（例: `001-auth/FR-001`）。`@impl` タグ、lock ファイルのキーで使用
- Spec Kit Feature Directory: `specs/NNN-feature/` ディレクトリ。spec.md と関連成果物を格納する単位

## Success Criteria *(mandatory)*

### Measurable Outcomes

- SC-001: Spec Kit 形式（リスト項目 PREFIX-NNN）の spec.md を scan すると、全ての要件が REQ ノードとして認識される
- SC-002: Kiro 形式（見出し Requirement N）の spec.md を scan すると、全ての要件が REQ ノードとして認識される
- SC-003: 複数 spec に同一 ID が存在するプロジェクトで、名前空間が正しく分離され、衝突による誤動作が発生しない
- SC-004: リスト項目・見出し両形式の要件に対して、drift 検出（content-hash 比較）が正しく動作する
- SC-005: 既存の `@impl` / `check` / `impact` ワークフローが新しい ID 形式でもそのまま機能する

## Assumptions

- SDD ツールの ID は .md ファイル内のリスト項目または見出しに記述されている（design.md D1, D2）。spectrace 独自の ID レイヤーは設けない
- `specs/` ディレクトリは既にデフォルトのスキャン対象に含まれている（config の `specDirs: ["specs", "docs"]`）
- デフォルトの認識パターンは PREFIX-NNN（大文字英字 + ハイフン + 数字）と Requirement N。これで Spec Kit, BMAD, Kiro, cc-sdd の主要形式をカバーする
- 名前空間の衝突が無い場合（プロジェクト内で ID が一意）、`@impl FR-001` のように修飾なしで参照できる
- 既存の `@impl` / `check` / `impact` / drift 検出メカニズムは、ID パターンの変更に伴い内部的に更新されるが、ユーザー向けの動作は変わらない
- plan.md、tasks.md 等の Spec Kit 関連ファイルのパースは本機能のスコープ外（将来の拡張として doc↔doc 連携で対応）
