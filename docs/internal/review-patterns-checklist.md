# Review Patterns Checklist（レビュー指摘の前倒しチェックリスト）

このリポジトリの直近 PR は「実装 → 敵対的レビュー → メタレビュー → 一括修正」の流れで進めており、
1 PR あたり 8〜23 件の指摘が出ている。それらを横断分析すると、**指摘の大半は実装の難所ではなく、
初回実装で毎回同じ 7 カテゴリの観点が抜けている**ことに起因する。

この文書はその 7 カテゴリを**正典（SSOT）**として定義する。敵対的レビューは「安全網」であって、
本来の狙いは**シフトレフト＝最初の実装で潰しておく**ことにある。各カテゴリは以下のいずれかの形で
強制される（実効性の強い順）:

| 強制力 | 手段 | 例 |
|---|---|---|
| 最強（マージ不可） | 自動テスト / `artgraph` ゲート | `tests/skills-templates.test.ts`, `*-dogfood.test.ts`, `artgraph check --diff` |
| 強（埋めないと進めない） | Spec Kit ゲート | `plan.md` の Constitution Check, `/speckit-analyze` |
| 中（着手時に必ず見る） | `tasks.md` の Definition of Done, agent-context | 本文書を参照 |
| 弱（参照のみ） | この正典ドキュメント | — |

> **使い方**: `/speckit-plan` 時は「設計時ゲート」を Constitution Check で確認し、
> `/speckit-tasks` 後は各タスクが「実装時 DoD」を満たすか確認し、実装完了後は
> `artgraph check --diff` / `artgraph plan-coverage` のドッグフードで drift=0 を確認する。

---

## カテゴリ一覧（頻度の高い順）

### Cat1. ハッピーパス実装 — 異常系の取りこぼし（最頻出）

初回実装が「想定どおりの入力」だけを処理し、異常系をレビューが後付けしている。

**実際に出た指摘**: `match[1] == null` ガード欠落 / `ancestorTitles` 欠落でクラッシュ /
glob 0 件と破損 JSON の混同 / BOM 付き `package.json` / `existsSync` がディレクトリ名 lockfile を誤判定 /
非 ASCII パスの取りこぼし / `JSON.parse`・`execFileSync`・`globSync` の try-catch 欠落 / tsconfig 不在。

**前倒しルール**: 入力を受ける各関数で次の 8 系統を**実装時にその場で**潰す。
- null / undefined
- 空 / 0 件マッチ
- 型違い（配列期待に文字列等）
- 巨大入力 / 多重ネスト
- 非 ASCII パス（git は `-c core.quotePath=false ... -z`）
- BOM 付きファイル
- 壊れた / 不正な JSON・YAML（「結果なし」と「破損」を区別して warning）
- 存在しないパス / ENOENT

### Cat2. SSOT（単一の真実源）を張らずに二重実装する（重大度・最高）

同じ知識を 2 箇所に書き、レビューが**乖離**を発見する。直近 PR で最も "High/ブロッカー" を量産。

**実際に出た指摘**: bash 検出 vs TS 検出の divergence（`split("@")[0]` ≠ `^([a-z]+)@`、
grep nested 誤検出 ≠ TS top-level parse）/ パーサ正規表現 vs リライタ正規表現のドリフト /
REQ タグ正規表現が module ごとに別物 / テンプレ vs ドッグフードコピー vs インストール先の 3 重ドリフト /
`escapeRegExp`・`extOf` の重複定義。

**前倒しルール**:
- plan 段階で「同じ知識が複数箇所に出るペア」を**列挙**し、どちらを SSOT にするか決める。
- bash↔TS のように bootstrap 上やむを得ない二重実装は、**等価性メタテスト**（テンプレから bash を抽出し、
  同一 fixture で TS と結果を突き合わせる）を最初から書く。
- 共有定数（`REQ_ID_TOKEN` 等）・共有ヘルパに集約し、コピーを作らない。

### Cat3. 仕様・ドキュメントと実装の不整合（毎回）

spec / README / SKILL / コメント / バージョン記述が実装に追従せず、レビューが拾う。

**実際に出た指摘**: spec.md の見出し例が実装と矛盾 / README Commands 表・skills-guide が旧コマンド形 /
コメントが実挙動と食い違う / 事実誤認バージョン（Deno `>=1.45`→`1.42` 等）/ 旧例の superseded note 不足。

**前倒しルール**:
- コードを変えたら**同じ PR 内**で spec / README / SKILL / コメント / バージョン文言を更新する（DoD 固定項目）。
- 実装後に必ず `artgraph check --diff` と `artgraph plan-coverage` のドッグフードを回し、**drift=0** を確認してから出す。
- 旧い例には削除でなく superseded note を付ける。

### Cat4. テストがハッピーパス／vacuous（空振り）になっている

初回テストが「通ること」を確認するだけで、反証力がない。

**実際に出た指摘**: dogfood が `totalAffected>0` 前提なしで常に green（vacuous）/ 組合せの 1/4 しか張らない /
過剰波及ガードなし / brittle テスト（SHA-256 完全一致・whitespace 固定）/ エッジ欠落（BOM+CRLF / ENOENT /
malformed / env vs file 優先 / perf scale）。

**前倒しルール**: テストごとに「**この前提が崩れたら必ず落ちるか？**」を自問する。新フラグ・新分岐には
次の 4 種をセットで書く。
- negative（不正値を拒否する）
- boundary（`REQ-30` vs `REQ-3` の境界など）
- matrix（組合せの全網羅。1/4 で済ませない）
- anti-vacuous（`expect(totalAffected).toBeGreaterThan(0)` 等の precondition assert）
- 完全一致比較（SHA / whitespace 固定）でなく**正規化比較**にする。

