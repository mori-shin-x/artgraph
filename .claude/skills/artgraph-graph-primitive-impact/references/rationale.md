# チェックの根拠と過去の事故

親 SKILL (`../SKILL.md`) の 24 チェックのうち分量の大きい 6 つ (11-B / 17 / 18 / 19 / 21 / 24) について、
**規則の機序**(なぜその挙動になるのか)、**ツール比較表**、**過去の事故 (前例)** をここへ退避してある。

**このファイルを読まなくても、SKILL.md 側の手順だけでチェックは実行できる。** 開くのは次の場合:

- 規則の出どころを確かめたい / 規則を変えようとしている
- 報告の (e) 根拠欄に「なぜこの経路が silent なのか」を書く必要がある
- Step 9 振り返りで「このチェックは過去に何を捕まえたか」を照合する

---

## チェック 11-B. recognize ↔ rewrite/validate パリティ監査

### なぜ 11-A では届かないか

11-A は「分類変数名」を起点に消費者を追う。変更が「ある**構文**を認識する規則」を狭める / 広げる場合はこれでは届かない — 同じ構文を**書き換える・検証する**側は分類変数を経由せず、構文リテラルを自前で綴り直しているためである。だから grep は分類変数名ではなく、変更する構文のリテラル断片から作る。

### 前例: PR #429 (issue #422)

見出し文法の受理集合を広げたとき、消費者を全数列挙しないまま `rewriteSpecHeading` だけを直し、`specDefinitionId` (split/merge が定義行の特定に使う) を漏らした。結果 `rename --merge` が exit 0 で成功を報告しながら spec を半適用し、直後に `check --gate` が 0→2 になる回帰を**その PR 自身が持ち込んだ** — その PR が閉じようとしていた欠陥クラスそのもの。step 2 の grep (`git grep -n '(#+' -- src`) は 5 行 / 3 ファイルを返し、漏れた 2 箇所 (`specDefinitionId` と `rewriteSpecHeading` の custom grammar 経路) を両方含んでいた。さらにレビュー段が作った消費者表も 9 ヒット中 5 行しか載せておらず、`src/parsers/sdd-files.ts` の 2 行を無言で落としていた (step 1 の「全行載せる」はこれを防ぐ)。

### 前例: PR #423 (issue #387)

パーサは「タグがコメントを**開いて**いるか」に変わったのに、`src/rename.ts:302` / `src/rename-executor.ts:689` は「その**行**のどこかに `//…@impl` があるか」のまま残った。結果 (a) claim が 1 本も無い散文を `rename` が書き換える、(b) `rename --split` が実在しない claim に `manual-assignment-needed` 警告を出し、`rename-executor.ts` の安全弁 (`allChanges.length === 0 && warnings.length === 0` で throw) を偽の警告で満たす。メタレビューの横展開でさらに 4 件が出た — `req:` annotation は `\s*` で改行を跨ぐが rewriter は行単位 / **`tasks.md` の task-tag は一切書き換えられず、しかも `findOrphans` の task スキップ (`src/graph/traverse.ts:697`) と結合して rename 後の宙づりエッジが完全沈黙する (最も深刻)** / 順序付きリストの req 定義が書き換えられない / インデントコードブロック内の擬似定義が書き換えられる。5 件まとめて #426。1 チェックあたりの finding 数が最大だった。

---

## チェック 17-A. ファイル内容のバイナリ判定による脱落

### 機序

「対象パターンを `src/` 配下で再帰的に grep し、ヒットした箇所を全消費者/全生成元として扱う」という前提は、対象ファイルに生の NUL バイトが 1 バイトでも含まれていると崩れる (複合キーの衝突回避セパレータとして `` `${a}\0${b}` `` の形で意図的に埋め込まれるケースが本リポジトリに実在する)。ripgrep・git grep・Claude Code の Grep ツールは、NUL バイトを検出した時点でそのファイルを「バイナリ」として扱い、既定では通常の内容一致表示をスキップする。

脱落は exit code 0・stderr 無しで起きるため、ヒット件数が減ったことに気づく手掛かりが原理的に存在しない。

### ツール別の脱落可視性 (SKILL.md 冒頭「横断 grep を始める前に」が参照している表)

**脱落の可視性はツールにより異なり、最も一般的な呼び出し方 (ディレクトリ/glob 対象の再帰探索) が最も危険:**

