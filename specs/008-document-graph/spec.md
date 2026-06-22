# Feature Specification: ドキュメント間グラフ構造

Feature Branch: `008-document-graph`

Created: 2026-06-21

Status: Draft

Input: SDD ツールが出力する Markdown ファイル群の依存関係をグラフとして管理し、ドキュメント→要求→実装の一気通貫トレーサビリティを実現する

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 散文 Markdown のグラフ自動登録 (Priority: P1)

開発者が Kiro の design.md のような要求 ID を含まない散文 Markdown を持っている。
現状では frontmatter が無い md ファイルはグラフからノード 0 個で消えてしまい、
依存関係を追跡できない。`artgraph scan` を実行すると、各 md ファイルが自動的に
`doc` ノードとしてグラフに登録され、frontmatter の有無に関わらずドキュメントの
存在がグラフ上で可視化される。

Why this priority: doc ノードの自動生成はグラフの基盤となる機能であり、後続の
doc→doc 依存（US2）や contains エッジ（US3）が全てこの機能に依存する。散文中心の
SDD ツール出力を扱うために必須。

Independent Test: frontmatter を含まない散文のみの md ファイルを配置し、
`artgraph scan` で doc ノードとして認識されることを確認する。

Acceptance Scenarios:

1. Given frontmatter の無い散文 Markdown ファイルがスキャン対象にある, When `artgraph scan` を実行する, Then そのファイルが `doc` ノードとしてグラフに登録される
2. Given frontmatter に `artgraph.node_id` が指定された Markdown ファイルがある, When `artgraph scan` を実行する, Then 自動採番ではなく指定された node_id が doc ノードの ID として使用される
3. Given 散文のみの md と要求 ID を含む md が同じプロジェクトにある, When `artgraph scan` を実行する, Then 両方のファイルに doc ノードが生成され、要求 ID を含む md では req ノードも併存する
4. Given doc ノードの自動生成が無効化されている設定の場合, When `artgraph scan` を実行する, Then frontmatter に node_id がない md ファイルからは doc ノードが生成されない

---

### User Story 2 - ドキュメント間の依存チェーン表現 (Priority: P1)

開発者が Spec Kit の `spec.md → plan.md → tasks.md` や Kiro の
`requirements.md → design.md → tasks.md` のようなドキュメント連鎖を持っている。
frontmatter に依存関係を記述することで、ドキュメント間の derives_from / depends_on
関係がグラフに反映される。これにより上流ドキュメントの変更が下流にどこまで影響するか
を追跡できる。

Why this priority: ドキュメント間の依存グラフは artgraph の本来の狙いである
「md 依存の管理」を実現する中核機能。US1 の doc ノード自動生成と合わせて v1 の骨格を成す。

Independent Test: frontmatter で derives_from 関係を記述した 3 ファイルの連鎖を
配置し、`artgraph scan` で doc→doc エッジが正しく張られることを確認する。

Acceptance Scenarios:

1. Given design.md の frontmatter に `artgraph: { derives_from: [requirements.md] }` と記述されている, When `artgraph scan` を実行する, Then design.md から requirements.md への `derives_from` エッジがグラフに生成される
2. Given `tasks.md → design.md → requirements.md` の 3 段階の依存チェーンが frontmatter で定義されている, When `artgraph impact` を tasks.md 起点で実行する, Then design.md と requirements.md の両方が影響範囲に含まれる
3. Given frontmatter の依存先に存在しないドキュメント ID が指定されている, When `artgraph scan` を実行する, Then `orphan-doc` 警告が出力される
4. Given frontmatter の relation に `derives_from` / `depends_on` 以外の値が指定されている, When `artgraph scan` を実行する, Then `invalid-relation` 警告が出力される

---

### User Story 3 - ドキュメントから要求・実装への一気通貫トレース (Priority: P1)

開発者が要求 ID（FR-001 等）を含む spec.md を持っている。doc ノードとその中の
req ノード間に `contains` エッジが自動生成されることで、ドキュメントの変更が
中の要求を経由して実装ファイルまで影響範囲として到達できる。

Why this priority: contains エッジは doc グラフと req/実装グラフを接続し、
一気通貫トレーサビリティを実現するために不可欠。US1, US2 と合わせて v1 の
コア価値を構成する。

Independent Test: 要求 ID を含む spec.md とその要求を実装するコードを配置し、
spec.md 起点の `impact` が実装ファイルまで到達することを確認する。

Acceptance Scenarios:

1. Given spec.md に FR-001 がリスト項目として含まれている, When `artgraph scan` を実行する, Then `doc:spec.md --contains--> FR-001` エッジがグラフに生成される
2. Given spec.md に FR-001 があり、コード内に `// @impl FR-001` がある, When `artgraph impact` を spec.md 起点で実行する, Then contains を経由して FR-001 → 実装ファイルまで影響範囲が到達する
3. Given doc ノードの自動生成が有効だが contains が無効化されている設定の場合, When `artgraph scan` を実行する, Then doc ノードは生成されるが `contains` エッジは生成されない
4. Given 名前空間衝突で req ID が remap される状況の場合, When `artgraph scan` を実行する, Then contains エッジのターゲットも remap 後の ID に正しく更新される

---

### User Story 4 - ドキュメント依存グラフの可視化 (Priority: P2)

開発者が `artgraph graph` コマンドを実行すると、ドキュメント間の依存チェーンが
テキストまたは JSON 形式で出力される。グラフの全体構造を確認でき、ドキュメント管理
の状況を把握できる。

Why this priority: グラフを「見える化」しないと「md 依存を管理する」という目的が
達成されない。US1-3 でグラフが構築できた後に可視化を提供する。

Independent Test: doc 依存チェーンを持つプロジェクトで `artgraph graph` を
実行し、text / JSON 両形式で依存構造が正しく出力されることを確認する。

Acceptance Scenarios:

1. Given doc 依存チェーンが構築されたプロジェクトがある, When `artgraph graph --format text` を実行する, Then doc を起点にした依存チェーンがインデント付きのツリー形式で表示される
2. Given doc 依存チェーンが構築されたプロジェクトがある, When `artgraph graph --format json` を実行する, Then `{ nodes: [...], edges: [...] }` 形式の JSON が出力される
3. Given doc ノードのみの依存関係を見たい場合, When `artgraph graph --kind doc` を実行する, Then doc ノードに限定したグラフが表示される
4. Given `artgraph graph` をオプション無しで実行する, When デフォルト設定の場合, Then text 形式で全ノード種別のグラフが出力される

---

### Edge Cases

- frontmatter に同じ依存先を二重に記載した場合 → エッジデデュープにより 1 本に統合される（キーは source, target, kind の組み合わせ）
- req ID が `doc:` / `file:` / `test:` / `symbol:` プレフィクスを使っている場合 → 予約プレフィクス衝突として警告が出る
- doc ノードの自動生成が無効かつ frontmatter の node_id も無い md ファイル → doc ノードが生成されず、contains エッジも張られない
- ドキュメント内容（散文）のみ変更し要求 ID の本文は変更していない場合 → doc ノードのみ drift し、req ノードは drift しない（意図どおりの挙動）
- impact が contains 経由で大量のノードに到達する場合 → 到達ノード数の内訳（docs / reqs / files）が表示され、影響範囲の広がりが可視化される
- contains 逆流による影響範囲の広がり（req 起点で親 doc に遡り、さらに別の req に到達するケース）→ `--depth N` オプションで探索深さを制限して対処する。002-doc-impact-ux の depth 表示では contains 逆流は depth が深い＝「参考」扱いとなる
- 異なるファイルが同じ node_id を frontmatter で指定した場合 → duplicate-id 警告を出力する（既存の重複 ID 検出と同じ挙動）

## Requirements *(mandatory)*

### Functional Requirements

