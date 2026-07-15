# Phase 0 Research: check --base <ref> — CI PR gating

spec / plan の Technical Context から抽出した設計判断とその根拠。すべて現行実装 (`src/diff.ts` / `src/baseline.ts` / `src/commands/check.ts`) の実コード読解に基づく (Cat6 前提検証)。承認済み決定 (Clarifications D1–D3, 2026-07-15) を正式な decision record に落とす。

---

## R1. merge-base 統一 vs two-dot (ref tip) 直接比較 — 本 feature 最重要の意味論決定

**Decision**: `--base <ref>` は **`git merge-base <ref> HEAD` を 1 回だけ解決** し、diff range (`<mergeBase>..HEAD`) と baseline worktree (`computeBaselineIssues` の base ref) の両方に **同一の merge-base SHA** を使う (D1, FR-005/FR-007)。GitHub PR の three-dot (`base...head`) と同じ意味論。

**Rationale — moved-ahead base の failure analysis**: base ブランチが分岐後に進んでいる (CI では常態) とき、`<ref>` の tip を直接使うと双方向に壊れる:

1. **false exit 2 (誤爆)**: branch point 時点で存在した issue X を、分岐後に base 側で修正したとする。tip の baseline には X が無い → current (branch は X を未修正のまま) の X が「新規」判定され exit 2。開発者は自分が導入していない問題でゲートに落ちる — issue #174 (spec 017 が潰した誤爆) の base-range 版再発。
2. **fail-open (見逃し)**: 逆に、分岐後に base 側で issue Y が新規導入されたとする。tip の baseline には Y が入る → 本 PR が **同じキーの** issue を独自に導入しても pre-existing と誤判定され suppress される。ゲートの見逃し。

さらに悪い変種として、「diff range は merge-base、baseline は tip」のような **不一致実装** は上記 1・2 に加えて「diff に入らないファイルの issue が baseline にだけ現れる」非対称を生む。FR-007 は diff range と baseline の SHA 一致を要求として明文化し、この divergence を構造的に禁止する。

merge-base に統一すると: baseline = branch point 時点のプロジェクト状態 = 「このブランチが出発した地点」。current \ baseline は正確に「このブランチ (+ 作業ツリー) が導入したもの」になる。

**Alternatives considered**:
- *two-dot 直接 (`git diff <ref> HEAD` = tip 比較)*: 上記の双方向誤判定。却下。
- *`<ref>...HEAD` の three-dot 構文を git に丸投げ*: diff range としては等価だが、baseline worktree 用に merge-base SHA そのものが必要 (worktree はコミットにしか add できない)。`git merge-base` を明示的に 1 回解決して両者に配る方が SSOT として明確。採用形はこの明示解決。

---

## R2. `--base` without `--diff` — hard error vs 警告 vs `--diff` 暗黙有効化

**Decision**: `--diff` なしの `--base` は **exit 1 のハードエラー** (D2, FR-002)。

**Rationale**:
- `--base` の意味論は「`--diff` の変更ファイル集合とベースライン基準点の変更」であり、`--diff` なしでは作用対象が存在しない。無視して plain check として続行 (`--ignore` が採る警告方式, `src/commands/check.ts:35-37`) すると、CI の YAML で `--diff` を書き漏らしたとき **ゲートが別物 (全件 legacy 判定) として黙って動き続ける**。CI 用フラグである以上、構成ミスは fail-closed で即座に露見すべき (Constitution 原則 I: 判定を隠さない)。
- exit 1 は 017 が確立した「gate 合否 (0/2) と区別される判定不能・エラー系」と整合する (contracts/cli-check-gate.md §2)。

**Alternatives considered**:
- *`--ignore` 型の警告 + 無視*: 上記のとおり CI での silent 誤構成を許す。却下。
- *`--base` が `--diff` を暗黙に有効化*: タイプ量は減るが、(a) `check --base X` と `check --diff --base X` が同じになりフラグの直交性が崩れる、(b) Stop hook 等の既存呼び出しと `--diff` の有無で挙動が分かれる現行設計 (`not_applicable` vs baseline 系) に暗黙の第 3 経路を足す。明示 > 暗黙。却下 (エラーメッセージで `--diff` の追加を案内すれば UX 差は僅少)。

---

## R3. 変更ファイル集合 — 和集合 (three-way ∪ base range) を維持する

**Decision**: `--base` 時の変更ファイル集合 = 現行 three-way union (staged ∪ unstaged ∪ untracked) ∪ `git -c core.quotePath=false diff --name-only -M -z <mergeBase> HEAD` (FR-006)。作業ツリー差分を置き換えない。

