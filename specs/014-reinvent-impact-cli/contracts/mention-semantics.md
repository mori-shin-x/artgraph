# Contract: REQ-ID Mention Semantics

**Feature**: impact CLI 再設計 + plan-coverage 新設 | **Date**: 2026-06-28

`plan-coverage` が `affectedReqs` から `implicitImpacts` を計算する際の「言及されている」判定の意味論を定義する。実装は `src/plan-coverage/mention.ts`(新規)。

---

## 中核ルール

> tasks.md / plan.md / spec.md のテキスト union のどこかに、REQ-ID が **語境界マッチ**で 1 度でも出現すれば「言及されている」とみなす。

---

## Source set(言及検索対象)

| ファイル | 取得方法 | 存在しない場合 |
|---|---|---|
| `tasks.md` | `--tasks <path>` または `<spec-dir>/tasks.md` | エラー(`--tasks` 必須) |
| `plan.md` | `--plan <path>` または `<spec-dir>/plan.md` | スキップ(任意) |
| `spec.md` | `<spec-dir>/spec.md` | スキップ(任意 — Kiro の `requirements.md` 等は v1 では対応せず別 issue) |

3 ファイルのテキストを **改行で連結して 1 つの string にして** 検索対象とする。ファイル境界は意識しない(どのファイルで mention されているかは output に出さない — シンプル化優先)。

---

## 境界マッチの正確な定義

各 affected REQ-ID `R`(例: `REQ-3`)について、以下の正規表現で source text を検索する:

```regex
(?<![A-Za-z0-9_])R(?![A-Za-z0-9_])
```

- 前後の boundary は **`[A-Za-z0-9_]` 以外**(`\w` の否定)
- ハイフン(`-`)、コロン(`:`)、ブラケット(`[`, `]`)、空白、句読点、行頭・行末は **boundary として有効**

### なぜ `\b` ではなく lookahead/lookbehind か

`\b` は `\w` 境界を判定するが、`REQ-3` の `-` 自体が `\w` 境界となるため、`\bREQ-3\b` を素直に書くと「`REQ-3` の `3` の前後が word boundary か」だけ確認することになる。これで正しく動くケース:

- `REQ-3` の `3` 後ろが `0` → `\b` なし → `REQ-30` には誤マッチしない ✓
- `REQ-3` の `3` 後ろが `]` → `\b` あり → `[REQ-3]` にマッチ ✓

ただし `\b` は POSIX class とエンコーディング依存があるため、安全のため `[A-Za-z0-9_]` を明示する lookahead/lookbehind を採用する。挙動は等価。

---

## マッチする例(言及あり と判定)

| source 文 | REQ-3 マッチ? |
|---|---|
| `Considered: REQ-3 — investigated, no impact` | ✓ |
| `Affected: REQ-3` | ✓ |
| `[REQ-3](#req-3)` | ✓(`[` も `]` も非 word) |
| `## REQ-3 ユーザ認証` | ✓ |
| `REQ-3 に依存する` | ✓ |
| `本タスクは REQ-1, REQ-3, REQ-7 を扱う` | ✓ |
| `<!-- REQ-3 -->` | ✓(HTML comment 内も対象) |
| `\`REQ-3\`` (code span) | ✓ |
| `` ```\nREQ-3\n``` `` (code fence) | ✓ |

code block / HTML comment 内も意図的に **対象に含める**。理由:
- 「考慮済 REQ をコメントとして記録する」も有効な記録形式
- 除外ロジックを入れると markdown AST parser が必要になり依存が増える
- false positive(意図せず REQ-ID が混入)は実害がない(言及されている REQ は単に「警告から外れる」だけ)

---

## マッチしない例(言及なし と判定)

| source 文 | REQ-3 マッチ? |
|---|---|
| `REQ-30` | ✗(`3` 後ろが `0` で word 継続) |
| `REQ-300` | ✗(同上) |
| `aREQ-3` | ✗(`R` 前が `a` で word 継続) |
| `REQ-3xyz` | ✗(`3` 後ろが `x` で word 継続) |
| `_REQ-3` | ✗(`R` 前が `_` で word 継続) |
| `REQ-3_log` | ✗(`3` 後ろが `_` で word 継続) |
| `REQ-3.5` | ✓(`.` は word 外 — ピリオドの後の文字には依らない) |
| `REQ-3-extended` | ✓(`-` は word 外) |

`REQ-3-extended` のように REQ-ID にハイフンが続くケースで、`REQ-3` と `REQ-3-extended` が両方 REQ-ID として graph に存在する場合、両 ID が並列にマッチング対象になる(各 ID 独立に lookahead/lookbehind を評価)。これは現実の REQ 命名としては稀。

