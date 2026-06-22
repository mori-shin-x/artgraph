# Feature Specification: rename / split / merge（ID ライフサイクル管理）

Feature Branch: `004-id-lifecycle`

Created: 2026-06-20

Status: Draft

Input: 仕様 ID のリネーム・分割・統合をプロジェクト全体で一括実行できるコマンドを提供し、ID ライフサイクルを管理する

## User Scenarios & Testing (mandatory)

### User Story 1 - 仕様 ID のリネーム (Priority: P1)

開発者が仕様策定中に ID の命名規則を変更したい、または ID に誤りがあった場合、
`spectrace rename --from REQ-xxxx --to REQ-yyyy` を実行すると、プロジェクト全体のあらゆる参照箇所
（仕様ファイルの見出し・リスト項目、コードの `@impl` タグ、テストの `[REQ-xxxx]` タグ、frontmatter の `depends_on`、`.trace.lock` のキー）
が一括で新しい ID に書き換えられる。`doc:xxx` 形式のドキュメント ID にも同じ操作が適用される。

Why this priority: ID のリネームは仕様策定の初期段階で頻繁に発生する最も基本的なライフサイクル操作であり、手作業での一括書き換えはミスを招きやすい。split / merge の前提となる書き換えメカニズムもここで確立する。

Independent Test: fixture プロジェクトに REQ-001 を含む spec.md, コードファイル (`@impl REQ-001`), テストファイル (`[REQ-001]`), `.trace.lock` を配置し、`spectrace rename --from REQ-001 --to REQ-100` を実行後、全ファイルの参照が REQ-100 に書き換わっていることを確認する。

Acceptance Scenarios:

1. Given spec.md に `- REQ-001: ユーザー認証` というリスト項目がある, When `spectrace rename --from REQ-001 --to REQ-100` を実行する, Then spec.md 内の `REQ-001` が `REQ-100` に書き換わる
2. Given コードファイルに `// @impl REQ-001` がある, When rename を実行する, Then `// @impl REQ-100` に書き換わる
3. Given テストファイルに `[REQ-001]` がある, When rename を実行する, Then `[REQ-100]` に書き換わる
4. Given `.trace.lock` に `"REQ-001"` キーのエントリがある, When rename を実行する, Then キーが `"REQ-100"` に変更され、エントリの内容は保持される
5. Given frontmatter の `depends_on` に `REQ-001` への参照がある, When rename を実行する, Then 参照が `REQ-100` に書き換わる
6. Given `--dry-run` オプションを指定する, When rename を実行する, Then 変更箇所の一覧が表示されるが、ファイルは書き換わらない
7. Given `--to` で指定した ID がプロジェクト内に既に存在する, When rename を実行する, Then エラーを報告し、書き換えは行わない
8. Given `--from` で指定した ID がプロジェクト内に存在しない, When rename を実行する, Then エラーを報告する

---

### User Story 2 - 仕様 ID の分割 (Priority: P2)

要件の粒度が大きすぎると判断した開発者が、1 つの仕様 ID を 2 つの新しい ID に分割したい。
`spectrace rename --split REQ-001 --into REQ-001a REQ-001b` を実行すると、
元の ID が仕様ファイルから削除され、新しい 2 つの ID の見出し雛形が追記される。
`@impl REQ-001` を持つコードファイルには手動振り分けが必要な旨の警告が出力される。
`.trace.lock` から元の ID が削除され、新しい ID のエントリが空で追加される。

Why this priority: 仕様の粒度見直しは設計の成熟に伴い発生する。rename（US1）で確立した書き換えメカニズムを前提として、分割ロジックを追加する。merge（US3）より先に対応するのは、分割の方が発生頻度が高いため。

Independent Test: fixture プロジェクトに REQ-001 を含む spec.md とコードファイル（`@impl REQ-001`）を配置し、split 実行後、spec.md に新 ID の雛形が追加されていること、コードファイルに対する警告が出力されること、lock が更新されていることを確認する。