**Rationale**:
- US2 (ローカル pre-push): コミット済み変更と未コミット変更が混在するのが普通。base range だけにすると未コミットの新規 orphan がゲートを素通りする (fail-open)。
- CI では作業ツリーが clean なので union の作業ツリー項は自然に空になり、base range のみが効く。1 つの定義で両環境をカバーできる。
- untracked の包含維持は 017/FR-003 (現状の `--diff` の定義) の上位互換。

**`-z` + `core.quotePath=false` への統一 (既存 3 呼び出しも変換)**: 新設のコミット間差分は `getGitTrackedFiles` / `getGitRenameMap` と同じ `-z` + `core.quotePath=false` 方式 (`parseNulSeparated`) を使う。一方、既存の staged/unstaged/untracked 3 呼び出し (src/diff.ts:38-49) は改行区切り + quotePath 既定のままで、非 ASCII path が octal-escape される既知の非対称がある。base range 側だけ `-z` にすると **同じファイルが 2 つの表記で集合に入る** 事故 (union の同一性が壊れる) が起きるため、この機会に 3 呼び出しも `-z` 化して表記を揃える (FR-006 後段)。既存挙動への影響は「octal-escape されていた非 ASCII path が正しい表記になる」方向のみ (getGitTrackedFiles が既にこの表記で動いているため、グラフ側の path 照合とはむしろ一致する)。

**`-M` (rename 検出) を name-only に付ける理由**: rename を R レコードとして畳み込む。**実測 (T001d) 修正**: `--name-only -M` は rename を **new path 1 エントリのみ** に畳み込む (`--name-status` と異なり old path は出力されない)。old path は `getGitRenameMap(rootDir, baseSha)` → inverseRenameMap → baselineEntries 経由で回復される — 作業ツリー rename の既存経路 (T229-5) と完全に同型で、取りこぼしはない。`-M` を外すと D+A の 2 エントリになり両 path が入るが、rename 正規化 (FR-008) と表現が乖離するため採らない。

---

## R4. base..HEAD 内で削除されたファイル — tracked-path probe の一般化 (最大の silent-break リスク)

**Decision**: `getHeadTrackedPaths` (src/diff.ts:119, `git ls-tree -r HEAD` 固定) を base ref パラメータ化し、`--base` 時は **HEAD tree に加えて merge-base tree も probe** する (FR-009)。

**Rationale**: issue #229 の failure mode の再発防止。`src/commands/check.ts:172-190` の skip 最適化は「diff の path が (a) 現在グラフで解決する / (b) HEAD で tracked / (c) rename の new path のいずれかでなければ baseline build を skip してよい」と判定する。base..HEAD 内の **コミットで** 削除されたファイルは:
- HEAD で untracked (削除済み)、
- 作業ツリーに不在、
- 現在グラフに存在しない (scan 対象外)、

の三重で不可視になり、(a)(b)(c) すべて false → baseline build skip → そのファイルが持っていた唯一の `@impl` エッジの喪失 (= REQ の新規 uncovered 転落) が **「Changed files are not tracked in the graph」の exit 0** に化ける。これは #229 が worktree 削除について直したのと同型の fail-open で、`--base` 導入時に merge-base tree を probe しなければ必ず再発する (削除がコミット済みか否かだけの違い)。事前分析で本 feature の #1 silent-break リスクとランク付けされた点であり、FR-009 として独立要求化し、SC-003 の受け入れテスト (A1) で pin する。

**実装形**: probe は「HEAD tree ∪ merge-base tree のどちらかで tracked なら resolvable 扱い」。probe 失敗時のバッチ単位 conservative fallback (tracked 扱い → baseline を作る側に倒す) は既存のまま両 tree に適用。

---

## R5. base..HEAD 内のコミット済み rename — `getGitRenameMap` のパラメータ化

**Decision**: `getGitRenameMap` (src/diff.ts:153, `git diff -M HEAD` 固定) を base ref パラメータ化し、`--base` 時は `git diff -M <mergeBase>` を実行する (FR-008)。