| ツール / 呼び出し方 | 挙動 |
| --- | --- |
| `rg <pattern> src/` (ディレクトリ/glob 再帰) | 該当ファイルは結果から**何の痕跡もなく**消える。stdout・stderr・exit code のいずれにも異常は出ない。`-l` / `-c` でも同様 |
| `rg <pattern> <file>` (単体指定) | `binary file matches (found "\0" byte around offset N)` を出すが、既に疑わしい 1 ファイルを名指しできている場面でしか得られない |
| Claude Code の **Grep ツール** | 無言で除外し、かつ `-a` / `--text` / `--binary` 相当のパラメータを持たない。**このツール単体では完全性を担保できない** |
| GNU `grep -rn` (内容表示) | notice を **stderr** に出す |
| GNU `grep -rl` (一覧モード) | 該当ファイルを正しくヒット扱いでリストする |
| `git grep <pattern>` (内容表示) | `Binary file <file> matches` を **stdout** に出す |
| `git grep -l` | 正しくリストする |

「grep 出力に `binary file matches` が出ていないか確認する」だけでは不十分な理由もこの表にある — 実際の横断監査で最も使われる呼び出し方 (ディレクトリ対象の `rg` / Grep ツール) では、この文字列自体が一切出力されない。

### 監査手順 step 2 の補足

`<pattern>` を省略した `rg -l --glob '*.ts' src` が cwd 全体を探索することは、`rg -l --glob '*.ts' -e src .` と同一の結果になることで確認できる。エラーは出ず差分も非ゼロで返るため監査が成立したように見えてしまう — このチェックが警告している失敗そのものが、コマンドの書き間違いでも起きる。

### 監査手順 step 4 の補足

`` `${a}\x00${b}` `` の実行時の値が raw byte 版と完全に同一であることは `a\x00b === Buffer.from([...]).toString()` が `true` になることで確認できる。

### 前例: PR #376 / PR #390

PR #376 — symbol ノード生成箇所の横断 grep が `src/graph/star-expansion.ts` を静かに取りこぼし、7 箇所を 6 箇所と誤って結論した (PR 本文に記録)。PR #390 — 同じ `star-expansion.ts` が同じ理由で再び脱落し (同時に `src/trace/ingest.ts` も脱落)、`lastIndexOf("#")` の該当箇所数を 6 ファイルを 5 ファイルと誤って結論した (PR 本文に記録。脱落した ingest.ts は当該 PR 自身が編集していたファイルだった)。

---

## チェック 17-B. pathspec の複合 glob による探索範囲の脱落

### 機序: git pathspec の wildmatch 意味論

git の pathspec は既定で wildmatch を **pathname 意味論なし**で適用する。つまり `*` は `/` を跨いでマッチし、`**` は `*` と同義で、パターン中に書いた `/` は**必ず 1 個消費されるリテラル**になる。帰結として `'docs/**/*.md'` は「`docs/` 配下の全 `.md`」ではなく「**中間ディレクトリを 1 段以上挟む** `.md`」を意味し、`docs/` 直下のファイルを 1 件残らず落とす。

git だけが「0 段以上」ではなく「1 段以上」に解釈するため、手元で見慣れた glob 意味論で検算すると正しく見えてしまう。

### 同一パターンのツール間比較

**この罠が特に危険なのは、同じパターン文字列が他ツールでは期待どおりに動くこと**:

| 同一パターン `d/**/*.md` | `d/top.md` | `d/sub/nested.md` |
| --- | --- | --- |
| git pathspec (既定) | **落ちる** | ヒット |
| git pathspec `:(glob)` 明示 | ヒット | ヒット |
| ripgrep `--glob` | ヒット | ヒット |
| bash `shopt -s globstar` | ヒット | ヒット |

`:(glob)` magic を付けると範囲が**広がる**(直感と逆) ことは、この表と下の self-check で確認できる。

### 本リポジトリで再現できる self-check

```bash
git grep -la 'export' -- 'src/**/*.ts' | wc -l   # 59 — src/ 直下 22 ファイルが無言で脱落
git grep -la 'export' -- src           | wc -l   # 81
```

脱落するのは `src/config.ts` / `src/scan.ts` / `src/check.ts` / `src/baseline.ts` / `src/glob-utils.ts` など、**他チェックが消費者・生成元として名指しする中心ファイル群**。

---

## チェック 18-A. fixture 文字列 × 自身の scan 対象

### 機序: なぜ全階層が scan 対象になるか

`include` と `testPatterns` は独立した glob プールとして union されるため、`testPatterns` の `**/*.test.ts` が全階層に効く。`tests/helpers.ts` への退避が形状を問わない回避策になるのは、このファイル名が `*.test.ts` にも `src/` にもマッチせず、どちらのプールからも外れるため。

### 機序: 実在 REQ と衝突したときになぜ `orphans` が動かないか

fixture の ID が実在する REQ と衝突した場合、生成される偽エッジは orphan にならない (ターゲットが実在するため) ので `orphans` は完全に不変のまま、その REQ の status だけが `impl-only` → `verified` にサイレント反転する。`uncovered` / `drifted` / `pass` / `newIssues` のどれもこの変化を映さない。しかも「改善方向」の変化なので gate も素通りする。

