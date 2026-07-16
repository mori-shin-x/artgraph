---
name: "issue-retro"
description: "issue-loop の Step 9 (振り返り) 単体 skill。対象 PR のレビュー/メタレビュー/E2E findings を「事前 (Step 0-pre) に検出可能だったか」で分類し、プロジェクト側チェックリスト skill への追加提案を出力する。Use when the user asks for a retrospective of a completed PR / issue loop, or to feed findings back into a Step 0-pre checklist."
user-invocable: true
disable-model-invocation: false
---

## Purpose

issue 対応ループの品質を**次の issue に複利で効かせる**ためのフィードバック工程。Step 4 (敵対的レビュー) / Step 5 (メタレビュー) / Step 7 (E2E) が surfacing した finding を分類し、「事前に見つけられたはずのもの」の検出条件をプロジェクトの Step 0-pre チェックリスト skill (例: artgraph の `artgraph-graph-primitive-impact`) に還元する。

## 引数

対象 PR (URL or 番号)。loop の各 Step ログ (findings 一覧) があれば併せて渡す。

## 手順

### 1. findings の収集

対象 PR のレビューコメント / loop の Step 4・5・7 成果物から finding を列挙する (誤検知と判定されたものは除外)。

### 2. 事前検出可能性の分類

各 finding を 3 値で分類し、表にする:

| 分類 | 基準 |
| --- | --- |
| **可能** | 現行の Step 0-pre チェックリストのいずれかのチェックを正しく実行していれば検出できた |
| **条件付き** | チェックリストに**新しい観点**を足せば検出できた (その観点を明文化する) |
| **不可能** | 実装が存在して初めて観測できる (実行時挙動・環境依存など)。Step 4/5/7 が正当な検出層 |

分類表の各行: finding 概要 / ランク / 分類 / 根拠 (どのチェックで・なぜ引っかかる or かからないか)。

### 3. チェックリスト更新提案の判定

「条件付き」の finding について、検出条件をチェックリストへ追加すべきかを判定する:

- **追加する**: 同型の欠陥が今後も出うる一般性がある (例: hub-node パターン監査、CLI フラグ parse 意味論監査)
- **追加しない**: 一回性が高い / チェックのコストが検出価値を上回る (理由を記録)

### 4. 出力

1. **振り返りサマリ** — 分類表 + プロセス上の学び (brief の改善点、有効だった指示など)
2. **更新提案** — 追加すべき検出条件がある場合:
   - プロジェクト側チェックリスト skill の SKILL.md にチェック項目を追加する **PR を作成**する (チェック番号は既存の末尾に追記。出所・経緯は SKILL.md には書かず PR 本文に記載する — 成果物には実行に効く情報のみ残す)
   - PR を作らない場合 (プロジェクト外・権限なし) は、チェックリスト skill の管理 issue にコメントとして提案を残す

## 運用メモ

- 分類は**クリーンな Sonnet 5 (`claude-sonnet-5`) サブエージェント**に委譲してよい (メイン loop が実装・レビューに関与しているため、自己評価バイアスを避ける)。
- 「可能」に分類された finding が出た場合はチェックリストの問題ではなく**実行の問題** — Step 0-pre の brief が正しくチェックを回せていたかを見直し、brief テンプレ側を直す。