Acceptance Scenarios:

1. Given spec.md に `- REQ-001: ユーザー認証` がある, When `spectrace rename --split REQ-001 --into REQ-001a REQ-001b` を実行する, Then spec.md から REQ-001 の行が削除され、REQ-001a と REQ-001b の見出し雛形が追記される
2. Given コードファイルに `// @impl REQ-001` がある, When split を実行する, Then 「REQ-001 の impl が以下のファイルに存在します。手動で REQ-001a または REQ-001b に振り分けてください」という警告が出力される
3. Given `.trace.lock` に `"REQ-001"` のエントリがある, When split を実行する, Then `"REQ-001"` が削除され、`"REQ-001a"` と `"REQ-001b"` の空エントリが追加される
4. Given `--dry-run` オプションを指定する, When split を実行する, Then 変更予定の一覧が表示されるが、ファイルは変更されない
5. Given `--into` で指定した ID のいずれかがプロジェクト内に既に存在する, When split を実行する, Then エラーを報告し、操作は行わない

---

### User Story 3 - 仕様 ID の統合 (Priority: P2)

重複する 2 つの要件を 1 つに統合したい開発者が、
`spectrace rename --merge REQ-001a REQ-001b --into REQ-001` を実行すると、
プロジェクト全体の両 ID への参照が新しい ID に書き換わる。
`.trace.lock` では元の 2 つのエントリの impl / tests を合算して新 ID に統合する。

Why this priority: 統合は分割の逆操作であり、分割（US2）と同等の優先度。分割後の調整や要件の重複解消に使用される。

Independent Test: fixture プロジェクトに REQ-001a, REQ-001b を含む spec.md, コードファイル, テストファイル, lock を配置し、merge 実行後、全参照が REQ-001 に統一され、lock の impl / tests が合算されていることを確認する。

Acceptance Scenarios:

1. Given spec.md に `- REQ-001a: ...` と `- REQ-001b: ...` がある, When `spectrace rename --merge REQ-001a REQ-001b --into REQ-001` を実行する, Then spec.md から REQ-001a と REQ-001b が削除され、REQ-001 の見出し雛形が追記される
2. Given コードファイルに `// @impl REQ-001a` と別ファイルに `// @impl REQ-001b` がある, When merge を実行する, Then 両方とも `// @impl REQ-001` に書き換わる
3. Given `.trace.lock` に REQ-001a (impl: [a.ts], tests: [a.test.ts]) と REQ-001b (impl: [b.ts], tests: [b.test.ts]) がある, When merge を実行する, Then REQ-001 のエントリが作成され、impl: [a.ts, b.ts], tests: [a.test.ts, b.test.ts] となる
4. Given `--dry-run` オプションを指定する, When merge を実行する, Then 変更予定の一覧が表示されるが、ファイルは変更されない
5. Given `--into` で指定した ID がプロジェクト内に既に存在する, When merge を実行する, Then エラーを報告し、操作は行わない

---

### Edge Cases

- 名前空間修飾付き ID（`001-auth/FR-001`）に対する rename / split / merge → 修飾を含めた完全 ID として処理する
- 同一ファイル内に `--from` の ID が複数箇所で参照されている場合 → 全箇所を書き換える
- `--from` の ID がコード内の文字列リテラルやコメント（`@impl` 以外）に含まれる場合 → `@impl`、`[ID]`、frontmatter の `depends_on`、lock のキーのみを対象とし、無関係なテキストは書き換えない
- untracked ファイル（git で追跡されていないファイル）に対象 ID が含まれる場合 → 書き換え対象外とする
- split で `--into` に 3 つ以上の ID を指定した場合 → 2 つ以上の任意個数を許容する
- merge で `--into` に指定した ID が merge 元の ID のいずれかと同じ場合 → 許容する（元の ID を残して他方を統合する操作として扱う）
- `.trace.lock` が存在しない場合 → lock の更新はスキップし、ファイル書き換えのみ実行する
- dry-run の出力フォーマット → `--format json|text` で制御可能とする