これは実測済み: 実在する `impl-only` の REQ をブラケットで参照する fixture を足すと、`orphans` は 128 のまま集合も一致し、その REQ だけが `verified` に反転する。

### なぜコメント本文が特に危ないか

回避慣習を正しく適用した直後に、その理由を書いた散文で汚染する事故が実在する。

### 監査範囲が新規混入の予防に限られる理由

既存の混入の発見は PR 起点に依存しない定期監査 / doctor 診断側の課題。予防が効くほど新規混入という「発見の起点」が減るため、既存分は別途扱う必要がある。

### 前例: PR #386

新規 fixture の `"- [ ] T101 do it [FR-101]"` が `testReqRe` にマッチし、本物のグラフに `verifies` 偽エッジ 2 本が生えた (orphans 128→130)。同ファイルには `"@" + "impl ..."` 分割が既にあったが、それは別形状に効く慣習でブラケットには無力であり、ブラケット分割の前例 (`tests/parser-oxc-canary.test.ts`) は別ファイルにあったため参照されなかった。

---

## チェック 18-B. 実リポジトリを対象にする dogfood テストの副作用監査

### 機序: なぜ `src` ビルドが書いたキャッシュを `dist` ビルドが読むか

`computeCacheFingerprint` は `SCHEMA_VERSION` + `artgraphVersion()` + config のみで構成され、`artgraphVersion()` は src 実行時も dist 実行時も同じ `package.json` を読む。したがってキャッシュのキーに「どのビルドが作ったか」は入らず、両者は HIT する。

### step 1 の grep 形が引数の値でなければならない理由

`buildGraph(REPO_ROOT` だけで grep すると `runPlanCoverage({ repoRoot: REPO_ROOT … })` が落ちる — 実際に落ちた。

### 前例: PR #423 (issue #387)

