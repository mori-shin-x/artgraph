# Feature Specification: SDD ツールワークフロー統合 (Spec Kit Extension / Kiro Steering)

**Feature Branch**: `feat/sdd-workflow`

**Created**: 2026-06-23

**Status**: Draft

**Input**: User description: "SDD ツール（Spec Kit / Kiro）への spectrace 検証統合機能。`spectrace integrate speckit` で Spec Kit Extension を、`spectrace integrate kiro` で Kiro Steering file を生成し、SDD ワークフロー本体に spectrace の検証（scan / reconcile / check）を組み込む。" (GitHub Issue: ShintaroMorimoto/artgraph#16)

> **CLI 名整合に関する注記（plan.md §Summary と整合）**: 本仕様内で "spectrace integrate ..." と書かれているコマンドは、本リポジトリの実 CLI 名 **`artgraph`** で実装される（constitution §技術基盤と制約、`packages/artgraph/package.json#bin`）。"spectrace" の名前は (a) 生成される Spec Kit Extension のディレクトリ名 `.specify/extensions/spectrace/`、(b) Kiro Steering file 名 `.kiro/steering/spectrace.md` の 2 箇所にのみ残し、製品コードネームとしての識別子として保持する。FR/SC の "spectrace ..." 表記はすべて "artgraph ..." として実装すること。

## Clarifications

### Session 2026-06-23

- Q: 本イテレーションで `integrate` コマンドをプロバイダ追加可能なアーキテクチャにするか、2 ツール決め打ちで実装し将来リファクタするか → A: 内部はプロバイダ抽象として設計し、speckit / kiro を最初の 2 実装として登録する（OpenSpec は将来 3 つ目のプロバイダとして追加）
- Q: Hook API を持たない SDD ツール向けのガイド文書生成（Kiro Steering / 将来の OpenSpec Skills）を共通機構に寄せるか、ツールごとに独立にするか → A: "agent-guidance generator" を共通レイヤとして 1 つ用意し、プロバイダは配置先 path・テンプレ本体・変数のみを提供する。Spec Kit Extension の YAML 追記は別レイヤ
- Q: 参照実装 `.specify/extensions/agent-context/` の構造規約が将来破壊変更された場合のフォールバック方針は → A: 本機能リリース時点の Spec Kit Extension スキーマ（`schema_version: "1.0"`）をコードに固定し、`agent-context` はドキュメント上の参照例に留める（コードからは依存しない）。Spec Kit の schema_version が上がった時は本機能側で明示的にバージョン分岐 PR を切る
- Q: `spectrace integrate speckit` を `--gate` フラグの有無を変えて再実行した場合の挙動は → A: `--gate` フラグは「現在の状態を宣言する」セマンティクス。指定時は `before_implement` hook を追加、無指定（または `--no-gate` 明示）は削除。再実行で必ず指定状態に収束する
- Q: `integrate` の CLI 表面はどこまで広げるか（独立コマンドのみ／`init` の one-shot フラグも提供／対話モード） → A: 独立コマンドに加えて `spectrace init --integrate=speckit,kiro` のような one-shot フラグも提供する。手動の `spectrace integrate <tool>` も並行して残す。「init で何が書き換わったか」は CLI 出力（生成・変更ファイル一覧、推奨次コマンド）でカバーする

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Spec Kit ワークフローに spectrace 検証を自動組み込みする (Priority: P1)

Spec Kit を利用している開発者が、`spectrace init` 完了後に `spectrace integrate speckit` を 1 回実行するだけで、以降の Spec Kit ワークフロー（`/speckit-tasks`、`/speckit-implement`）の節目に spectrace の検証コマンドが自動で挟まる状態をつくる。これにより、開発者はコマンドの実行順序や呼び忘れを意識せず、SDD のリズムに乗ったまま「タスク生成後にベースライン確立」「実装後にカバレッジ・orphan・drift 検証」が自然に走るようになる。

**Why this priority**: 本機能の主目的は「SDD ワークフロー側に検証を取り込む」こと。Spec Kit はリファレンス実装が公開済みで Extension/Hook 機構も整っており、ここを最初に押さえることで spectrace の価値（決定的グラフ × SDD）がエンドユーザーに最短で届く。Spec Kit 統合が無いと、本リポジトリ自身を含む既存ユーザーが手動で spectrace を呼ぶ運用から抜けられない。

**Independent Test**: `.specify/` を持つ任意のリポジトリで `spectrace integrate speckit` を実行し、(1) `.specify/extensions/spectrace/` 以下に Extension 一式が生成されること、(2) `.specify/extensions.yml` の `hooks.after_tasks` と `hooks.after_implement` に spectrace のコマンド登録が追記されていること、(3) その後 `/speckit-tasks` と `/speckit-implement` を実行したときに登録した spectrace コマンドが Spec Kit のフックランナー経由で発火することの 3 点を確認すれば、単独で価値を提供できる。

**Acceptance Scenarios**:

1. **Given** `.specify/extensions.yml` が存在し spectrace 統合がまだ無いリポジトリ、**When** `spectrace integrate speckit` を実行する、**Then** `.specify/extensions/spectrace/` 配下に Extension 定義一式が新規生成され、`.specify/extensions.yml` の `installed:` に `spectrace` が追加され、`hooks.after_tasks` と `hooks.after_implement` に spectrace のコマンド登録が追記される
2. **Given** spectrace 統合が既に導入済みのリポジトリ、**When** 再度 `spectrace integrate speckit` を実行する、**Then** 既存設定を上書きせず「既に統合済み」と通知し、不足している hook のみを冪等に補完する
3. **Given** spectrace Extension が登録済みの Spec Kit プロジェクト、**When** ユーザーが `/speckit-tasks` を完了する、**Then** Spec Kit の Hook ランナーが `spectrace scan && spectrace reconcile` を発火し、spec ↔ コードのベースラインが更新される
4. **Given** spectrace Extension が登録済みの Spec Kit プロジェクト、**When** ユーザーが `/speckit-implement` を完了する、**Then** Spec Kit の Hook ランナーが `spectrace check --diff` を発火し、カバレッジ / orphan / drift の検証結果が表示される
5. **Given** `.specify/` がそもそも存在しないリポジトリ、**When** `spectrace integrate speckit` を実行する、**Then** 「Spec Kit が検出できない」旨のエラーで終了し、ファイルシステムを変更しない

---

### User Story 2 - Kiro ワークフローに spectrace 利用ガイドを Steering 経由で配布する (Priority: P2)

Kiro を利用しているチームが、`spectrace integrate kiro` を 1 回実行するだけで、Kiro エージェントが「実装前に `spectrace impact` で影響範囲を確認 → 実装後に `spectrace check --diff` で検証 → drift 検出時は `spectrace reconcile` で修正」という運用フローを把握できる Steering file が `.kiro/steering/` に配置される状態をつくる。これにより、Kiro 側に専用 Extension API が未公開でも、エージェントの振る舞いだけは spectrace 寄りに揃えられる。

**Why this priority**: Kiro 自体の Extension/Hook API がまだ公開されていないため自動フックは張れず、エージェント挙動のガイドが当面の最大効果を出す手段になる。Spec Kit 統合（P1）が動いてから着手しても市場を逃さないが、Kiro ユーザー向けに最低限の入口を用意することは spectrace の対象 SDD を 2 つに広げるうえで欠かせない。

**Independent Test**: `.kiro/` を持つ任意のリポジトリで `spectrace integrate kiro` を実行し、(1) `.kiro/steering/spectrace.md` が生成されること、(2) その内容に impact / check / reconcile の 3 コマンドと使いどころが明記されていること、(3) Kiro エージェントが当該 Steering を読み込んだ状態で実装タスクを開始したときに、上記コマンドを実行候補として提示することの 3 点で単独検証できる。

**Acceptance Scenarios**:

1. **Given** `.kiro/steering/` が存在し spectrace 用 Steering が無いリポジトリ、**When** `spectrace integrate kiro` を実行する、**Then** `.kiro/steering/spectrace.md` が生成され、impact / check / reconcile の使い方とトリガー条件が記載される
2. **Given** `.kiro/steering/spectrace.md` が既に存在するリポジトリ、**When** 再度 `spectrace integrate kiro` を実行する、**Then** 既存ファイルを上書きせず「既に統合済み」と通知し、`--force` 等で明示的に指定された場合のみ再生成する
3. **Given** `.kiro/` が存在しないリポジトリ、**When** `spectrace integrate kiro` を実行する、**Then** 「Kiro が検出できない」旨のエラーで終了し、ファイルシステムを変更しない
4. **Given** 将来 Kiro 公式の Hook API が公開された場合、**When** 本機能の後継リリースが同 API を利用するモードを追加する、**Then** 既存 Steering 利用者の設定を壊さずに自動 Hook 登録モードへ移行できる（前方互換性）

---

### User Story 3 - 統合済み状態の検査・案内 (Priority: P3)

`spectrace init` を実行した開発者が、検出された SDD ツール（Spec Kit / Kiro）に対して spectrace 統合がまだ済んでいないことを画面上の案内で気付けるようにする。実行は強制しないが、`spectrace integrate <tool>` の存在と効果を init 出力の末尾に明示することで、統合機能の発見性を担保する。

**Why this priority**: integrate コマンド自体（P1/P2）が動けば技術的なゴールは達成されるが、ユーザーが存在を知らなければ採用されない。init コマンド出力の数行で発見性を底上げできるので投資対効果が高い。一方、integrate 本体が動かなければ案内の意味も無いので優先度は P3。

**Independent Test**: `.specify/` だけが存在するリポジトリで `spectrace init` を実行し、出力末尾に「Spec Kit を検出。`spectrace integrate speckit` で SDD ワークフローへの検証統合を有効化できます」のような案内が表示され、`.kiro/` も同時にある場合は両ツール分の案内が出ることを確認すれば良い。

**Acceptance Scenarios**:

1. **Given** `.specify/` を持ち spectrace Extension 未導入のリポジトリ、**When** `spectrace init` を実行する、**Then** 通常の init 出力に続けて Spec Kit 向け integrate コマンドの案内が表示される
2. **Given** `.specify/` と `.kiro/` の双方を持つリポジトリ、**When** `spectrace init` を実行する、**Then** 検出された両ツール分の integrate 案内が表示される
3. **Given** spectrace 統合が既に完了しているリポジトリ、**When** `spectrace init` を実行する、**Then** 「統合済み」のステータスのみ表示され、integrate コマンド案内は出ない

---

### Edge Cases

- `extensions.yml` がパース不能・スキーマ非互換の場合、`spectrace integrate speckit` はファイルを書き換えず、原因と修正方法を表示して exit する。
- `.specify/extensions/spectrace/` 配下に手動で編集されたファイルが既に存在する場合、ユーザーの編集を上書きせず差分の有無を報告し、`--force` 指定時のみ再生成する。
- `extensions.yml` の hook 配列に他の Extension が既に `after_tasks` / `after_implement` を登録している場合、spectrace のエントリを追記する（既存登録は削除しない）。priority は spectrace 規定値を用いる。
- `spectrace integrate speckit --no-gate`（または `--gate` 無指定）での再実行時、spectrace が以前登録した `before_implement` フックのみを削除し、他の Extension が登録した `before_implement` 配列要素には触れない。
- `.kiro/steering/` ディレクトリが存在するが書き込み権限が無い場合、`spectrace integrate kiro` は何も書き換えず原因を表示して exit する。
- Spec Kit の Extension スキーマバージョンが本機能の想定範囲（`requires.speckit_version`）を外れている場合、警告付きで停止する。
- `spectrace integrate` 実行中に途中失敗した場合、生成途中のファイル・追記途中の yaml は元の状態に巻き戻す（部分適用を残さない）。

## Requirements *(mandatory)*

### Functional Requirements

#### `spectrace integrate speckit` コマンド

- **FR-001**: `spectrace integrate speckit` は `.specify/extensions/spectrace/` 配下に Spec Kit Extension 一式（少なくとも `extension.yml`、`commands/` ディレクトリ、`README.md`）を生成しなければならない。本機能リリース時点で本機能が対応する Spec Kit Extension スキーマ（`schema_version: "1.0"`）に従って生成すること。スキーマ定義は本機能のコード内に固定で保持し、外部 Extension（例: `agent-context`）の実行時参照には依存してはならない。
- **FR-002**: `spectrace integrate speckit` は `.specify/extensions.yml` の `installed` リストに `spectrace` を追加し、`hooks.after_tasks` に `spectrace scan && spectrace reconcile` 相当のコマンド登録を、`hooks.after_implement` に `spectrace check --diff` 相当のコマンド登録を、それぞれ Spec Kit のフックエントリ形式（`extension` / `command` / `enabled` / `optional` / `priority` / `prompt` / `description` / `condition`）で追記しなければならない。
- **FR-003**: `spectrace integrate speckit` の `--gate` フラグは「現在の状態を宣言する」セマンティクスを持たなければならない。`--gate` 指定時は `hooks.before_implement` に `spectrace check --gate` 相当のフック登録を追加し、無指定（または `--no-gate` 明示）時は spectrace が登録した同フックを削除する。デフォルト（フラグ無指定）は無し相当として扱う。これにより、フラグの有無を変えた再実行は必ず指定状態に収束する。
- **FR-004**: `spectrace integrate speckit` は冪等でなければならない。同じリポジトリで複数回実行しても、Extension ファイル・hook 登録の重複追加・上書きを発生させない。
- **FR-005**: `spectrace integrate speckit` は `.specify/` が存在しないリポジトリでは何も書き込まずに非ゼロ終了し、エラーメッセージで原因（Spec Kit 未検出）を伝えなければならない。
- **FR-006**: `spectrace integrate speckit` は生成・編集対象ファイルの書き込み権限が無い場合、ファイルシステムを変更せずに失敗し、原因を伝えなければならない。複数ファイル書き込みの途中で権限エラーが発生した場合も、それまでに書き込み済みのファイルをすべて元の状態に巻き戻し、部分適用を残してはならない（edge case「途中失敗時の巻き戻し」と整合）。
- **FR-007**: `spectrace integrate speckit` は `extensions.yml` の更新を原子的に行わなければならない（途中失敗時に部分適用を残さない）。

#### `spectrace integrate kiro` コマンド

- **FR-008**: `spectrace integrate kiro` は `.kiro/steering/spectrace.md` を生成し、その内容には少なくとも以下の運用指示を含めなければならない: (a) 実装前の `spectrace impact <path>` 実行タイミング、(b) 実装後の `spectrace check --diff` 実行タイミング、(c) drift 検出時の `spectrace reconcile` 実行手順。
- **FR-009**: `spectrace integrate kiro` は冪等でなければならない。既に `.kiro/steering/spectrace.md` が存在する場合、デフォルトでは上書きせず「統合済み」と通知し、`--force` フラグが指定されたときのみ再生成しなければならない。
- **FR-010**: `spectrace integrate kiro` は `.kiro/` が存在しないリポジトリでは何も書き込まずに非ゼロ終了し、原因を伝えなければならない。書き込み権限不足等で途中失敗した場合も、それまでに作成済みのファイル・ディレクトリをすべて元の状態に巻き戻し、部分適用を残してはならない。
- **FR-011**: `spectrace integrate kiro` は将来 Kiro 公式の Hook API が利用可能になった場合に、既存 Steering 利用者の設定を破壊せずに追加モードを提供できる拡張余地を持って設計しなければならない（具体実装は本イテレーションのスコープ外）。

#### `spectrace init` からの案内・one-shot 統合

- **FR-012**: `spectrace init` は `.specify/` を検出した場合、その後の標準出力末尾に Spec Kit 向け integrate コマンド（`spectrace integrate speckit`）の案内を表示しなければならない。ただし spectrace Extension が既に導入済みである場合は表示しない。
- **FR-013**: `spectrace init` は `.kiro/` を検出した場合、その後の標準出力末尾に Kiro 向け integrate コマンド（`spectrace integrate kiro`）の案内を表示しなければならない。ただし `.kiro/steering/spectrace.md` が既に存在する場合は表示しない。
- **FR-014**: `spectrace init` の検出ロジック自体（detect Spec Kit / detect Kiro）は本機能内の `spectrace integrate` と共通実装を共有し、検出条件のずれを起こさないこと。
- **FR-022**: `spectrace init` は `--integrate=<tool[,tool...]>` フラグを受け取れなければならない。値は `speckit` / `kiro`（カンマ区切りで複数可、`all` で検出済み全ツール）を取り、検出に成功したツールに対して対応する `spectrace integrate <tool>` と同等の処理を init 連続実行内で行う。指定したが未検出のツールは警告して当該ツール分のみスキップし、init 全体は失敗させない。
- **FR-023**: FR-022 の one-shot 実行であっても、`integrate` 単独実行時と同じ CLI 出力（FR-015：生成ファイル一覧・変更ファイル一覧・次に推奨するコマンド）を、ツールごとにブロック分けして必ず表示しなければならない。`init` 出力に紛れて変更が見落とされることを避けるため、明示的なセクション見出しを伴うこと。
- **FR-024**: FR-022 で行う統合は独立 `spectrace integrate <tool>` と完全に同じ実装（FR-018 のプロバイダ抽象経由）を呼び出さなければならない。`init` 経由かどうかで結果に差異が出てはならない。`--gate` 等の integrate 固有フラグは `--integrate-gate` のように接頭辞付きで init から受け渡せること。

#### 共通

- **FR-015**: `spectrace integrate <tool>` は実行結果として「生成したファイル」「変更したファイル」「次に実行を推奨するコマンド」をユーザー可読な形式で出力しなければならない。
- **FR-016**: 生成される Spec Kit Extension の `extension.yml` には `requires.speckit_version` を含み、本機能が対応する Spec Kit のバージョン下限を宣言しなければならない。下限の具体値は `contracts/speckit-extension-schema.md §1` に canonical 値として固定する（本イテレーション時点では `">=0.11.0"`、本リポジトリの `.specify/init-options.json` `speckit_version: "0.11.5"` 環境で動作確認することを最低基準とする）。Spec Kit 側のスキーマが破壊的に変わった場合は本機能側で明示的なバージョン分岐 PR を起こすこと（Clarifications Q3 と整合）。
- **FR-017**: Spec Kit Hook 経由で発火する spectrace コマンドは、Spec Kit ワークフローの終了コード規約に整合しなければならない（gate 検証失敗時は SDD ワークフローを停止させる）。
- **FR-018**: `spectrace integrate` のサブコマンド群は、SDD ツールごとの個別実装ではなく、共通の "integration provider" 抽象（少なくとも `detect` / `generate` / `install` の 3 操作を持つ）を介して実装されなければならない。speckit と kiro が本イテレーションでの 2 実装であり、将来 OpenSpec 等の追加プロバイダを既存コード変更なしに登録できる構造とすること。
- **FR-019**: `spectrace init` の SDD ツール検出ロジックは FR-018 のプロバイダ抽象が公開する `detect` を利用し、`integrate` 側と完全に同じ判定結果を返さなければならない（FR-014 の共通実装要件はこの抽象で満たす）。
- **FR-020**: Hook API を持たない SDD ツール向けのガイド文書生成（本イテレーションでは Kiro Steering、将来の OpenSpec Skills 等を含む）は、共通の "agent-guidance generator" レイヤを介して実装されなければならない。当該レイヤは「配置先 path」「テンプレート本体」「テンプレート変数」をプロバイダから受け取り、書き込み・冪等判定・`--force` 時の上書きを一元的に扱う。
- **FR-021**: Spec Kit Extension の YAML 追記処理（`.specify/extensions.yml` の `installed` / `hooks.*` 更新）は FR-020 のガイド文書生成レイヤとは独立した別レイヤとして実装しなければならない。両者の混在による冪等性破壊を避けること。

### Key Entities *(include if feature involves data)*

- **Spec Kit Extension マニフェスト**: `.specify/extensions/spectrace/extension.yml`。Extension の ID・名前・バージョン・依存 Spec Kit バージョン・provides commands・hooks 宣言を持つ。本機能が生成・管理する成果物。
- **Spec Kit Hooks レジストリ**: `.specify/extensions.yml`。インストール済み Extension 一覧と、ワークフロー段階（`after_tasks` / `before_implement` / `after_implement` 等）ごとに発火するコマンドエントリを持つプロジェクトレベルの設定ファイル。本機能は新規作成ではなく既存ファイルへの追記主体。
- **Kiro Steering エントリ**: `.kiro/steering/spectrace.md`。Kiro エージェントの振る舞いをガイドする Markdown 文書。トリガー条件と推奨コマンド列を含む。本機能では "agent-guidance generator" の最初の利用ケースとして実装される。
- **SDD ツール検出結果**: `spectrace init` と `spectrace integrate` が共有する、リポジトリにおける Spec Kit / Kiro / spectrace 統合の有無のスナップショット。永続化はせず、両コマンドで同じ判定ロジックを利用する。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Spec Kit を持つ既存リポジトリで `spectrace integrate speckit` を実行してから最初の `/speckit-implement` 完了までの間、ユーザーが追加で実行する手動 spectrace コマンドはゼロ回である。
- **SC-002**: `spectrace integrate speckit` を 2 回連続で実行した後の `.specify/extensions.yml` と `.specify/extensions/spectrace/` の差分は無し（バイナリ・YAML 構造ともに）であり、冪等性が保たれている。
- **SC-003**: `spectrace integrate kiro` 実行後、Kiro エージェントが「実装前の impact 確認」「実装後の check 実行」「drift 時の reconcile」の 3 つの運用フローを Steering 経由で自動提示する。
- **SC-004**: `.specify/` も `.kiro/` も存在しないリポジトリでは、`spectrace integrate <tool>` は 1 秒以内に検出エラーで終了し、ファイルシステムを一切変更しない。**計測条件**: Node.js 20 / SSD / warm cache（CLI バイナリは事前ビルド済み）の典型開発環境において、`integrate` プロセス起動から exit までの wall-clock 時間で計測する。CI 上のテストでも同条件を満たすことを E2E でアサートする（tasks.md T032 と T046 のタイミング検証）。
- **SC-005**: `spectrace init` を初めて実行したユーザーのうち、検出された SDD ツールについて 90% 以上が integrate コマンドの存在を出力から認識できる（初期メッセージで案内が確認可能）。
- **SC-007**: `spectrace init --integrate=all` を実行したユーザーは、画面出力のみから「どのツールに対して何ファイルが生成・変更されたか」「次に何を実行すべきか」を、追加コマンド無しに把握できる。
- **SC-006**: Spec Kit Hook 経由で発火する `spectrace check --diff` が drift / orphan / 未カバーを検出した場合、Spec Kit ワークフローのその段階を停止させ、ユーザーが原因と次のアクション（reconcile / 追加実装）を画面上から特定できる。

## Assumptions

- Spec Kit の Extension / Hook 機構（`.specify/extensions.yml` のスキーマ、`hooks.after_tasks` / `before_implement` / `after_implement` トリガー名、Hook コマンド名規約）は本機能の対象バージョン（`requires.speckit_version` で宣言）で安定している。
- Kiro の `.kiro/steering/` ディレクトリ規約は本機能リリース時点で公開仕様として有効であり、`*.md` を配置するだけでエージェントが読み込む。
- spectrace 自身の CLI コマンド `scan` / `reconcile` / `check --diff` / `check --gate` / `impact` は本機能リリース時点で利用可能である（既存 P1 機能）。
- `spectrace init` コマンド本体（P1）は本機能の前提として既に動作しており、本機能はその案内出力部分のみを拡張する。
- 同一リポジトリに Spec Kit と Kiro が同時に存在するケースを許容する（両方の integrate コマンドが独立に動作する）。
- 生成される Spec Kit Extension の構造規約は、本機能リリース時点の Spec Kit Extension スキーマ（`schema_version: "1.0"`）を本機能のコード内に固定で持つ。本リポジトリ内 `.specify/extensions/agent-context/` は人間がスキーマを理解するためのドキュメント上の参照例として位置づけ、実行時に解析・追従しない。Spec Kit 側のスキーマが破壊的に更新された場合は、本機能側で明示的にバージョン分岐 PR を起こして対応する。
- 本機能のスコープには、Claude Code Skill テンプレート（`/spectrace-check` 等）の同時配布は含めない（後続イテレーションで検討）。
- Kiro 用 Hook API への対応は将来追加のオプションとして扱い、本イテレーションでは Steering file 生成のみ実装する。
- 本機能のプロバイダ抽象は OpenSpec（GitHub Issue ShintaroMorimoto/artgraph#25 で検討中）を含む将来の SDD ツールを 3 つ目以降のプロバイダとして登録できる粒度で設計するが、本イテレーションでは OpenSpec 用プロバイダ実装そのものは含めない。
