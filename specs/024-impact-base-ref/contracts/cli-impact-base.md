# Contract: `artgraph impact --diff --base <ref> [--tests] [--format json|text]`

本 feature が確定する `impact --base <ref>` の外部契約。spec 016 の `impact` CLI 契約 (`specs/016-impact-plan-symbol-level/contracts/cli-flags.md`) §1.3 (`--diff` 起動契約) / §2 (検証順) を **上書きせず拡張** し、spec 023 の `check --base` 契約 (`specs/023-check-base-ref/contracts/cli-check-base.md`) と意味論 (merge-base / fail-closed / 値検証) を共有する。`--base` 未指定時は現行契約がそのまま成立する (byte-identical, FR-003 — 唯一の例外は §2-1 の `--format` `.choices()` 化)。

## 1. フラグ構文

```
artgraph impact --diff --base <ref> [--tests] [--format json|text]
```

- `--base <ref>`: 値必須。`<ref>` は git が解決できる任意の参照 (ブランチ名 / `origin/main` 等のリモート追跡ブランチ / SHA / タグ)。range 構文 (`A..B` / `A...B`) は受理しない (単一 ref のみ — merge-base 計算は内部で行う)。
- **値の parse 時検証 (spec 023 F1/F2 クラス、FR-001)**: 空文字列、および `-` で始まる値は `nonOptionValue` (src/commands/shared.ts) により option パース時点で usage error (exit 1) として拒否する。CI で base-ref 変数が空展開すると `--base --tests` は `--tests` を値として食い (テスト選択が黙って通常 impact に化ける)、`--base ""` は falsy として全 `--base` 分岐をスキップし「clean tree では空選択 exit 0」の no-op に縮退する — どちらも fail-closed で遮断する。`-` で始まる正当な ref は完全形 (`refs/heads/--foo`) で指定可能。
- 意味論: 変更ファイル集合を `mergeBase = git merge-base <ref> HEAD` 起点のコミット間差分との和集合に拡張する (spec 023 D1 と同一 — `<ref>` の tip は判定に使われない)。**`--base` は start source ではなく `--diff` の modifier** である: start source の排他 (targets / `--diff`) にも、`IMPACT_REQ_ID_REJECTION` / `IMPACT_DOC_PREFIX_REJECTION` の start source 列挙にも現れない (FR-003)。

### 1.1 `--diff` 起動契約の拡張 (016 §1.3 の現行形)

`--diff` (± `--base`) の各変更ファイル path は `SymbolEntry { path, line: 1 }` (symbol undefined、file-unit 意味論) として `resolveStartIds()` に渡される。symbol 単位の起動が git diff からできない点は 016 §1.3 のまま不変。

### 1.2 spec 016 契約からの既知 drift (本契約が現行意味論を正とする)

- **`line` 値**: 016 §1.3 / §1.1 は `line: 0` と記すが、実装は **`line: 1`** (`src/commands/impact.ts:193`、`src/commands/shared.ts` `pathsToEntries` の JSDoc)。値の用途は診断表示のみ。本契約は `line: 1` を正とし、016 §1.3 には forward-pointer 注記を追加済み。
- **channel 集合**: 016 §1/§2 の `--from-tasks` / `--from-plan` は撤去済み (現行 channel は targets / `--diff` の 2 つ)。本契約の §2 は現行実装の検証順を正とする。

## 2. 検証順 (SSOT: `src/commands/impact.ts` — D-6)

| # | 検証 | 失敗時 |
|---|------|--------|
| 1 | commander の option パース: `--base` 値ガード (§1 — 空 / `-` 始まりを `nonOptionValue` で拒否)、`--format` の `.choices(["json","text"])` (FR-010 — bogus 値と `--format --diff` swallow を拒否) | commander 標準エラー (`InvalidArgumentError` / invalid choice)、exit 1 |
| 2 | REQ-ID rejection (`REQ_ID_INPUT_RE`) → `doc:` prefix rejection | 既存の navigational error (文言不変)、exit 1 |
| 3 | `--base` かつ `--diff` なし (FR-002 — **targets の有無に関わらずここで落ちる**) | stderr にエラー (§5.1) + exit 1。**JSON を出力しない**。警告して続行しない |
| 4 | targets × `--diff` 排他 + no-source | 既存エラー (文言不変)、exit 1 |
| 5 | `--tests` かつ trace shard ゼロ | `TRACE_NO_SHARDS_GUIDANCE` (既存・同文言)、exit 1 |
| 6 | `classifyBaseRef(rootDir, <ref>)` ≠ `"resolved"` (FR-004a) | stderr: §5.2 の見出し + `FETCH_DEPTH_HINT`、exit 1。**JSON なし** |
| 7 | `resolveMergeBase(rootDir, <ref>)` 失敗 (FR-004b) | stderr: その診断文字列 (fetch-depth ヒント既含)、exit 1。**JSON なし** |
| 8 | (scan → merged diff → resolveStartIds — 検証ではなく実行。全 path 未解決は §3 の既存 exit 1) | — |

