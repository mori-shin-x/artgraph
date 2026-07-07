# Phase 0 Research: check --gate baseline 差分化

spec / plan の Technical Context から抽出した設計判断とその根拠。すべて実コード・実測に基づく (Cat6 前提検証)。

---

## R1. baseline を「global」で計算するか「scoped」で計算するか

**Decision**: baseline は base graph 全体 (**global**) の issue 集合をキー化する。current issue は従来どおり scoped (blast radius)。`new = current issue のうち baseline キー集合に無いもの`。

**Rationale**:
- current issue は既存の `impact()` BFS で scoped に出す (blast radius 温存 = FR-007)。ここに手を入れない。
- baseline を global にすると、base ref に存在した issue はすべてキー集合に入る。current の scoped issue から「base に既にあったもの」を漏れなく引ける。base ref 側で scope (blast radius) を再計算する必要がなく、実装が単純。
- global 計算のコストは `findOrphans` / `findUncovered` / `computeCoverage` / drift 判定を base graph 全体に 1 回適用するだけ (いずれも O(edges) or O(nodes) の純粋関数)。主コストは worktree の `scan` 自体であり、global 化による追加コストは無視できる。

**Alternatives considered**:
- *baseline も scoped*: base graph 上で同じ startIds から `impact()` を再実行して scope を作る。だが変更ファイルが新規追加 (base に無い) の場合 startId が base graph に解決せず scope がずれる。複雑な割に利点なし。却下。

---

## R2. base ref の状態をどう副作用ゼロで得るか

**Decision**: `git worktree add --detach <tmpdir> <baseRef>` で base ref を一時ディレクトリに展開 → `scan(<tmpdir>, config)` → `git worktree remove --force <tmpdir>` で撤去。`<tmpdir>` は OS の一時領域 (`os.tmpdir()` 配下に `mkdtemp`)。

**Rationale**:
- `git stash` はユーザーの作業ツリー・index を書き換えるため FR-004 違反。worktree は独立したチェックアウトで、ユーザーの作業ツリー・index・lock に一切触れない。
- **parse-cache は自動的に cold path**: cache は `<root>/node_modules` が存在するときのみ有効 (`src/parse-cache.ts:67-70`)。worktree には `node_modules` が無いのでキャッシュの読み書きが発生せず、現在の cache を汚染しない。追加のガードは不要 (必要なら `ARTGRAPH_CACHE=0` も併用可)。
- **本 repo 自体が worktree ベース開発**であり (`git worktree list` に複数の linked worktree)、linked worktree からの `git worktree add` も共有 `.git` を指して動作することを確認済み。
- lock は worktree に来ない (gitignore) が、これは R3 の設計で問題にならない。

