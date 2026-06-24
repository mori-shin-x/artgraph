# Contract: 注釈文法（Annotation Grammar）

Plan: [../plan.md](../plan.md) | Spec: [../spec.md](../spec.md) | Data Model: [../data-model.md](../data-model.md)

## 正規表現

注釈は以下の正規表現で抽出される:

```regex
\(\s*(depends_on|derives_from)\s*:\s*([^()]+?)\s*\)
```

- フラグ: `g`（同一行内の複数注釈を全て抽出）
- 各マッチ:
  - capture group 1: キーワード（`depends_on` または `derives_from`）
  - capture group 2: ID リスト（カンマ区切りの生文字列、後段で個別 ID に分解）

## 検出位置

| req 形式 | 注釈が認識される位置 |
|---|---|
| list-item req | 同一行の任意の位置（末尾推奨） |
| heading req | heading 直下にある **最初の段落ブロック** の **先頭行** または **末尾行**（段落が単一行ならその 1 行）。中間行・複数段落・複数行にまたがる注釈は対象外 |

heading 行自体（`## Requirement N: タイトル`）の括弧式は **注釈として扱わない**。

### 「最初の段落ブロック」の定義（heading のみ）

heading 行の次行から、空行（または次の heading）に達するまで連続する非空行の集合を「最初の段落ブロック」と定義する。例:

```md
## Requirement 2: セッション管理       ← heading 行（注釈非対象）

(depends_on: Requirement-1)             ← 段落ブロックの先頭行（受理）
セッションは 24 時間有効とする。       ← 中間行（注釈非対象）
有効期限後は自動 logout する。(depends_on: AUTH-X)  ← 末尾行（受理）

別段落の本文 (depends_on: Y)            ← 第 2 段落（注釈非対象）
```

## ID 分解ルール

capture group 2 を以下の順に処理:

1. `,` で split
2. 各要素を `trim()`
3. 両端の `**` を 1 回だけ剥がす（`**AUTH-001**` → `AUTH-001`、`***X***` は `*X*` になる）
4. config の `reqPatterns.codeId` 正規表現にマッチしないものは破棄し `invalid-annotation-id` 警告
5. 空配列になった場合は `empty-annotation` 警告（edge は生成しない）

## 受理パターン（必ず認識される）

| 入力 | 抽出結果 |
|---|---|
| `(depends_on: AUTH-001)` | `[{kind: depends_on, targets: [AUTH-001]}]` |
| `(derives_from: AUTH-001)` | `[{kind: derives_from, targets: [AUTH-001]}]` |
| `(depends_on: AUTH-001, AUTH-002, AUTH-003)` | `[{kind: depends_on, targets: [AUTH-001, AUTH-002, AUTH-003]}]` |
| `(depends_on: **AUTH-001**)` | `[{kind: depends_on, targets: [AUTH-001]}]` |
| `( depends_on : AUTH-001 , AUTH-002 )` | `[{kind: depends_on, targets: [AUTH-001, AUTH-002]}]` |
| `(depends_on: A)(derives_from: B)` | `[{kind: depends_on, targets: [A]}, {kind: derives_from, targets: [B]}]` |
| `(depends_on: A)(depends_on: B)` | `[{kind: depends_on, targets: [A]}, {kind: depends_on, targets: [B]}]`（dedup は builder 段階） |

## 非受理パターン（認識されない・edge 生成されない）

| 入力 | 理由 |
|---|---|
| `(depends on AUTH-001)` | アンダースコア無し（誤検出防止） |
| `(DEPENDS_ON: AUTH-001)` | キーワード大文字化（厳密一致） |
| `(blocks: AUTH-001)` | v1 で受理しないキーワード |
| `(depends_on: A; derives_from: B)` | 1 括弧内に複数キーワード（受理しない） |
| `[depends_on: A]` | `(` `)` 以外の括弧 |
| 散文中の単独 `AUTH-001` 言及 | 注釈構文ではない |
| fenced code block 内の任意の注釈 | F6 規約により全パーサで除外 |

## 警告条件

| 警告 type | 発生条件 |
|---|---|
| `invalid-annotation-id` | 注釈内 ID が `reqPatterns.codeId` にマッチしない（例: `(depends_on: foo)`） |
| `empty-annotation` | `(depends_on:)` または `(depends_on: )` |
| `self-reference-annotation` | 注釈の依存先 ID が当該 req 自身の ID（builder で検出） |

## 期待される単体テストケース（最低 18 件）

### 受理系（edge 生成あり）

1. list-item: 単一 ID `(depends_on: A)`
2. list-item: 複数 ID `(depends_on: A, B, C)` → 3 本の edge
3. list-item: `(derives_from: A)` 種別違い
4. list-item: `(depends_on: **A**)` BOLD
5. list-item: `( depends_on : A , B )` 空白バリエーション
6. list-item: 同一行に同 keyword 並列 `(depends_on: A)(depends_on: B)` → 2 本の edge（dedup なし、A と B は別 target）
7. list-item: 同一行に別 keyword 並列 `(depends_on: A)(derives_from: B)` → kind の異なる 2 本の edge
8. heading: 直下段落の **先頭行** `(depends_on: A)`
9. heading: 直下段落の **末尾行** `(depends_on: A)`
10. heading: 段落が単一行のとき `(depends_on: A)` を受理（先頭兼末尾）

### dedup 系（builder 段階で重複統合）

11. dedup: 同一 source/target/kind の edge が複数経路（例: 同一行に `(depends_on: A)(depends_on: A)`）から生成された場合、グラフ上は 1 本に統合される

### 非受理系（edge 生成なし、警告なし）

12. heading 行自体の `(depends_on: X)` は非受理（非警告）
13. heading 直下段落の **中間行** の `(depends_on: X)` は非受理（非警告）
14. 散文中の `(depends on A)`（アンダースコア無し）は非受理（非警告）
15. fenced code block 内 `` ```md\n(depends_on: A)\n``` `` は非受理（非警告）
16. 大文字キーワード `(DEPENDS_ON: A)` は非受理（非警告）

### 警告系（edge 生成なし、警告 emit）

17. `(depends_on:)` または `(depends_on: )` → `empty-annotation`
18. `(depends_on: foo)` → `invalid-annotation-id`（`reqPatterns.codeId` 不一致）

### orphan / self-reference 系（builder 段階の警告）

19. orphan-target: 注釈で参照された ID がグラフ上のどの req とも一致しない → `orphan-edge` 警告（既存 type を再利用）。edge は生成され target はそのまま記録される（doc→req の既存挙動と同様）
20. self-reference: 注釈の依存先 ID が当該 req と同一 → `self-reference-annotation` 警告。edge は生成されない