- **3 が 4 より先** (D-3 pin): `impact src/a.ts --base x` → 「--base requires --diff」(排他エラーではない)。`impact src/a.ts --diff --base x` → 3 を通過し 4 の排他エラー。
- **6/7 が scan より先** (D-6 fast fail): check (`023 契約 §2` — scan 後の `--diff` 分岐内で解決し `unavailable` に合流) と意図的に異なる。impact の `--base` 失敗は無条件 exit 1 であり、合流先 (表示のみモード) が存在しないため、グラフ構築コストを払う前に落とす。
- 6/7 で `<ref>` の失敗が `"unborn"` として空扱いになることはない (`isUnbornHead` の非 HEAD early return — spec 023 A10/B10 で pin 済みの前提を共有)。unborn HEAD の repo で `--base HEAD` を指定した場合は 6 の「does not resolve」扱い (fail-closed、spec 023 契約 F5 と同型)。

## 3. Exit code (impact 既存契約の拡張 — code の意味は不変、exit 2 はない)

| code | 条件 | 意味 | CI consumer の扱い (D-5) |
|------|------|------|--------------------------|
| `0` | 正常出力。空 merged diff の「No changes detected in git diff.」を含む (`--base` 指定時は正当な clean 判定) | 選択結果は有効 | `testsToRun` を使用 (空なら §6 の注意) |
| `1` | (a) §2-1〜5 の usage / 前提エラー、(b) `--base` の環境失敗 (§2-6/7 — ref 解決不能 / merge-base 失敗)、(c) merged diff の全 path が startId 未解決 (「No matching nodes found」— 既存文言・既存経路 byte-identical, FR-008)、(d) scan-mode mismatch / symbol miss (既存) | 選択不能・構成エラー (fail-closed) | **full suite に fallback** |

- (c) は `--base` なしの同経路と完全に同一 — `--base` は新しい early exit・新しいメッセージ・新しい exit code を追加しない (D-4)。
- 縮退判定 (merge-base 失敗時に working-tree-only diff へフォールバック等) は行わない (FR-004 / research.md R2)。

## 4. 変更ファイル集合と JSON 不変条件

### 4.1 merged diff (FR-006 — check と同一の SSOT)

```
mergedDiff = (staged ∪ unstaged ∪ untracked)                 // 現行 --diff、不変
           ∪ git diff --name-only -M -z <mergeBase> HEAD     // --base 時のみ追加 (getGitDiffFiles(rootDir, baseSha))
```

- 定義・実装とも `getGitDiffFiles(rootDir, baseSha?)` (src/diff.ts、spec 023 FR-006) を check と共有する。**agreement property (FR-013)**: 同一 repo 状態・同一 `<ref>` で impact と check の merged changed-file set は一致し (i)、check-scope ⊇ impact-reach (ii) — deleted-edge ケースで check だけが baseline 側解決を持つため正当に真の superset になる。
- untracked は `--base` 指定時も含まれる (US2)。非 ASCII path の verbatim 扱い (`-z` + `core.quotePath=false`) は 023 から継承。
- base range の rename は new path 1 エントリに畳まれる (`-M`)。**impact は rename map を持たない (FR-011/D-8)** — current-graph query にとって new path が正しい入力であり、old path への翻訳対象 (baseline グラフ) が存在しない。

### 4.2 `--format json` 不変条件

**フィールド追加ゼロ** — `ImpactResult` (016 契約 §5.1 + 020 の `reqProvenance`/`testsToRun`) がそのまま成立する。`--base` の影響は値のみ (startId 集合が merged diff 由来に広がる)。

- `testsToRun` の意味論は spec 020 FR-018 のまま: (staleness フィルタ済み) exercises evidence が startId に到達する REQ のタグ付きテスト。**評価対象の startId が merged set 全体になる** だけで、join 規則は不変。
- 空 merged diff (`--base` あり含む) の early-exit payload は既存 E4 shape を byte-identical に維持する:

  ```jsonc
  {
    "affectedFiles": [], "affectedDocs": [], "impactReqs": [], "affectedTasks": [],
    "drifted": [], "originReqs": [],
    "summary": { "docs": 0, "reqs": 0, "files": 0, "tasks": 0 },
    "warnings": [],
    "message": "No changes detected in git diff."
  }
  ```

  exit 0。`--base` 指定時この shape は「base に対して本当に変更がない」正当な clean 判定を意味する (Edge Case)。
- **エラー時は JSON を出さない** (§2-3/6/7、FR-004/D-2): 環境失敗・usage error は verdict ではない。`testsToRun: []` を含む JSON を exit 1 と併せて出すと、exit code を見ない `jq` パイプが「選択 = 空」と誤読する — stdout 空 + exit 1 が fallback の唯一のシグナル。

## 5. text 出力 / エラー文言 (canonical strings)

### 5.1 usage error (FR-002 — check FR-002 のミラー)

```text
error: --base requires --diff (--base sets the base point of the git diff; without --diff there is nothing to compare).
run: artgraph impact --diff --base <ref> [--tests]
```

exit 1。

### 5.2 base ref 解決不能 (FR-004a)

