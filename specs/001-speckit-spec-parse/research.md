# Research: Spec Kit spec.md パース対応

## R1. SDD ツールの仕様 ID 記法

Decision: リスト項目の PREFIX-NNN（パターン A）と見出しの Requirement N（パターン B）を認識する

Rationale:
- パターン A（リスト項目 PREFIX-NNN）が AI SDD ツール群で最も普及（Spec Kit, BMAD, cc-sdd）
- パターン B（見出し Requirement N）は Kiro（AWS）が採用し、主要フォーマットの一角
- 両方をサポートすることで、主要 SDD ツールの spec をそのまま spectrace に取り込める
- 調査対象: Spec Kit, OpenSpec, BMAD-METHOD, Kiro, cc-sdd, VSDD, CoDD, DocDD, OpenFastTrace, reqmd

Alternatives considered:
- パターン C（OpenFastTrace / reqmd の型付き ID）: 要求工学寄りで SDD ツール群では非主流。将来の拡張として設定で追加可能にする
- spectrace 独自フォーマットのみ: SDD ツールとの統合を阻害する。「補完レイヤー」の戦略と矛盾

## R2. ID パターンの正規表現設計

Decision: デフォルトで以下の2パターンを認識する

リスト項目パターン（Spec Kit / BMAD 互換）:

remark AST の `listItem` ノードを走査し、テキストコンテンツに対して以下のパターンを適用:
```
/^(?:\*\*)?([A-Z][A-Za-z]*-\d+)(?:\*\*)?[:\s]/
```
認識例: `- FR-001: ...`, `- **FR-001**: ...`, `- SC-001: ...`, `- NFR-1: ...`, `- REQ-001: ...`

AST ベースのため、リストマーカーの種類（`-`, `*`, `+`, `1.`）に依存しない。
remark がリストマーカーを除去した後のテキストに対してマッチする。

見出しパターン（Kiro 互換）:

remark AST の `heading` ノードを走査し、テキストコンテンツに対して以下のパターンを適用:
```
/^Requirement\s+(\d+)\s*:/
```
認識例: `### Requirement 1: ...`, `## Requirement 42: ...`

ID の正規化: `Requirement 1` → `Requirement-1`（ハイフン区切り）に正規化して格納。
スペースを含む ID はコード注釈（`@impl`）で使用しづらいため。

Rationale:
- PREFIX は大文字英字で始まり英字が続く（`[A-Z][A-Za-z]*`）。`\w`（数字・アンダースコア含む）ではなく英字のみにして誤検出を防ぐ
- 太字の有無（`**FR-001**`）に対応。Spec Kit テンプレートは `**FR-001**` 形式を使用（確認済み）
- Kiro の ID はハイフン正規化することで、`// @impl Requirement-1` と書ける。スペース区切りの複数 ID 列挙（`// @impl FR-001 SC-001`）との曖昧さを回避
- remark AST を見出し・リスト項目の両方で使用し、パース手法を統一

Alternatives considered:
- 生テキスト正規表現でリスト項目を走査: remark AST とのアプローチ不整合。リストマーカー（`-`, `*`, `+`, `1.`）全てを正規表現で扱う必要があり煩雑
- `Requirement 1` をスペース込みで ID にする: `// @impl Requirement 1 Requirement 2` のパースが曖昧になる。1行に複数 ID を書けなくなるか、専用のデリミタが必要

## R3. 名前空間の解決方式

Decision: 2パスビルドで衝突を検出し、衝突時のみ修飾する

方式:

パス1（収集）:
1. 全 spec ファイルをパースし、`{ id, specDir, node }` のリストを収集
2. ID ごとにグループ化し、同一 ID が複数の specDir に存在するか検出
3. 衝突する ID のセットを確定

パス2（登録）:
4. 衝突しない ID はそのまま Map に登録（キー = `FR-001`）
5. 衝突する ID は `specDirName/ID` 形式に修飾して登録（キー = `001-auth/FR-001`）
6. エッジの target も同じ修飾ルールで正規化

@impl タグの解決:
7. `@impl FR-001` → グラフのノード Map を検索。一意なら解決
8. マッチしなければ、修飾形式のノード（`*/FR-001`）を検索。一意なら解決、複数なら警告
9. `@impl 001-auth/FR-001` → 修飾形式で直接検索

Rationale:
- 2パスにすることで、1パス目で挿入したノードを後から修飾し直す必要がない
- 衝突検出 → 修飾決定 → 登録の順序が明確で、エッジの target も一貫して処理できる
- 大多数のプロジェクトでは衝突が発生しないため、修飾無しの低摩擦な UX を維持

Alternatives considered:
- 常に修飾: 衝突は防げるが、単一 spec プロジェクトでも冗長な @impl タグが必要
- 1パスで衝突時にリネーム: 既に Map に入ったノードのキー変更＋全エッジの参照書き換えが必要で複雑
- 衝突を許容して警告のみ: Map の上書きでデータが消失する

## R4. リスト項目の content-hash 範囲

Decision: リスト項目とそのネストした子項目をまとめて content-hash の対象とする

方式:
- remark AST の `listItem` ノードの全テキストコンテンツ（子ノード含む）を content-hash の対象とする
- AST ベースのため、行の切り出しロジックが不要

Rationale:
- ネストを含めることで、acceptance criteria の変更も drift として検出できる
- AST の `listItem` ノードは子要素を含むため、自然に範囲が決まる

Alternatives considered:
- 行単位（リスト項目の1行のみ）: ネストした詳細の変更が検出できない
- セクション全体（### Functional Requirements 配下全部）: 粒度が粗すぎ、1つの FR 変更で全 FR が drift
