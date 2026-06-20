# Spec Kit 連携の検討メモ

## 背景

spectrace は spec/doc/code/test のトレーサビリティを追跡する CLI ツール。
GitHub Spec Kit のような SDD ツールと組み合わせて使われることを想定しており、
Spec Kit が生成する spec.md を spectrace がネイティブにパースできるようにする必要がある。

## 現状のギャップ

spectrace は `REQ-[0-9a-fA-F]{4,}` 形式の ID をマークダウン見出しから検出するが、
Spec Kit の spec.md は自然言語のユーザーストーリーや Success Criteria で構成されており、REQ-ID を持たない。

Spec Kit の spec.md 構造:

```yaml
---
title: "Feature Name"
description: "..."
owner: "team-name"
status: "draft"  # draft, in-review, approved, implemented
priority: "p0"
---
```

セクション: Overview, User Stories, Success Criteria, Acceptance Tests, API Contracts, Dependencies & Constraints

## やるべきこと（3 層）

### 1. spec.md パース対応（最優先）

Spec Kit の frontmatter と構造化セクションを spectrace が理解できるようにする。

検討事項:
- REQ-ID の自動生成（見出しハッシュから `REQ-xxxx` を振る）か、Spec Kit テンプレートに REQ-ID 記法を組み込むガイドラインを提供するか
- frontmatter の status/priority をグラフノードの属性として取り込むか
- User Stories / Success Criteria を個別の requirement ノードとして扱うか

### 2. plan.md / tasks.md とコードの紐付き

- plan.md のタスクが `@impl` タグでコードに紐づく
- tasks.md の項目がテストの `[REQ-xxxx]` 記法で検証される
- この流れを spectrace のグラフに載せる

### 3. .spectrace.json の拡張

- Spec Kit の `specs/` ディレクトリ構造（`specs/001-feature/spec.md` 等）をスキャン対象として設定可能にする
- 現状の `specPatterns` / `srcPatterns` / `testPatterns` に加えて、Spec Kit 固有のパス規約を認識する

## 次のアクション

- Spec Kit の spec.md テンプレートを詳細に分析し、パーサー拡張の設計を詰める
- プロトタイプとして spectrace 自身の specs/ ディレクトリを Spec Kit で管理し、ドッグフーディングする
