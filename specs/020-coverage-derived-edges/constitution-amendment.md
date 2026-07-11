# Constitution 改訂 PR 文面(v1.1.0 → v1.2.0)— spec 020 前提改訂

> 本ファイルは改訂 PR の**下書き**。Governance 手続き(憲法 §Governance)に従い、spec 020 の実装 PR とは**別 PR** として提出し、オーナー(@mori-shin-x)のレビュー承認を得る。承認・マージが **spec 020 Phase B の着手条件**(plan.md Gate 裁定)。

---

## PR タイトル

```
docs(constitution): v1.2.0 — 実行トレースを第4のエッジ導出元として追加し、カバレッジ評価に exercised を導入 (spec 020 前提改訂)
```

## PR 本文(そのまま使用可)

### 目的

spec 020(カバレッジ由来トレーサビリティ)は、`[REQ]` タグ付きテストの per-test 実行証拠から `exercises` エッジを導出する。これは憲法 v1.1.0 の 2 箇所の**字義**と衝突する(意図とは衝突しない)ため、MINOR 改訂を提案する。

1. **原則 I**: エッジ導出元の列挙(frontmatter 宣言 / ID タグ / TS AST)に「テスト実行トレース成果物」が含まれない
2. **原則 III**: カバレッジ評価が三段階(`untagged` / `impl-only` / `verified`)に固定されており、オプトイン第 4 状態 `exercised` を許容しない

### なぜ原則の意図は維持されるか

- **決定性(原則 I の核)**: trace 成果物は正規化済みの決定的**入力**であり、`graph = f(files, trace)` — 同一入力から byte-identical に再導出できる(spec 020 FR-010/011、SC-002/007)。LLM・統計推定は一切関与しない。
- **非対称な信頼境界(原則 III の核)**: `exercised` は「タグだけで安心する」の逆方向 — 宣言(自己申告)を実行証拠が**監査**する仕組みであり、既定 off のオプトイン。宣言済み REQ の評価軸(impl-only / verified)には影響しない。むしろ UNEXERCISED CLAIM(主張されたが実行されない)の検出により、原則 III が防ごうとした「タグだけの安心」への対抗手段が増える。
- **意味判定の排除(原則 V)**: 「実行された」は観測可能な構造的事実であり、意味的正しさの判定ではない。抵触なし(改訂不要)。

### バージョニング根拠

MINOR(1.1.0 → 1.2.0): 既存原則の削除・後方非互換な再定義ではなく、ガイダンスの実質的拡張(§Governance の Versioning 規定)。

### 同梱物チェックリスト(Governance 要件)

- [ ] (a) 改訂後の constitution **全文**(下記の改訂ハンク 3 点を適用したもの)
- [ ] (b) 影響を受けるテンプレート / docs の同時更新(下記「波及確認」)
- [ ] (c) Sync Impact Report の更新(下記をファイル先頭コメントに置換)

---

## 改訂ハンク(3 点)

### ハンク 1: 原則 I — 導出元列挙の拡張

**現行**:

```markdown
- ノード/エッジは frontmatter 宣言、ID タグ、TS AST のいずれかから派生する。
- drift / orphan / uncovered の判定は content-hash と lock ファイルだけで決まる。
```

**改訂後**:

```markdown
- ノード/エッジは frontmatter 宣言、ID タグ、TS AST、または正規化済みテスト実行
  トレース成果物のいずれかから派生する。トレース由来のエッジ (`exercises`) は
  `graph = f(files, trace)` を満たし、同一の trace 入力から byte-identical に
  再導出できなければならない。
- drift / orphan / uncovered の判定は content-hash と lock ファイルだけで決まる。
  トレース由来エッジの鮮度 (staleness) 判定も同じく content-hash 照合だけで決まる。
```

### ハンク 2: 原則 III — カバレッジ評価の拡張

**現行**:

```markdown
要求 ID(FR-NNN, Requirement N 等)は仕様ファイル側で発行する。実装側は
`// @impl FR-001` のように claim タグで参照するだけで、独自 ID を発行しない。
カバレッジは三段階で評価する: `untagged` / `impl-only` /
`verified(impl + green test)`。
```

**改訂後**:

```markdown
要求 ID(FR-NNN, Requirement N 等)は仕様ファイル側で発行する。実装側は
`// @impl FR-001` のように claim タグで参照するだけで、独自 ID を発行しない。
カバレッジは三段階で評価する: `untagged` / `impl-only` /
`verified(impl + green test)`。オプトイン設定 (`trace.acceptExercises`) が
有効な場合に限り、claim を持たない REQ に第 4 状態 `exercised`(green な
タグ付きテストによる排他的実行証拠あり)を許す。`exercised` は claim 済み
REQ の評価には影響せず、実行証拠が claim を代替することはあっても、claim が
実行証拠を偽装することはできない(証拠は claim を監査する方向にのみ働く)。
```

同原則の箇条書きに 1 点追加:

```markdown
- claim(`@impl`)と実行証拠(`exercises`)の不一致 — 実行されない claim、
  claim なき排他的実行 — は CLI で即時可視化される。
```

### ハンク 3: バージョン行

**現行**:

```markdown
**Version**: 1.1.0 | **Ratified**: 2026-06-23 | **Last Amended**: 2026-06-26
```

**改訂後**(Last Amended は PR マージ日に更新):

```markdown
**Version**: 1.2.0 | **Ratified**: 2026-06-23 | **Last Amended**: 2026-07-XX
```

---

## Sync Impact Report(ファイル先頭コメントの置換文面)

```markdown
Sync Impact Report — Constitution v1.2.0
================================================================
Version change: 1.1.0 → 1.2.0 (MINOR — 原則 I / III のガイダンス拡張)
Amended: 2026-07-XX

Modified principles:
- I. 決定的グラフ第一 (Determinism First)
  - エッジ導出元の列挙に「正規化済みテスト実行トレース成果物」を追加。
    graph = f(files, trace) の byte-identical 再導出要件と、staleness 判定も
    content-hash 照合のみで決まることを明文化 (spec 020)。
- III. Spec が ID を所有、コードが claim (Spec Owns the ID; Code Claims)
  - オプトイン限定の第 4 カバレッジ状態 `exercised` を追加。証拠は claim を
    監査する方向にのみ働くこと(非対称性の維持)を明文化 (spec 020)。

Principles (5): 削除・再定義なし。II / IV / V は変更なし。

Templates / dependent artifacts:
- .specify/templates/plan-template.md   ✅ Constitution Check は generic placeholder のままで整合
- .specify/templates/spec-template.md   ✅ 変更不要
- .specify/templates/tasks-template.md  ✅ 変更不要
- docs/architecture.md                  ⚠️ §3 コアモデルのエッジ型列挙に `exercises` を追記 (spec 020 実装 PR で同時更新)
- README.md                             ⚠️ 「every edge is deterministic and sourced from …」の列挙に trace を追記 (spec 020 実装 PR で同時更新)

Follow-up TODOs:
- spec 020 Phase B/C の実装 PR で docs/architecture.md §3 / README の記述を同期する
  (本改訂 PR では憲法本文のみを変更し、実装を伴う docs は実装 PR 側に寄せる)。
```

---

## 波及確認(レビュー観点)

- 原則 II は改訂不要: `exercises` は既存の 4 ノード型間の新しいエッジ型であり、原則 II の「エッジ型」列挙(`depends_on` / `derives_from` / `implements` / `verifies` / `imports`)への追記は**憲法ではなく plan の Constitution Check で正当化する運用**(原則 II 自体が「新フィールドは plan で説明」と規定)— ただしレビューで「列挙に `exercises` を加えるべき」と判断される場合は本 PR に含めてよい(その場合も MINOR のまま)。
- 原則 V は改訂不要: SUGGESTED IMPL は提案出力であり、グラフ/lock への自動コミットをしない(spec 020 plan.md 原則 V 整合の項)。
- `.specify/memory/constitution.md` の改訂は本 PR のみで行い、spec 020 実装 PR には含めない(Governance: 憲法改訂は独立 PR)。