- FR-001: 各 Markdown ファイルを frontmatter の有無に関わらず `doc` ノードとしてグラフに自動登録する。frontmatter `artgraph.node_id` がある場合はその値を ID として使用し、無い場合は spec ディレクトリからの相対パスを基に自動採番する。対象は `specDirs` 配下のファイルに限定し、設定で除外パターンを指定可能とする
- FR-002: ドキュメント間の依存関係を frontmatter の `artgraph` ブロック内に relation をキーとしてフラット記述する（例: `artgraph: { derives_from: [requirements.md], depends_on: [shared-types.md] }`）。relation として `derives_from` と `depends_on` の 2 種類をサポートし、それ以外のキーには `invalid-relation` 警告を出しエッジを生成しない
- FR-003: doc ノードとその同一ファイル内の req ノード間に `contains` エッジを自動生成し、ドキュメント階層→要求→実装の一気通貫トレースを可能にする
- FR-004: `artgraph graph` コマンドでドキュメント依存チェーンを text / JSON 形式で出力する。`--kind` オプションでノード種別を絞り込める
- FR-005: frontmatter の依存先ノードが存在しない場合、`orphan-doc` 警告を出力する。`check --gate` 実行時は warning として報告するが gate を fail させない
- FR-006: 全エッジ確定後に source, target, kind の組をキーとしてエッジの重複を除去する
- FR-007: req ID が予約プレフィクス（doc: / file: / test: / symbol:）を使用している場合、名前空間衝突として警告を出す
- FR-008: doc ノードの自動生成と contains エッジ生成はそれぞれ独立した設定で有効・無効を制御できる（設定キー例: `docGraph.autoNodes`, `docGraph.autoContains`）
- FR-009: `impact` 出力に到達ノード数の内訳（docs / reqs / files）を表示し、contains 経由の影響範囲の広がりを可視化する。到達内訳の表示は 008 のスコープとし、depth 表示や via 表示は 002-doc-impact-ux のスコープとする
- FR-010: `artgraph impact` がファイルパスを受け取った場合、対応する doc ノードも起点に含める（resolveStartIds での doc: プレフィクス対応）
- FR-011: `artgraph impact` に `--depth N` オプションを追加し、BFS の探索深さを制限できるようにする（デフォルトは無制限）。contains エッジは双方向に辿るため、逆流による影響範囲の広がりを depth で制御する

### Key Entities

- doc ノード: Markdown ファイルを表すグラフノード。frontmatter の有無に関わらず各 md ファイルに 1 個生成される。ファイル全体のハッシュを contentHash として保持し、ドキュメント変更の drift 検知に使用する
- contains エッジ: doc ノードとその中で定義された req ノードの間の所属関係を表すエッジ。doc グラフと req/実装グラフを接続する役割を持つ
- derives_from エッジ: 下流ドキュメントから上流ドキュメントへの派生関係（例: design.md が requirements.md から派生）。frontmatter の `artgraph.derives_from` キーで定義する
- depends_on エッジ: ドキュメント間の一般的な依存関係。frontmatter の `artgraph.depends_on` キーで定義する
- doc ノード ID: frontmatter 指定がある場合はその値、無い場合は `doc:<specDir からの相対パス>` の形式で自動採番される

## Success Criteria *(mandatory)*

### Measurable Outcomes

- SC-001: frontmatter を持たない散文のみの Markdown ファイルが `doc` ノードとしてグラフに登録される
- SC-002: frontmatter で定義された doc→doc 依存チェーンが正しくグラフのエッジとして反映される
- SC-003: doc 起点の `impact` が contains エッジを経由して req → 実装ファイルまで到達し、一気通貫トレースが実現される
- SC-004: `artgraph graph` コマンドの text / JSON 出力が依存構造を正しく表現する
- SC-005: 依存先の存在しないドキュメント参照に対して `orphan-doc` 警告が出力される
- SC-006: req ID の予約プレフィクス使用に対して名前空間衝突の警告が出力される
- SC-007: doc ノードの contentHash はファイル全体で計算され、散文変更時に doc のみ drift し req は独立して drift 検知される

## Assumptions

- グラフの基本単位はファイル（doc ノード）とする。要求 ID 抽出は「ある場合に拾う」ベストエフォートであり、散文のみのドキュメントもグラフに参加できる
- doc→doc 依存の入力は v1 では frontmatter の 1 経路のみとする。ツール規約の自動推論（C-3）は v1 スコープ外。インラインリンク自動抽出（C-2）は issue #11 で本 spec 後に実装し、`docGraph.inlineLinks`（既定 true）で制御する
- 要求⇔要求の依存（req→req）は v1 スコープ外
- `via` エッジメタデータは v1 では追加しない（消費者がいないため）。002-doc-impact-ux の via フィールド（impact 出力で各ノードに到達した際のエッジ型表示）とは別概念であり、本 spec の via 非ゴールはグラフモデル自体へのエッジメタデータ追加を指す
- DOT / Mermaid 等のリッチ可視化は v1 スコープ外（text/JSON のみ）
- symbol 粒度、steering doc、task 粒度のモデル化、版管理は v1 スコープ外
- contains エッジは lock ファイルに永続化しない（毎回グラフから再生成できる構造情報のため）
- 未リリースのため後方互換は考慮しない
- `specs/` ディレクトリは既にデフォルトのスキャン対象に含まれている
- 008（本 spec）は 002-doc-impact-ux より先に実装する。008 で到達内訳の基本表示を実装し、002 で depth/via の UX を洗練する順序を想定