**Alternatives considered**:
- *`git cat-file` / `git show <ref>:<path>` で blob を読み in-memory scan*: `scan` / `buildGraph` は fast-glob でファイルシステムを走査する前提なので、in-memory 仮想 FS を差し込む改修が大きい。worktree の方が既存 `scan(rootDir, config)` をそのまま再利用でき低リスク。却下 (将来 in-memory FileSource 層 #166 が入れば再検討)。
- *`.git/worktrees` 配下に作る*: repo 内に一時物を置くと dogfood の `scan` や別ツールが拾うリスク。OS tmpdir が安全。

**実運用事故パターンと対策 (tasks で実装・テスト)**:
- **後始末の確実性**: worktree 撤去は `try/finally` で必ず実行。`git worktree remove --force` が失敗しても `git worktree prune` で回収し、それも失敗したら警告のみ (baseline 結果は既に取得済みなので処理は続行)。
- **中断・異常終了時の残骸**: SIGINT / プロセスクラッシュで `finally` が走らず worktree が残ると `git worktree list` が汚れ disk を消費する。対策として、tmpdir 名に識別可能な prefix (例 `artgraph-baseline-`) を付け、`computeBaselineIssues` 冒頭で prefix 一致の古い残骸を best-effort に `prune`/`remove` する掃除を行う。
- **並行実行**: エディタ保存フックと手動実行が同時に走るケース。`mkdtemp` でユニーク tmpdir を使い worktree パスを衝突させない。共有 `.git` への worktree 操作は git 内部ロックに委ねる (稀な競合時は unavailable にフォールバック)。
- **linked worktree からの実行**: 本 repo 自体が linked worktree。linked worktree から `git worktree add` が動くことを実測タスクで確認する (R2 冒頭の前提)。

---

## R3. drift の baseline をどう計算するか (lock が gitignore な前提)

**Decision**: baseline drift は **現在の lock** を基準に計算する。base graph の各 req/doc ノードの contentHash を現在の `.trace.lock` と比較し、差があるものを baseline drift とする。

**Rationale**:
- `.trace.lock` は gitignore (`​.gitignore:4`) されておりコミットされない。`git worktree add` は tracked file だけを展開するため worktree に lock は現れない。「base ref 時点の lock」は取得不能。
- drift の意味は「現在の lock に対する逸脱」。base graph を現在の lock と比較すれば「base 時点で既に lock からずれていたノード (pre-existing drift)」が得られ、それを current drift から引けば「今回の変更で新たにずれたノード」が残る。lock は現在の 1 つで足りる。
- この方針は lock がコミット対象に変わっても有効 (現在の lock を基準にする一貫性は保たれる)。

**Alternatives considered**:
- *worktree に現在の lock をコピーして base 版として使う*: base graph を現在 lock と比較するのと結果が同じで、コピー分だけ手数が増える。却下。

---

## R4. issue の同一性キー (集合差の粒度)

**Decision**: 種別プレフィックス付きの文字列キーで集合化する。

| 種別 | キー |
|------|------|
| drift | `drift:<nodeId>` |
| orphan | `orphan:<source> -> <target> (<kind>)` (= `findOrphans` の出力文字列そのまま) |
| uncovered | `uncovered:<reqId>` |
| test failure | `testfail:<reqId>` |

`new issue = current issue のうち、キーが baseline キー集合 (Set<string>) に含まれないもの`。

**Rationale**:
- 4 種別は識別子が異なる (drift/uncovered/testfail は単一 ID、orphan は source→target→kind の三つ組)。プレフィックスで種別衝突を防ぐ。
- orphan は既存 `findOrphans` が既に `"${source} -> ${target} (${kind})"` を返すので、その文字列をそのままキーにできる (SSOT: キー生成を 1 箇所に集約)。
- drift は「同じ nodeId が base でも drift していたか」で pre-existing 判定できる。現在 lock 基準 (R3) なので base/current で同じ lock を見ており比較が整合。

**Alternatives considered**:
- *drift を hash 値まで含めてキー化*: 「base で drift、current でも drift だが別内容」を別扱いにできるが、gate 目的では「その node が新たに drift 状態に入ったか」で十分。過剰。却下。

---

## R5. orphan のスコープ照合を厳密 ID 一致にする (FR-006)

**Decision**: `check()` の orphan スコープ照合を、現状の部分文字列マッチ `allOrphans.filter(o => [...scope].some(s => o.includes(s)))` から、**orphan の source を厳密に scoped node 集合と照合**する方式に変更する。`findOrphans` を構造化して `{ source, target, kind }` を返す (表示用の文字列化は別途) ことで、`scopedNodeIds.has(orphan.source)` の厳密判定を可能にする。

**Rationale**:
- 現状は orphan 文字列全体に scope token が部分一致するかを見るため、無関係な fixture ファイル (`tests/impact-cli.test.ts` 等) の orphan 行が「そのファイルが scope に入っているだけ」で誤って scope 内と判定される (issue #174 で実測: 53 orphan 中 48 が部分文字列で誤マッチ)。
- orphan は「source (コード/テストファイル) が存在しない target REQ を claim している」問題。因果的にゲート対象なのは **変更ファイルが source の orphan** のみ。source を startIds (変更ファイル node) と厳密照合するのが正しい。
- `findOrphans` の構造化は既存呼び出し元 (presenter / check) の小改修で済む。文字列形式 `"${source} -> ${target} (${kind})"` は R4 のキー生成・表示で引き続き使う。

**Alternatives considered**:
- *文字列のまま source を split で抽出*: `o.split(" -> ")[0]` で source を取り出し照合。構造化せず最小改修。ただし target に ` -> ` が含まれる異常 ID で壊れる懸念。構造化の方が堅牢。tasks でどちらかを最終選択 (構造化を推奨)。

---

## R6. 遅延評価 (baseline を計算しない条件)

**Decision**: current の scoped issue (drift/orphan/uncovered/testfail のいずれか) が **1 件でもある場合のみ** baseline を算出する。current が全クリーンなら baseline (worktree) を作らず即 exit 0。

**Rationale**:
- baseline は「current issue から pre-existing を引く」ためにある。current issue がゼロなら引く対象が無く、new もゼロ確定。worktree 生成コストを丸ごと省ける (SC-005)。
- 純粋リファクタ (spec/タグ非変更) では current の scoped issue は pre-existing のみ非空になりうるので、この最適化は「本当に問題ゼロのケース」で効く。pre-existing がある場合は baseline を作って引く必要がある。

**注意**: 「current issue 非空」の判定は scoped issue 全体 (pre-existing 含む) で行う。pre-existing だけが非空のケースでも baseline を計算して引く必要があるため。「current が完全にゼロ」の場合だけスキップする。

---

## R7. baseline 構築不能時のエラー終了 (Clarify 済み)

**Decision**: baseline を構築できない異常系 (非 git リポジトリ / `git worktree add` 失敗 / scan 失敗) では、`--gate` 指定時に専用 exit code **1** と明示メッセージで終了する。縮退した別判定は行わない。`--gate` なし (表示のみ) の場合は警告を出して current issue を全表示し exit 0 (new マークは付かない)。

**Rationale**:
- Clarify (2026-07-07) で確定。判定不能の黙殺は Constitution 原則 I 違反。専用 exit code でゲート合否 (0/2) と区別し、CI が検知できる。
- 縮退判定 (直接 claim のみ等) は稀な異常系のために別ロジックを常時維持することになり過剰。シンプルさを優先。
- **HEAD 無しの初回コミット前は異常系ではない**: baseline を「空集合」として扱い、current の全 issue を new とする (FR-014)。`git worktree add HEAD` が失敗する前に「HEAD が解決するか」を先に判定して分岐する。

**Alternatives considered**: 縮退モード / fail-closed / fail-open はいずれも Clarify で却下 (spec Clarifications 参照)。

---

## R8. CheckResult 拡張と JSON 後方互換

**Decision**: `CheckResult` に新フィールドを **追加のみ** で拡張する。既存フィールド (`drifted` / `orphans` / `uncovered` / `coverage` / `testFailures`) は「scoped 全 issue」を従来どおり保持。`pass` の **意味だけ** を「new issue がゼロか」に変更する。追加フィールド: `newIssues` (new のサブセット) / `suppressedCount` (pre-existing 抑制数) / `baselineStatus` (`computed`|`empty`|`skipped`|`unavailable`)。JSON 消費者は issue が `newIssues` に含まれるかで新規判定 (FR-009)。

**Rationale**:
- 既存フィールドを壊さないので、`artgraph-verify` Skill (`check --diff --format json` を消費) の既存パースは動き続ける。
- `pass` の意味変更は意図的でありゲートの正しい定義 (原則 III)。ただし「pass=true でも `orphans` 配列は pre-existing で非空になりうる」ので、Skill 側ドキュメント (`templates/skills/artgraph-verify/SKILL.md` と 5 agent 複製 + `_shared/output-schema.md`) の解釈更新をタスクに含める。
- `newIssues` サブセット方式は、各要素に `isNew` boolean を埋めるより既存 `string[]` 型を壊さず追加でき、後方互換に優れる。

**Alternatives considered**:
- *各 issue 要素を `{ value, isNew }` に構造化*: `orphans: string[]` → `orphans: {value,isNew}[]` は破壊的変更で Skill パースを壊す。却下。

---

## まとめ: 未解決の NEEDS CLARIFICATION

なし。spec の Clarify (R7) と本 research (R1–R8) で全論点を解決済み。実装細部 (worktree 後始末の try/finally、orphan の構造化 vs split、tmpdir 命名) は tasks フェーズで確定する範囲。
