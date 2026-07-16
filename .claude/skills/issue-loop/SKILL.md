---
name: "issue-loop"
description: "issue 対応の 10 ステップ・ループ (Step 0-pre shift-left 調査 → 設計 → 実装 → 敵対的レビュー → メタレビュー → E2E → merge → 振り返り) を駆動する汎用 dev process skill。issue 番号 or URL を渡して起動する。Use when the user asks to run the issue loop / 10 ステップループ for a GitHub issue, or to 対応 an issue with the full review process."
user-invocable: true
disable-model-invocation: false
---

## Purpose

GitHub issue 1 件を、shift-left 調査から振り返りまでの 10 ステップで対応する**プロジェクト非依存の** dev process。品質担保の核は (1) 設計前の独立インパクト調査、(2) 実装とレビューの文脈分離 (クリーンなサブエージェント)、(3) レビュー finding の独立検証 (メタレビュー)、(4) 振り返りによるチェックリストへのフィードバック。

## 引数

issue 番号 or issue URL。省略された場合は対象 issue を確認してから開始する。

## サブエージェント運用の原則

- 委譲先は常に**クリーンな Sonnet 5 (`claude-sonnet-5`) サブエージェント**。メイン loop (主担当) の仮説・文脈を持ち込ませないことで、確証バイアスを避ける。
- brief は本 SKILL.md のテンプレから生成する。**issue 番号と対象ファイルを埋めるだけで brief が完成する**状態を保つ。
- メイン loop は orchestration と判断に徹し、調査・実装・レビューの実作業はサブエージェントに出す。

## ユーザー判断のエスカレーション

メイン loop が自律で下してよいのは**技術判断**まで。以下の 3 点は**ユーザー (プロダクトオーナー) の判断領域**であり、自律実行の明示的な許可 (「確認なしで進めて」等) がない限り、質問ツール等で確認してから先へ進む:

1. **設計選択 (Step 0)**: 実装方針の候補が複数あり trade-off が非自明な場合 (issue に複数案が併記されている場合を含む)。Step 0-pre report の要点と推奨案 + 根拠を添えて選択を仰ぐ。
2. **プロダクト意図の変更**: spec の要件文言の改訂、既存保証の縮小、既知限界の accept (修正せず文書化) など、機能の意図そのものに触れる判断。技術的整合性だけでは決められない。
3. **main への merge (Step 8)**: CI green と E2E 完了を確認した上で、merge 実行の**直前**に確認する。

確認時は、判断に必要な文脈 (選択肢 / 推奨 / 影響範囲) を質問自体に含め、ユーザーが過去ログをスクロールバックせずに答えられる形にする。確認待ちの間、ブロックされない他 Step の準備 (レビュー brief の生成等) は進めてよい。

## 10 ステップ

### Step 0-pre: shift-left インパクト調査

対象プロジェクトの AGENTS.md / CLAUDE.md に **Step 0-pre 用のプロジェクト固有チェックリスト skill** が定義されていればそれに従う (例: artgraph の `artgraph-graph-primitive-impact` — graph-core 変更時の 9 チェック)。無ければ以下の汎用 4 チェックを brief にする:

1. 変更対象関数の直接呼び出し元 grep
2. **戻り値フィールド名**での transitive consumer trace (関数名でなくフィールド名で追う)
3. エントリポイント (CLI コマンド / API ルート / hook) 全網羅の使用マトリクス
4. fail の見逃しが高コストな経路 (gate / CI / 課金 / 認可) への到達可能性

> **brief テンプレ (Step 0-pre)**
> あなたは {{repo}} の調査担当です。issue {{issue}} で `{{変更対象}}` を `{{変更の一行要約}}` する変更を検討しています。実装はまだ存在しません。{{チェックリスト skill のパス or 上記汎用 4 チェック}} を順に実行し、「この変更で SILENT に破壊される経路」のランク付きリスト (HIGH/MEDIUM/LOW) を報告してください。各項目: (a) 経路 (b) 影響を受ける機能 (c) 該当テストの有無 (d) 推奨 (本 PR で fix / 別 issue / accept)。

