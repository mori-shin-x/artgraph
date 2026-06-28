# Feature Specification: package manager 非依存化の基盤 + 既存配布物の PM 非依存化 + Bun/Deno smoke test

**Feature Branch**: `claude/artgraph-issue-102-1dn27j`

**Created**: 2026-06-28

**Status**: Draft

**Input**: User description: 「spec 012-skills-expansion ([#98](https://github.com/ShintaroMorimoto/artgraph/issues/98)) で `artgraph-setup` Skill 内に最小の package manager 検出ロジックを組み込んだが、artgraph の配布物全体・docs はまだ `npx artgraph` 前提の表記が残る。完全な package manager 非依存化を [#102](https://github.com/ShintaroMorimoto/artgraph/issues/102) で扱う。」

**Parent issue**: [#102](https://github.com/ShintaroMorimoto/artgraph/issues/102) — pkg-mgr agnosticism follow-up

**Related**: [#98](https://github.com/ShintaroMorimoto/artgraph/issues/98) (spec 012, 最小 pkg-mgr 検出を `artgraph-setup` Skill に組み込み済), [#109](https://github.com/ShintaroMorimoto/artgraph/issues/109) (split: `installHooks` + `settings.json.template`), [#110](https://github.com/ShintaroMorimoto/artgraph/issues/110) (split: `installAgentContext` + agent-context テンプレ), [#111](https://github.com/ShintaroMorimoto/artgraph/issues/111) (split: `.claude-plugin` 配布 + plugin hooks)

## 背景と前提の訂正 *(重要)*

本 spec 着手にあたりコードベースを精査した結果、issue #102 が前提とする「spec 012 完了後の想定」と実態に乖離があった。**spec 012 は Skills 部分のみ出荷済みで、hooks / plugin / agent-context は未実装スタブ**である:

| issue #102 が前提とした対象 | 実態 |
|---|---|
| `templates/hooks/settings.json.template` | ❌ 存在しない。`installHooks()` は空スタブ (`src/init.ts:357`) |
| `.claude-plugin/hooks/hooks.json` | ❌ 存在しない。`.claude-plugin/` 自体なし |
| `templates/agent-context/*.md` | ❌ 存在しない。`installAgentContext()` も空スタブ (`src/init.ts:365`) |
| `templates/skills/*/SKILL.md` 本文 | ✅ 存在。一部は既に PM 非依存 (`artgraph-setup` フル対応表、`artgraph-detect` は `<PM-exec>` 表現) |
| `README.md` Quickstart | ✅ 既に 4 PM 列挙済 (L19-24)。本文の例は `npx artgraph` のまま |

加えて `ArtgraphConfig` に `packageManager` フィールドはなく、PM 検出ロジックは `src/` に一切存在しない (`_shared/package-manager.md` の bash スニペットとしてのみ存在)。

したがって「存在しないテンプレを templating する」という当初チェックリストは成立しない。本 spec は **(a) PM 非依存化の基盤 (検出 + 記録 + exec 組み立て)** と **(b) 既に存在する配布物 (Skills / README / docs) の PM 非依存化** と **(c) Bun/Deno smoke test** に絞る。hooks / agent-context / plugin の templating は、機能本体を実装する別 issue (#109 / #110 / #111) が本 spec の基盤を consume して最初から PM 非依存で作る (= 二度手間回避)。

## User Scenarios & Testing *(mandatory)*

### User Story 1 — PM 検出基盤と `.artgraph.json` への記録 (Priority: P1)

ユーザーが bun プロジェクト (`bun.lockb` あり) で `bunx artgraph init` を実行する。`init` は package manager を `bun` と検出し、`.artgraph.json` に `"packageManager": "bun"` を記録する。以降 artgraph の各機能 (本 spec の対象外だが #109/#110/#111 が consume する) は、毎回 lockfile を再 sniff せずこの記録値から exec コマンド (`bunx artgraph ...`) を組み立てられる。

**Why this priority**: これが本 spec の中核であり、切り出した別 issue (#109/#110/#111) すべてが依存する基盤。これ無しに hooks/agent-context/plugin を PM 非依存化しようとすると各々が独自に検出を再実装してしまう。検出ロジックを `src/` に一本化し記録することで、再検出コストと実装重複の両方を消す。

**Independent Test**: `bun.lockb` を置いた一時 dir で `runInit` を呼び、生成された `.artgraph.json` に `"packageManager": "bun"` が含まれることを確認。`pnpm-lock.yaml` のみの dir なら `"pnpm"`、`package-lock.json` のみなら `"npm"`、`deno.json` のみ (package.json 無し) なら `"deno"`、`yarn.lock` のみなら `"npm"` + warning が確認できる。

**Acceptance Scenarios**:

1. **Given** `package.json` に `"packageManager": "pnpm@9.0.0"` がある dir、 **When** `runInit` 実行、 **Then** `.artgraph.json` に `"packageManager": "pnpm"` が記録される (corepack field 優先)。
2. **Given** `bun.lockb` のみの dir、 **When** `runInit` 実行、 **Then** `"packageManager": "bun"`。
3. **Given** `package.json` 無し + `deno.json` のみの dir、 **When** `runInit` 実行、 **Then** `"packageManager": "deno"`。
4. **Given** `yarn.lock` のみの dir、 **When** `runInit` 実行、 **Then** `"packageManager": "npm"` が記録され、Yarn 非対応の warning が stderr に出る。
5. **Given** どの lockfile も `packageManager` field も無いが `package.json` がある dir、 **When** `runInit` 実行、 **Then** `"packageManager": "npm"` (default)。
6. **Given** PM が検出できない dir (package.json も lockfile も deno もない)、 **When** `runInit` 実行、 **Then** `init` は失敗せず `packageManager` を省略 (or 記録なし) し、警告のみ出す。
7. **Given** 検出済 PM、 **When** `buildExecCommand("deno", "check --diff")` を呼ぶ、 **Then** `"deno run -A npm:artgraph/cli check --diff"` を返す。

---

### User Story 2 — 既存 Skill の PM 非依存化 (Priority: P1)

bun ユーザーが配備済 Skill (`artgraph-verify` 等) を発火させたとき、Skill 本文のコマンド例が `npx artgraph` 固定ではなく「プロジェクトの package runner を使う」表現になっており、エージェントが `bunx artgraph check --diff` を選べる。`allowed-tools` frontmatter も npm 以外の exec を pre-approve しているため、bun/pnpm/deno でも追加の許可プロンプトが出ない。

**Why this priority**: Skill は既に配布されている実体で、今すぐ PM 非依存化できる。`artgraph-setup` / `artgraph-detect` は既に対応済なので、残り Skill を同じパターンに揃えるだけで一貫性が出る。frontmatter の `allowed-tools` が `npx artgraph *` 固定だと bun/pnpm/deno ユーザーで pre-approve が効かず体験が劣化する。

**Independent Test**: `templates/skills/*/SKILL.md` を grep し、本文の生コマンド例に裸の `npx artgraph` が残っていない (= `<PM-exec>` 等のプレースホルダ表現か `artgraph` 単体) ことを確認。`allowed-tools` に `Bash(artgraph *)` が含まれる (= local bin 解決の包括 pre-approve) ことを確認。

**Acceptance Scenarios**:

1. **Given** 改訂後の全 `templates/skills/*/SKILL.md`、 **When** 本文 (frontmatter 除く) を grep、 **Then** 裸の `npx artgraph <subcommand>` 形のコマンド例が 0 件 (プレースホルダ or `artgraph` 単体に統一)。
2. **Given** 各 Skill の frontmatter、 **When** `allowed-tools` を確認、 **Then** `Bash(artgraph *)` を含む (PM 非依存の包括 pre-approve)。`npx artgraph *` 等の個別 exec は補助として残してよい。
3. **Given** `artgraph-setup` の PM 対応表、 **When** 確認、 **Then** npm/pnpm/bun/deno の install/exec マッピングが維持されている (退行なし)。

---

### User Story 3 — README / docs の PM 非依存化 (Priority: P2)

bun/deno ユーザーが README や `docs/skills-guide.md` を読んだとき、コマンド例が npm 専用に見えず、自分の package manager で読み替えられる。Quickstart は既に 4 PM を列挙しているので、本文の個別コマンド例 (`npx artgraph reconcile` 等) も同様に PM 非依存にする。

**Why this priority**: ドキュメントの整合性。CLI / Skill が PM 非依存でも docs が npm 固定だと新規ユーザーを誤誘導する。P2 なのは「コードと Skill が固まってから書く」順序のため。

**Independent Test**: `README.md` と `docs/skills-guide.md` を grep し、PM 固定の生コマンド例が「PM 非依存の注記つき」または「裸の `artgraph`」になっていることを確認。Quickstart の 4 PM 列挙は維持。

**Acceptance Scenarios**:

1. **Given** 改訂後 README、 **When** 本文の artgraph 実行例を確認、 **Then** `npx` 固定ではなく PM 非依存の表現 (Quickstart の 4 PM 列挙、または「your package runner」注記) になっている。
2. **Given** 改訂後 `docs/skills-guide.md`、 **When** L25-26 等の `npx artgraph init` 例を確認、 **Then** PM 非依存表現に更新されている。

---

### User Story 4 — Bun / Deno での CLI smoke test + CI matrix (Priority: P2)

メンテナが CI を見たとき、artgraph CLI が npm だけでなく bun / deno でも `init` / `check` を完走することが matrix job で保証されている。とくに `ts-morph` (TypeScript compiler 依存) が Deno の Node 互換レイヤで動くかどうかが可視化される。

**Why this priority**: 「PM 非依存」を謳う以上、実ランタイムでの動作保証が無いと表記だけの非依存になる。issue #102 のスコープ質問1 で「#102 に含める」と合意済。Deno は独自 TS パーサを持つため `ts-morph` 互換性が最大のリスクで、smoke test で早期に顕在化させる価値が高い。

**Independent Test**: CI で `bunx artgraph init` → `bunx artgraph check` が exit 0、`deno run -A npm:artgraph/cli init` → `... check` が exit 0 (または既知の制約を明示) になることを確認。

**Acceptance Scenarios**:

1. **Given** CI matrix に bun job、 **When** 最小 fixture で `bunx artgraph init` → `check`、 **Then** 両方 exit 0。
2. **Given** CI matrix に deno job、 **When** `deno run -A npm:artgraph/cli init` → `check`、 **Then** exit 0。**もし `ts-morph` 非互換で失敗する場合**は、Deno を「既知の未サポート」として明示し (docs の対応表から deno を一旦外すか注記)、CI job を許容失敗 (continue-on-error) かスキップにする判断を research で確定する。
3. **Given** matrix の npm / pnpm job、 **When** 同 smoke test、 **Then** 退行なく exit 0。

---

### Edge Cases

- **`packageManager` field と lockfile の不一致**: `package.json#packageManager` が `pnpm` だが `package-lock.json` も存在する場合、field を優先 (spec 012 と同じ。corepack convention)。
- **multiple lockfile**: `bun.lockb` と `pnpm-lock.yaml` が両方ある場合、`_shared/package-manager.md` の検出順 (bun が先) に従い first match。検出順は TS 移植でも完全に踏襲する。
- **deno.json + package.json 併存**: `package.json` がある場合は deno 判定をスキップ (Node プロジェクトとして扱う)。`package.json` 無しのときのみ deno。
- **検出不能**: `init` を壊さない。`packageManager` を記録せず警告のみ。後続機能 (#109/#110) は記録欠如時 `npx artgraph` を安全な default にフォールバック。
- **既存 `.artgraph.json` に `packageManager` がある状態で再 init**: `--force` 無しは従来通りエラー。`--force` 時は再検出して上書き。
- **Yarn**: 引き続き対象外。検出時は npm fallback + warning (spec 012 踏襲)。本 spec で Yarn サポートは追加しない。
- **Deno の `ts-morph`**: Deno の Node 互換で `ts-morph` が動かない可能性。動かない場合は「Deno は当面 best-effort / 未サポート」と明示し、対応表・smoke test を現実に合わせる (誇大表記を避ける)。
- **`bunx` vs `npx` の resolver**: Skill / docs では bun ユーザーに `bunx` を案内する (npx は Bun の resolver を迂回するため非推奨)。これは `_shared/package-manager.md` の既存方針を踏襲。

## Requirements *(mandatory)*

### Functional Requirements

**PM 検出基盤 (US1)**

- **FR-001**: `src/package-manager.ts` (新規) に PM 検出関数 `detectPackageManager(rootDir): "npm" | "pnpm" | "bun" | "deno"` を実装する。ロジックは `templates/skills/_shared/package-manager.md` の bash スニペットを **逐語的に TypeScript へ移植**する (検出順・分岐を完全一致させる)。
- **FR-002**: 検出順序は次を厳守する: (1) `package.json#packageManager` field (`npm`/`pnpm`/`bun` を採用、`yarn` は npm fallback + warn)、(2) lockfile sniff (first match: `bun.lockb`|`bun.lock` → bun / `package.json` 無し時の `deno.lock`|`deno.json(c)` → deno / `pnpm-lock.yaml` → pnpm / `yarn.lock` → npm fallback + warn / `package-lock.json` → npm)、(3) `package.json` あり → npm default、(4) `package.json` 無し + `deno.json(c)` → deno、(5) いずれも無し → 検出不能。
- **FR-003**: 戻り値の型は `"npm" | "pnpm" | "bun" | "deno"`。Yarn は決して返さず npm にフォールバックし、stderr に warning を出す。検出不能時は専用の sentinel (例: `null` / `undefined`) を返し呼び出し側で扱う。
- **FR-004**: exec コマンド組み立てヘルパ `buildExecCommand(pm, subcommand): string` を提供する。マッピング: npm→`npx artgraph <sub>` / pnpm→`pnpm exec artgraph <sub>` / bun→`bunx artgraph <sub>` / deno→`deno run -A npm:artgraph/cli <sub>`。`_shared/package-manager.md` の Command mapping 表と一致させる。
- **FR-005**: install コマンド組み立てヘルパ `buildInstallCommand(pm): string` も提供する (npm→`npm install -D artgraph` 等)。本 spec では未使用だが #109/#110 が consume できるよう基盤として用意する。
- **FR-006**: `ArtgraphConfig` (`src/types.ts`) に `packageManager?: "npm" | "pnpm" | "bun" | "deno"` を追加する。optional。
- **FR-007**: `runInit` (`src/init.ts`) は実行時に `detectPackageManager` を呼び、検出できた場合のみ生成する `.artgraph.json` の `packageManager` に記録する。これにより後続機能が lockfile 再 sniff を避けられる。
- **FR-008**: 検出不能時、`runInit` は失敗せず `packageManager` を省略し警告を出す。`init` の他ステージ (scan / skills 等) は通常通り続行する。

**既存 Skill PM 非依存化 (US2)**

- **FR-009**: `templates/skills/*/SKILL.md` の frontmatter `allowed-tools` に `Bash(artgraph *)` を含める (local bin 解決の包括 pre-approve)。既存の `Bash(npx artgraph *)` 等の個別 exec は補助として残してよい。
- **FR-010**: 各 Skill 本文 (frontmatter 除く) に残る裸の `npx artgraph <subcommand>` コマンド例を、`artgraph-detect` で既に採用している `<PM-exec>` プレースホルダ表現、または裸の `artgraph` 表現に統一する。
- **FR-011**: `artgraph-setup` Skill の PM 対応表 (npm/pnpm/bun/deno の install/exec マッピング) は退行なく維持する。
- **FR-012**: `templates/skills/_shared/package-manager.md` の bash スニペットと TS 実装 (FR-001) の検出順が食い違わないよう、両者を single source of truth として整合させる (差分が出たら片方を直す)。

**README / docs (US3)**

- **FR-013**: `README.md` 本文の artgraph 実行例 (`npx artgraph reconcile` / `check` / `init` 等) を PM 非依存表現に更新する。Quickstart の 4 PM 列挙 (既存) は維持する。
- **FR-014**: `docs/skills-guide.md` の `npx artgraph` 例を PM 非依存表現に更新する。

**Bun / Deno smoke test + CI (US4)**

- **FR-015**: Bun での CLI smoke test を追加する: 最小 fixture で `bunx artgraph init` → `bunx artgraph check` が exit 0。`fs.promises` / `process.argv` / `ts-morph` の Bun 動作を確認する。
- **FR-016**: Deno での CLI smoke test を追加する: `deno run -A npm:artgraph/cli init` → `... check`。`ts-morph` の Deno 互換性を検証し、動かない場合は「Deno 未サポート / best-effort」として対応表・CI を現実に合わせる (誇大表記禁止)。
- **FR-017**: CI に package manager matrix (npm / pnpm / bun / deno) を追加する。deno が `ts-morph` 非互換の場合は continue-on-error / skip の方針を research で確定する。

**テスト**

- **FR-018**: `tests/package-manager-detection.test.ts` (新規) を追加し、(a) FR-002 の全検出分岐、(b) `.artgraph.json#packageManager` 記録 (FR-007)、(c) `buildExecCommand` / `buildInstallCommand` の全 PM 出力 (FR-004/005)、(d) 検出不能時の挙動 (FR-008) を覆う。

**スコープ境界 (cross-cutting)**

- **FR-019**: hooks (`settings.json.template`) / agent-context テンプレの templating は本 spec のスコープ外。機能本体が未実装のため #109 / #110 が本 spec の基盤 (FR-004/006/007) を consume して実装する。
- **FR-020**: `.claude-plugin` 配布および plugin Stop hook の **runtime PM 検出は本 spec のスコープ外** (#111)。plugin の Stop hook は当面 `npx artgraph` 固定 (issue #102 スコープ質問2 で合意)。
- **FR-021**: Yarn サポートは本 spec でも対象外 (npm fallback + warn)。
- **FR-022**: 全変更は constitution (Determinism First / Boundary of Determinism) を維持する。PM 検出は lockfile / `packageManager` field の決定的読み取りのみで、LLM 推定を使わない。

### Key Entities

- **PackageManager**: `"npm" | "pnpm" | "bun" | "deno"` の 4 値 union。Yarn は含まない (npm fallback)。`src/types.ts` の `ArtgraphConfig.packageManager` および検出関数の戻り値型として共有。
- **Detection Result**: `detectPackageManager` の出力。検出できた PM、または検出不能 sentinel。検出順は `_shared/package-manager.md` の bash と完全一致。
- **Exec Command Builder**: `(pm, subcommand) → string` の決定的マッピング。`_shared/package-manager.md` の Command mapping 表が single source of truth。
- **Package Manager Config**: `.artgraph.json` の `packageManager` フィールド。`init` 時に検出値を記録し、後続機能が再 sniff を避けるためのキャッシュ。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: `detectPackageManager` が FR-002 の全分岐 (corepack field / bun / deno / pnpm / yarn-fallback / npm-default / detect-fail の 7 系統以上) について fixture テストで **100%** 期待通りの PM を返す。
- **SC-002**: `runInit` 実行後、対応する lockfile / field を持つ fixture で `.artgraph.json` に正しい `packageManager` が記録される (npm/pnpm/bun/deno の 4 ケース **100%**)。検出不能 fixture では `init` が exit 0 で完走し `packageManager` が省略される。
- **SC-003**: `buildExecCommand` の 4 PM 出力が `_shared/package-manager.md` の Command mapping 表と **完全一致**する。
- **SC-004**: `templates/skills/*/SKILL.md` の本文 (frontmatter 除く) に裸の `npx artgraph <subcommand>` 形のコマンド例が **0 件** (`grep` で空)。全 Skill の `allowed-tools` に `Bash(artgraph *)` が含まれる。
- **SC-005**: `README.md` / `docs/skills-guide.md` の artgraph 実行例が PM 非依存表現に更新され、npm 専用に見える生コマンド例が残っていない (peer review + grep で確認)。
- **SC-006**: CI matrix で npm / pnpm / bun の `init` → `check` smoke test が exit 0。deno は exit 0、または `ts-morph` 非互換が確定した場合は「未サポート」明示 + CI 上で意図的に skip/continue-on-error。
- **SC-007**: `_shared/package-manager.md` の bash 検出順と `src/package-manager.ts` の TS 検出順が一致している (両者を突き合わせるテスト or レビューで確認)。

## Assumptions

- **基盤先行の依存方向**: 依存は **本 spec の基盤 → #109 / #110 / #111** の一方向。基盤 (検出 + 記録 + exec ヘルパ) を本 spec で先にマージし、hooks / agent-context / plugin はそれを consume して最初から PM 非依存で実装する。これにより「あとで templating」の二度手間が発生しない。
- **issue #102 の当初前提は不成立**: hooks/plugin/agent-context テンプレは存在しない (機能本体が未実装スタブ)。よって当初チェックリストの templating タスクは別 issue に畳み込み、本 spec は基盤 + 既存配布物 + smoke test に縮小する (issue #102 のコメントで合意済)。
- **Bun/Deno smoke test は本 spec に含む** (issue #102 スコープ質問1)。
- **Plugin runtime PM 検出は本 spec 範囲外** (issue #102 スコープ質問2)。plugin Stop hook は当面 `npx artgraph` 固定。
- **template engine**: 単純 `{{VAR}}` 置換で十分 (handlebars 等は不要)。ただし本 spec では templating 化される配布物 (hooks/agent-context) は対象外なので、置換エンジンの実装自体は #109/#110 側。本 spec は exec 文字列を組み立てる `buildExecCommand` までを提供する。
- **`packageManager` field 優先**: lockfile より `package.json#packageManager` を優先 (spec 012 / corepack convention 踏襲)。
- **Deno 互換性は未確定リスク**: `ts-morph` が Deno の Node 互換で動くかは smoke test で初めて確定する。動かない場合は誇大表記を避け「未サポート / best-effort」を明示する。動く場合のみ正式サポートとして対応表に残す。
- **検出ロジックの SSOT**: 当面 `_shared/package-manager.md` (bash) と `src/package-manager.ts` (TS) の 2 実装が並存する (bash は Skill エージェント用、TS は CLI 用)。両者の検出順を一致させ、片方変更時はもう片方も追従する運用とする (将来 bash を廃し TS 出力を Skill から呼ぶ案は別途検討)。
- **PR 構成**: 本 spec は単一 PR で出す (基盤 + Skills + docs + smoke test)。基盤は #109/#110/#111 より先にマージされる必要がある。
