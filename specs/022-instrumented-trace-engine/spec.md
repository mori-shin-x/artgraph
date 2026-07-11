# Feature Specification: trace capture engine v2 — 静的計装による per-test 採取固定費のモジュール数独立化

**Feature Branch**: `claude/artgraph-test-perf-q48v46`

**Created**: 2026-07-11

**Status**: Draft

**Input**: User description: "trace capture engine v2 — CDP採取(per-test takePreciseCoverage)から withTrace() 注入の vite plugin による関数入口静的計装への転換。per-test固定費をロード済みモジュール数から独立させ、大規模スイートでのrunnerオーバーヘッドを劇的に削減する(issue #241)。設計文書: docs/design/241-trace-engine-v2.md"

**Related**:

- Issue [#241](https://github.com/mori-shin-x/artgraph/issues/241) — 本 spec の起点。大規模スイートで runner オーバーヘッドがテスト数に比例して増大する問題。issue 記載の対策候補(バッチ化・hash キャッシュ・フィルタ前倒し)では支配項に届かないことの計測根拠は設計文書に記録済み。
- 設計文書 [docs/design/241-trace-engine-v2.md](../../docs/design/241-trace-engine-v2.md) — 事前調査。`takePreciseCoverage` 1 回のコストが isolate のロード済みスクリプト数に比例する実測(25→1,600 モジュールで 0.35ms→1.55ms、ペイロード一定)、および計装方式の per-test コスト実測(0.013〜0.13ms)。
- spec 020 (coverage-derived-edges) — 前身。本 spec は spec 020 の**採取層(runner)のみ**を置き換える。shard 契約(`specs/020-coverage-derived-edges/contracts/trace-artifact.md`)・ingest・graph・check/impact のセマンティクスは一切変更しない。research.md D1 が計装方式を棄却した理由「config 1 行の UX が壊れる」は、spec 020 自身が導入した `withTrace()` ラッパーの存在により失効している(採用時は D9 として追記)。
- spec 020 SC-005 — 現行 perf バジェット(≤1.5 倍)。本 spec はこれを恒久的に引き下げる。
- spec 018 (reexport-symbol-precision) — fail-safe フォールバック哲学。計装できないモジュール・解決できない関数名は証拠の欠落(file 粒度 or 証拠なし)に倒し、誤ったエッジを出さない。

**前提**: shard 契約は schemaVersion 1 のまま**不変**。本 spec は「同じ成果物をより安く作る」変更であり、成果物の意味・形状・下流(ingest 以降)の挙動は変わらない。旧採取方式(CDP)は fallback として残置し、削除しない。

## 問題の構造(本 spec の設計核)

現行 runner の per-test 固定費(約 3〜4ms/テスト、import 重スイートで比率 1.7 倍)は 3 つの成分からなるが、支配項は `Profiler.takePreciseCoverage` である。計測により、**その 1 回のコストはテストが何を実行したかと無関係に、ワーカーにロード済みのスクリプト総数に比例する**ことが判明した(V8 が take のたびに isolate 内の全スクリプトの関数カウンタをスイープするため)。さらに precise coverage の有効化自体が、ワーカー内で実行される全コード(テストフレームワーク・依存ライブラリ含む)に計数の税を課す。

つまり現行方式のコストモデルは「**テスト数 × ロード済みモジュール数**」に比例し、プロジェクトが大きくなるほど二重に悪化する。書き込みバッチ化や hash キャッシュはこの支配項に触れないため、抜本策として採取機構そのものを置き換える:

| | 現行 (CDP 採取) | v2 (静的計装) |
| --- | --- | --- |
| per-test 固定費 | ロード済みスクリプト数に比例(実測 0.35〜1.55ms × 2 回/テスト) | ロード済み計装関数スロットの走査のみ(実測 0.013〜0.13ms) |
| 常時課税 | ワーカー内の**全**実行コード | プロジェクト内ソースの関数入口 1 store のみ(≈1ns/呼び出し) |
| 一回性コスト | なし | ソース変換(モジュール数に比例・キャッシュされ、ワーカー間で共有) |
| 採取の前提 | inspector が使える Node 環境 | ソースが変換パイプラインを通ること |

変換は「関数の入口に実行印を 1 つ押す」ことだけを行い、テストの可観測挙動(結果・スナップショット・エラーの行番号)を変えない。実行印の回収(per-test の hits 化)・shard への書き出しは従来どおり runner の責務で、書き出しはテストファイル境界にまとめる。

## User Scenarios & Testing *(mandatory)*

### User Story 1 — 大規模スイートでの体感オーバーヘッド解消 (Priority: P1)

数千テスト・import 重のプロジェクトの開発者が、`withTrace()` を設定したまま普段どおり `vitest run` を実行する。トレース採取有効時の実行時間の増加が、従来の「テスト数とモジュール数に比例して膨らむ」構造から「ほぼ一定の薄い上乗せ」に変わり、「テストを普段どおり回すだけ」という導入ストーリーが大規模プロジェクトでも成立する。

**Why this priority**: 本 spec の存在理由。issue #241 の実測(artgraph 自身の 1,801 テストで 1.7 倍)は、数千〜万テスト級の適用プロジェクトで実用性を直撃する。採取層の性能は spec 020 全体の普及の前提条件。

**Independent Test**: artgraph 自身の unit スイート(1,800 テスト級)を採取有効/無効で実行し、実行時間比が受け入れ基準(SC-001)内であることを計測で確認する。

**Acceptance Scenarios**:

1. **Given** artgraph 自身の unit スイート(1,800 テスト級・import 重)、 **When** v2 エンジン有効で `vitest run`、 **Then** 実行時間はベースライン(採取無効)の 1.15 倍以下。
2. **Given** 同スイート、 **When** v2 エンジン有効で実行、 **Then** `.artgraph/trace/` に従来と同一契約(schemaVersion 1)の shard が生成され、`artgraph trace report` / `artgraph scan` が無変更で読める。
3. **Given** ロード済みモジュール数が数百〜千級の import 重 fixture、 **When** v2 エンジン有効で実行、 **Then** per-test 固定費はモジュール数を増やしてもほぼ一定(モジュール数比例の構造が消えている)。

---

### User Story 2 — 既存利用者の無破壊移行(出力等価性) (Priority: P1)

spec 020 のトレーサビリティ(exercises エッジ・UNEXERCISED CLAIM 監査・impact --tests)を既に使っているユーザーが、artgraph を更新して次に `vitest run` した時、**得られるエッジ・診断・レポートが従来と一致する**。採取が速くなったこと以外、何も変わったように見えない。

**Why this priority**: 採取層の置き換えが下流の意味論を 1 ビットでも変えるなら、それは「性能改善」ではなく「別の機能」になる。決定性ブランド(憲法原則 I)の下では、等価性が改善の成立条件。

**Independent Test**: 同一 fixture を旧エンジン(CDP)と v2 エンジンでそれぞれ実行し、ingest 通過後の正規化エッジ集合が一致することを differential テストで assert する。

**Acceptance Scenarios**:

1. **Given** export 関数・arrow 代入・クラスメソッド・named default export を含む fixture、 **When** 両エンジンでそれぞれ `vitest run` → ingest、 **Then** 導出される exercises エッジ集合(req → symbol|file)は一致する。
2. **Given** 同一 fixture・同一エンジン、 **When** 2 回実行して ingest、 **Then** 正規化出力は byte-identical(既存 FR-004/FR-011 の決定性維持)。
3. **Given** v2 エンジンで生成した shard、 **When** 既存の ingest / `trace report` / `check` / `impact --tests` に入力、 **Then** コード変更なしの下流がそのまま動作する(schemaVersion 1・レコード形状・ファイル配置・世代管理すべて従来どおり)。
4. **Given** trace 記録後にソースを編集、 **When** `check`、 **Then** staleness 判定(記録時 contentHash vs 現在)が従来どおり機能する(v2 の hash は従来と同一規則で計算されている)。

---

### User Story 3 — 特殊構成ユーザーの逃げ道(エンジン選択) (Priority: P2)

ソース変換パイプラインに独自の transformer を挟んでいる等、計装が適用できない・適用したくない構成のユーザーが、設定または環境変数で旧エンジン(CDP)を明示的に選択する。旧エンジンは従来どおり動作し、shard 出力は v2 と等価。

**Why this priority**: 計装方式はソースが変換パイプラインを通ることを前提とする。前提が崩れる構成への fail-soft(証拠の欠落)だけでなく、明示的な opt-out を提供することで導入リスクをゼロにする。differential テストの比較対象としても旧エンジンは必要。

**Independent Test**: エンジン切替設定それぞれで同一 fixture を実行し、(a) 指定どおりのエンジンが使われること、(b) どちらでも下流が同一結果を得ることを assert する。

**Acceptance Scenarios**:

1. **Given** エンジン未指定(既定)、 **When** `withTrace()` 構成で実行、 **Then** v2(計装)エンジンが使われる。
2. **Given** 旧エンジンを明示指定、 **When** 実行、 **Then** CDP 採取で従来どおり shard が生成される。
3. **Given** 旧エンジン指定、 **When** 実行、 **Then** 従来の per-test 同期書き込み・hash 再計算は安価な改善(hash メモ化・バッチ書き込み)適用済みで動作する。

---

### User Story 4 — perf 回帰の継続監視(バジェット引き下げと import 重 fixture) (Priority: P2)

メンテナが CI の perf スイートを実行する。従来の純関数 500 テスト fixture に加え、**import 重 fixture**(1.7 倍の悪化体質を再現するロード済みモジュール数の多い構成)でもオーバーヘッド比が計測され、引き下げ後のバジェットで green になる。以後の変更で採取固定費が退行すれば CI が検出する。

**Why this priority**: 現行の公式 perf fixture(純関数 500 テスト)は issue #241 の悪化構造を再現できておらず、バジェット(1.5 倍)も緩すぎて退行を見逃す。改善を主張する土台と、改善を維持する回帰ガードの両方がこの fixture 群に依存する。

**Independent Test**: perf スイート単体を実行し、両 fixture のオーバーヘッド比が新バジェット内で green になることを確認する。

**Acceptance Scenarios**:

1. **Given** 既存の純関数 500 テスト fixture、 **When** perf テスト実行、 **Then** バジェット 1.5 → **1.2** に引き下げても green。
2. **Given** 新設の import 重 fixture(数百モジュール級のロード)、 **When** perf テスト実行、 **Then** 同バジェット(1.2)で green。
3. **Given** 両 fixture、 **When** perf テスト実行、 **Then** 実測比が記録目的で毎回ログ出力される(現行 SC-005 テストの慣行を維持)。

---

### Edge Cases

- **解析不能なソース**(構文エラー・対応外の構文): 計装をスキップし、そのモジュールからは証拠が生成されない(fail-soft — 誤ったエッジより欠落が正しい)。スキップした事実は実行時に警告として可視化する(silent skip 禁止)。
- **変換パイプラインを通らないコード**(実行時 eval・動的生成コード等): 証拠なし。現行方式も `file://` URL のスクリプトのみ対象であり、実質的な後退はない。
- **スタックトレース・エラー報告**: 計装挿入は既存行内で行い、行番号を変えない。列ずれはソースマップ連鎖で吸収する。テストの失敗メッセージ・スナップショットは計装の有無で不変。
- **`it.concurrent`**: 現行どおり帰属破棄(`skipped: concurrent`)。計装レジストリの構造は将来の並行帰属(ビットマスク)を妨げないが、本 spec のスコープ外。
- **watch モード**: 現行どおり非対応(run 中のファイル不変が前提)。
- **ワーカーの途中 kill**: 書き込みはテストファイル境界のバッチになるため、失われるのは高々「最後の flush 以降のテストファイル 1 つ分」のレコード。それ以前の shard 内容は完全な JSONL であること(部分 shard 耐性 — 既存テストの対象を維持)。
- **同名関数の同一ファイル内重複・無名関数**: 現行と同じく symbol 解決は ingest 側の責務で、曖昧は file 粒度フォールバック。v2 で計装対象外とした無名関数は「解決できない名前」から「そもそも記録されない」に変わるが、どちらも symbol 粒度エッジを生まない点で下流の結果は同じ。
- **`@vitest/coverage-v8` との併用**: v2 は V8 Profiler 機構を使わないため取り合いが消える(改善)。旧エンジン選択時は現行と同じ制約。
- **テストファイル自身・node_modules**: 計装対象外(現行 runner の除外規則を変換時に前倒し適用)。shard の hits に現れない性質は不変。

## Requirements *(mandatory)*

### Functional Requirements

**採取エンジン v2(計装)**

- **FR-001**: `withTrace()` は設定 1 行のまま(ユーザー UX 不変)で v2 採取エンジンを既定として有効化すること。既存のテスト結果・スナップショット・レポーター・エラーメッセージの行番号など、テストの可観測挙動を変更しないこと。
- **FR-002**: v2 エンジンの per-test 採取コストは、ワーカーにロード済みのモジュール総数から独立であること(テストごとの作業は「実行印の回収と消去」に限られ、inspector/CDP 往復・全スクリプト走査を伴わない)。
- **FR-003**: 実行時の常時コストはプロジェクト内ソースの関数入口に限定されること。テストフレームワーク・依存ライブラリ(node_modules)・テストファイル自身には計装もカウンティングも課さないこと。
- **FR-004**: 計装対象は現行 runner の除外規則(プロジェクトルート外・node_modules・テストファイル)を変換時に前倒し適用して決定すること。
- **FR-005**: 記録される関数名は現行(V8 `functionName`)と互換の命名規則で静的に決定すること。少なくとも ingest の symbol 解決が扱う名前種別 — export 関数名・arrow/関数式の代入先変数名・クラスメンバ名・named default export — で現行と同一名を生成すること。静的に命名できない関数は計装対象外としてよい(現行でも file 粒度フォールバック止まりであり、symbol 粒度の結果は変わらない)。
- **FR-006**: 各実行ファイルの contentHash は変換時にディスク上の原ソースから既存規則(BOM 除去 → sha256 → 16 桁)で計算し、per-test のファイル読み取り・hash 計算を行わないこと。既存の hash 等価性ピン(`tests/hash-equivalence.test.ts` 相当)を v2 の hash 生成経路にも適用すること。
- **FR-007**: shard への書き込みはテストファイル境界単位のバッチで行い、書き込み回数をテスト数から独立させること。ワーカー異常終了時、最後の flush までの shard 内容は完全な JSONL として残ること(部分 shard 耐性の維持)。
- **FR-008**: 解析不能・変換対象外のモジュールは計装をスキップし(fail-soft)、スキップの事実を実行時警告として可視化すること。スキップされたモジュールについて誤った証拠を生成しないこと。

**契約と下流の不変性**

- **FR-009**: shard 契約は schemaVersion 1 のまま不変であること — レコード種別(`meta`/`test`/`skipped`)・フィールド形状・ファイル配置(`<workerId>-<runToken>.jsonl`)・世代管理(globalSetup による削除)のすべて。ingest / scan / check / impact / trace report はコード変更なしで v2 の shard を読めること。
- **FR-010**: 契約文書(`trace-artifact.md` §test)の `fn` の記述を「V8 functionName 互換の命名規則で決定した関数名」に注記修正すること(schemaVersion は据え置き)。spec 020 research.md に採取方式転換の設計判断を D9 として追記すること。
- **FR-011**: 同一 fixture を両エンジンで実行し、ingest 通過後の正規化エッジ集合が一致することを differential テストとして CI で強制すること。

**エンジン選択と fallback**

- **FR-012**: 採取エンジンは設定(`withTrace()` オプション)および環境変数で明示切替できること。既定は v2。旧エンジン(CDP)は削除せず fallback として残置すること。
- **FR-013**: 旧エンジンには安価な 2 改善 — ワーカー内 contentHash メモ化・shard 書き込みのバッチ化 — のみ適用すること(それ以上の最適化投資はしない)。
- **FR-014**: 両エンジンとも vitest の対応バージョン範囲(現行 `>=3 <5`)・forks / threads 両プールで動作し、既存の E2E マトリクスを両エンジンで実施すること。

**perf 計測基盤**

- **FR-015**: perf スイートに import 重 fixture(数百モジュール級のロードを伴う構成)を追加し、既存の純関数 fixture と合わせて両方でオーバーヘッド比を計測すること。
- **FR-016**: perf バジェットを 1.5 倍から 1.2 倍に引き下げること(spec 020 SC-005 の改訂)。実測比のログ出力慣行は維持すること。

### Key Entities

- **採取エンジン (capture engine)**: shard を生成する機構の抽象。v2(静的計装)と cdp(現行の per-test 精密カバレッジ)の 2 実装を持ち、切替可能。**shard 契約より上流のみ**に存在する概念で、ingest 以降はエンジンを区別しない(できない)。
- **計装レジストリ (instrumentation registry)**: ワーカー内に 1 つ存在する「実行印」の記録面。モジュール登録時に(相対パス・contentHash・関数名表)を受け取り、関数入口の実行印を保持し、テスト境界で回収・消去される。shard 契約には現れない実装内部のエンティティ。
- **import 重 fixture**: perf 計測用の合成プロジェクト。テスト数だけでなく「ワーカーにロードされるモジュール数」を独立に大きくできる構成で、per-test 固定費のモジュール数依存を検出する。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: artgraph 自身の unit スイート(1,800 テスト級・import 重)で、採取有効時の実行時間増加が **1.15 倍以下**(issue #241 の受け入れ基準 1.3 倍を上回る達成水準。現状は約 1.7 倍)。
- **SC-002**: 公式 perf テスト(純関数 500 テスト fixture)がバジェット **1.2 倍**(現行 1.5 倍)で green。
- **SC-003**: import 重 fixture でも同バジェット(1.2 倍)で green — per-test 固定費がロード済みモジュール数から独立していることの回帰ガード。
- **SC-004**: 両エンジンの differential テストで、正規化エッジ集合の一致率 100%(対象 fixture は ingest が symbol 解決できる全名前種別を網羅)。ただし採取環境そのものに固有の 2 ケース — vite-node SSR 変換による無名 default export の合成名 rename、V8 パーサ内部 `FuncNameInferrer` によるコンテナ越し推測名 — は両エンジンの挙動を differential テストで個別に固定する(実測根拠: research.md V4 の T012 追記)。
- **SC-005**: v2 エンジンで生成した shard に対する下流(ingest / scan / check / impact / trace report)の出力が、同一実行内容の旧エンジン shard に対する出力と一致する。trace 不在時の全コマンド出力は本 spec 導入前と byte-identical(オプトイン性の回帰ガード維持)。
- **SC-006**: artgraph 自身の全テストスイートが v2 計装有効の下で全 green(計装がテストの可観測挙動を変えないことの実地検証)。

## Assumptions

- **変換パイプライン前提**: v2 はソースが vitest の変換パイプラインを通ることを前提とする(vitest の標準構成)。通らないコードは証拠なし(fail-soft)。前提が許容できない構成には旧エンジンの明示選択で対応する。
- **既定エンジンの切替タイミング**: v2 は differential テスト・E2E マトリクス・perf 受け入れがすべて green になった時点で既定化する(段階リリースはしない — 0.1 で実利用者はいない想定という spec 019/020 の前提を踏襲)。
- **並行帰属・browser mode・Jest 展開はスコープ外**: v2 の構造はいずれも将来可能にする(inspector 非依存・変換の差し替え可能性)が、本 spec では扱わない。`it.concurrent` の帰属破棄・watch モード非対応は現状維持。
- **依存境界の明文化**: 変換処理は既存の解析基盤(メインプロセス側)を再利用してよいが、ワーカー内で動く実行時部品は Node 組み込みのみに依存する — spec 020 の「vitest ワーカーに CLI バンドルを持ち込まない」境界規則を、「変換はメインプロセス専用・実行時レジストリは依存ゼロ」として引き継ぐ。
- **性能数値の根拠**: SC-001〜003 の目標値は設計文書のプローブ実測(per-test 固定費 3〜4ms → 0.013〜0.13ms)から十分な余裕をもって設定した。達成不能が判明した場合は計測データとともにバジェットを再交渉する(黙って緩めない)。
- **Constitution 影響なし**: 採取機構の置き換えは `graph = f(files, trace)` の trace を「より安く作る」だけであり、エッジ導出元・決定性・信頼境界(原則 I / III)に変更はない。憲法改訂は不要。