**Rationale**: `git diff -M <commit>` は `<commit>` と作業ツリーの比較なので、merge-base を渡せば「コミット済み rename + 作業ツリー rename」の両方が 1 回で取れる (追加の diff 呼び出し不要)。この rename map は 2 箇所に供給されており、どちらも base-range rename を必要とする:
1. **`src/commands/check.ts:136-142`** — inverse-rename による baseline 側 startId 解決 (rename + sole-edge 削除の複合 diff で baseline グラフが old path しか知らない問題、issue #229 レビュー)。
2. **`src/baseline.ts:229`** — baseline orphan-key の source path 正規化 (pure rename で pre-existing orphan の suppress が外れる 017 C2/SC-004)。

HEAD 固定のままだと、rename を **コミットしてしまった瞬間** に両者が壊れる (CI では常にコミット済み)。US1 AS5 / SC-004 でテスト固定する。

**注意 (037 実装時)**: `git diff <commit>` は untracked を報告しない既存の制限 (src/diff.ts JSDoc) は base 化後も同じ。`git mv` 済み or コミット済み rename が対象で、素の `mv` (未 add) が検出されないのは現行どおり。

---

## R6. ref 検証と unavailable への集約

**Decision**: 検証順は (1) `classifyBaseRef(rootDir, <ref>)` → (2) `git merge-base <ref> HEAD`。どちらの失敗も `baselineStatus:"unavailable"` に集約し (FR-004/FR-005/FR-012)、メッセージに shallow clone / `fetch-depth: 0` ヒントを含める。

**Rationale**:
- `classifyBaseRef` は 017 (issue #182 レビュー B3) が unborn / error の判別のために導入済み。`isUnbornHead` は `baseRef !== "HEAD"` で即 false を返す (src/baseline.ts:381) ため、**named ref の解決失敗が "unborn" (= baseline 空 = 全部新規) に化けることは構造的にない** — この early return は本 feature の安全性の前提なのでテストで pin する (A10)。
- CI で最も多い失敗は shallow clone (checkout 既定 `fetch-depth: 1`) による ref 未 fetch / 共通祖先の欠落。どちらの段階で失敗しても対処は同じ (`fetch-depth: 0`) なので、ヒント文言は単一定数に集約する (SSOT)。
- `unavailable` への集約 (FR-012) は `--ignore` の pass 再計算 (`src/commands/check.ts:300-310`) の安全性条件でもある: あの再計算は `baselineStatus === "unavailable"` を明示的に non-passing に固定しており、`--base` の失敗がこの status 以外で表現されると `--ignore` 併用時に pass が true に再計算されうる。新しい failure channel を作らないことを設計制約として明文化する。

**Alternatives considered**:
- *`--base` 失敗専用の新 exit code / 新 CheckResult フィールド*: 017 の 0/1/2 契約と JSON 後方互換を壊す。`unavailable` + `baselineError` (017 B1) で判別情報は既に十分。却下。
- *merge-base 失敗時に ref tip へフォールバック*: R1 の誤判定を「たまに」導入する最悪の縮退。fail-closed 一択。却下。

---

## R7. CI 空 diff 警告の抑制

**Decision**: `--base` 指定時は CI 警告 (`src/commands/check.ts:90-93`) を出さない。merged diff が空なら通常の「No changes detected」exit 0 (FR-010)。

**Rationale**: あの警告は「CI では `--diff` が恒常的に空 = 何も比較していない」ことへの注意喚起であり、`--base` はまさにその解消手段。`--base` 付きで merged diff が空なのは「base に対して本当に変更がない」正当な状態 (例: merge 直後の再実行) であり、警告はノイズかつ誤解を招く。警告文言自体も "without --base <ref> (Phase 2 — see #185)" と本 feature を future work として参照しているため、実装時に文言更新する (FR-011)。json の `warnings[]` も同じ条件で CI 警告を含めない (既存 E1 テスト tests/check-baseline-diff.test.ts:175-224 を `--base` あり分岐で拡張)。

---

## R8. 受容する制限 (documented, not fixed)

1. **`trace.staleness: "gate"` の scope 拡大**: base range は作業ツリー diff より広く、scope に入る REQ が増える。従来 scope 外だった stale evidence が新たに exit 2 を出しうるが、「その REQ はこの変更範囲に本当に入っている」ので意味的に正しい。docs / `templates/skills/_shared/output-schema.md` に明記。
2. **config skew**: baseline scan は **現在の** `.artgraph.json` を base worktree に適用する (017 既存挙動: `computeBaselineIssues` は config 引数を受けそのまま `scan(<tmp>, config)`)。base が遠いほど config (include/specDirs 等) と base 時点のファイル配置の skew が大きくなる。base ref 時点の config を読む案は「config パースの二重化 + config 自体の drift 検出」という別問題を持ち込むため採らず、既知の制限としてドキュメント化する (017 R3 の「現在基準」方針と同型)。
3. **Submodule**: 017 どおり fail-closed (`unavailable`)。メッセージの "see #185" は本 feature が消化するため文言変更のみ (FR-011)。

---

## まとめ: 未解決の NEEDS CLARIFICATION

なし。D1–D3 (2026-07-15 承認) と R1–R8 で全論点を解決済み。実装細部 (merge-base ヒント文言の正確な wording、`resolveMergeBase` の配置は data-model.md §3 の推奨に従う) は tasks フェーズで確定する範囲。
