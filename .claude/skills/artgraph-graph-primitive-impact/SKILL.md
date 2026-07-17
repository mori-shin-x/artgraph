---
name: "artgraph-graph-primitive-impact"
description: "artgraph コントリビュータ向け内部 skill。グラフ基本操作 (src/graph/traverse.ts / src/graph/builder.ts の BFS・エッジ意味論・ID 解決) や graph-core 関数 (impact() / check() / buildGraph()) を変更する issue/PR に着手する前 (Step 0-pre) に、14 チェックの shift-left インパクト調査を実行し「silent に破壊される経路」のランク付きリストを報告する。Use when starting a PR that touches src/graph/, edge semantics, or graph-core function signatures/return values."
allowed-tools:
  - "Read"
  - "Grep"
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

グラフ基本操作 (BFS / エッジ意味論 / ID 解決) は多数の CLI コマンドと gate 経路から間接消費されており、意味論を狭める・広げる変更は**直接の呼び出し元 grep では見えない経路を silent に壊す**。本 skill は issue 対応ループの **Step 0-pre**(設計より前)で、その経路を事前に列挙するための 14 チェック調査を定義する。

## トリガー条件

以下のいずれかに該当する issue/PR に着手する時、設計 (Step 0) の**前に**本調査を実行する:

- `src/graph/traverse.ts` / `src/graph/builder.ts` を変更する
- エッジ意味論 (kind の追加・削除、forward/reverse トラバース条件の変更) を変える
- `impact()` / `check()` / `buildGraph()` など graph-core 関数のシグネチャ・戻り値・意味論を変更する

## 実行モデル

**クリーンな Sonnet 5 (`claude-sonnet-5`) サブエージェント**に委譲する。メイン loop の文脈 (実装方針の仮説) を持ち込まないことで、確証バイアスなしに経路を列挙させる。

サブエージェント brief テンプレ:

> あなたは artgraph リポジトリの調査担当です。これから `<変更対象の primitive / 関数 / エッジ kind>` を `<変更の一行要約>` する変更を検討しています。実装はまだ存在しません。
> `.claude/skills/artgraph-graph-primitive-impact/SKILL.md` の 14 チェックを順に実行し、「この primitive を変えると SILENT に破壊される経路」のランク付きリストを報告してください。各項目には (a) 経路の説明 (b) 影響を受ける CLI コマンド (c) 該当テストの有無 (d) 推奨 (本 PR で fix / 別 issue / accept) を含めること。

## 14 チェック

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
3. 対象修正後、hub-node を経由した「A → hub → B」(A/B は本来独立) の到達経路が残らないか、fixture ベースで想定 test を書き出す
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

## 出力フォーマット

「この primitive を変えると SILENT に破壊される経路」の**ランク付きリスト** (HIGH / MEDIUM / LOW)。各項目:

| 欄 | 内容 |
| --- | --- |
| (a) 経路 | 出発点 → 中継 (ファイル:行) → 破壊される観測点 |
| (b) 影響 CLI | チェック 3 のマトリクスから該当コマンドを列挙 |
| (c) テスト | この経路を守るテストが存在するか (ファイル名 / なし) |
| (d) 推奨 | 本 PR で fix / 別 issue に切り出し / accept (理由付き) |

ランクの目安: gate の fail 見逃し = HIGH、非 gate 出力の誤り = MEDIUM、メッセージ/ヒントの劣化 = LOW。

## フィードバックループ (Step 9 retro との接続)

issue 対応ループの Step 9 振り返りで「事前 (Step 0-pre) に見つけられたはずの finding」が特定された場合、その検出条件を本チェックリストへ追加する PR を出す。