---

## ラベル無依存

`Considered:` / `Affected:` / `Refs:` / `[REQ-X]` / `# REQ-X` などのラベル keyword は **区別しない**。単に REQ-ID 文字列が境界マッチで現れているかだけを見る。

理由: spec 014 はラベル規約を強制せず、ユーザが任意の書き方で「考慮済」と記録できることを優先する(検知後 3 経路の 1 つ目を低摩擦にする)。

将来 `--require-ack-keyword` のような strict mode を導入する場合は別 issue([#105](https://github.com/ShintaroMorimoto/artgraph/issues/105) の C 項に記載)。

---

## アルゴリズム

```
function detectMentions(
  affectedReqIds: string[],     // impact() の出力から
  sources: { tasks: string, plan?: string, spec?: string }
): { mentioned: Set<string>, implicit: string[] } {
  const text = [sources.tasks, sources.plan, sources.spec]
    .filter(Boolean)
    .join("\n");

  const mentioned = new Set<string>();
  for (const reqId of affectedReqIds) {
    const re = new RegExp(
      `(?<![A-Za-z0-9_])${escapeRegex(reqId)}(?![A-Za-z0-9_])`
    );
    if (re.test(text)) mentioned.add(reqId);
  }

  const implicit = affectedReqIds.filter(id => !mentioned.has(id));
  return { mentioned, implicit };
}
```

- `escapeRegex` で REQ-ID 内の正規表現特殊文字をエスケープ(`REQ-001` 等は安全だが、将来 `REQ.001` 命名等に備える)
- 1 source pass で全 REQ-ID をテスト(O(N × M)、N = 入力文字数、M = REQ 数)
- M が大きい場合(REQ 100+)は **1 つの巨大 regex `(?<![A-Za-z0-9_])(REQ-1|REQ-2|...)(?![A-Za-z0-9_])`** に統合する最適化が可能だが、初版では shipping シンプルさ優先で個別 regex を採用

---

## `--ignore` の事後フィルタリング

`--ignore REQ-3,REQ-7` が渡された場合:

```
implicit = implicit.filter(id => !ignoreSet.has(id))
```

`implicit` から除外するだけで、mention 検出ロジック自体には影響しない。`--ignore` で除外した ID は output の `ignored: []` field にそのまま入る(透明性)。

---

## エッジケース

### REQ-ID の前 word boundary が `/`

`src/REQ-3.ts` のような file path 中の出現:

- `/` は `[A-Za-z0-9_]` ではないので boundary 成立 → **マッチする**

これは設計上の許容範囲。file 名に REQ-ID を含める命名規則の人は実質「言及」してると解釈してよい。

### REQ-ID が改行で分断される

```
REQ-
3
```

→ マッチしない(regex は単一行内マッチ)。これは現実的に発生しないので問題視しない。

### REQ-ID 大文字小文字

REQ-ID の case は graph 上の表記に厳密一致(`REQ-3` と `req-3` は別)。理由: graph の node ID は case-sensitive で扱われており、`scan` 時の正規化に依存させたくない。

### Markdown link reference

```
[REQ-3]: https://example.com/req-3.html

See [REQ-3] for details.
```

→ 2 箇所両方マッチ(両方とも word boundary 成立)。「言及」判定は OR なので 1 度でもマッチすれば mentioned。

---

## Test 戦略

`tests/mention-detector.test.ts` で以下を網羅する:

1. **基本マッチ**: 単純な `REQ-3` 出現 → mentioned
2. **誤判定防止**: `REQ-30` / `REQ-300` / `aREQ-3` / `_REQ-3` → not mentioned
3. **境界バリエーション**: `[REQ-3]` / `(REQ-3)` / `<REQ-3>` / `\`REQ-3\`` / `# REQ-3` → mentioned
4. **複数 source 結合**: tasks.md のみマッチ / plan.md のみマッチ / spec.md のみマッチ → 全 mentioned
5. **空 source**: tasks.md だけ存在、plan.md / spec.md ファイル不在 → エラーにせず tasks.md のみ検索
6. **大文字小文字**: `req-3` は `REQ-3` の言及と扱わない
7. **同 REQ の複数マッチ**: 1 ファイル内に `REQ-3` が複数回 → mentioned 1 度(Set 化)
8. **ハイフン拡張命名**: `REQ-3-extended` と `REQ-3` が両方 graph にある場合、両方独立に検出