新設した dogfood テストが `buildGraph(REPO_ROOT)` を呼び、リポジトリの実 `node_modules/.cache/artgraph/parse-cache.json` (745 KB) を生成した。**同じ PR が `SCHEMA_VERSION` を bump してまで潰した「warm ≠ cold」汚染チャネルを、別方向に開けていた** — 修正前パーサで温めたキャッシュを修正後バイナリが warm 読みすると orphans 118 / cold は 110 (実測)。さらに step 1 の grep 漏れにより、**同じチャネルが `tests/plan-coverage-dogfood.test.ts` (PR #362 由来) で以前から開いていた**ことが後段で判明した (#427)。事後監査は grep 3 本で全数済んだ = 事前化のコストは実質ゼロだった。

---

## チェック 19. 生成値を比較キーへ昇格させる変更の環境不変性監査

### 機序: 二重 materialization (step 2 の詳細)

baseline worktree は `git worktree add` 実行時点の**現在の** git 設定でマテリアライズされ、current 側は working tree が最後にチェックアウトされた時点のバイト列を読む。step 1 の生成レシピ非対称は単体では発火せず、この checkout 時点差と組み合わさって初めて同一 blob が両側で別ハッシュになる。

### 前例: PR #397 (issue #383)

driftKey への currentHash 折り込みで、typescript.ts (EOL 非正規化・BOM 除去) と markdown.ts (EOL 正規化・BOM 非除去) の既存レシピ非対称が二重 materialization と組み合わさり、独立理由で drift 済みの無編集ノードが gate を落とす偽陽性経路になることが Step 4 まで検出されなかった。spec 022 FR-006 の byte-identity pin により修正は cross-spec 切り出しになった (#398)。

### step 5-7 の前例: PR #417 (issue #235)

(i) mdast offset を post-frontmatter 文字列の添字として使う設計で、先頭 U+FEFF があると micromark 側だけが 1 文字読み飛ばし、全 offset が 1 ずれて**ファイル全体で正規化が no-op** になった (#420)。Step 0-pre は「`markdown.ts` は BOM を除去しない」ことを明記し、`raw.endsWith(content)` プローブでは **BOM 入力を実際に構成していた**が、その入力を offset 写像の健全性側へ sweep しなかった。offset の健全性は emoji / CJK (= 文字幅の軸) だけで検証され、prefix 読み飛ばしの軸が空だった。レビューが投じた 5,880 形 + 4,000 ランダム入力は「バイト変化 0 件」を安全の根拠にしたが、**その 0 件が症状そのものだった**。(ii) 初版の形状述語は `]` の後続文字を見ておらず、`- [x](/href)` / `- [x][ref]` / `- [x]tight` を canonical 化して `[ ]` 綴りと hash 衝突させていた (実測: 両者が同一ハッシュ `59268fd05d24d1d2`)。fixture 表は over-broad を state 文字の軸 (`[-]`/`[~]`/`[P]`) でしか考えていなかった。実装者が自力で発見し「計画外なので実装せず報告」した。

---

## チェック 21. 必須 fixture の判別力設計

### 機序: なぜ経路の列挙だけでは足りないか

**挙動保存 (equivalence) を契約とする変更** (性能リファクタ、データ構造の差し替え) では、経路を通るだけの fixture は新旧どちらの実装でも同じ値を返すため、実装が誤っていても緑のままになりやすい。

### step 1 で「変更しない分岐も含める」理由

挙動保存 PR は「この関数の未 fixture 経路に初めて fixture を付けた」と主張しがちで、レビューはその主張を分岐単位ではなく**関数全体**に対して評価する。

### 前例: PR #417 (issue #235) — conjunct 台帳の欠落

4 conjunct のうち **2 つに isolating fixture が無かった**。(i) 閉じ括弧 conjunct: 既存の `- [xx]` assertion がそれを pin していると設計時点で想定されていたが、後から追加された後続空白 conjunct が先に弾くため、閉じ括弧 conjunct を削除する mutant が全スイート緑で生存した。isolating 入力は `- [x  ] a`。(ii) `after === undefined` 分岐: 既存の assertion がヘルパ経由で末尾改行を付けており `after === "\n"` を通っていた。isolating 入力は末尾改行なしで `]` で終わるファイル。(iii) accept 側の列挙 (2-B-6) が無かったため、`- [x](/href)` を accept してしまう 4 番目の conjunct の欠落が実装段階まで発見されなかった。

### 前例: PR #423 (issue #387) — 2-B-0 の欠落

**台帳を作り、コンパイル済み `dist` から conjunct を個別に外した 5 ビルドで mutation まで実測したうえで**、2-B-0 が無いために回帰が通り抜けた。新設ガードは `implRe` が既に受理した区切り空白を再検証する述語だったが、上流 `[^\S\n]` に対して `[ \t]` と綴られ、**22 コードポイント** (NBSP U+00A0、全角スペース U+3000、FF、VT、CR、U+2028/2029、U+FEFF ほか) で受理集合が狭かった。日本語コメント主体の下流では現実的に踏む形状で、しかも 4-B の性質により**恒久的にゲートから見えない**。`[ \t]` を pin するテストは 0 件で、`[^\S\n]` に mutate しても 124 ファイル全 pass だった。共有定数化した後に 2-B-0 step 4 を当てると、その定数が oxc の**行終端** `U+000D` / `U+2028` / `U+2029` を含むことも出る。さらに containment conjunct は isolating 入力では「反転せず」に見えたためコードコメントに「冗長」と書かれたが、実際は削除すると**最初の Line コメントで `return`** してしまい後続コメントの本物のタグが全滅する false-negative 方向の load-bearing で、フルスイートでは **68 テスト / 17 ファイル**が赤になった (isolating 入力だけで測った「20 件」は parser 系 5 ファイルに限った数字だった)。

---

## チェック 24. 抑制する signal の retention 監査

### 機序: 既存チェックとの守備範囲の違い

チェック 4 は gate が誤って green になる経路を追い、チェック 2 は消費側の意味論を問うが、どちらも「消した signal がどこにも残らない入力クラスがあるか」を問わない。

### 前例: PR #417 (issue #235)

doc hash から checkbox 状態を落とす緩和で、「状態は task ノードで見える」が緩和の根拠に使われた。しかし task ノードは lock エントリにならない (`src/lock.ts:288` が `req`/`doc`/`symbol` 以外を skip) ため、drift 経路には元から現れない。さらに `specs/*/checklists/requirements.md` のような **task ID を持たないチェックリストは doc ノードしか生成しない**ので、その状態はグラフと lock のどこにも残らない — サインオフ済みチェックリストを全部 untick しても `check` が完全に無反応になる。本リポジトリで影響を受ける 36 doc のうち 15 件がこの形。Step 0-pre は構成要素 (task は lock 対象外 / チェックリストが最多) を両方**独立に実測していた**が、合成して「どこにも残らないクラス」を数えていなかった。

### 前例: PR #423 (issue #387)

upgrade note が「`@impl` claim を 1 つ失えば `check` の `UNCOVERED:` に出る」と書いたが、`uncovered` の条件は `implFiles.length === 0` (`src/coverage.ts:112-116`) なので、**同じ requirement に別の claim が残っていれば `check` はまったく反応しない**。step 3 の判定オラクルを「その REQ に別の claim がある」入力クラスへ当てれば出た。この行は Step 0-pre 報告が既に逐語で引用していた。
