# Phase 1 Data Model: impact --diff --base <ref> — CI テスト選択

spec の Key Entities を実装形に落とす。**新しい型・新しい JSON フィールド・新しい共有関数は追加しない** — 本 feature は spec 023 が実装済みの配管を `src/commands/impact.ts` から呼ぶ配線のみで、共有モジュールには 1 行も手を入れない。

---

## 1. 既存型 — 変更なし

### 1.1 `ImpactResult` (src/types.ts) — 不変

`affectedFiles` / `affectedDocs` / `impactReqs` / `affectedTasks` / `drifted` / `originReqs` / `summary` / (trace 有時) `reqProvenance` / `testsToRun` は spec 016/020 のまま。`--base` の影響は **入力の startId 集合が merged diff 由来に広がるだけ** で、フィールド追加ゼロ = 完全後方互換。

- `testsToRun` (spec 020 FR-018) の意味論は不変: 「(staleness フィルタ済み) exercises evidence が startId に到達する REQ のタグ付きテスト集合」。startIds が merged diff (three-way ∪ base range) から解決されるようになるだけで、evidence join (grain-aware 3 規則, impact.ts:349-367) は無変更。
- 空 merged diff の early-exit JSON (E4 shape, impact.ts:169-191) も不変 (contract §4.2 で pin)。

### 1.2 `SymbolEntry` — 不変 (016 drift の明記)

`--diff` の各 path は従来どおり `{ path, line: 1 }` (symbol undefined、file-unit 意味論) に lift される (impact.ts:193)。**spec 016 契約 §1.3 の `line: 0` は drift** であり、本 feature は実装の現行値 `line: 1` を正として contract に明記する (research.md R9-1)。値の用途は診断表示のみで、解決意味論に影響しない。

---

## 2. 再利用台帳 — reuses / does-not-modify (FR-005/006/013 の構造的根拠)

| 資産 | 場所 | 本 feature での扱い |
|------|------|---------------------|
| `resolveMergeBase(rootDir, ref)` | src/baseline.ts:160 | **import して再利用** (1 回だけ呼ぶ)。再実装・変更禁止 |
| `FETCH_DEPTH_HINT` | src/baseline.ts:142 | **import して再利用** (エラー文言に連結)。重複定義禁止 |
| `classifyBaseRef(rootDir, ref)` | src/baseline.ts:427 | **import して再利用** (ref 検証。named ref は `"unborn"` になり得ない — 023 A10 で pin 済み) |
| `getGitDiffFiles(rootDir, baseSha?)` | src/diff.ts:48 | **import して再利用** (merged diff の SSOT — check と共有 = agreement (i)) |
| `nonOptionValue(flag, opts)` | src/commands/shared.ts:24 | **import して再利用** (`--base` 値の parse 時ガード, FR-001) |
| `TRACE_NO_SHARDS_GUIDANCE` | src/commands/shared.ts:152 | 既存利用のまま不変 (検証順 §2 の位置も不変) |
| `IMPACT_REQ_ID_REJECTION` / `IMPACT_DOC_PREFIX_REJECTION` | src/commands/impact.ts:13-30 | **文言不変** (FR-003 — `--base` は start source ではないため列挙に加えない) |
| `resolveStartIds` / `impact()` / evidence join | src/graph/traverse.ts / impact.ts:349-382 | 不変 (入力集合が広がるのみ) |

**does-not-modify (spec.md Out of Scope で pin)**: `src/diff.ts`、`src/baseline.ts`、`src/graph/traverse.ts`、`src/commands/check.ts`、`src/commands/shared.ts` (import のみ)。`getGitRenameMap` / `getHeadTrackedPaths` / `computeBaselineIssues` は **呼ばない** (D-1/D-8 — impact に baseline 側の消費者は存在しない)。

---

## 3. コマンドフロー (src/commands/impact.ts) — `--base` 追加後のパイプライン

```
0. option 定義:
     .addOption(new Option("--base <ref>", "...").argParser(nonOptionValue("--base", { hint: refs/... spelling })))   // FR-001
     .addOption(new Option("--format <format>", "Output format").choices(["json", "text"]).default("text"))          // FR-010
1. REQ-ID rejection → doc: rejection                                  (既存・不変。--base より先 — D-6)
2. --base requires --diff (FR-002): opts.base && !opts.diff
     → stderr にエラー (check FR-002 ミラー文言) + exit 1。JSON なし。
     (targets の有無に関わらずここで落ちる — 排他検査より前, D-3)
3. targets×--diff 排他 + no-source                                     (既存・不変)
4. --tests shard 存在ガード (TRACE_NO_SHARDS_GUIDANCE)                 (既存・不変 — scan 前)
5. --base 検証 + merge-base 解決 (FR-004/FR-005 — scan より前, fast fail):
     a. classifyBaseRef(rootDir, opts.base) !== "resolved"
          → stderr: `error: base ref "<ref>" does not resolve` + FETCH_DEPTH_HINT → exit 1 (JSON なし)
     b. resolveMergeBase(rootDir, opts.base)
          → { error } → stderr にその診断 (ヒント既含) → exit 1 (JSON なし)
          → { sha }   → baseSha = sha (以後この 1 変数のみ)
6. scan(rootDir, config) → graph / warnings                            (既存・不変)
7. trace ingest + staleness exclude 集合                               (既存・不変)
7b. D-9 警告 (FR-012): opts.tests && opts.base && staleness === "exclude"
      → stderr に非致命 WARNING 1 回 (canonical string は contract §5.3)
8. diffFiles = getGitDiffFiles(rootDir, baseSha)                       // FR-006 — check と同一関数・同一 union
     空 → 既存の「No changes detected in git diff.」early exit (exit 0、E4 JSON shape 不変)
     — --base 指定時これは正当な clean 判定 (Edge Case)
9. entries = diffFiles.map((p) => ({ path: p, line: 1 }))              (既存・不変 — 016 drift 注記は §1.2)
10. resolveStartIds → (全 path 未解決なら既存の「No matching nodes found」exit 1 — FR-008/D-4。
    削除・グラフ未追跡 path は単に startId を生まない — FR-007/D-1、新分岐なし)
11. impact BFS → originReqs → --tests evidence join → 出力              (既存・不変)
```