### Cat5. CLI 表面の一貫性 — 兄弟コマンドと揃っていない

新フラグ・新コマンドをアドホックに作り、レビューが「揃えろ」と指摘。

**実際に出た指摘**: `--kind`/`--format`/`--mode` に `.choices()` 不在 / `--depth` の NaN・負値チェック欠落 /
`--plan <missing>` が silent fallback（`--tasks` と非対称）/ `--format json` が失敗時に JSON を返さない /
排他フラグ検証欠落 / REQ-ID 受理 regex が狭く Kiro `Requirement-3`・scoped `auth/FR-2`・dotted `REQ-1.2` を取りこぼす。

**前倒しルール**: 新コマンドは下記の CLI 規約のコピーから始める。
- enum 値は必ず commander `.choices()` で拒否する。
- 全コマンドが `--format json|text` を持ち、**失敗時もフォーマットを遵守**する。
- 数値フラグは parseInt 後に NaN / 負値を検証する。
- 同種フラグ（`--tasks`/`--plan` 等）のエラー挙動は**対称**にする（片方だけ silent fallback にしない）。
- 排他フラグは明示的に検証する。
- ID 受理 regex は共有定数を使い、Kiro / scoped / dotted 形を含める。

### Cat6. 着手前の前提検証（件数は少ないが最も高コスト）

issue / spec の前提を実コードで裏取りせずに進め、後で覆る。1 件で**スコープ全体の作り直し**になりうる。

**実際に出た指摘**: issue の前提「既に出荷済」が実態は未実装スタブ → スコープ再定義＋別 issue 分離 /
新 spec の FR-ID が旧 spec と衝突しグラフ上で qualified 化 → mention 検出が外れて REQ が implicit 漏れ。

**前倒しルール**: `/speckit-specify` 着手**前**にリアリティチェックを必須化する。
- 前提として書かれている「既出荷機能・依存 spec・既存挙動」を `grep` / `artgraph` で**実在確認**する。
- 新規 ID を発行する時は、既存 spec との **ID 衝突**を先に検査する（衝突するとグラフで qualified 化され
  mention 検出から外れる）。

### Cat7. アルゴリズム／グラフ走査の精度（impact 系で再発）

トレーサビリティ中核ロジックで、境界・方向・重複の取りこぼし。

**実際に出た指摘**: file→symbol 展開漏れ／逆に過剰検知 / `continue` で同一ファイル内ノードを起点から除外 /
エッジ方向を無視したルート判定 / 関数オーバーロードで symbol ノード重複 / `affectedFiles` の dedup 漏れ /
fenced code block 内の ID まで書き換え。

**前倒しルール**: グラフ操作は次の 3 点を実装時に**明示コメント＋テスト**で pin する。
- 方向（forward / reverse / 双方向）
- 重複（dedup key を明示。例 `source|target|kind`）
- 境界（同一ファイル・同一 stem・コードフェンス内を含む / 除外の別）

---

## 設計時ゲート（`/speckit-plan` の Constitution Check で確認）

- [ ] **前提検証 (Cat6)**: issue/spec の前提（既出荷機能・依存 spec・既存挙動）を実コードで裏取りした。
- [ ] **ID 衝突 (Cat6)**: 新規 REQ-ID を発行する場合、既存 spec との衝突を確認した。
- [ ] **SSOT ペア (Cat2)**: 同じ知識が 2 箇所に出る箇所を列挙し、真実源と等価性テストをタスク化した。
- [ ] **CLI 規約 (Cat5)**: 新コマンド/フラグが `--format`・`.choices()`・対称な検証・共有 ID regex に沿う。
- [ ] **走査仕様 (Cat7)**: グラフ操作の方向・dedup key・境界を plan に明記した。

## 実装時 Definition of Done（各タスク／PR 提出前）

- [ ] **異常系 (Cat1)**: 入力関数で 8 系統（null/空/0件/型違い/巨大/非ASCII/BOM/壊れ/不在パス）を潰した。
- [ ] **安全な書き込み (Cat1)**: 書き込みは atomic（tmp+rename）かつ成功後に確定し、symlink/repo 外を拒否。
- [ ] **正規表現 (Cat2/Cat7)**: 共有定数化し、境界（lookaround）とコードフェンス除外を入れた。
- [ ] **doc 同時更新 (Cat3)**: 同じ PR で spec/README/SKILL/コメント/バージョン文言を更新した。
- [ ] **反証可能テスト (Cat4)**: negative / boundary / matrix / anti-vacuous をセットで書いた（完全一致比較を避けた）。
- [ ] **ドッグフード (Cat3)**: `artgraph check --diff` と `artgraph plan-coverage` が drift=0 / implicit=0。
- [ ] **等価性 (Cat2)**: bash↔TS 等の二重実装に等価性メタテストがあり green。

---

## 出典

直近 PR のレビュー修正コミット（`fix: ... レビュー指摘対応` / `敵対的レビュー` / `メタレビュー`）を
横断分析して抽出した。代表例:
PR #106 (`49af4e0`), PR #112 (`74144ed` / `87fc9d2`), rename (`9f0d959`), PR #30 (`b219b90`),
PR #27 (`92601f8`), PR #34 (`c8a6543`)。