## Requirements (mandatory)

### Functional Requirements

- FR-001: `spectrace rename --from <old-id> --to <new-id>` コマンドは、プロジェクト内の全参照箇所（spec 見出し・リスト項目、`@impl` タグ、テストタグ、frontmatter `depends_on`、`.trace.lock` キー）を一括で書き換える
- FR-002: `spectrace rename --split <old-id> --into <new-id-1> <new-id-2> [...]` コマンドは、元の ID を仕様ファイルから削除し、新 ID の見出し雛形を追記し、`@impl` を持つコードファイルに対して手動振り分けの警告を出力する
- FR-003: `spectrace rename --merge <id-1> <id-2> --into <new-id>` コマンドは、全参照を新 ID に書き換え、lock の impl / tests を合算して統合する
- FR-004: 全サブコマンドは `--dry-run` オプションをサポートし、実際の書き換えを行わずに変更箇所の一覧を表示する
- FR-005: 全サブコマンドは `--format json|text` オプションをサポートし、出力フォーマットを制御できる
- FR-006: 書き換え対象は git で追跡中のファイルに限定し、untracked ファイルは無視する
- FR-007: 書き換え対象の ID パターンは、仕様ファイルの見出し・リスト項目、コードの `@impl` タグ、テストの `[ID]` タグ、frontmatter の `depends_on`、`.trace.lock` のキーに限定する（無関係なテキスト内の偶発的な一致は書き換えない）
- FR-008: `--to` / `--into` で指定した新 ID がプロジェクト内に既に存在する場合はエラーとする（merge で元 ID と同一の場合を除く）
- FR-009: `--from` / `--split` で指定した元 ID がプロジェクト内に存在しない場合はエラーとする
- FR-010: `doc:xxx` 形式のドキュメント ID にも rename / split / merge を適用可能とする

### Key Entities

- 仕様 ID: SDD ツールが付与する ID（REQ-001, FR-001, doc:auth 等）。rename / split / merge の操作対象
- 参照箇所: 仕様 ID が出現するファイル内の特定パターン。spec の見出し・リスト項目、`@impl` タグ、テストタグ `[ID]`、frontmatter `depends_on`、`.trace.lock` キーの 5 種類
- dry-run レポート: 書き換え前に表示される変更予定の一覧。ファイルパス、行番号、変更前後のテキストを含む
- 見出し雛形: split / merge 時に仕様ファイルに追記される新 ID のプレースホルダー行

## Success Criteria (mandatory)

### Measurable Outcomes

- SC-001: rename 実行後、プロジェクト内に旧 ID への参照が 0 件であること（`spectrace scan` + `grep` で検証）
- SC-002: split 実行後、元 ID の参照が 0 件、新 ID の雛形が仕様ファイルに存在すること
- SC-003: merge 実行後、元の 2 ID の参照が 0 件、新 ID に全参照が統合されていること
- SC-004: dry-run モードでは、実行前後でファイルの内容が一切変更されないこと
- SC-005: rename / split / merge 実行後に `spectrace check` を実行し、ID 不整合が発生しないこと（split 時の手動振り分け警告を除く）

## Assumptions

- 書き換え対象のファイルは全て git で追跡されている（spectrace のスキャン対象と一致する）
- 仕様 ID のパターンは spectrace のパーサーが認識する形式（PREFIX-NNN, Requirement-N, doc:xxx）に限定される
- 単一のコマンド実行で書き換えが完結する（トランザクション的な操作は不要。書き換え中に失敗した場合、ユーザーは `git checkout` で復元できる）
- `.trace.lock` のフォーマットは JSON であり、spectrace の既存の lock 読み書き機構を再利用できる
- split で生成される見出し雛形は最小限の内容（ID とプレースホルダーテキスト）であり、ユーザーが後から内容を記述する