```text
error: base ref "origin/main" does not resolve
hint: if this is a shallow clone, fetch full history (actions/checkout: fetch-depth: 0) or fetch the base ref first.
```

exit 1。2 行目は `FETCH_DEPTH_HINT` 定数 (src/baseline.ts — spec 023 SSOT) そのもの。merge-base 失敗 (FR-004b) は `resolveMergeBase` の診断文字列 (`could not determine merge-base of "<ref>" and HEAD (shallow clone or unrelated histories?): ...` + 同ヒント) をそのまま stderr に出す。

### 5.3 D-9 staleness 警告 (FR-012 — 非致命、経路を変えない)

`--tests` && `--base` && `trace.staleness === "exclude"` の共起時、stderr に 1 回:

```text
WARNING: --tests with --base under trace.staleness "exclude": the changed code's evidence is stale by construction and its tests may be dropped from the selection. Use staleness "warn" for CI test selection, or fall back to the full suite.
```

exit code / stdout (JSON 含む) は不変。3 条件のいずれかを欠く組み合わせでは出力しない (SC-006)。

### 5.4 正常系

正常系の text / json 出力は 016 契約 §5 (+ 020 の `--tests` 拡張) と同一フォーマット。「No matching nodes found for: ...」(全 path 未解決) も既存文言のまま (FR-008)。

## 6. フラグ相互作用表

| 組み合わせ | 挙動 |
|-----------|------|
| `--base` のみ (`--diff` なし、targets なし) | usage error §5.1, exit 1 (FR-002) |
| `<targets> --base <ref>` (`--diff` なし) | **usage error §5.1** (排他エラーではない — §2 の 3 が 4 より先, D-3) |
| `<targets> --diff --base <ref>` | 排他エラー (既存文言), exit 1 |
| `--diff --base <ref>` | merged diff で impact。環境失敗は exit 1 (JSON なし) |
| `--diff --base <ref> --tests` | merged diff 上でテスト選択。shard ゼロは既存 `TRACE_NO_SHARDS_GUIDANCE` exit 1 (§2 の 5 — base 検証より先) |
| `--diff --base <ref> --format json` | §4.2。フィールド追加なし。エラー時 JSON なし |
| `--diff --base HEAD` | merge-base == HEAD、コミット間差分空 → 現行 `--diff` と同一結果に退化 (SC-007) |
| `--diff --base <ref>` + `trace.staleness: "exclude"` + `--tests` | §5.3 の警告 + 通常実行 (FR-012)。選択結果から stale evidence の REQ が落ちるのは spec 020 FR-017 の既存意味論 |
| `--diff --base <ref>` + `trace.staleness: "warn"` / `"gate"` | 警告なし (D-9 は exclude のみ)。staleness "gate" は check 側の概念で impact の exit code に影響しない |
| `--diff` のみ (`--base` なし) | 現行契約そのまま byte-identical (FR-003)。CI では clean tree のため「No changes detected」exit 0 になる — それを解消するのが本 feature |
| `--format <bogus>` (`--base` 無関係) | `.choices()` エラー exit 1 (FR-010 — **挙動変更**: 従来は silent text fallback)。`--format --diff` も parse 時拒否 |

## 7. 契約テスト (quickstart / tasks と対応)

| # | 契約 | 検証 |
|---|------|------|
| I1 | `--base` w/o `--diff` (targets 有無両方) → exit 1 §5.1、JSON 非出力、排他エラーより優先 | FR-002 / §2-3 |
| I2 | `--base` なし全実行の byte-identical 回帰 (rejection 文言・E4 shape・No matching nodes 含む) | FR-003 / SC-005 |
| I3 | committed 変更のみ (clean tree) + `--base` → testsToRun 非空 / `--base` なし → No changes | FR-006 / SC-001 |
| I4 | impact と check の merged changed-file set 一致 (US4 agreement 拡張) | FR-013 / SC-002 |
| I5 | base..HEAD 内の sole `@impl` ファイル削除 → impact は無言で寄与ゼロ・check は exit 2 (superset 分業) | FR-007 / SC-003 |
| I6 | 解決不能 ref / merge-base 失敗 → exit 1 + `FETCH_DEPTH_HINT`、`--format json` でも stdout 空 | FR-004 / SC-004 |
| I7 | merged diff 全 path 未解決 → 既存「No matching nodes found」exit 1 (文言・経路 byte-identical) | FR-008 |
| I8 | 空 merged diff + `--base` → exit 0、E4 JSON shape 不変 | FR-006 / §4.2 |
| I9 | untracked ∪ base range の和集合 (両系統が startId に入る) | FR-006 / US2 |
| I10 | `--base HEAD` → `--base` なし `--diff` と同一結果 | SC-007 |
| I11 | `--format` bogus / `--format --diff` → exit 1 (choices)、`json`/`text` は従来どおり | FR-010 |
| I12 | D-9 警告が 3 条件共起時のみ stderr に出る (2 条件以下では出ない)、exit code 不変 | FR-012 / SC-006 |
| I13 | `--base` 値ガード: `--base ""` / `--base --tests` → parse 時 exit 1 | FR-001 / §1 |
