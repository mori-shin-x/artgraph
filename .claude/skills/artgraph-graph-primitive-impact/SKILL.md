---
name: "artgraph-graph-primitive-impact"
description: "artgraph コントリビュータ向け内部 skill。グラフ基本操作 (src/graph/traverse.ts / src/graph/builder.ts の BFS・エッジ意味論・ID 解決) や graph-core 関数 (impact() / check() / buildGraph()) を変更する issue/PR に着手する前 (Step 0-pre) に、23 チェックの shift-left インパクト調査を実行し「silent に破壊される経路」のランク付きリストを報告する。Use when starting a PR that touches src/graph/, edge semantics, or graph-core function signatures/return values."
allowed-tools:
  - "Read"
  - "Glob"
  - "Bash(grep *)"
  - "Bash(git grep *)"
  - "Bash(git log *)"
  - "Bash(git diff *)"
user-invocable: true
disable-model-invocation: false
---

## Purpose

**artgraph リポジトリ内部専用の dev process skill**(`templates/skills/` の一般配布ツリーには含まれない。canonical コピーは `.claude/skills/artgraph-graph-primitive-impact/SKILL.md` のみ)。

グラフ基本操作 (BFS / エッジ意味論 / ID 解決) は多数の CLI コマンドと gate 経路から間接消費されており、意味論を狭める・広げる変更は**直接の呼び出し元 grep では見えない経路を silent に壊す**。本 skill は issue 対応ループの **Step 0-pre**(設計より前)で、その経路を事前に列挙するための 23 チェック調査を定義する。

## トリガー条件

以下のいずれかに該当する issue/PR に着手する時、設計 (Step 0) の**前に**本調査を実行する:

- `src/graph/traverse.ts` / `src/graph/builder.ts` を変更する
- エッジ意味論 (kind の追加・削除、forward/reverse トラバース条件の変更) を変える
- `impact()` / `check()` / `buildGraph()` など graph-core 関数のシグネチャ・戻り値・意味論を変更する

## 実行モデル

**クリーンな Opus 5 (`claude-opus-5`) サブエージェント**に委譲する。メイン loop の文脈 (実装方針の仮説) を持ち込まないことで、確証バイアスなしに経路を列挙させる。

サブエージェント brief テンプレ:

> あなたは artgraph リポジトリの調査担当です。これから `<変更対象の primitive / 関数 / エッジ kind>` を `<変更の一行要約>` する変更を検討しています。実装はまだ存在しません。
> `.claude/skills/artgraph-graph-primitive-impact/SKILL.md` の 23 チェックを順に実行し、「この primitive を変えると SILENT に破壊される経路」のランク付きリストを報告してください。各項目には (a) 経路の説明 (b) 影響を受ける CLI コマンド (c) 該当テストの有無 (d) 推奨 (本 PR で fix / 別 issue / accept) を含めること。

## 横断 grep を始める前に

この調査で「全部で N 箇所」「他に無い」型の完全性を主張する横断 grep を行う場合、**check 2 / 11 / 13 に限らず調査全体を通じて**、`Bash(grep -a ...)` または `Bash(git grep ...)` を使うこと (`git grep` は `-l` 一覧モードなら**バイナリ判定については**既定で安全 — 詳細は check 17 A の表)。`rg` そのもの、および `rg` 実装の検索ツール全般は `-l` / `-c` でも既定で NUL バイト入りファイルを無言で除外するため、完全性が要求される横断 grep には使わない。本 skill の `allowed-tools` に `Grep` ツールを含めていないのはこのため — cross-file 検索は `Bash(grep -a)` / `Bash(git grep)` のみで行う。

加えて、**探索範囲を絞る pathspec に `'src/**/*.ts'` 形の複合 glob を使わない**。git は既定でこれを「中間ディレクトリを 1 段以上挟むもの」に解釈し、ディレクトリ直下のファイルを無言で全部落とす (ripgrep や bash の同名パターンとは意味論が違う — check 17 B)。pathspec はディレクトリ止め (`-- src`) にすること。

## 23 チェック

### 1. 直接呼び出し元

変更対象の関数名で全呼び出し箇所を列挙する。

```bash
grep -rn "<関数名>(" src/ tests/
```

これは**出発点にすぎない**。チェック 2 以降が本体。

### 2. 戻り値フィールドの transitive consumer trace

変更対象が返す**各フィールド名**を grep し、非テストコードの消費側を追う。関数名ではなくフィールド名で追うのがポイント(呼び出し元が結果オブジェクトを別関数に渡した先で消費されるケースを捕まえる)。

```bash
# impact() の例 — 返却フィールドごとに実行
for f in impactReqs affectedFiles affectedDocs affectedTasks drifted originReqs reqProvenance testsToRun warnings; do
  echo "== $f =="; grep -rn "$f" src/ | grep -v "\.test\."
done
```

浮上した消費側それぞれについて「変更後の意味論でこの消費は正しいままか」を判定する。

### 3. CLI サブコマンド全網羅マトリクス

`scan / check / impact / plan-coverage / rename / trace report / graph / init / reconcile / doctor` の各 CLI 入口 (`src/commands/*.ts`) を Read し、変更対象の primitive を**直接/間接**に使用しているかを ○/× のマトリクスで判定する。「間接」はチェック 2 の consumer 経由を含む。

### 4. Gate クリティカル経路

fail の見逃しが最も高コストな経路を個別に追う:

- `check --diff --gate`(AGENTS.md の標準ゲート)
- `plan-coverage --gate`
- Stop hook 経由の `check --gate`
- CI の `check --diff --base origin/<base> --gate`

これらの入口関数から変更対象への到達可能性を追い、「gate が誤って green になる」パターンがあれば **HIGH** として報告する。

### 5. Cross-cutting config 交差

`acceptExercises` / `staleness` / `trace.acceptExercises` / `docGraph.autoNodes` / `ignoreIdPrefixes` など `.artgraph.json` の config キーが変更対象と交わる箇所を grep する。config の ON/OFF で変更後の挙動が分岐する場合、両側を影響リストに含める。

### 6. spec.md FR-XXX 逆引き

```bash
grep -rn "<primitive 名 / エッジ kind / フィールド名>" specs/*/spec.md
```

変更対象を要件文言で参照する FR を列挙し、spec 側の追随変更要否を判定する。追随が要るのに触らない場合、`check` の drift 検出対象になるかも確認する。

### 7. hub-node パターンの網羅監査

対象の edge kind に**同じ hub-node パターン**(single node が多数の incident edges を持ち、bidirectional traversal で pass-through する)を持つ他の辺 (`contains` / `exercises` / `verifies` / `imports` / `depends_on` / `derives_from`) がバイパス経路を作らないかを監査する:

