---
description: "Task list for SDD ツールワークフロー統合 (009-sdd-integration) — TDD-ordered"
---

# Tasks: SDD ツールワークフロー統合 (Spec Kit Extension / Kiro Steering)

**Input**: Design documents under `specs/009-sdd-integration/`

**Prerequisites**: [spec.md](./spec.md) (required), [plan.md](./plan.md) (required), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: TDD（ユーザー指定）— **各 impl タスクの直前に必ず対応する Red テストが置かれる**。テストタスク自体は省略しない。

**Organization**: Tasks are grouped by user story to enable independent implementation and testing. Phase 1/2 が完了すれば、US1 と US2 は並列に実装可能。US3 は US1/US2 の少なくとも一方が完了していると価値を出せる。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 別ファイルで先行依存なし、並列実行可
- **[Story]**: US1=Spec Kit / US2=Kiro / US3=init 案内 + one-shot + list
- 各タスクは絶対パス・相対パスを含む

## Path Conventions

- **CLI source**: `packages/artgraph/src/`
- **Templates (distributed)**: `packages/artgraph/templates/`
- **Tests**: `packages/artgraph/tests/`
- **Fixtures**: `packages/artgraph/tests/fixtures/integrate/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 依存追加とディレクトリ骨格

- [X] T001 `packages/artgraph/package.json` に `yaml` (4.x) を `dependencies` として追加し、`pnpm install` でロックを更新する（research R3） — **実装メモ**: `yaml` の上流公開バージョンは 2.x（next タグの 3.0.0-1 が存在）。tasks.md / plan.md 上の "4.x" 表記は不正確。実装では `^2.9.0` を採用（Document API は本機能の編集要件を満たす）。
- [X] T002 [P] `packages/artgraph/src/integrate/` と `packages/artgraph/src/integrate/{providers,schemas}/` のディレクトリ骨格を `.gitkeep` で作成する
- [X] T003 [P] `packages/artgraph/templates/integrate/{speckit,speckit/commands,kiro}/` のディレクトリ骨格を作成する
- [X] T004 [P] `packages/artgraph/tests/integrate/{providers}/` と `packages/artgraph/tests/fixtures/integrate/` のディレクトリ骨格を作成する

**Checkpoint**: 依存追加とディレクトリが揃い、type 追加とテスト追加が開始可能

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: すべての user story が依存する共通基盤

**⚠️ CRITICAL**: ここが緑にならない限り US1/US2/US3 のいずれも進められない

- [X] T005 `packages/artgraph/src/types.ts` に integration 関連型を追加する: `IntegrationProviderId`、`IntegrationProvider`、`InstallOptions`、`IntegrateResult`、`IntegrationStatus`、`HookEntry`、`HookTrigger`、`GuidanceWriteRequest`、`GuidanceWriteResult`（data-model.md §1〜§5 の通り）

- [X] T006 [P] `packages/artgraph/tests/integrate/atomic-write.test.ts` を作成し、`atomicWriteFile(path, content)` の Red テストを書く: (a) 新規ファイル書き込み、(b) 既存上書きが atomic（rename）、(c) 途中失敗時に target 不変、(d) EACCES で throw、(e) 末尾改行付与なし（呼び出し側責務）
- [X] T007 `packages/artgraph/src/integrate/atomic-write.ts` を実装し T006 を Green にする（temp suffix にランダム文字列、`renameSync`、エラー時 `unlinkSync` で tmp 除去）

- [X] T008 [P] `packages/artgraph/tests/integrate/templates.test.ts` を作成し、`renderTemplate(template, vars)` の Red テストを書く: (a) `{{name}}` 置換、(b) 前後空白許容 `{{ name }}`、(c) 未定義 key で `MissingTemplateVarError`、(d) 同 key の複数出現
- [X] T009 `packages/artgraph/src/integrate/templates.ts` を実装し T008 を Green にする（正規表現 `\{\{\s*(\w+)\s*\}\}` ベースの単純置換 + テンプレート loader util `loadTemplate(relPath)`）

- [X] T010 [P] `packages/artgraph/tests/integrate/registry.test.ts` を作成し、`registerProvider` / `getProvider` / `listProviders` の Red テストを書く: (a) 登録順保証、(b) 未知 id で undefined、(c) 重複登録は例外
- [X] T011 `packages/artgraph/src/integrate/registry.ts` と `packages/artgraph/src/integrate/providers/types.ts` を実装し T010 を Green にする（Map<id, provider> を持つだけのシンプルレジストリ）

- [X] T012 [P] `packages/artgraph/tests/integrate/runner.test.ts` を作成し、`runIntegrate(rootDir, tool, opts)` の Red テストを書く: (a) 未知 tool で throw、(b) 登録済 provider に dispatch（dummy provider をテスト内で register）、(c) opts.uninstall でアンインストール経路
- [X] T013 `packages/artgraph/src/integrate/runner.ts` を実装し T012 を Green にする（registry.get → provider.install / provider.uninstall に dispatch）

- [X] T014 `packages/artgraph/src/integrate/index.ts` を作成し、`runIntegrate`、`registry` モジュール、provider 登録の初期化用 `registerBuiltinProviders()` を export する（US1/US2 が個別 provider を register する受け口）

- [X] T015 `packages/artgraph/src/cli.ts` に `program.command("integrate <tool>")` サブコマンドの skeleton を追加する: `--gate` / `--no-gate` / `--force` / `--uninstall` / `--format` / `--help` を commander に登録し、`runIntegrate` を呼ぶだけ。出力フォーマッタは US1/US2 で実装する仮実装（JSON.stringify でも可）

**Checkpoint**: 基盤 + CLI skeleton が緑。US1 と US2 を並列開始可能

---

## Phase 3: User Story 1 — Spec Kit Extension 自動組み込み (Priority: P1) 🎯 MVP

**Goal**: `artgraph integrate speckit` で `.specify/extensions/spectrace/` 一式と `.specify/extensions.yml` の hook 登録を冪等に生成・更新する（spec FR-001〜FR-007、FR-015〜FR-017、Clarifications Q3/Q4）。

**Independent Test**: `.specify/extensions.yml` を持つ tmpdir で `artgraph integrate speckit` 実行 → quickstart Scenario 1 のすべての Step（new install / 冪等再実行 / `--gate` / `--no-gate` / `--uninstall`）が期待通り。

### Tests for User Story 1 (TDD Red 先行)

- [X] T016 [P] [US1] `packages/artgraph/tests/integrate/schemas-speckit-1.test.ts` を作成し、`validateExtensionYaml` / `validateHookEntry` の Red テストを書く（contracts/speckit-extension-schema.md §5 のテスト要件 6 件 ＋ canonical manifest の roundtrip）
- [X] T017 [P] [US1] `packages/artgraph/tests/integrate/speckit-yaml.test.ts` を作成し、`parseExtensionsYaml` / `serializeExtensionsYaml` / `addInstalled` / `removeInstalled` / `addHookEntry` / `removeHookEntry` / `removeAllSpectraceHooks` の Red テストを書く（contracts/speckit-extension-schema.md §5 のテスト要件 11 件、コメント保持・キー順序を含む）
- [X] T018 [P] [US1] `packages/artgraph/tests/fixtures/integrate/specify-empty/.specify/extensions.yml` を作成（空 hooks）
- [X] T019 [P] [US1] `packages/artgraph/tests/fixtures/integrate/specify-with-other/.specify/extensions.yml` を作成（既存 agent-context の after_specify hook を含む）
- [X] T020 [P] [US1] `packages/artgraph/tests/fixtures/integrate/specify-already-installed/` を作成（`installed: [agent-context, spectrace]` + spectrace hook 登録済み + `.specify/extensions/spectrace/extension.yml` も配置）
- [X] T021 [P] [US1] `packages/artgraph/tests/integrate/providers/speckit.test.ts` を作成し、`SpecKitProvider` の Red テストを書く（contracts/integration-provider.md §テスト要件 のうち SpecKit に関する 13 ケース: detect / isInstalled partial / install idempotent / install throws on no detect / `--force` overwrite / `--gate=true` adds before_implement / `--gate=false` removes only own entry / `--gate=undefined` no-op / rollback on disk error / uninstall removes installed marker / uninstall preserves others / uninstall no-op when not installed）

### Implementation for User Story 1

- [X] T022 [US1] `packages/artgraph/src/integrate/schemas/speckit-1.0.ts` を実装し T016 を Green にする（`SPECKIT_SCHEMA_VERSION = "1.0"`、`SpecKitExtensionManifest`/`SpecKitInstalledExtensionsYaml` 型、`validateExtensionYaml`、`validateHookEntry`、`UnsupportedSchemaVersionError`）
- [X] T023 [US1] `packages/artgraph/src/integrate/speckit-yaml.ts` を実装し T017 を Green にする（`yaml` ライブラリの `Document` API を使い、comment/order 保持、`atomicWriteFile` 経由で書き戻し）
- [X] T024 [P] [US1] `packages/artgraph/templates/integrate/speckit/extension.yml` を contracts/speckit-extension-schema.md §1 の canonical 内容で作成
- [X] T025 [P] [US1] `packages/artgraph/templates/integrate/speckit/README.md` を contracts/speckit-extension-schema.md §4 の内容で作成
- [X] T026 [P] [US1] `packages/artgraph/templates/integrate/speckit/commands/artgraph.scan-reconcile.md` を contracts/speckit-extension-schema.md §3 の内容で作成
- [X] T027 [P] [US1] `packages/artgraph/templates/integrate/speckit/commands/artgraph.check-diff.md` を contracts/speckit-extension-schema.md §3 の内容で作成
- [X] T028 [P] [US1] `packages/artgraph/templates/integrate/speckit/commands/artgraph.check-gate.md` を contracts/speckit-extension-schema.md §3 の内容で作成
- [X] T029 [US1] `packages/artgraph/src/integrate/providers/speckit.ts` を実装し T021 を Green にする（detect: `.specify/` 存在判定、isInstalled: installed リスト + extension.yml の AND 判定、install: テンプレ展開 → atomic-write でディレクトリ生成 → speckit-yaml で extensions.yml 更新、--gate 宣言型ロジック、rollback リスト管理、uninstall: 逆操作）
- [X] T030 [US1] `packages/artgraph/src/integrate/index.ts` の `registerBuiltinProviders()` で `SpecKitProvider` を登録、`cli.ts` 起動時に呼ぶ（既存の `program.parse()` 前）
- [X] T031 [US1] `packages/artgraph/src/cli.ts` の `integrate <tool>` ハンドラで、`IntegrateResult` を contracts/integrate-cli.md §1 の Text フォーマット（✓ Integrated / Created / Modified / Removed / Next / warnings）と JSON フォーマットで出力する formatter を実装
- [X] T032 [P] [US1] `packages/artgraph/tests/integrate-cli.test.ts` に quickstart Scenario 1 を E2E 化（spawn artgraph CLI、tmpdir フィクスチャ、stdout/stderr/exit code 検証）。Step 1〜5 を個別 `it()` に分割

**Checkpoint**: US1 完了 — MVP。`artgraph integrate speckit` が動作し、Spec Kit Hook 経由で artgraph scan/reconcile/check が自動発火する状態

---

## Phase 4: User Story 2 — Kiro Steering 配布 (Priority: P2)

**Goal**: `artgraph integrate kiro` で `.kiro/steering/spectrace.md` を冪等に生成する（spec FR-008〜FR-011、Clarifications Q2）。共通 agent-guidance generator を導入し、将来 OpenSpec 等にも転用できる構造を確立する。

**Independent Test**: `.kiro/` を持つ tmpdir で `artgraph integrate kiro` 実行 → quickstart Scenario 2（new install / 冪等再実行 / `--force` 上書き / `.kiro/` 不在で fail）がすべて期待通り。US1 の有無に依存しない。

### Tests for User Story 2 (TDD Red 先行)

- [X] T033 [P] [US2] `packages/artgraph/tests/integrate/guidance.test.ts` を作成し、`writeGuidanceFile` の Red テストを書く（contracts/agent-guidance.md §テスト要件 の 10 ケース: new write / no-op on match / no-op on differ+!force / overwrite on differ+force / createParentDirs auto / fails without createParentDirs / atomicity / trailing newline / renderTemplate substitution / renderTemplate missing var throws ※後者 2 つは T008 と重複する場合は省略可）
- [X] T034 [P] [US2] `packages/artgraph/tests/fixtures/integrate/kiro-empty/.kiro/steering/.gitkeep` を作成（`.kiro/steering/` ディレクトリのみ存在）
- [X] T035 [P] [US2] `packages/artgraph/tests/fixtures/integrate/kiro-installed/.kiro/steering/spectrace.md` を作成（既存導入済みケース）
- [X] T036 [P] [US2] `packages/artgraph/tests/integrate/providers/kiro.test.ts` を作成し、`KiroProvider` の Red テストを書く（detect / isInstalled / install new / install idempotent / install --force overwrite / install fails when no .kiro/ / uninstall removes file / uninstall no-op when absent）

### Implementation for User Story 2

- [X] T037 [US2] `packages/artgraph/src/integrate/guidance.ts` を実装し T033 を Green にする（`writeGuidanceFile(req)`: 既存 read → byte 比較 → atomic-write or skip、`createParentDirs` 制御、末尾改行付与）
- [X] T038 [P] [US2] `packages/artgraph/templates/integrate/kiro/spectrace.md` を research.md §R4 の内容で作成（frontmatter なし、impact / check / reconcile 説明 + コマンド表）
- [X] T039 [US2] `packages/artgraph/src/integrate/providers/kiro.ts` を実装し T036 を Green にする（detect: `.kiro/` 存在判定、isInstalled: `.kiro/steering/spectrace.md` 存在判定、install: template 読み込み → guidance generator 呼び出し、uninstall: ファイル削除）
- [X] T040 [US2] `packages/artgraph/src/integrate/index.ts` の `registerBuiltinProviders()` に `KiroProvider` 登録を追加
- [X] T041 [P] [US2] `packages/artgraph/tests/integrate-cli.test.ts` に quickstart Scenario 2 を E2E 化（Step 1〜4 を個別 `it()` に）

**Checkpoint**: US2 完了 — Kiro 利用者にも artgraph 統合が届く

---

## Phase 5: User Story 3 — init 案内表示 + one-shot 統合 + integrate list (Priority: P3)

**Goal**: `artgraph init` 出力に統合案内を追加し（FR-012〜FR-014）、`artgraph init --integrate=<tools>` で one-shot 統合（FR-022〜FR-024）、`artgraph integrate list` で provider 一覧表示（ユーザー指定）を提供する。

**Independent Test**: quickstart Scenario 3（list）/ Scenario 4（init --integrate=all）/ Scenario 5（init Tip）がすべて期待通り。US1/US2 のどちらかが完了している前提だが、US3 自体の機能境界は init 拡張と list 表示で独立にテスト可能。

### Tests for User Story 3 (TDD Red 先行)

- [X] T042 [P] [US3] `packages/artgraph/tests/integrate/registry.test.ts`（既存）に `listProviders().map(p => ({ id, displayName, marker, detected, installed }))` 用ヘルパ `getProviderStatuses(rootDir)` の Red テストを追加（または `packages/artgraph/src/integrate/index.ts` に export する関数の単体テストを作成） — **実装メモ**: 新規 `packages/artgraph/tests/integrate/index.test.ts` を作成し、`getProviderStatuses` の 4 ケース（順序保証 / 空 repo / detect 反映 / displayName+marker 伝搬）を追加。
- [X] T043 [P] [US3] `packages/artgraph/tests/integrate-cli.test.ts` に `integrate list` の Red テストを追加（text 出力で speckit/kiro が登録順に表示、JSON 出力が `IntegrationStatus[]` schema 準拠）
- [X] T044 [P] [US3] `packages/artgraph/tests/init.test.ts`（既存）に `detectProject` 拡張の Red テストを追加（`integrations` フィールドが `IntegrationStatus[]` を返す、detect/installed 状態が provider と整合）
- [X] T045 [P] [US3] `packages/artgraph/tests/integrate-cli.test.ts` に Scenario 5 の init Tip 出力 Red テストを追加（Spec Kit 検出 & 未導入 → Tip 表示 / Spec Kit 検出 & 導入済 → Tip 非表示 / 両ツール検出 → 2 件 Tip）
- [X] T046 [P] [US3] `packages/artgraph/tests/integrate-cli.test.ts` に Scenario 4 の `init --integrate=<tools>` Red テストを追加（`speckit` 単独 / `kiro` 単独 / `all` / 未検出ツール指定で警告 + exit 0 / `--integrate-gate` 透過 / 出力にツール別セクション）

### Implementation for User Story 3

- [X] T047 [US3] `packages/artgraph/src/integrate/index.ts` に `getProviderStatuses(rootDir): IntegrationStatus[]` を追加実装し T042 を Green にする（`registry.listProviders().map(...)`、`detect()` + `isInstalled()` を呼ぶ）
- [X] T048 [US3] `packages/artgraph/src/init.ts` の `detectProject` を改修し、戻り値 `DetectionResult.integrations` を `getProviderStatuses(rootDir)` の結果で埋める（既存 `sddTools` は互換のため残す）。T044 を Green に
- [X] T049 [US3] `packages/artgraph/src/cli.ts` に `program.command("integrate").command("list")` 階層的サブコマンドを追加し、`getProviderStatuses(rootDir)` を text/JSON でフォーマット。T043 を Green に（contracts/integrate-cli.md §2 のフォーマット） — **実装メモ**: commander 13 で `integrate <tool>` と sub-sub-command を共存させるのが煩雑なため、`tool === "list"` で内部 dispatch する方式を採用（T050 参照）。出力は contracts §2 の text/JSON フォーマットに準拠。
- [X] T050 [US3] `packages/artgraph/src/cli.ts` の `integrate <tool>` 形式が `integrate list` と衝突しないよう、commander の sub-sub-command パターンを整理する（必要なら `integrate-list` エイリアスや tool 引数の正規化） — **実装メモ**: tool 引数の値で分岐する argument-based dispatch を採用（`runIntegrateList` を別関数化）。`artgraph integrate list` / `artgraph integrate speckit` / `artgraph integrate kiro` の 3 形式とも動作。
- [X] T051 [US3] `packages/artgraph/src/init.ts` の `runInit` text フォーマッタに「Tip: ... Run `artgraph integrate <id>` ...」行を追加し、`detected && !installed` の provider についてのみ表示する。T045 を Green に — **実装メモ**: Tip 出力は `src/cli.ts` の `printIntegrationTips()` に置き、`runInit` は `DetectionResult.integrations` を返す責務に留めた（formatter の責務分離）。
- [X] T052 [US3] `packages/artgraph/src/types.ts` の `InitOptions` に `integrations?: IntegrationProviderId[] | "all"` と `integrateGate?: boolean` を追加
- [X] T053 [US3] `packages/artgraph/src/init.ts` の `runInit` に `integrations` オプション処理を追加: 指定された provider に対して `runIntegrate` を順次呼び、結果を `InitResult.integrationResults: IntegrateResult[]` として返す。未検出 provider は warning を積みつつ continue（init 全体は exit 0）
- [X] T054 [US3] `packages/artgraph/src/cli.ts` の `init` ハンドラに `--integrate <tools>` / `--integrate-gate` / `--no-integrate-gate` フラグを追加し、`runInit({integrations, integrateGate})` に渡す。出力 formatter で `=== Integration: <id> ===` セクション見出しを伴ってツール別ブロックを表示。T046 を Green に

**Checkpoint**: US3 完了 — 発見性 + 一発統合 + 状態確認が揃う

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: 品質保証・regression 防止・ドキュメント整備

- [X] T055 [P] `packages/artgraph/tests/integrate-cli.test.ts` に quickstart Scenario 6（rollback）を E2E 化: `fs.renameSync` (実際には `atomicWriteFile`) を mock して 2 ファイル目で throw → 1 ファイル目も削除済み・disk が install 前と一致することを検証 — **実装メモ**: `spawnSync` 子プロセス境界を越えた mock は不可能なため、CLI ハンドラと同一の `SpecKitProvider.install` を直接呼び in-process で `atomicWriteFile` を spy する形で E2E 化（quickstart.md §シナリオ6 末尾の注記とも整合）。2 ケース追加: (1) 2 番目の write で throw → ext dir 全削除、(2) extensions.yml の atomic-write で throw → ext dir + yml すべて巻き戻し。
- [X] T056 [P] `packages/artgraph/tests/init.test.ts` 既存テストすべてが緑のまま通ることを確認し、必要なら新フィールド `integrations` を期待値に追加する regression 修正 — **実装メモ**: Phase 5 (T044/T048) で `integrations` フィールドはすでに追加・テスト済み。本タスクは確認のみで passthrough。
- [X] T057 [P] `packages/artgraph/knip.json` に新規ファイル（`src/integrate/**`、`templates/integrate/**`）を inspection 対象として登録し、`pnpm -C packages/artgraph knip` で未使用検出ゼロを確認 — **実装メモ**: knip 設定は触らず、未使用扱いだった 3 件（`writeExtensionsYaml` / `SpecKitInstalledExtensionsYaml` / `src/integrate/providers/types.ts`）を実際に削除。`templates/integrate/**` は静的アセットで knip の対象外。
- [X] T058 [P] `pnpm oxlint` と `pnpm oxfmt` を新規ファイル全体に対して通し、警告ゼロにする — **実装メモ**: `src/integrate` / `tests/integrate*` / `templates/integrate` で oxlint 警告ゼロ。oxfmt は新規ファイル含め全件適用済み（既存 oxlint 警告は本機能スコープ外の resident issue）。
- [X] T059 [P] `packages/artgraph/README.md` に `integrate` / `integrate list` / `init --integrate` の節を追加し、quickstart リンクを張る
- [X] T060 [P] `docs/p2-roadmap.md` の SDD 統合に関する項目に本機能リリース済み旨を追記（issue #16 の参照付き）
- [X] T061 quickstart.md の全シナリオ（1〜6）を手動 + E2E で一周し、spec.md の SC-001〜SC-007 がすべて観察可能な形で達成されていることを確認 — **実装メモ**: `tests/integrate-cli.test.ts` の 31 ケースが Scenario 1〜6 を網羅。SC-001〜SC-007 のカバレッジは Phase 7 の Coverage Update 表に明記。
- [X] T062 `pnpm -r build && pnpm -r test` を root から実行し、本機能の全テスト + 既存テストが緑であることを確認

---

## Phase 7: Remediation from /speckit-analyze (2026-06-23)

**Purpose**: `/speckit-analyze` の HIGH+MEDIUM 指摘（C1 / C2 / A1）に対応する追加タスク群。Phase 3〜5 の対応 user story が完了した直後に着手し、Phase 6 (Polish) と並列に処理して良い。

### SC-006 / FR-017: Gate halt verification（C1）

- [X] T063 [P] [US1] `packages/artgraph/tests/integrate-cli.test.ts` に SC-006 / FR-017 を直接検証する E2E を追加する: (a) `.specify/` + 既知の uncovered を仕込んだ fixture を用意、(b) `artgraph init --integrate=speckit --integrate-gate` で gate hook を登録、(c) `artgraph check --gate` を直接呼び出して exit code 2 で終了することを確認、(d) stdout に `UNCOVERED:` 一覧（GATE-001 / GATE-002）が含まれ Spec Kit ワークフローが当該段階で停止する条件を満たすこと、`--format json` 出力で `pass: false` + `uncovered: [...]` が外部 hook 消費者向けに観察可能であることを assert
- [X] T064 [US1] `packages/artgraph/tests/fixtures/integrate/specify-with-gate-failure/` を作成する: `.specify/extensions.yml`（agent-context のみ pre-seed）+ `specs/uncovered.md`（GATE-001 / GATE-002 を未カバー状態で宣言）。T063 が `init --integrate=speckit --integrate-gate` でその上に spectrace 一式と before_implement hook を installs する。

### FR-011: Kiro future hook API extensibility（C2）

- [X] T065 [P] [US2] `packages/artgraph/tests/integrate/providers/kiro.test.ts` に「将来 Kiro 公式 Hook API が利用可能になった場合の追加モード受け入れ余地」を担保する設計テストを追加 — `describe("FR-011 forward-compat design (T065)")` 2 ケース: (a) 将来 `mode?: "steering" | "hook"` を追加した `FutureInstallOptions` で `install` を呼び出した時に既存 Steering モードと同等動作 + 冪等性を維持、(b) `mode: "hook"` を渡しても既存 `.kiro/steering/spectrace.md` が削除・改変されないこと（migration ガード相当）。
- [X] T066 [US2] `packages/artgraph/src/integrate/providers/kiro.ts` に FR-011 拡張余地を実装 — `opts.force` のみを明示的に読み取り、未知フィールド（`mode` 等）は silently ignore する forward-compat 動作を実装 + コメントで将来の hook mode 追加時の責務（migration step 必須）を明記
- [X] T067 [P] [US1] `packages/artgraph/tests/integrate-cli.test.ts` で `artgraph integrate speckit` の detect 失敗パス（`.specify/` 不在 tmpdir）について `process.hrtime.bigint()` で wall-clock を計測し、1500ms 未満を hard ceiling として assert、1000ms 超過は `console.warn` で soft target 報告（spec SC-004 計測条件・CI flaky 回避）。Warm cache を作るため事前に `--version` を一度実行
- [X] T068 [P] [US2] T067 と同等のテストを `artgraph integrate kiro` の detect 失敗パス（`.kiro/` 不在 tmpdir）に対して追加（同じ 1500ms ハードリミット + 1000ms ソフト target）

### Remediation 完了確認

- [X] T069 T063〜T068 すべてが Green であり、spec.md の FR-006/FR-010（rollback 文言追記）/ FR-011 / FR-016 / FR-017 / SC-004 / SC-006 がすべて少なくとも 1 つのテストでカバーされていることを再確認。Coverage Update 表（本ファイル末尾）を参照

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 依存なし。最初に着手
- **Foundational (Phase 2)**: Setup 完了が必須。**US1/US2/US3 を全部ブロック**
- **US1 (Phase 3, P1)**: Foundational 完了後に着手可能
- **US2 (Phase 4, P2)**: Foundational 完了後に着手可能。US1 と並列可
- **US3 (Phase 5, P3)**: Foundational 完了後に着手可能だが、価値検証には US1 か US2 のどちらかが完了していることが望ましい
- **Polish (Phase 6)**: 対象とする US 完了後
- **Remediation (Phase 7)**: 対象 US（C1/C2/A1）が完了した直後に着手。Phase 6 と並列実行可能。T063-T066 は対応 US（US1 / US2）の検証を強化する位置づけで、対象 US の receivers を破壊しないこと

### Within Foundational (Phase 2)

T005 (types) → T006-T013 が並列可能（test → impl のペアで順次）。registry/runner は他に依存しないので T010/T011 と T012/T013 はペア内で順次、ペア間で並列可。T014 (index) → T015 (CLI skeleton) は最後。

### Within Each User Story

- **TDD 厳守**: 各 impl タスクの直前に対応する Red テストタスクを完了させる
- US1: T016〜T021 を並列に作成（fixture と test 別ファイル）→ T022 (schema) → T023 (yaml editor) → T024-T028 (テンプレ作成、並列) → T029 (provider) → T030 (register) → T031 (CLI formatter) → T032 (E2E)
- US2: T033〜T036 を並列に作成 → T037 (guidance) → T038 (テンプレ作成、並列) → T039 (provider) → T040 (register) → T041 (E2E)
- US3: T042〜T046 を並列に作成 → T047〜T054 を依存順に（T047/T048 → T049/T050 → T051 → T052/T053 → T054）

### Parallel Opportunities

- Phase 1: T002/T003/T004 並列
- Phase 2: 4 つの test-impl ペア（atomic-write / templates / registry / runner）はペア内順次・ペア間並列
- Phase 3 内: T016〜T021（test/fixture）並列、T024〜T028（テンプレ作成）並列
- Phase 4 内: T033〜T036（test/fixture）並列
- Phase 5 内: T042〜T046（test 群）並列
- Phase 3 と Phase 4 はチーム作業時に並列可（共通ファイル `index.ts` / `cli.ts` は最後に統合）
- Phase 6: T055〜T060 並列可、T061/T062 は最後
- Phase 7: T063 (US1 gate halt E2E) / T065 (US2 future hook test) / T067 (US1 wall-clock) / T068 (US2 wall-clock) は別ファイルで並列可。T064 は T063 の fixture 依存。T066 は T065 を Green にする実装。T069 は最後

---

## Parallel Example: User Story 1 ハッシュ

```text
# Foundational 完了後、US1 を立ち上げる時の最初のひと固まり（テスト + fixture + テンプレ）
T016 [P] [US1] schemas test    (tests/integrate/schemas-speckit-1.test.ts)
T017 [P] [US1] yaml editor test (tests/integrate/speckit-yaml.test.ts)
T018 [P] [US1] fixture specify-empty
T019 [P] [US1] fixture specify-with-other
T020 [P] [US1] fixture specify-already-installed
T021 [P] [US1] provider test    (tests/integrate/providers/speckit.test.ts)
T024 [P] [US1] template extension.yml
T025 [P] [US1] template README.md
T026 [P] [US1] template command scan-reconcile.md
T027 [P] [US1] template command check-diff.md
T028 [P] [US1] template command check-gate.md
```

これらが完了して初めて T022→T023→T029→T030→T031→T032 の順次実装に入る。

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1 Setup を完了（T001〜T004）
2. Phase 2 Foundational を完了（T005〜T015）
3. Phase 3 User Story 1 を TDD 厳守で完了（T016〜T032）
4. **STOP & VALIDATE**: quickstart Scenario 1 を手動再現。Spec Kit 利用ユーザーへ MVP として配布可能

### Incremental Delivery

1. Setup + Foundational → 基盤完了
2. **US1 完了 → MVP リリース** （Spec Kit ユーザーが価値を得る）
3. US2 完了 → Kiro ユーザーへの範囲拡大
4. US3 完了 → 発見性向上 + 一発統合 + 状態確認
5. Polish → 品質保証

### Parallel Team Strategy

- Dev A: US1（Spec Kit）
- Dev B: US2（Kiro）
- Dev C: US3（init/list）— US1 か US2 の `IntegrationStatus` 出力に依存するので、レジストリスケルトンが揃った時点で着手
- 共通ファイル（`src/cli.ts` / `src/integrate/index.ts`）は触る順序を Slack / PR で調整し、衝突を避ける

---

## Suggested MVP Scope

**User Story 1 (Phase 3) のみ** — 本機能の主目的（spec で P1）。`.specify/` を持つ既存ユーザー全員が即時恩恵を受けられる。Kiro 統合（US2）と init 拡張（US3）は段階的に追加可能。

---

## Notes

- [P] tasks = 別ファイルで依存なし、並列実行可
- [Story] label = US1/US2/US3 で traceability
- 各 user story は独立に完成・テスト可能
- TDD: Red テストが先、Green impl が後、Refactor は安全網が整ってから
- 各タスクごとにコミット推奨（小さな PR 単位）
- 各 checkpoint で validate してから次へ進む
- 避けること: 曖昧なタスク・同一ファイルでの並列 [P]・user story 間の不要な依存

---

## Coverage Update（/speckit-analyze remediation 2026-06-23 反映後）

| Requirement | Pre-remediation | Post-remediation tasks |
|---|---|---|
| FR-006（権限なし fail + rollback）| Partial（T007 のみ）| T029 + T063〜T064 + 既存 rollback E2E (T055) |
| FR-010（Kiro 失敗 + rollback）| Partial（fail のみ）| T039 + T055 + T068 |
| FR-011（Kiro 将来 hook API 余地）| 未カバー | T065 + T066 |
| FR-016（speckit_version 具体値）| Partial（具体値不在）| contracts/speckit-extension-schema.md §1 で `>=0.11.0` を canonical 化 + T022 で参照 |
| FR-017（Hook 終了コード規約）| 未カバー | T063 + T064 |
| SC-004（1 秒以内）| Partial（計測条件不在）| spec SC-004 に計測条件明記 + T067 + T068 |
| SC-006（gate halt 観察可能）| 未カバー | T063（出力フォーマット + exit code）|

これにより `/speckit-analyze` の HIGH+MEDIUM 6 件（I1 / I2 / C1 / C2 / A1 / U1）はすべて spec.md / tasks.md / contracts に反映され、対応する verification タスクが存在する状態になった。残る LOW 9 件は実装中の改善で対応可。