**設計上の要点**:

- merge-base は step 5b で **1 回だけ** 解決され、消費者は step 8 の `getGitDiffFiles` のみ。check (023 data-model §4) と異なり rename map / tracked probe / baseline への配布は存在しない — D-1/D-8 により消費者自体がない。
- step 5 が scan (step 6) より前にあるのが check との意図的な差 (D-6): check は `unavailable` 合流 (表示のみモード) のために scan 後の `--diff` 分岐内で解決するが、impact の `--base` 失敗は無条件 exit 1 なので scan コストを払う前に落とす。
- step 2 / 5 のエラーはどちらも **JSON を出さない** (FR-004/D-2)。impact の既存エラー経路 (rejection / 排他 / no-source / shard なし / symbol miss / no-matching-nodes) と同じ「stderr + exit 1、stdout 空」の一貫形。
- step 9 以降は 1 バイトも変わらない — `--base` の作用は「step 8 に渡す第 2 引数」に完全に局所化される。

**exit code**: `0` 正常 (空 merged diff の No changes 含む) / `1` usage error・環境失敗・全 path 未解決・shard なし `--tests` (impact に exit 2 はない — contract §3)。

---

## 4. SSOT 台帳 (Cat2)

| 知識 | 真実源 | 従属 (等価性をテストで担保) |
|------|--------|------------------------------|
| merged diff の定義 (union) | `getGitDiffFiles(rootDir, baseSha?)` 単一関数 (src/diff.ts — 023 SSOT) | impact / check の両コマンドが同一関数を呼ぶ = agreement (i)。独自 diff 取得の実装禁止 (FR-013)。US4 拡張テストで pin |
| merge-base SHA | `resolveMergeBase()` の戻り値 → impact.ts ローカル変数 `baseSha` | `getGitDiffFiles` は引数で受けるのみ (再解決禁止)。消費者 1 つでも規律は 023 と同一 |
| fetch-depth ヒント文言 | `FETCH_DEPTH_HINT` 定数 (src/baseline.ts — 023 SSOT) | impact の ref 解決失敗メッセージ / `resolveMergeBase` の診断 / quickstart.md troubleshooting |
| `--base` 値の parse 時ガード | `nonOptionValue` (src/commands/shared.ts — #306 SSOT) | impact `--base`。check `--base` の bespoke validator (ref 特化文言) とは意図的に別実装だが、拒否集合 (空 / `-` 始まり) は同一クラス (spec 023 F1/F2) |
| 「does not resolve」見出し文言 | contract §5.2 の canonical string (impact.ts 内の 1 箇所) | check 側見出しは stage-label 付き (PR #304 F3) の別文 — 共有するのはヒント定数のみ。テストは impact 側文字列を pin |
| テスト選択の意味論 (evidence join / testsToRun) | spec 020 の既存 SSOT (impact.ts:349-382 / src/trace/report.ts) — 本 feature は不変 | `templates/skills/_shared/output-schema.md` に「merged set 上で評価」の 1 行と D-9 注記を追記 |
| consumer rule の文言 | spec.md FR-009 (D-5) | README / docs/commands.md / SKILL.md / output-schema.md / quickstart.md S1 が同旨を記載 (docs 同時更新は tasks Phase 6) |

---

## 5. 状態遷移 (入力 × `--base` → 終了経路)

impact に `baselineStatus` に相当する状態機械はない。終了経路の全域を列挙する (**新しい経路は 2 と 5 のみ、どちらも既存 exit 1 ファミリー**):

```
--diff なし
   ├─ --base あり (targets 有無問わず) ─► usage error "--base requires --diff", exit 1 (FR-002。JSON なし)
   └─ --base なし ───────────────────► 既存どおり (targets 経路 / no-source エラー)

--diff あり + --base <ref>
   ├─ <ref> 解決不能 (classifyBaseRef ≠ resolved) ─► exit 1: does not resolve + FETCH_DEPTH_HINT (JSON なし)
   ├─ merge-base 失敗 (shallow / unrelated)        ─► exit 1: resolveMergeBase 診断 (JSON なし)
   ├─ merged diff 空 ─────────────────────────────► "No changes detected" exit 0 (E4 JSON shape 不変 — 正当な clean)
   ├─ 全 path 未解決 ─────────────────────────────► "No matching nodes found" exit 1 (既存文言 byte-identical, FR-008)
   └─ 1 つ以上解決 ───────────────────────────────► BFS → 出力 exit 0
        (削除 / グラフ未追跡 path は無言で寄与ゼロ — FR-007/D-1)

--tests && --base && staleness === "exclude" ──► 上記に加え非致命 stderr WARNING (FR-012。経路は変えない)
```
