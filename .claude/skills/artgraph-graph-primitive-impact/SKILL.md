---
name: "artgraph-graph-primitive-impact"
description: "artgraph コントリビュータ向け内部 skill。グラフ基本操作 (src/graph/traverse.ts / src/graph/builder.ts の BFS・エッジ意味論・ID 解決) や graph-core 関数 (impact() / check() / buildGraph()) を変更する issue/PR に着手する前 (Step 0-pre) に、9 チェックの shift-left インパクト調査を実行し「silent に破壊される経路」のランク付きリストを報告する。Use when starting a PR that touches src/graph/, edge semantics, or graph-core function signatures/return values."
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

グラフ基本操作 (BFS / エッジ意味論 / ID 解決) は多数の CLI コマンドと gate 経路から間接消費されており、意味論を狭める・広げる変更は**直接の呼び出し元 grep では見えない経路を silent に壊す**。本 skill は issue 対応ループの **Step 0-pre**(設計より前)で、その経路を事前に列挙するための 9 チェック調査を定義する。

## トリガー条件

以下のいずれかに該当する issue/PR に着手する時、設計 (Step 0) の**前に**本調査を実行する:

- `src/graph/traverse.ts` / `src/graph/builder.ts` を変更する
- エッジ意味論 (kind の追加・削除、forward/reverse トラバース条件の変更) を変える
- `impact()` / `check()` / `buildGraph()` など graph-core 関数のシグネチャ・戻り値・意味論を変更する

## 実行モデル

**クリーンな Sonnet 5 (`claude-sonnet-5`) サブエージェント**に委譲する。メイン loop の文脈 (実装方針の仮説) を持ち込まないことで、確証バイアスなしに経路を列挙させる。

サブエージェント brief テンプレ:

> あなたは artgraph リポジトリの調査担当です。これから `<変更対象の primitive / 関数 / エッジ kind>` を `<変更の一行要約>` する変更を検討しています。実装はまだ存在しません。
> `.claude/skills/artgraph-graph-primitive-impact/SKILL.md` の 9 チェックを順に実行し、「この primitive を変えると SILENT に破壊される経路」のランク付きリストを報告してください。各項目には (a) 経路の説明 (b) 影響を受ける CLI コマンド (c) 該当テストの有無 (d) 推奨 (本 PR で fix / 別 issue / accept) を含めること。

## 9 チェック

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
