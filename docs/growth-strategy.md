# artgraph — 成長戦略(GitHub 1万スターへの道筋)

> 本書は「ツールとして本質的に価値がなければマーケティングでは伸びない」を大前提に、
> artgraph が 1 万スター級のツールになるための価値定義・製品条件・配布戦略・撤退ラインを
> まとめた戦略文書。競合ポジショニングの一次資料は [architecture.md](./architecture.md) §2 を参照。
> 本書末尾に 2026-07 時点の競合再調査結果を付す。

作成: 2026-07-03

---

## 0. 結論(TL;DR)

artgraph が 1 万スターに届く条件は、**「人間向けトレーサビリティツール」をやめて
「AI コーディングエージェントのための決定的コンテキスト供給層 + ガードレール」として
価値を定義し直し、タグゼロ・設定ゼロで最初の 5 分に価値が出ること**。

現在の設計思想(決定的グラフ・4層統合・Skills/Hook 統合)は正しい土台だが、
価値の届き方が「規律を受け入れた人にだけ効く」構造になっており、これは
[architecture.md](./architecture.md) §10 が自ら引用している失敗事例
(ContextGit 10 stars、traceability-tool 8 stars でアーカイブ)と同じ死に方をするリスクがある。

推奨実行順:

1. npm 公開(v0.1.0)
2. タグゼロ初回体験(`npx artgraph impact --diff` が import グラフだけで動く)+ デモ GIF
3. MCP サーバー化(Claude Code の外へ)
4. OpenSpec 対応(Issue #25)
5. グラフ可視化(`artgraph scan --format json` の graph 出力を食わせるビューア)
6. エージェント精度ベンチマークの公開

## 1. 本質的価値の再定義 — カテゴリを変える

### 「トレーサビリティ」カテゴリは歴史的に伸びない

「要求トレーサビリティ」は 20 年間、規制産業(StrictDoc / OpenFastTrace が生きる
航空・医療・車載)の外では一度も普及していない。理由は単純で、**人間はタグを書かない**。

- `@impl REQ-001` をコードに書く
- テスト名に `[REQ-001]` を付ける
- 仕様に ID を振る

という 3 つの習慣変更を人間に要求するツールは、便益がどれだけ本物でも採用の谷を越えられない。
Brenn Hill の実証研究(architecture.md §10)も「人間が仕様を保守する」前提でのデータであり、
このカテゴリの牽引力の無さは ContextGit / traceability-tool の失敗が実証している。

### 前提が変わった: コードを書くのはエージェント

エージェントはタグ保守のコストをゼロにする。指示すれば `@impl` を 100% 付け、
rename にも追従する。したがって artgraph の本質的価値は次の 2 つに再定義すべき:

1. **エージェントへの決定的コンテキストルーティング**
   変更対象から「関係する仕様・設計・テストだけ」を引く。CLAUDE.md 肥大化問題への
   構造的な解であり、RAG と違って決定的・再現可能。「エージェントが仕様を忘れて壊す」は
   いま全員が踏んでいるペイン。
2. **エージェント作業のガードレール**
   「Plan で REQ-001 をやると言ったのに未カバーで終了」「仕様が変わったのにコードが未追従」を
   機械的にゲートする。エージェントの出力は速いが信用できない、という非対称性が
   広がるほど価値が上がる。

これは追い風のあるカテゴリ(agent context / agent guardrails)であり、
逆風のカテゴリ(requirements traceability)ではない。ツールの中身はほぼ同じでも、
**何の道具として認知されるかがスターの母集団を決める**。README の一行目・リポジトリの
description・topics をこのペインを直撃する言葉に変えるべき。

## 2. 価値を成立させる製品条件(優先順)

### P0 — npm に公開する

README に「Pre-release: not yet on npm」とある状態では戦略以前の問題。
v0.1.0 を出さない限り何も始まらない。

### P0 — タグゼロで最初の価値を出す(コールドスタートの解消)

architecture.md §10 のブラウンフィールド項で認識済みの通り、
**「タグが 1 つもない既存リポジトリで `npx artgraph impact --diff` を打ったら
import グラフだけで file-level の影響範囲が出る」を初回体験にする**。

knip や depcheck が伸びたのは `npx` 一発で自分のリポジトリに対して即座に何かを
見せたから。仕様・タグ・lock は「使い込むと精度が上がる」段階的な深化であって、
入場料にしてはいけない。

さらに一歩踏み込むなら、既存リポジトリの spec ↔ code リンクをエージェントに
一括推定させてタグを**提案**する `artgraph bootstrap`(推定は LLM、以後の検証は決定的)が
コールドスタート問題の決定打になる。D5(決定性の境界)とは矛盾しない —
**リンクの生成は確率的でよく、リンクの検証が決定的であればいい**。

### P0 — MCP サーバー化

現状の配布面は Claude Code Skills + Spec Kit/Kiro フックで、Claude Code ユーザーに
閉じている。MCP サーバーを出せば Cursor / Windsurf / Codex / Cline が全部市場になる。
「エージェントのコンテキスト供給層」を名乗るなら MCP は必須装備。

### P1 — 見せられるグラフ(可視化ビューア)

> 注: 旧構想では専用 `artgraph graph --serve` コマンドを想定していたが、`graph` サブコマンドは #135 で `scan --format json` に統合された。インタラクティブ可視化は #125 でその `scan` 上に `--serve`(ローカル HTTP でのプレビュー)/ `--output`(静的 HTML 書き出し)として実装済み。

req↔doc↔code↔test の 4 層グラフをインタラクティブに可視化する。
1 万スター級の devtool には例外なく「スクリーンショット 1 枚で価値が伝わる絵」がある。
CLI のテキスト出力は共有されないが、自分のリポジトリの仕様とコードが繋がったグラフは
SNS で共有される。ドリフト箇所が赤く光る絵は、そのままランディングページとデモ GIF になる。

### P1 — OpenSpec 対応(Issue #25)

OpenSpec は ID を持たない見出し駆動で、artgraph の ID 主キー前提と相性が悪い最大勢力。
slug 派生案(`<domain>/slug(requirement-name)`)で対応すれば
「Spec Kit / Kiro / OpenSpec のどれで書いても後半検証は artgraph」という位置が完成する。
エコシステムの一角でも欠けると「うちのツールでは使えない」で離脱される。

### P1 — GitHub Action

`artgraph check --gate` を Marketplace の公式 Action として出す。
CI バッジと Action は devtool の配布チャネルそのもの。

### P2 — エビデンスを作る

前提条件が「本質的価値」なら、それを測定可能にする。
「同一タスクを artgraph の impact コンテキストあり/なしでエージェントに実行させ、
回帰・修正漏れ・ドキュメント未更新率を比較」というベンチマークを自リポジトリの
ドッグフーディングで取る。DORA や Zenn の間接データより、この一次データ 1 つの方が
ブログ 1 本・カンファレンストーク 1 本として遥かに強い。
伸びた devtool の多くは「主張」ではなく「測定結果」で拡散している。

## 3. 配布戦略 — 自前集客ではなく大河に合流する

Spec Kit・OpenSpec・Kiro のコミュニティは全員「生成した後、仕様とコードがずれていく」
問題を未解決のまま抱えている(Kiro Issue #9435 が傍証)。artgraph は競合ではなく
**それらの公式な「後半」**になるのが最短経路。

具体的なチャネル:

- 各エコシステムの docs / awesome リストへの掲載 PR
- Spec Kit の extensions 機構への公式登録
- awesome-claude-code / MCP レジストリへの登録
- GitHub Marketplace(Action)

10 万スター級リポジトリの README から 1 本リンクが張られる方が、
どんな launch post より効く。

## 4. 反証と撤退ライン

ContextGit と traceability-tool が死んだのは技術力不足ではなく、

- (a) 入場料(タグ/設定)が便益より先に来た
- (b) エージェント時代の前に作られ、人間に規律を要求した

の 2 点。§2 の P0 群はこの死因の除去である。

逆に言えば、**npm 公開 + タグゼロ体験 + MCP を揃えて 3〜6 ヶ月経っても
organic な採用(外部からの issue、外部記事)が発生しないなら、
「変更時整合性」単体では需要が薄いというシグナル**であり、その時は impact 出力を
エージェントのコンテキスト最適化(必要な仕様だけを注入する層)に全振りする
ピボットを検討する。

---

## 5. 競合再調査(2026-07-03 実施)

[architecture.md](./architecture.md) §2 の競合調査を最新化するため、4 つの角度
(①直接競合のトレーサビリティツール ②SDD エコシステムの検証レイヤー
③LLM ベースの doc 同期ツール ④エージェント向けコンテキスト/メモリ/ガードレール層)から
それぞれ独立の Web 調査(計 50 回超の検索 + リポジトリ/ドキュメント実査)を並列実行した。

### 5.1 結論

**artgraph の 4 交差点(JS/TS ネイティブ × 決定的 × AST 由来の自動エッジ ×
req↔doc↔code↔test の 4 層統合グラフ)を完全に占めるツールは 2026-07 時点でも存在しない。**

ただし状況認識は更新が必要: もはや「競合ゼロ」ではなく、
**「部分競合が爆発的に増殖中で、交差点の設計図は公開済み。窓は閉じつつある」**が正しい。
象徴的な事実:

- Spec Kit の公式拡張カタログに**検証/ドリフト/トレーサビリティ系拡張が約 26 個**出現
  (ほぼ全て LLM プロンプトパックで非決定的)
- 2026 年 3〜6 月だけで **artgraph とほぼ同一のピッチを掲げる 10 スター未満のリポジトリが 6 個以上**
  独立に誕生(specgraph、spec-seal、specstitch、spectrace-ai-coding 等)
- 2026-06 の arXiv 論文 "The Spec Growth Engine"(2606.27045)が
  「機械可読 spec グラフ + 決定的コンテキスト供給 + ブロッキング drift ゲート」という
  **artgraph の設計そのものをアーキテクチャとして公開**(実装は未確認)
- 「決定的(非 LLM)」は artgraph 固有の差別化語ではなくなり、
  Sourcegraph("deterministic search vs approximate retrieval")、Dosu、Swimm らが
  **マーケティング言語として採用済み** — カテゴリの語彙を教育するコストは消えたが、
  言葉だけでは差別化できなくなった

### 5.2 象限別の主要ファインディング

#### ① 直接競合(決定的トレーサビリティ)

- **StrictDoc**(最重要既存競合): v0.25.1(2026-07-02)時点でも **JS/TS 非対応のまま**。
  tree-sitter パーサーは Python / C/C++ のみ、リンクは手動 `@relation` マーカー必須。
  関数レベルパース計画(Issue #1957)にも JS/TS への言及なし。→ 脅威は現状維持。
- **Cladding / Ironclad**(qwerfunch/cladding、9★、2026-07 に v0.7.1、週次リリース):
  **新規参入で最も交差点に近い**。JS/TS、AST ベース、spec/design/code/tests/docs、
  40 種の drift 検出器 + 15 段の決定的ゲート + knowledge graph。ただし LLM グレーダーを
  内蔵したエージェント統治レイヤーであり、中立な単体 CLI ではない。**最重要ウォッチ対象**。
- **spec-seal**(0★、2026-05 以降停止): 「requirements のためのテストランナー」という
  artgraph に最も近いピッチの決定的 TS CLI だが、手動アノテーションのみ・2 層・実質死亡。
  konstantin-hatvan/traceability-tool(2024 アーカイブ)に続く「同じ問題に着手して
  完成しなかった」傍証がまた 1 つ増えた形。
- **rtmx**(25★、Go、活発): requirements↔tests をテストランナー結果から自動導出 + MCP。
  4 層グラフなし。新規参入では最大トラクション。
- ContextGit は 10★ のまま(v1.2 で JSDoc 経由の JS/TS 対応を追加したが AST なし)。
- **AST 由来の自動エッジ(import グラフ/シンボル精度)× 要求グラフの組合せは
  依然としてどのツールにもない。** 決定的競合は全てタグ/キーワード照合ベース。

#### ② SDD エコシステムの検証レイヤー

- **Spec Kit**: コアに決定的 drift エンジンは無し。新コマンド `/speckit.converge`
  (実装後にコードベースを spec と突き合わせて未実装作業を tasks.md に追記)が
  最も artgraph 領域に踏み込んだ動きだが、LLM エージェント実行・機能単位・非継続的。
  一方で公式拡張カタログの検証系 26 拡張(spec-kit-sync 21★、spec-kit-verify、
  spec-kit-ci-guard、spec-kit-v-model 等)は**需要の実証**であり、
  **artgraph 自身が拡張として掲載されるべき配布チャネル**でもある。
- **Kiro(AWS)**: ビッグベンダーとして最も本格的な参入。
  (a) Requirements Analysis(2026-05): SMT ソルバーで要求同士の整合性を形式検証(前半のみ)。
  (b) **Spec correctness / property-based testing**: EARS 形式の要求から性質を抽出し
  プロパティベーステストを生成、要求への traceability 付き(「コードは spec に一致するか?」)。
  ただし性質抽出は LLM、doc 層なし、Kiro IDE にロックイン、逆方向(実装→spec)の
  ドリフトは未解決とのレビューあり。**Issue #9435(git ref による drift 検出)は
  依然 open・トリアージ待ち・返答なし** — 需要の傍証として今も有効。
- **OpenSpec**: `/opsx:verify` は LLM 裁定の助言的レポート(非決定的・非 CI)。
  エコシステムにも決定的検証ツールは見つからず。
- **Augment Code "Intent"**(2026、商用): living specs + Verifier エージェント。
  「spec は決してドリフトしない」を LLM マルチエージェントで謳う closed platform。
- **fiberplane/drift**(116★、Zig、v0.10.1 2026-06): **技術的に最も近い類似物**。
  tree-sitter の AST フィンガープリントで markdown doc をコードに束縛し、
  `drift.lock` + `drift check` で CI をフェイルさせる(GitHub Action あり)。
  artgraph と同じ lock + 決定的検証の思想。ただし **doc↔code の 2 層のみ**
  (要求モデル・テスト層・orphan/uncovered 分析なし)。

#### ③ LLM ベース doc 同期ツール

- **CoDD**(yohey-w/codd-dev、**108★・3.5 ヶ月で 16→108 と急成長**、Python、活発):
  **現役で最も重複度の高い競合**。要求↔設計↔コード↔設定↔テストの決定的コネクションマップ、
  影響分類(Green/Amber/Gray)、コミットをブロックする pre-commit ゲート、MCP 統合。
  相違点: 要求 ID 主キーなし、Python/Claude Code 中心(TS ネイティブ CLI でない)、
  AST シンボル精度なし。architecture.md 執筆時の「doc 階層止まり・LLM 伝播」という
  評価は**もう古い** — 表の更新が必要。
- **Dosu**(商用): CI の docs freshness スコアを「決定的チェック 3 種(git age、
  TTL 契約、シンボルレベル drift)+ グレーゾーンのみ LLM」で構成。
  **純 LLM ドリフト検出の誤検知問題を商用側が自認し、決定性へ収束し始めた**シグナル。
- DeepDocs / Mintlify は生成型(LLM が doc を書き直す)で検証はしない。
  Swimm は決定的スニペット結合の元祖だが、メインフレーム近代化へピボットし本領域から退場。
- **MCP エコシステムに「要求 ID ベースの traceability / 決定的 drift 検出」サーバーは不在**
  (約 2 万サーバーを横断確認)。dadbodgeoff/drift(781★・5 ヶ月、コード規約の決定的検出)が
  「決定的コードベース真実 × MCP」への需要を証明している。

#### ④ エージェント向けコンテキスト/メモリ/ガードレール層

- **決定的コードグラフ MCP は記録的速度でコモディティ化**:
  codegraph(2026-01 作成で **57k★**)、GitNexus(43k★)、codebase-memory-mcp(25k★)、
  Sourcegraph MCP GA、Augment Context Engine。**ただし全て code-only** —
  要求・doc・テストをグラフノードに持つものは皆無。
- **rac-core "Requirements as Code"**(258★、2026-06 リリース、活発):
  **思想面で最も近い隣人**。型付き Markdown アーティファクト + スキーマ検証 +
  「LLM ゼロ・ネットワークゼロ・決定的」+ read-only MCP + CI ゲート(`rac gate`)。
  ただし**コード/テストへのエッジを持たない**(知識アーティファクト間のみ)。
  artgraph = rac-core の哲学 + グラフのコード/テスト半分、という関係。
- メモリ層(mem0 60k★ / Graphiti 28k★ / cognee 27k★ / Letta 24k★)に
  構造化された要求↔コード連携をやるものは無し。
- 「エージェントは宣言通りに実装したか」を検証するパッケージ化された
  plan-vs-diff 検証ツールで 200★ 超のものは存在しない。Qodo が
  「context plane + verification」を同一テーゼで商用展開(LLM 裁定・Jira 連携・企業向け)。
- CLAUDE.md 肥大化問題は本家 Issue(#29971)化しており、解は glob スコープの
  静的ファイル分割か LLM トリガーの Skills のみ。
  **「型付き要求グラフからの per-change コンテキストルーティング」は空白のまま** —
  §1 の再定義が狙うレーンは無人であることが確認できた。

### 5.3 脅威マップ(上位)

| 競合 | 決定的? | 層 | トラクション | 脅威度 | 欠けているもの |
|---|---|---|---|---|---|
| CoDD | ほぼ(伝播ロジックは決定的) | 5 層 | 108★・急成長 | **高** | 要求 ID・AST 精度・TS ネイティブ |
| Kiro spec correctness | テスト実行時のみ | req↔test↔code | AWS の配布力 | **高** | doc 層・逆方向・ロックイン |
| codegraph 等コードグラフ MCP 群 | はい | code のみ | 25k〜57k★ | **中〜高**(req ノード追加は容易) | 要求/doc/テスト層 |
| fiberplane/drift | はい(AST fingerprint + lock) | doc↔code | 116★ | 中 | 要求モデル・テスト層 |
| rac-core | はい | req/doc のみ | 258★ | 中(code エッジ追加なら直撃) | コード/テスト層 |
| Cladding/Ironclad | ハイブリッド | 実質 4 層+ | 9★・週次リリース | 中 | 中立性・軽量さ・トラクション |
| spec-kit-sync 等 26 拡張 | いいえ(LLM) | req↔code | 公式カタログ配布 | 中(価値訴求が重複) | 決定性・継続性 |
| Augment Intent / Qodo / Dosu | 一部 | 各様 | 商用資本 | 中 | ローカル・OSS・型付きグラフ |
| StrictDoc | はい | 3 層 | 最大手 | 低〜中(JS/TS 追加時に急騰) | JS/TS・自動エッジ |

### 5.4 戦略への影響(§1〜4 の修正・強化点)

1. **緊急度が上がった。** 「交差点が空白」は変わらないが、設計図は arXiv で公開され、
   隣接ジャイアント(codegraph 系が req ノードを足す / rac-core が code エッジを足す /
   Kiro が逆方向を塞ぐ)のどれか 1 手で埋まる。§2 の P0 群(npm 公開・タグゼロ体験・MCP)は
   四半期単位ではなく**週単位**で進めるべき。
2. **§1 の再カテゴリ化は調査で裏付けられた。** 「決定的コンテキスト供給 × MCP」は
   codegraph の 5 ヶ月 57k★ が証明する爆発カテゴリで、かつ要求層を持つ参加者はゼロ。
   artgraph の差別化メッセージは「コードグラフ MCP はもう持っているでしょう。
   でもそのグラフは**あなたの仕様を知らない**」に定めるのが最も鋭い。
3. **Spec Kit 拡張カタログは配布チャネル兼戦場。** 検証系 26 拡張は全て LLM プロンプトで、
   決定的 CLI は不在。artgraph を公式拡張として掲載し、
   「プロンプトではなく再現可能な CI ゲート」を差別化点として明記する。
4. **「決定的」だけでは語れない。** Dosu / Sourcegraph / Swimm が同じ語彙を使い始めた以上、
   訴求は「決定的であること」ではなく
   **「要求 ID を主キーに 4 層を 1 本のグラフで繋ぐ唯一のツール」+ lock による承認フロー**
   という具体構造で語る。
5. **architecture.md §2 の競合表は要更新**(CoDD の評価が旧く、Cladding / fiberplane/drift /
   rac-core / rtmx / Kiro spec correctness / Spec Kit 拡張群が未掲載)。

### 5.5 ウォッチリスト(四半期ごとに再確認)

- yohey-w/codd-dev(成長速度・要求 ID 導入の有無)
- qwerfunch/cladding(週次リリースの内容)
- fiberplane/drift(要求層への拡張)
- itsthelore/rac-core(code/test エッジの追加)
- Kiro spec correctness(逆方向ドリフト対応・IDE 外提供)
- github/spec-kit(コアへの検証機能取り込み、`/speckit.converge` の進化)
- StrictDoc(tree-sitter パーサーの JS/TS 対応 — Issue #1957)
- Dosu / Qodo(決定的チェックの拡張・ダウンマーケット展開)

主要ソース: [github.github.io/spec-kit/community/extensions.html](https://github.github.io/spec-kit/community/extensions.html)、[kiro.dev/docs/specs/correctness/](https://kiro.dev/docs/specs/correctness/)、[github.com/kirodotdev/Kiro/issues/9435](https://github.com/kirodotdev/Kiro/issues/9435)、[github.com/fiberplane/drift](https://github.com/fiberplane/drift)、[github.com/yohey-w/codd-dev](https://github.com/yohey-w/codd-dev)、[github.com/itsthelore/rac-core](https://github.com/itsthelore/rac-core)、[github.com/qwerfunch/cladding](https://github.com/qwerfunch/cladding)、[github.com/colbymchenry/codegraph](https://github.com/colbymchenry/codegraph)、[arxiv.org/abs/2606.27045](https://arxiv.org/abs/2606.27045)、[github.com/strictdoc-project/strictdoc/issues/1957](https://github.com/strictdoc-project/strictdoc/issues/1957)、[github.com/bgervin/spec-kit-sync](https://github.com/bgervin/spec-kit-sync)、[dosu.dev/blog/score-documentation-freshness-in-ci](https://dosu.dev/blog/score-documentation-freshness-in-ci)、[qodo.ai/blog/context-plane-and-verification/](https://www.qodo.ai/blog/context-plane-and-verification/)
