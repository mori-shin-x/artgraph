# Phase 0 Research: impact --diff --base <ref> — CI テスト選択

spec / plan の Technical Context から抽出した設計判断とその根拠。すべて現行実装 (`src/commands/impact.ts` / `src/diff.ts` / `src/baseline.ts` / `src/commands/check.ts` / `src/trace/report.ts`) の実コード読解と spec 023 の decision record に基づく (Cat6 前提検証)。承認済み決定 (Clarifications D-1〜D-9, Session 2026-07-15/16, issue #305) を正式な decision record に落とす。

---

## R1. current-graph-only vs baseline union vs trace-join — 本 feature 最重要の意味論決定

**Decision**: impact は **baseline worktree を持たない** (D-1, FR-007)。startId 解決は現在グラフのみ。base..HEAD 内のコミットで削除されたファイルは merged diff に現れるが startId を解決せず、エラーも警告もなく寄与しない (silent)。

**Rationale — 「選択」と「判定」の責務分離**:

`check --base` (spec 023) が baseline union (FR-007〜009: merge-base tree probe / baseline 側 startId 解決 / rename map) を必要としたのは、check が **正しさの判定 (gate)** だからである — 削除で失われた `@impl` エッジの見逃しは fail-open であり、exit 0 が嘘になる。

impact `--tests` は **選択 (optimization)** である。選び漏れの帰結は「本来走らせたかったテストが走らない」であり、これは (a) consumer rule (D-5/FR-009: exit 1 や不確かな場合は full suite に fallback、正しさは check が担保) と (b) 同じ CI パイプラインの `check --diff --base --gate` (spec 023 SC-003 が削除起因の uncovered 転落を exit 2 で捕まえる) で回復・補償される。baseline worktree を impact に持ち込むと、worktree ライフサイクル・cleanup・数百 ms〜秒の scan コスト (check で実測済み) がテスト選択のホットパスに乗り、「選択は軽くなければ意味がない」という機能の前提と衝突する。

**bounded fail-open の分析** — 削除の選び漏れは無制限ではない:

1. **静的 import されていたファイルの削除**は、コンパイルが通る限り importer 側の編集 (import 文の除去・呼び出しの置換) を必然的に伴う。その importer は merged diff に入り、現在グラフで解決し、importer 経由の到達 REQ・テストが選択される。つまり「削除だけが diff に入り、関連テストが一切選ばれない」形は、動的参照や設定ファイル経由の疎結合など、静的グラフがそもそも追っていない結合に限られる。
2. その残余ケースの正しさ (REQ の uncovered 転落) は check 側 baseline union が exit 2 で捕まえる — テスト選択の漏れは緑を偽装しない (gate が別途赤くなる)。

**Alternatives considered**:

- *baseline union を impact にも実装 (check FR-007〜009 の移植)*: 正確だが、worktree + baseline scan のコストとライフサイクル複雑性を選択レイヤーに持ち込む。選択の価値 (軽さ) を毀損し、得られるのは「fallback で回復可能な選び漏れの削減」のみ。却下。
- *trace-join 回復 (安価な部分回復 — **follow-up 候補として記録、本 feature では out of scope**)*: merged diff のうち startId が解決しなかった path を、`ownerFilePath` (src/trace/report.ts) で trace evidence の node id (`file:<path>` / `symbol:<path>#...`) の owner path と突き合わせ、一致した evidence node の REQ → タグ付きテストを testsToRun に加える。グラフを経由しない (trace shards は削除前の実行の記録なので削除ファイルの node を保持している) ため baseline 不要・追加コストは Map 走査のみ。「削除ファイルが exercise していた REQ のテスト」がちょうど回復対象になる。**第二の具体的動機 (PR #316 review AG-1)**: base..HEAD 内で **rename** されたファイルも同型の選び漏れを起こす — startId は new path で解決するが、base ブランチでキャッシュした trace shards は evidence を **旧パス** で記録しており、`--tests` の path 文字列 join が繋がらないため、そのテストが非空・exit 0 の選択から無言で落ちる。trace-join の入力に rename の旧パスを供給すれば (`-M` は new path に畳むため、join 用には旧パスを別途得る — 削除 path が「未解決 path」として自然に入力になるのと違い、ここだけ供給経路が要る)、**削除と rename の両方** の選択が同一機構で回復する。**後から追加しても出力契約 (testsToRun の形) を変えない** ことを確認済み — だからこそ今やる必要がない。本 feature では D-1 の宣言 (docs + consumer rule) を先に確定し、回復は必要が実証されてから follow-up issue で扱う。
- *削除 path 検出時に警告を出す*: 「merged diff にあるが解決しない」は削除に限らず、グラフ未追跡ファイル (README、設定、`include` 外) でも常に起きる — 現行 `--diff` が無言で許容している集合と区別できず、CI で恒常的なノイズになる。全 path 未解決の既存 exit 1 (R4) が唯一の明示シグナルであることを維持する。却下。

---

## R2. 環境失敗の扱い — fail-closed、JSON なし、縮退なし

**Decision**: `classifyBaseRef !== "resolved"` → `error: base ref "<ref>" does not resolve` + `FETCH_DEPTH_HINT`。`resolveMergeBase` 失敗 → その診断文字列 (ヒント既含)。どちらも stderr のみ・exit 1・**stdout に JSON を出さない** (`--format json` でも)。working-tree-only diff への fallback をしない (D-2, FR-004)。

**Rationale**:

- **JSON を出さない**: 環境失敗は verdict ではない。`testsToRun: []` を含む JSON を exit 1 と同時に出すと、exit code を見ない `jq` パイプ (CI で最も普通の消費形) が「選択結果は空 = 走らせるテストなし」と誤読する — テスト選択の fail-open として最悪の形。空 JSON の不在 + exit 1 が「fallback せよ」の唯一の曖昧さのないシグナルになる (D-5 の consumer rule と対)。usage error で JSON を出さない check FR-002 / impact の既存 rejection 群と同じ原則。
- **display-only 縮退を持たない**: check には `--gate` なし = 表示のみモードがあり、`unavailable` を「警告 + 全表示 exit 0」に落とせた (017 契約 §4.4)。impact にはその軸がない — 出力はそのまま選択結果として消費される。「警告して working-tree diff だけで続行」は、CI では clean tree のため **空選択の JSON を exit 0 で返す** ことと等価であり、`--base` が解決しなかったことをパイプラインが検知できない。fail-open。却下 (spec 023 research R6「merge-base 失敗時の tip fallback 却下」と同じ一択)。
- **`FETCH_DEPTH_HINT` の共有**: CI での支配的な原因は check と同一 (`fetch-depth: 1`)。ヒント文言は 023 の単一定数を import し、重複定義しない (SSOT)。

**Alternatives considered**: *`--format json` 時にエラー JSON (`{error: ...}`) を出す*: impact の既存エラー経路 (rejection / no-source / symbol miss / no-matching-nodes) はすべて stderr + exit 1 で JSON を出さない。`--base` だけエラー JSON を導入すると失敗の表現が 2 系統になり、consumer は結局 exit code を見るしかない。却下。

---

## R3. `--base` requires `--diff` — 検証の位置と優先順位

**Decision**: `--diff` なしの `--base` は hard usage error exit 1 (D-3, FR-002)。検証位置は **REQ-ID / `doc:` rejection の後、targets×`--diff` 排他 / no-source の前** に pin する。

**Rationale**:

- hard error の理由は check FR-002 (spec 023 D2) と同一: `--base` は `--diff` の変更ファイル集合の modifier であり、`--diff` なしでは作用対象が存在しない。警告続行は CI YAML の `--diff` 書き漏らしを「別のコマンドとして黙って動き続ける」ことに変える。
- **優先順位の根拠**: (a) REQ-ID / `doc:` rejection が先頭のまま — spec 014 FR-003 / 016 契約 §2 の確立済み順序で、`--base` は入力の種類の判定 (navigational error) より優先されるべき理由がない。(b) requires-diff を排他より **前** に置く — `impact src/a.ts --base x` のユーザーの誤りは「`--diff` を忘れた」であって「start source を 2 つ指定した」ではない (`--base` は start source ではない)。排他エラーを先に出すと「targets を消せ」という誤った修正を誘導する。requires-diff が先なら、`impact src/a.ts --base x` → 「--base requires --diff」、それに従って `--diff` を足した `impact src/a.ts --diff --base x` → 排他エラー、と 2 段でユーザーを正しい形 (`impact --diff --base x`) に導く。
- エラーメッセージの文言は check FR-002 をミラー ("--base sets the base point of the git diff; without --diff there is nothing to compare") — 2 コマンドで同じ概念に同じ説明を与える。

---

## R4. 全 path 未解決の merged diff — 既存 exit 1 の維持と consumer rule

**Decision**: merged diff の全 path が startId を解決しない場合、既存の「No matching nodes found」exit 1 をそのまま使う (D-4, FR-008)。`--base` は新しい early exit・新しいメッセージ・新しい exit code を追加しない。あわせて consumer rule を FR + docs 化する (D-5, FR-009)。

**Rationale**:

- この経路は今日の `--diff` (作業ツリーの変更が全部グラフ外のとき) と同一であり、`--base` は集合を広げるだけで新しい失敗様式を作らない。byte-identical を保つことで、CI consumer の分岐は「exit 0 → 選択結果を使う / exit 1 → full suite」の 2 値で済む (エラーの種類での分岐を要求しない)。
- **consumer rule (FR-009 で mandatory 化)**: 「削除された、またはグラフ未追跡の変更ファイルは startId を寄与しない。`impact --tests` は最適化 — exit 1 時や不確かな場合は full suite に fallback。正しさのゲートは `check --diff --base --gate`。」— D-1 の選択限界・D-2 の fail-closed・D-4 の exit 1 は、この 1 つの規則で consumer 側の正しい実装 (quickstart.md S1) に落ちる。docs に書かないと D-1 は「隠れた fail-open」になる — 書くことが D-1 採用の前提条件である。

---

## R5. 検証順と merge-base 解決の配置 — scan 前 fast fail / agreement property

**Decision**: base-ref 検証 (`classifyBaseRef`) + merge-base 解決 (`resolveMergeBase`、1 回だけ) は **scan より前** に置く (D-6, FR-005)。merged diff は `getGitDiffFiles(rootDir, baseSha)` — check と同一関数の共有 (FR-006/FR-013)。

**Rationale**:

- **scan 前 fast fail**: check は `--base` 検証を `--diff` 分岐内 (scan 後) で行う — check には plain / `--diff` の分岐があり、baseline `unavailable` へ「合流」させる必要があったため (017 契約 §4.4 の表示のみモード)。impact にその制約はない: `--base` の失敗は無条件に exit 1 (R2) なので、scan (グラフ構築 — 実 repo で最も高いステップ) を払う前に落とせる。誤構成の CI ジョブが毎回 scan コストを払う理由がない。既存の `TRACE_NO_SHARDS_GUIDANCE` ガード (impact.ts:119-122 — これも scan 前) と同じ「環境前提は先に検証する」配置。
- **単一 merge-base 解決**: `resolveMergeBase` を 1 回呼び、baseSha を `getGitDiffFiles` に渡すのみ。impact には rename map / tracked probe / baseline という他の消費者がいない (D-1/D-8) ため、023 の「配布」問題は消費者 1 つに縮退する — それでも再解決禁止 (SSOT) は同じく保つ。
- **agreement property (FR-013)**: (i) merged changed-file set の一致は「check と同じ `resolveMergeBase` → 同じ `getGitDiffFiles(rootDir, sha)` を呼ぶ」ことによる構造的保証であり、実装上の追加作業はゼロ — テスト (US4 拡張) は将来の分岐 (どちらかが独自 diff を持つ改変) への防波堤。(ii) check-scope ⊇ impact-reach: check は同じ merged diff から出発して baseline 側 startId 解決 (deleted / renamed) を **追加で** 持つため、スコープは impact の到達の上位集合になる。⊂ が起きるのは impact だけが到達を持つ場合だが、両者とも現在グラフの同じ BFS union を使うため構造的に起きない。deleted-edge ケースで正当に真の superset になる (それが D-1 の分業)。

---

## R6. `--format` の `.choices()` 化 — #306 F7 の残余消化

**Decision**: `impact` の `--format` を `.choices(["json", "text"])` に変換する (D-7, FR-010)。

**Rationale**: `src/commands/impact.ts:65` は issue #306 F7 が check を変換した後、gate 隣接コマンド群 (check / doctor / rename / plan-coverage / integrate — すべて `.choices()` 済み) の中で唯一の raw `--format` である。放置すると: (a) bogus 値 (`--format josn`) が silent に text へ fall through し、JSON を期待する CI パイプが text をパースして落ちる (原因が 2 ホップ先に見える)、(b) greedy な option-arg が `--format --diff` で `--diff` を値として食い、start source が消えて「no start source specified」という無関係なエラーになる。本 feature が impact を CI パイプの一級市民にする以上、このタイミングで揃えるのが最小コスト。**挙動変更**: bogus 値が exit 1 になる (従来 exit 0 + text)。`--base` 未指定でも発生する変更のため、FR-003 の byte-identical から独立の例外として明示し、回帰テストで新挙動を pin する。

**Alternatives considered**: *別 PR に分離*: 変更は 1 行で、`--base` の値ガードと同じ「parse 層の fail-closed 化」という主題に属する。分離のオーバーヘッドが利得を上回る。却下 (spec に FR として明示することで「無関係な変更の混入」ではなく「スコープ内の宣言された変更」にする)。

---

## R7. rename map を impact に持ち込まない

**Decision**: `getGitRenameMap` を impact に追加しない (D-8, FR-011)。

**Rationale**: `getGitDiffFiles` の base range は `-M` 付きで、rename は **new path 1 エントリ** に畳まれる (spec 023 T001d 実測)。check がそれでも rename map を必要とするのは、(a) baseline **グラフ** が old path しか知らないため inverse-rename で baseline 側 startId を解決する、(b) baseline orphan-key の source path を正規化して pre-existing 判定を保つ、という **baseline との翻訳** のためである (spec 023 FR-008)。impact に baseline はない (D-1) — current-graph query にとって rename されたファイルは「new path に存在するファイル」そのものであり、new path 畳み込みは正しい入力である。rename map を追加しても消費者が存在しない。**意図的な非目標として contract / コードコメントに明記する** — レビュアーや将来の実装者が check との差分を「対応漏れ」と誤認して追加しないようにするため (追加は dead code + 「baseline があるはず」という誤った示唆を生む)。

---

## R8. `trace.staleness: "exclude"` × `--base` × `--tests` — 目的の反転と警告

**Decision**: 3 条件の共起時に非致命の stderr 警告を 1 回出す + docs / output-schema.md に明記する (D-9, FR-012)。exit code / JSON は不変。

**Rationale**: `staleness: "exclude"` は「ソースが trace 取得時からハッシュ変化した evidence を辿らない」(spec 020 FR-017)。CI のテスト選択では trace shards は必然的に **変更前** の実行 (base ブランチで生成・キャッシュした shards 等) に由来する — PR が変更したコードはちょうど stale-by-construction であり、exclude はまさに「変更されたコードの evidence」を落とす。結果、**変更に最も関係するテストが選択されない** — 機能の目的の反転。これは構成の意味論としては正しい (exclude は「古い証拠を信じない」の明示的選択) ため、エラーにも自動無効化にもせず、警告 + ドキュメントで運用を正す (`warn` の使用、または full suite fallback)。警告は 3 条件が **すべて** 揃ったときのみ (SC-006) — `--base` なしのローカル `--tests` は shards が手元の実行で新鮮なことが多く、恒常ノイズを避ける。

**Alternatives considered**: *exclude 時に `--tests` をエラーにする*: 新鮮な shards を CI 内で直前に生成する正当な運用 (選択の意味は薄いが合法) を壊す。却下。*警告なしで docs のみ*: 空 (または過小) の testsToRun が緑で出るため、docs を読んでいない consumer が気づく手掛かりがゼロになる。実行時警告が必要。却下。

---

## R9. 受容する制限・既知の drift (documented, not fixed)

1. **016 契約の drift**: `specs/016-impact-plan-symbol-level/contracts/cli-flags.md` §1.3 は `--diff` エントリを `line: 0` と記すが、実装は `line: 1` (`src/commands/impact.ts:193`、`pathsToEntries` の JSDoc も `line: 1` を明記)。また §1/§2 は撤去済みの `--from-tasks` / `--from-plan` channel を参照する。本 feature の contract (cli-impact-base.md §1.2) は **実装の現行意味論 (`line: 1`) を正として明記** し、016 側 §1.3 に forward-pointer 注記 (spec 023 が 017 に行ったのと同じ様式) を追加する。016 文書の全面改訂はしない — どちらの文書も黙って矛盾したままにしない、が本 feature の義務の範囲。
2. **trace は現在の shards 基準**: base ref 時点の trace 復元は行わない (spec.md Assumptions)。D-9 はこの方針の帰結を運用者に見せる装置である。
3. **`--tests` なしの `--base`**: REQ 影響の base-range 化 (`impactReqs` / `affectedFiles` の広がり) も同じ機構で成立する。テスト選択専用フラグにはしない — `--base` は `--diff` の一般化であり、023 と対称。

---

## まとめ: 未解決の NEEDS CLARIFICATION

なし。D-1〜D-9 (2026-07-15/16 承認, issue #305) と R1〜R9 で全論点を解決済み。実装細部 (D-9 警告の正確な wording) は contract §5 の canonical string として tasks フェーズで確定する範囲。