### Step 0: 設計 + デグレ調査

Step 0-pre の report を入力に、実装方針を決める。report の HIGH 項目は設計で必ず言及 (対処 or accept の理由) する。設計候補が複数あり trade-off が非自明な場合、および spec/プロダクト意図の変更を伴う場合は、決める前にユーザーに確認する (上記「ユーザー判断のエスカレーション」1/2)。

### Step 1: 実装計画

タスク分解 + **7 観点セルフチェック** (Step 4 と同じ観点で自分の計画を先に叩く): 境界条件 / 条件分岐の組み合わせ / 不正な状態遷移 / 例外系 / 実運用の事故 / エッジケース / 考慮漏れ。

### Step 2: 実装委譲

> **brief テンプレ (Step 2)**
> あなたは {{repo}} の実装担当です。issue {{issue}} の実装計画は以下です: {{Step 1 の計画}}。対象ファイル: {{files}}。計画に従い実装し、テストを追加・更新してください。計画にない設計変更が必要になった場合は実装せず報告してください。

### Step 3: 差分確認 / commit / push / PR 作成

メイン loop が diff を確認し、プロジェクトの規約 (commit 規約 / PR テンプレ / CI ゲート) に従って PR を作る。

### Step 4: 敵対的レビュー

**別のクリーンな Sonnet 5** に、実装文脈なしで PR diff だけを渡す。

> **brief テンプレ (Step 4)**
> あなたは {{repo}} の敵対的レビュアーです。PR {{pr}} の diff を、以下の 7 観点で「壊す」つもりでレビューしてください: (1) 境界条件 (2) 条件分岐の組み合わせ (3) 不正な状態遷移 (4) 例外系 (5) 実運用の事故 (6) エッジケース (7) 考慮漏れ。各 finding にランク (HIGH/MEDIUM/LOW) と再現手順を付けること。褒める必要はありません。

### Step 5: 敵対的メタレビュー

**さらに別のクリーンな Sonnet 5** が Step 4 の findings を独立検証する。単なる検証にとどめず、**レビューアが生産的だった seam の second-look (横展開探索)** を brief に含める — 同じ seam の兄弟箇所に同型欠陥がないかを探索させる。

> **brief テンプレ (Step 5)**
> あなたは {{repo}} のメタレビュアーです。PR {{pr}} に対する以下のレビュー findings を独立に検証し、各 finding を 妥当 / 誤検知 / 要追加調査 に分類してください: {{Step 4 findings}}。加えて、妥当な finding が出た seam (同一ファイル・同一パターンの箇所) について、**同型の欠陥が他に残っていないか横展開で探索**してください。

### Step 6: 妥当な指摘の反映

クリーンな Sonnet 5 に、Step 5 で妥当と判定された findings のみを渡して修正させる。

### Step 7: E2E 実機確認

クリーンな Sonnet 5 が、テストではなく**実際の入口** (CLI / アプリ / API) から変更後の挙動を確認する。ここで新 finding が出たら Step 4 相当として扱い Step 5 に回す。

### Step 8: PR 反映 → CI 監視 → merge

修正を push し、CI green を確認して main へ merge する。merge の実行直前にユーザーに確認する (上記「ユーザー判断のエスカレーション」3)。

### Step 9: 振り返り

`issue-retro` skill を起動する (対象: 本 loop の PR と各 Step の findings)。「Step 4/5/7 が見つけた finding のうち Step 0-pre で検出できたはずのもの」を特定し、プロジェクト側チェックリスト skill への追加を提案する。

## 出力

- PR URL
- 各 Step の成果物へのポインタ (Step 0-pre report / 設計 / findings 一覧 / E2E 結果)
- Step 9 振り返りレポート

## スキップ条件

docs-only など明白に低リスクな変更では Step 0-pre / Step 5 / Step 7 を省略してよい。ただし省略した Step は出力に「skipped (理由)」と明記し、silent skip にしない。