1. `src/graph/traverse.ts` の BFS 内で `edge.target === id` の逆方向トラバースを許可する edge kind を列挙
2. 各 kind について、graph 上で hub-node になりうる node kind (doc, test, file) を洗い出す
3. 対象修正後、hub-node を経由した「A → hub → B」(A/B は本来独立) の到達経路が残らないか、fixture ベースで想定 test を書き出す。fixture を手組みグラフで書く場合、**実パーサー由来の粒度制約との乖離**に注意する (例: test ファイル起点の `imports` 辺は `useSymbol = mode==="symbol" && !isTest` により常に file 粒度 — symbol 粒度の手組み fixture では実 CLI で再現しない経路を「検証済み」と誤認しうる。PR #363 E2E で発見)
4. 想定 test の一つでも「元 issue の症状を再現する」なら、修正方針の拡張 or 別 issue 切り出しを判断

hub-node pass-through 経路の例:

```
symbol:fnB
  → (forward implements) REQ-902
    → (reverse verifies) test:tests/sample.test.ts     ← hub node
      → (forward verifies) REQ-901
```

### 8. CLI フラグ parse 意味論監査

gate 判定に関与するコマンドへ**値必須オプションを追加・変更する** PR では:

- (a) **greedy consumption**: `--flag` の直後に別フラグが来た場合に何が起きるか(commander は次のフラグを値として飲み込み、gate を無言解除しうる)
- (b) **空文字値**: `--flag ""` の挙動
- (c) **兄弟オプション横展開**: 同コマンドの他の値必須オプション (`--ignore` / `--format` など) に同型欠陥がないか
- (d) **fail-open 禁止**: parse 失敗時に gate が緩む方向に倒れないこと。repo convention は parse 時の `argParser` / `.choices()` 拒否

### 9. エラー原因の stage 帰属表(弱)

複数 stage が同一 failure channel(例: `baselineStatus: "unavailable"`)に合流する設計を導入・変更する場合、contract に**「原因 stage × ユーザー向けメッセージ」の対応表**を書き、誤帰属をレビュー可能にする。該当しない PR ではスキップしてよい。

### 10. 借用ガード述語の粒度監査 (per-edge vs per-node/global)

チェック 2/4 で「既存の REQ 分類・集合 (例: evidence-only REQ, `reqsWithImplements`) が gate false-green の鍵になる」と判明した場合、Step 0 の設計候補がその概念を**免除・ガード述語**として再利用することを見越し、以下を先回りで監査する:

1. 候補となる述語がどの単位 (edge 単位 / node 単位 / global) で評価されそうかを、既存の類似コード (`grep -n "reqsWithImplements\|acceptExercises" src/graph/*.ts`) から推定する。
2. hub-node (チェック 7 参照) が、その述語の対象条件を満たす incident edge を**複数**持つ fixture を書く (例: 同一 test node に evidence-only REQ が 2 つ以上 verifies している状態)。チェック 7 step 3 の A/B ペアは 1 個ずつでなく、**同種条件を満たす複数**で試すこと。
3. per-edge 粒度の判定が、意図した per-node/global の保証を破らないかを確認する。
4. 述語が依存する集合の再帰適用がある場合、hub を複数段連鎖 (daisy-chain) させても崩壊が増幅しないか、また到達深さ (maxDepth 等) が全 production call site で明示的に制限されているかを確認する。
5. 崩壊が見つかった場合、経路は「述語の粒度崩壊 → hub 経由の非独立到達」として記述し、gate 判定に絡むなら HIGH とする。
6. **述語のデータソース空集合監査**: 新設・変更する述語が特定のデータソース (trace 証跡、lock、外部成果物等) から構築される集合に依存する場合、**そのソースを導入していない/空のプロジェクト母集団**を列挙し、空集合時に述語が恒久 true/false に縮退して正当な経路まで全滅させないか (fail-open/closed をどちらに倒すか) を設計時に決めて fixture で実測する。前例: PR #363 H1 — exercises 辺のみから構築した照合述語が shard 未導入プロジェクトで恒久空集合になり、正当な evidence-only REQ まで gate scope から消えた (false-green)。

### 11. 判定材料 (node kind 等) の生成元 × config 整合 + 全消費者トレース

変更対象のロジックが特定の **node kind / boolean 分類** (例: `kind === "test"`, `isTest`) をガード条件として参照する場合:

1. 分類の計算箇所を特定する: `grep -rn "isTest\|kind.*===.*\"test\"" src/`
2. 生成元がハードコード (正規表現等) か `.artgraph.json` の config (`testPatterns` 等) を参照しているかを確認する。両方存在する場合、単一の関数/config に統合されているか、乖離しうるかを判定する。
3. チェック 2 の要領で、その分類結果 (boolean / kind 文字列) の**全消費者**を関数名でなく値/フィールド名で grep し、変更対象のロジックが触れていない箇所 (例: 別のタグ抽出関数) でも同じ判定材料に依存していないかを洗い出す。
4. 乖離や把握漏れの消費者が見つかった場合、本 PR の適用範囲外でも pre-existing の同根問題として MEDIUM 以上で報告し、別 issue 切り出しを推奨する。

### 12. docs/ 内の不変条件記述の逆引き (チェック 6 の docs 拡張)

チェック 6 は `specs/*/spec.md` のみを対象とするが、`docs/` 配下のユーザー向けガイドも同種の断定表現 (「常に」「必ず」「保証される」「混入しません」等) を含みうる。

```bash
grep -rn "<primitive 名 / 保証している挙動のキーワード>" docs/
```

該当箇所を列挙し、変更後も文言が成立するかを判定する。不成立なら doc 更新を本 PR のスコープに含めるか、caveat 追記を推奨する。

### 13. ID 表現粒度の生成元 × 全消費者比較監査 (チェック 11 の ID 版)

変更対象が扱う node ID が複数の粒度で表現されうる場合 (例: `file:` 単位 vs `symbol:` 単位、mode/config で切り替わる ID 体系):

1. ID を生成・解決する箇所を特定する: `grep -rn "resolveTraceGraphNodeId\|toNodeId\|nodeId =" src/`
2. 各生成箇所が単一の正規化/解決関数を経由しているか、独立実装 (raw 文字列の構築・比較) かを確認する。
3. チェック 2 の要領で、その ID を比較・照合する全消費者 (`.has(`, `===`, `.get(` 等) を関数名でなく「比較対象の ID 変数名」で grep し、`mode: "file"` のような config/mode 分岐ごとに**両辺の粒度が一致するか**を検証する。
4. 一致しない消費者が見つかった場合、本 PR の適用範囲外でも pre-existing の同根問題として MEDIUM 以上で報告し、別 issue 切り出しを推奨する (worktree 比較で pre-existing 判定を先取りしてよい)。

### 14. I/O 呼び出しの網羅監査 (多重取得の整合含む)

チェック 2 はフィールド名 grep が起点のため、返り値に現れない内部の raw I/O 呼び出し (`readFileSync` / `globSync` / `writeFileSync` 等) を捕捉できない。以下を対象ファイル・関数について監査する:

1. **多重取得の整合**: 同一ファイル/リソースを複数回 (例: hash 算出用と実処理用) 読み取る設計がないか `grep -n "readFileSync\|globSync" <対象ファイル>` で洗い出す。ある場合、2 回の取得が非対称に (片方だけ) 失敗しうるか、また片方の取得結果 (hash 等) を「真」としてもう片方の失敗結果を紐付けて永続化 (cache 等) していないかを確認する。
2. **ガード網羅性**: PR の目的が特定の失敗モード (EMFILE/ENFILE 等) への耐性追加である場合、対象ファイル内の全 raw I/O 呼び出しについて、意図したガードが適用されているかを一つずつ判定する (issue が名指しした箇所だけでなく)。
3. **ライブラリ間の失敗セマンティクス対称性**: 同一目的で複数の外部ライブラリを併用している場合 (例: 別々の glob 実装)、それぞれの errno / 失敗時セマンティクスが対称か (一方は throw、他方は握りつぶし、等) を比較する。
4. **既知 silent-failure ライブラリの import 全数列挙**: 対象ファイル・対象サブシステムの `import` を列挙し、silent-failure 前歴のあるライブラリが残っていないか確認する。本リポジトリの既知例: `glob` パッケージ (`path-scurry` が EMFILE/ENFILE を含む未知 errno を空 children にマップし、**throw せず空配列を返す** — issue #335 の根本原因、`src/glob-utils.ts` ヘッダ参照)。前歴: PR #353 レビュー H1 — 耐性追加 PR の Step 0-pre が buildSymbolNameTable チェーンの raw I/O は監査したのに、**同じ対象ファイル (ingest.ts) 内の shard 探索 `globSync`** を見落とした。存在プローブ (`has*` 系) や探索関数もサブシステムの I/O 入口として監査対象に含めること。

### 15. 不可能性主張の構成ソース網羅検証

調査報告の中で「X はこの集合に入り得ない」「この経路は原理的に到達不能」型の**不可能性主張**を根拠として使う場合、その集合/経路が**複数ソースの合成 (union / merge / fallback)** で構成されていないかを先に確認する:

1. 集合の構築箇所を grep (`new Set([...a, ...b])` / spread merge / `.concat` 等) し、全構成ソースを列挙する
2. 主張を各構成ソースに対して**個別に**検証する。特に current グラフ vs baseline グラフのように同名概念が別時点・別オブジェクトの複数インスタンスを持つ場合、「現在のグラフに存在しない」は「baseline 側にも存在しない」を意味しない
3. 一つでも反例ソースがあれば主張を撤回し、(e) 欄の根拠から除去する。撤回後も設計が成立するか (その主張に依存しない理由付けに置き換えられるか) を再判定する

前例: PR #341 M2 — 「stale lock id は scope に入り得ない (graph.nodes に無いから)」は current グラフのみを見た主張で、実際の CLI scope は current ∪ baseline の union であり baseline 側に rename 前の旧 id が入る反例があった。誤った主張が brief の逐語引用経由でコードコメント 3 箇所まで伝播した。

### 16. デフォルト値による保護の到達性監査 (カスタム config への伝搬)

修正・保護を **`DEFAULT_CONFIG` への値追加** (保護的負パターン、除外リスト、閾値等) で実現する設計を検討する場合:

1. その config キーの読み込み箇所を確認する: `grep -n "raw\.\|?? DEFAULT_CONFIG" src/config.ts`。`raw.x ?? DEFAULT_CONFIG.x` の**完全上書き**であれば、該当キーをカスタム指定している既存ユーザーには新しいデフォルト値が**一切届かない**。
2. 届かないユーザー集団にとっての帰結を実測する (保護が無い状態で何が起きるか)。gate / lock / suppression 機構がその帰結を検出できるかまで確認する (「改善方向の変化」— 例: coverage が impl-only → verified — は issue として扱われず、gate は構造的に沈黙しうる)。
3. 届かない場合の補完策 (doctor 診断 / scan 時の proactive 警告 / マージ意味論への変更) を設計の検討事項として報告に含める。

前例: PR #355 H1 — `DEFAULT_CONFIG.testPatterns` への `"!**/node_modules/**"` 追加はカスタム testPatterns ユーザーに届かず、vendor の偶然の `[REQ-x]` タグが REQ を静かに verified に反転、CI ゲートは構造的に検知不能だった (Step 0-pre はデフォルト側の非対称のみ検出し、伝搬ギャップを見落とした)。include 側にも #287 以来の同型ギャップがあった (issue #356)。

### 17. 横断 grep の静かな脱落監査 (A: バイナリ判定 / B: pathspec glob)

チェック 2 / 11 / 13 は「対象パターンを `src/` 配下で再帰的に grep し、ヒットした箇所を全消費者/全生成元として扱う」ことを前提にしている (チェック 14 も step 4 の import 全数列挙をサブシステム単位で回す場合は同じ前提に乗る。step 1 の例示は単体ファイル指定なので該当しない)。この前提を無言で崩す経路が**独立に 2 つ**ある — A (ファイル内容によるバイナリ判定) と B (探索範囲を絞る pathspec/glob の意味論)。**両方とも exit code 0・stderr 無し**で、ヒット件数が減ったことに気づく手掛かりが原理的に存在しない。B は A と違い `-a` / `--text` では防げず、`git grep -l` でも起きる。

#### A. ファイル内容のバイナリ判定による脱落

この前提は、対象ファイルに生の NUL バイトが 1 バイトでも含まれていると崩れる (複合キーの衝突回避セパレータとして `` `${a}\0${b}` `` の形で意図的に埋め込まれるケースが本リポジトリに実在する)。ripgrep・git grep・Claude Code の Grep ツールは、NUL バイトを検出した時点でそのファイルを「バイナリ」として扱い、既定では通常の内容一致表示をスキップする。

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

**「grep 出力に `binary file matches` が出ていないか確認する」だけでは不十分**: 実際の横断監査で最も使われる呼び出し方 (ディレクトリ対象の `rg` / Grep ツール) では、この文字列自体が一切出力されない。「出ていない」ことは「取りこぼしがない」ことの証拠にならないため、検出トリガーではなく**予防側** (既定で `--text` を付ける) に倒すこと。

監査手順:

1. チェック 2 / 11 / 13 でパターン・フィールド名・ID 表現を横断 grep する際は、`-a` (GNU grep) / `--text` (ripgrep) を**既定で付ける**。Claude Code の Grep ツールにはこの手段がないため、完全性が要求される監査は Bash 経由に切り替える。本 skill の `allowed-tools` にある `Bash(grep *)` / `Bash(git grep *)` で足りる:

   ```bash
   grep -rla '<pattern>' src --include='*.ts'     # -a で NUL 入りファイルも対象になる
   git grep -la '<pattern>' -- src                # pathspec はディレクトリ止め (理由は B)
   ```

2. 過去に `-a` / `--text` なしで行った監査の網羅性を事後検証する場合は、既定モードとテキスト強制モードのヒットファイル数を突き合わせる。差分がある分だけ取りこぼしがある。

   ```bash
   rg -l --glob '*.ts' '<pattern>' src | wc -l            # 既定
   rg -l --glob '*.ts' --text '<pattern>' src | wc -l     # テキスト強制
   ```

   **`<pattern>` を必ず渡すこと。** 省略して `rg -l --glob '*.ts' src` と書くと、ripgrep は唯一の位置引数を PATTERN として解釈し、探索対象は `src/` ではなく cwd 全体になる (`rg -l --glob '*.ts' -e src .` と同一の結果になることで確認できる)。エラーは出ず、差分も非ゼロで返るため**監査が成立したように見えてしまう** — このチェックが警告している失敗そのものが、コマンドの書き間違いでも起きる。
3. シェル引数には生の NUL バイトを渡せない (`$'\x00'` は空文字列に化ける) ため、NUL 保有の有無を確認する場合はシェル経由でなくファイルをバイト列として直接検査すること。`node scripts/check-no-raw-nul.mjs` (= `pnpm check:no-raw-nul`) が tracked ファイル全体に対するこの検査をすでに実装している (grep 系コマンドを一切使わない実装 — 理由は同スクリプトのヘッダ参照)。まずこれを走らせて対象が既知の NUL 保有ファイルかどうかを確認してから、シェル経由の確認に進む。
4. 対象ファイルの NUL バイトが複合キーの衝突回避など正当な設計意図を持つ場合、**raw byte のまま埋め込まない**。`` `${a}\x00${b}` `` は実行時の値が raw byte 版と完全に同一 (`a\x00b === Buffer.from([...]).toString()` は `true`) で、挙動は変わらない。raw byte を書かないことを第一防御とし、`pnpm check:no-raw-nul` (CI: `nul-guard` job, lefthook 未導入) が tracked ファイル全体に対してこれを強制する。この防御は本リポジトリの tracked ファイルにしか及ばないため、downstream プロジェクトや外部コードを対象にした横断 grep では引き続き手順 1-3 の grep 側頑健化が必要。

前例: PR #376 — symbol ノード生成箇所の横断 grep が `src/graph/star-expansion.ts` を静かに取りこぼし、7 箇所を 6 箇所と誤って結論した (PR 本文に記録)。PR #390 — 同じ `star-expansion.ts` が同じ理由で再び脱落し (同時に `src/trace/ingest.ts` も脱落)、`lastIndexOf("#")` の該当箇所数を 6 ファイルを 5 ファイルと誤って結論した (PR 本文に記録。脱落した ingest.ts は当該 PR 自身が編集していたファイルだった)。**クリーンなサブエージェントへ委譲しても防げない**: 脱落はツール側の挙動であって調査者の注意力の問題ではないため、同じコマンド形を使う限り誰が実行しても同じ結果になる。

#### B. pathspec の複合 glob による探索範囲の脱落

git の pathspec は既定で wildmatch を **pathname 意味論なし**で適用する。つまり `*` は `/` を跨いでマッチし、`**` は `*` と同義で、パターン中に書いた `/` は**必ず 1 個消費されるリテラル**になる。帰結として `'docs/**/*.md'` は「`docs/` 配下の全 `.md`」ではなく「**中間ディレクトリを 1 段以上挟む** `.md`」を意味し、`docs/` 直下のファイルを 1 件残らず落とす。

**この罠が特に危険なのは、同じパターン文字列が他ツールでは期待どおりに動くこと**:

| 同一パターン `d/**/*.md` | `d/top.md` | `d/sub/nested.md` |
| --- | --- | --- |
| git pathspec (既定) | **落ちる** | ヒット |
| git pathspec `:(glob)` 明示 | ヒット | ヒット |
| ripgrep `--glob` | ヒット | ヒット |
| bash `shopt -s globstar` | ヒット | ヒット |

git だけが「0 段以上」ではなく「1 段以上」に解釈するため、**手元で見慣れた glob 意味論で検算すると正しく見えてしまう**。`-a` / `--text` では防げず、`git grep -l` でも `git ls-files` でも同様に起きる (pathspec を解釈する全 git コマンド共通)。

本リポジトリで再現できる self-check:

```bash
git grep -la 'export' -- 'src/**/*.ts' | wc -l   # 59 — src/ 直下 22 ファイルが無言で脱落
git grep -la 'export' -- src           | wc -l   # 81
```

脱落するのは `src/config.ts` / `src/scan.ts` / `src/check.ts` / `src/baseline.ts` / `src/glob-utils.ts` など、**他チェックが消費者・生成元として名指しする中心ファイル群**。

監査手順:

1. 横断 grep の pathspec は**ディレクトリ止め**にする (`-- src` / `-- docs`)。拡張子で絞りたい場合は git 側でなく後段で行う (`| grep '\.ts$'`)。
2. component 単位の glob がどうしても要る場合は `:(glob)` magic を明示する。`:(glob)src/**/*.ts` は `**/` が「0 段以上」になり直下も含む — **magic を付けると範囲が狭まるのではなく広がる**方向なので、直感と逆であることに注意 (上表と self-check で確認できる)。
3. 完全性を主張する前に、必ず**ディレクトリ止めとの件数差**を取る。差が 0 でなければその分だけ脱落している。

### 18. dogfood 自己参照汚染監査 (fixture 文字列 × 自身の scan 対象)

artgraph は自身の `tests/` / `tests/fixtures/**` / `examples/**` を dogfood scan する (`include` と `testPatterns` は独立した glob プールとして union されるため、`testPatterns` の `**/*.test.ts` が全階層に効く)。設計が新規・変更の test fixture を要求する場合 (一時ディレクトリへの書き出し・commit 済み fixture プロジェクト・テストファイル自身の文字列リテラルのいずれでも):

1. fixture 文字列が `@impl` / `[ID]` ブラケット / `req: "..."` のいずれの形状にもマッチしないかを確認する。`buildIdMatchers` (`src/parsers/typescript.ts`) が返す 4 つのうち、**`testReqRe` / `testAnnotationRe` には `implRe` が持つ AST 実コメント判定ガード (`matchInLineComment`) が無い** — 文字列リテラルの中でもコメントの中でも無条件にマッチする。
2. マッチしうる形状を含み、かつその文字列が本プロジェクト自身の scan 対象パスに存在する場合 (一時ディレクトリの外)、既存の回避慣習を**その形状に効くものを選んで**適用する。形状ごとに効く慣習が違う:
   - `@impl` 形状 → `"@" + "impl ..."` の分割 (`tests/builder.test.ts` / `tests/check-baseline-diff.test.ts`)
   - `[ID]` ブラケット形状 → `"[" + "ID" + "]"` の分割 (`tests/parser-oxc-canary.test.ts` に前例。同ファイルのコメントがこの罠を詳述している)
   - 形状を問わない構造的回避 → `tests/helpers.ts` への退避 (`*.test.ts` にも `src/` にもマッチしないファイル名なので、どの glob プールからも外れる)

   **監査対象はファイルの全バイトであって「fixture 文字列」ではない。** step 1 のとおり `testReqRe` / `testAnnotationRe` はコメント判定ガードを持たずファイル全文を走査するため、以下も等しく汚染源になる:
   - **コメント本文** — 特に「なぜ分割規約を使っているか」を説明するコメント。回避慣習を正しく適用した直後に、その理由を書いた散文で汚染する事故が実在する
   - **`describe` / `it` のタイトル文字列**、変数名でない識別子リテラル、docstring 相当の記述

   コメント・テスト名には文字列連結の分割規約が**そのまま使えない** (コメントは連結できず、タイトルを分割すると可読性を落とす)。これらは規約を真似ようとせず、**ブラケット形を使わない散文に書き換える** (「ブラケット付きの ID 参照」等) か、タイトルなら実行時組み立てヘルパ経由にすること。
3. 慣習を適用した場合も、**適用した慣習が対象の形状に実際に効いているかを実測で確認する** (見た目を真似ただけで別形状に無力、というのが実際の事故の形)。`check --format json` を変更前後で実行し、以下を**すべて**突き合わせる:
   - `orphans` の件数と要素集合
   - **`coverage` 配列の各 REQ の `status`** — これが要。fixture の ID が**実在する REQ と衝突**した場合、生成される偽エッジは orphan にならない (ターゲットが実在するため) ので `orphans` は完全に不変のまま、その REQ の status だけが `impl-only` → `verified` に**サイレント反転**する。`uncovered` / `drifted` / `pass` / `newIssues` のどれもこの変化を映さない。しかも「改善方向」の変化なので gate も素通りする
4. **一時ディレクトリにのみ書き出す fixture でも、それを生成するテストファイル自身のソースに同じ文字列リテラルが現れるなら同じ実害がある。** 書き出し先で区別せず確認すること — 実際の事故はこの経路で起きる。

この監査が守るのは**新規混入の予防**のみで、既存の混入の発見は範囲外 (PR 起点に依存しない定期監査 / doctor 診断側の課題)。予防が効くほど新規混入という「発見の起点」が減るため、既存分は別途扱う必要がある。

前例: PR #386 — 新規 fixture の `"- [ ] T101 do it [FR-101]"` が `testReqRe` にマッチし、本物のグラフに `verifies` 偽エッジ 2 本が生えた (orphans 128→130)。同ファイルには `"@" + "impl ..."` 分割が既にあったが、それは別形状に効く慣習でブラケットには無力であり、ブラケット分割の前例 (`tests/parser-oxc-canary.test.ts`) は別ファイルにあったため参照されなかった。

実在 REQ との衝突が `orphans` では見えないことは実測済み: 実在する `impl-only` の REQ をブラケットで参照する fixture を足すと、`orphans` は 128 のまま集合も一致し、その REQ だけが `verified` に反転する。

### 19. 生成値を比較キーへ昇格させる変更の環境不変性監査 (producer レシピ × 二重 materialization × SSOT pin)

比較・キー化の対象が **id のみ** から **id + ハッシュ値**(または他の内容依存値)へ変わる、あるいは baseline 側 (ephemeral worktree scan) と current 側 (実 working tree scan) が**独立に生成した値同士**を等価比較するようになる場合:

1. その値の**全生成箇所**をノード種別ごとに洗い出し (`grep -an "contentHash" src/parsers/*.ts` を起点に)、生成レシピ (`stripBom` の有無 / EOL 正規化の有無 / 適用順序) をパーサー間で表にして突き合わせる。非対称は BOM 軸・EOL 軸の**両方向**を見る (片方だけ正規化している、が実際の形)。
2. 比較の両辺が**別々の materialization** から値を生成する設計なら、git が保証するのは blob 等価のみでバイト等価ではない。baseline worktree は `git worktree add` 実行時点の**現在の** git 設定でマテリアライズされ、current 側は working tree が最後にチェックアウトされた時点のバイト列を読む — 1 の非対称単体では発火せず、この checkout 時点差と組み合わさって初めて同一 blob が両側で別ハッシュになる。
3. materialization を割る要因を横展開して列挙する: `core.autocrlf` / `.gitattributes` の `eol=`・`text`・`working-tree-encoding` / smudge filter / `core.symlinks`。`.gitattributes` への `eol=` 追加は autocrlf 無変更でも同型を再現し、既存 working tree の `git status` に痕跡を残さない — 見落としやすい経路として必ず含める。要因ごとに「偽陽性 (無編集ノードの誤検出) / 偽陰性 (実編集の過剰抑制) のどちらへ倒れるか」を新旧両方の設計で判定する。
4. `grep -rlan "hashContent\|stripBom" tests/ specs/ src/` で、対象ハッシュ関数をバイト同一性で pin するテスト・spec (hash-equivalence 型テスト、「正規化しない」ことを意図としてピンする FR) を洗い出す。pin が存在する場合、生成側の正規化変更はその pin と**一体でしか動かせない** — 本 PR での安易な生成側修正を推奨せず、cross-spec issue として切り出す判断材料にする。

前例: PR #397 (issue #383) — driftKey への currentHash 折り込みで、typescript.ts (EOL 非正規化・BOM 除去) と markdown.ts (EOL 正規化・BOM 非除去) の既存レシピ非対称が二重 materialization と組み合わさり、独立理由で drift 済みの無編集ノードが gate を落とす偽陽性経路になることが Step 4 まで検出されなかった。spec 022 FR-006 の byte-identity pin により修正は cross-spec 切り出しになった (#398)。

### 20. primitive が横断する node kind / mode 変種の必須 fixture チェックリスト化 (弱)

変更対象のロジックが複数の node kind (req / doc / file / symbol) や `mode: "file"|"symbol"` 分岐を横断して同一判定を適用する場合、実装前でも変種の**列挙**と**必須 fixture のチェックリスト化**はできる:

1. チェック 13 の手順 1 の生成元洗い出しから、対象ロジックが実際に触れる node kind / mode の全変種を列挙する (lock 対象なら `buildLockFromGraph` の kind フィルタが正)。
2. 列挙した変種を Step 0-pre 報告の推奨欄に「実装が満たすべき必須 fixture チェックリスト」として明記する (例: file モードの req/doc 変種だけでなく、symbol モードの symbol ノード経路も最低 1 fixture)。
3. Step 4 (敵対的レビュー) で、新設テストの対象ノード種別を 2 のリストと突き合わせ、リストにあってテストに無い変種を差分として指摘する。

該当しない PR (単一 kind しか触れないロジック) ではスキップしてよい。

前例: PR #397 — 新設ユニットテスト T383-c/d/e/f は全て file モード (req/doc ノード) の drift 経路のみを検証し、symbol ノードの drift 経路はユニット層で未検証のまま Step 7 (E2E) の追加シナリオで初めて実機確認された。

### 21. 必須 fixture の判別力設計 (分岐台帳 × 判別オラクル × 自証明との突き合わせ)

チェック 20 が出す「必須 fixture チェックリスト」は**経路の列挙**であって検出力の保証ではない。**挙動保存 (equivalence) を契約とする変更** (性能リファクタ、データ構造の差し替え) では、経路を通るだけの fixture は新旧どちらの実装でも同じ値を返すため、実装が誤っていても緑のままになりやすい。チェック 20 を実行した場合は続けて以下を行い、報告のチェックリストを判別力つきに格上げする:

1. **分岐台帳を作る。** 変更対象の関数について、**変更しない分岐も含めた**全 tier / 早期 return / fallback / 非マッチ時 return を列挙する。挙動保存 PR は「この関数の未 fixture 経路に初めて fixture を付けた」と主張しがちで、レビューはその主張を分岐単位ではなく**関数全体**に対して評価する。
2. **台帳の全件について既存検出力を実測する。** 分岐ごとに到達カウンタのプローブを仕込み、全スイートを 1 回走らせて「到達 0 / 到達するが出力を変えない / 出力を変える」に分類する。**変更予定の分岐だけでなく台帳全件**を同じ 1 回の走査で取ること (追加コストはほぼゼロ)。到達 0 の分岐は、その分岐を丸ごと削除する mutant が全スイートで survive する状態 = silent な誤解決・誤リンクが無防備であることを意味するので、隣接分岐であっても本 PR の fixture 対象に含めるか別 issue に切り出すかを判断する。
3. **各必須 fixture に判別オラクルを 1 行で明記する。** 「どの経路を通るか」ではなく「**実装が誤っていたら、どの観測値がどう変わるか**」を書く。書けないものは smoke test であって pin ではないと明示する。検証は mutant を実際に当てて kill されるかで行うのが最も確実 (索引を空にする / tie-break を反転する / 境界を 1 つ落とす / 分岐を削除する)。
   **入力と出力が恒等になるケースは原理的に判別力ゼロ**: 「解決に成功した」場合と「解決されず素通しした」場合が同じ値を返す入力 (衝突していない ID など) は、経路に到達しても何も pin しない。経路到達を根拠に必須リストへ入れてはならない。
4. **報告自身が確立した恒等・到達不能証明を、報告内の全下流成果物に機械的に突き合わせる。** 同じ調査で「この分岐は到達不能」「この関数は恒等写像」を証明したなら:
   - その関数の本体を通す必須 fixture は判別オラクルを持てない → リストから外すか「判別力なしの regression guard」と明示する
   - 設計の正当化が dead な分岐の挙動を根拠にしていないか (「この構成にしないと `matches.length` の判定が壊れる」等) を再検査する。dead な分岐は壊れようがないので、その正当化は成立しない
   - 証明はコード側の当該行にも 1 行残す。報告と PR 本文にしかないと、次の読者はその分岐を生きているものとして読む
5. **命名と実体の一致を確認する。** fixture 名・ファイル冒頭コメント・PR 本文が「X を pin する」と名乗る場合、実際に X の分岐を通っているかを 2 のプローブで確認する。隣接 tier を通っていた・実は素通し経路だった、という名乗りと実体の乖離はレビューで最も高確率に指摘される欠陥であり、コメントやテスト名の側を実態に合わせて直す。

### 22. 無条件事前計算のコスト会計と需要ゲート監査

設計が「呼ばれたときだけ走る走査」を「毎回構築する索引・テーブル・Map」へ置き換える場合 (性能改善 PR の典型形)、**lookup が 1 回も要らない入力でも全額払う面**を新設することになる:

1. **コスト式を入力形状の関数として書く。** 要素数だけでなく、**1 要素あたりのコストが要素の内容に比例して伸びないか** (キー長・セグメント数・ネスト深さ) を必ず見る。要素数が同じでも形状次第で桁が変わる構成は、要素数ベースの見積りでは原理的に検出できない。
2. **その入力形状を作れる config / 文法を列挙し、到達性をチェック 23 の手順で確定させる。** デフォルト文法で無害でも、ユーザーが書ける設定で病的形状に到達できるなら、その形状は CI の毎回のスキャンに乗る。
3. **同じファイル・サブシステム内の需要ゲート前例を探す** (`grep -n 'Enabled &&\|\.length > 0' <対象ファイル>`)。`src/graph/builder.ts` には条件成立時のみ構築する前計算の前例が既にあり、遅延構築・needs-gate は既存慣習の範囲内。無条件構築を選ぶ場合は「なぜゲートしないか」を根拠つきで書く。
4. **多重支払い経路を数える。** `check --diff --base` は base 側と head 側で `buildGraph` を 2 回呼ぶため、1 回あたりのコストは標準の gate 経路で 2 倍払う。
5. **`tests/perf/` にその形状のガードを 1 本入れる。** 性能を目的とする変更が perf テストを持たないと、次のリファクタで静かに元の計算量へ戻せる (`tests/perf/rename-redos.perf.test.ts` が雛形)。閾値は「対策前の実装では確実に fail し、対策後は数倍の余裕で pass」する形状を実測で選ぶ。
6. **緩和策そのものにも 1-5 を再適用する。** 上限・cap・遅延化を入れると「上限を超えた入力では索引を一度も引かないまま構築コストだけ払い、その上で従来の全走査も走る」経路が生まれうる — **構築側を bounded にしてもクエリ側が bounded になるとは限らない**。緩和策の最悪形状は、緩和前の中間実装とではなく**変更前 (main)** と比較して評価すること。

### 23. fixture / 到達性主張が依存する config の loadConfig 通過確認

`ArtgraphConfig` を直接組み立てて `buildGraph` を呼ぶテストは `loadConfig` の validation を通らない (`validateReqPatterns` の ReDoS 検出・長さ・capture group 数など、`src/config.ts`)。したがって以下は別々に確認が要る:

1. **fixture が実演する設定をユーザーが書けるか。** 「この構成ではこう解決される」と示す fixture でも、その config を `loadConfig` が拒否するなら、その fixture は**存在しえないプロジェクト**を記述している。唯一 mutant を kill する fixture がこの状態だと、検出力があるように見えて実運用の保護がゼロになる。
2. **到達性主張の裏付け。** 「この病的形状はカスタム設定で到達可能」(チェック 22 step 2) や「この経路はデフォルト設定では到達しない」型の主張は、パターンを実際に `loadConfig` へ食わせて accept / reject を確定させてから使う。

パターンを実際にロードして ACCEPTED / REJECTED を確認し、結果を Step 0-pre 報告と PR 本文の該当箇所に書く。regex を新規に考案する場面では、`(?:[a-z]+/){1,2}` のような「内側の量指定子 + 外側の量指定子」の形は ReDoS 検出に弾かれるため、素直な文字クラス 1 個 (`^([A-Za-z0-9/_-]+):` 等) の方が通る。

## 出力フォーマット

「この primitive を変えると SILENT に破壊される経路」の**ランク付きリスト** (HIGH / MEDIUM / LOW)。各項目:

| 欄 | 内容 |
| --- | --- |
| (a) 経路 | 出発点 → 中継 (ファイル:行) → 破壊される観測点 |
| (b) 影響 CLI | チェック 3 のマトリクスから該当コマンドを列挙 |
| (c) テスト | この経路を守るテストが存在するか (ファイル名 / なし) |
| (d) 推奨 | 本 PR で fix / 別 issue に切り出し / accept (理由付き) |
| (e) 根拠 | **実測** (fixture で differential probe 済み) / **文書・ソース読解のみ (未実測)**。ライブラリのデフォルト値・オプション挙動に関する断定は特にこの区別を明記する |

**「未実測」のまま breaking change の説明・regression guard テスト・正当化コメントの根拠に使ってはならない。Step 0 (設計) に進む前に fixture による実測へ格上げすること。**

ランクの目安: gate の fail 見逃し = HIGH、非 gate 出力の誤り = MEDIUM、メッセージ/ヒントの劣化 = LOW。

## フィードバックループ (Step 9 retro との接続)

issue 対応ループの Step 9 振り返りで「事前 (Step 0-pre) に見つけられたはずの finding」が特定された場合、その検出条件を本チェックリストへ追加する PR を出す。
