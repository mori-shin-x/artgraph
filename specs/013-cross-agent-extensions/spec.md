# Feature Specification: Cross-Agent Extensions — Tier 1 多エージェント Skills + AGENTS.md canonical 配布

**Feature Branch**: `feat/cross-agent-extensions`

**Created**: 2026-06-29

**Status**: Draft

**Input**: User description: "issue #101 を受けた spec 013-cross-agent-extensions。Claude Code 専用だった artgraph の Skills / agent-context 配布を、5 エージェント (Claude Code / Codex CLI / Cursor / GitHub Copilot / Kiro) の Tier 1 として横展開する。"

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Tier 1 エージェント単独で artgraph をネイティブ利用 (Priority: P1)

Tier 1 として指定された 5 エージェント (Claude Code / Codex CLI / Cursor / GitHub Copilot / Kiro) のいずれかを主軸に使う開発者が、自分のエージェントから artgraph の Skills (artgraph-impact / artgraph-verify など) を description-triggered で呼び出せる状態を、1 コマンドで構築できる。

**Why this priority**: 「仕様↔ドキュメント↔コード↔テストのトレーサビリティ」という artgraph の射程を、Tier 1 5 エージェントすべてに同一品質で届ける。これが本 spec の中核価値で、MVP として独立で成立する。

**Independent Test (2 階建て)**:

- **A. 配布契約 (artgraph CI で自動検証)**: 任意の Tier 1 エージェント値で `artgraph init --agents=<one>` を実行し、(1) 対応する canonical Skills パスに SKILL.md 群がバイト一致で配置される、(2) frontmatter (`name` / `description`) が各エージェント公式 docs の仕様を満たす、(3) `templates/skills/_shared/` は配布されない、を検証する。
- **B. 実機 smoke (人手、quickstart で 1 エージェント以上)**: 対象エージェントを実環境で起動し、description-trigger により artgraph Skill が発見・実行されることを確認する。artgraph リポジトリ内では Claude Code を基準エージェントとしてドッグフーディングで担保し、他 4 エージェントは quickstart に手順を文書化して受け入れテスト化する。

**Acceptance Scenarios**:

**A. 配布契約 (CI で機械的に検証):**

1. **Given** Tier 1 エージェント識別子 1 つ (例: `codex`)、**When** `artgraph init --agents=codex` を実行、**Then** Codex CLI が解釈する canonical Skills パス (`.agents/skills/<name>/SKILL.md`) に全 Skill が配置され、各 SKILL.md は `templates/skills/<name>/SKILL.md` とバイト一致する。
2. **Given** `--agents=cursor`、**When** init 実行、**Then** `.cursor/skills/<name>/SKILL.md` 配下に同様にバイト一致で配置される。
3. **Given** `--agents=copilot`、**When** init 実行、**Then** `.github/skills/<name>/SKILL.md` 配下に同様に配置される。
4. **Given** `--agents=kiro`、**When** init 実行、**Then** `.kiro/skills/<name>/SKILL.md` 配下に同様に配置される (`.kiro/steering/` への配布は別フラグの責務)。
5. **Given** `--agents=claude`、**When** init 実行、**Then** `.claude/skills/<name>/SKILL.md` 配下に同様に配置される。
6. **Given** `templates/skills/_shared/` 配下にファイルが存在 (各 SKILL.md が `../_shared/...` で参照)、**When** いずれかの `--agents` で init 実行、**Then** 配布先にも `<agent_skills_path>/_shared/` がバイト一致で配置され、SKILL.md からの相対参照が解決可能になる。

**B. 実機 smoke (人手、quickstart 手順として記述):**

7. **Given** Claude Code 環境 + artgraph リポジトリで `--agents=claude` を実行 (基準エージェント、CI 相当の自動化が可能)、**When** Claude Code を起動して artgraph-impact 等の description が一致するプロンプトを与える、**Then** description-trigger により対応 Skill が選択・実行される。
8. **Given** Codex CLI / Cursor / GitHub Copilot / Kiro のいずれか実環境を持つレビュアー、**When** quickstart 手順に従って `artgraph init --agents=<one>` 実行後にエージェントを起動、**Then** Skill が発見され、quickstart に記載された期待動作と一致することを確認できる (受け入れテスト相当)。

---

### User Story 2 — 単一プロジェクト内の複数 Tier 1 エージェント並走 (Priority: P2)

同一プロジェクトに複数の Tier 1 エージェント (例: Claude Code + Cursor、Claude Code + Codex CLI + Kiro) を同居させているチームが、**1 つの canonical な SKILL.md 群を真実として保ち、複数エージェントの正規パスへ同期配布できる**。エージェントごとに SKILL.md を手で複製・編集する運用は不要にする。

**Why this priority**: チーム内で複数エージェント混在は実際に多く、canonical 化を最初から組み込まないと各配布先で drift し保守不能になる。US1 を実装すれば「複数 agent を `--agents` に列挙すれば各正規パスに配布される」が自然に成立するため追加コストは小さい。ただし MVP は US1 単独で成立するため P2。

**Independent Test**: `artgraph init --agents=claude,codex,cursor` を実行し、3 エージェントの正規 Skills パスにバイト一致する SKILL.md 群が配置されることを確認する。canonical 元 (`templates/skills/`) を 1 箇所書き換えて `--force` で再実行すると、3 配布先すべてに同じ変更が反映される。

**Acceptance Scenarios**:

1. **Given** Claude Code + Cursor を併用するプロジェクト、**When** `artgraph init --agents=claude,cursor` を実行、**Then** 両エージェントの canonical Skills パスに同内容の SKILL.md が配置される。
2. **Given** 既に `--agents=claude` で配布済のプロジェクト、**When** `artgraph init --agents=claude,codex --force` を再実行、**Then** Claude 配布は維持され、Codex 配布が新規に追加される。
3. **Given** canonical 元の SKILL.md を編集後、**When** `artgraph init --agents=claude,codex,cursor --force` を再実行、**Then** 3 配布先すべてが最新内容で同期される。

---

### User Story 3 — agent-context の AGENTS.md 一元化と薄ラッパー方式 (Priority: P2)

artgraph セクションを含む agent-context (システムプロンプト相当) を **AGENTS.md に canonical に集約**し、Claude Code 専用の `CLAUDE.md` と GitHub Copilot 専用の `.github/copilot-instructions.md` は `@AGENTS.md` で取り込む薄いラッパーとする。これにより agent-context 本文の二重管理が消える。

**Why this priority**: Tier 1 の 5 エージェントすべてが AGENTS.md をネイティブに自動ロードするため、AGENTS.md 1 本があれば本文流通は実用上完結する。Claude Code 慣習の `CLAUDE.md` や Copilot IDE 慣習の `.github/copilot-instructions.md` との連続性を保つために薄ラッパーは残すが、本文は AGENTS.md に集約することで保守単位を 1 つに削減する。US1 (Skills 配布) と独立に価値があるため P2。

**Independent Test**: `artgraph init --agents=claude,copilot` を実行し (`--no-agent-context` を付けない通常実行)、AGENTS.md に artgraph セクション本文が含まれ、CLAUDE.md と `.github/copilot-instructions.md` には `@AGENTS.md` 取り込みのみが含まれる (本文の二重コピーが無い) ことを diff で確認できる。

**Acceptance Scenarios**:

1. **Given** プロジェクトに AGENTS.md / CLAUDE.md / `.github/copilot-instructions.md` がいずれも無い状態、**When** `artgraph init --agents=claude,copilot` を実行、**Then** AGENTS.md に artgraph セクション本文が書き込まれ、CLAUDE.md と `.github/copilot-instructions.md` には `@AGENTS.md` 参照のみのラッパーが生成される。
2. **Given** ユーザー作成コンテンツを含む既存 CLAUDE.md が存在、**When** `artgraph init --agents=claude` を実行、**Then** 既存コンテンツは保持され、artgraph 用ラッパーブロックがマーカー境界付きで追記される (= 再実行で重複追記されない)。
3. **Given** Codex CLI / Cursor / Kiro のみを使うプロジェクト、**When** `artgraph init --agents=codex,cursor,kiro` を実行、**Then** AGENTS.md のみが書き込まれ、CLAUDE.md / `.github/copilot-instructions.md` は作成されない (= 不要なラッパーは出さない)。

---

### User Story 4 — doctor で配布物の健全性を診断 (Priority: P3)

Tier 1 エージェント向けに配布された Skills および agent-context ラッパーが drift / 欠落していないかを、**1 コマンドで診断できる**。チームで複数人が `--agents` を変更したり、誰かが配布先 SKILL.md を直接編集してしまった場合に後から気付ける手段を提供する。

**Why this priority**: drift しても多くの場合は壊れず動き続けるため即座のブロッカーではない。一方で長期運用での silent drift は artgraph の信頼性を損なうため診断手段は必須。US1/US2/US3 が動けば運用は成立するため P3。

**Independent Test**: `artgraph init --agents=claude,codex` で初期化したプロジェクトで doctor コマンドを実行すると診断項目すべてが PASS になり、配布先 SKILL.md のいずれかを改竄するか CLAUDE.md ラッパー内の `@AGENTS.md` を削除すると診断が FAIL し、どの配布物・どのエージェント向けかが特定できる出力が得られる。

**Acceptance Scenarios**:

1. **Given** 健全に init された Tier 1 プロジェクト、**When** doctor を実行、**Then** すべての配布先について PASS が返り、終了コードは 0。
2. **Given** 配布先 SKILL.md の本文が canonical 元と乖離した状態、**When** doctor を実行、**Then** 当該ファイルパスと「canonical との drift」が報告され、終了コードは非 0。
3. **Given** CLAUDE.md ラッパーから `@AGENTS.md` 行が削除された状態、**When** doctor を実行、**Then** 「ラッパー → canonical 参照が壊れている」旨が報告される。
4. **Given** プロジェクトに Tier 1 配布が 1 件も無い、**When** doctor を実行、**Then** 「Tier 1 配布対象 0 件」を明示し終了コード 0 を返す (診断するものが無いことは異常ではない)。

---

### Edge Cases

- **`--agents` 未指定で Skills/agent-context stage が走る場合**: `artgraph init` を引数なしで実行した場合 (= 既定で Skills + agent-context stage が走る経路)、`--agents` 必須エラーを返し、サポート値一覧 (`claude / codex / cursor / copilot / kiro`) と対処例 (`--agents=claude` を付ける / または `--no-skills --no-agent-context` で当該 stage を off にする / または `--minimal` を付ける) を提示する。
- **未知のエージェント値**: `--agents=windsurf` のように Tier 1 に含まれない値が渡された場合は明確なエラーで終了し、サポート対象一覧を提示する。空文字列、末尾カンマ、大文字小文字、重複 (`claude,claude`) も明示的に扱う。
- **`--minimal` + `--agents` 併用**: `--minimal` は全 stage を OFF にするため、`--agents` 指定があっても Skills / agent-context 配布は走らない。組合せは黙ってスキップでなく、警告で「`--minimal` により `--agents` 指定は無視される」と明示する。
- **`--no-skills` かつ `--no-agent-context` 指定**: 配布対象 stage が両方 off の場合、`--agents` 指定は不要 (指定があれば「対象 stage off につき無視」と警告)。
- **配布先と canonical の競合**: 配布先 (例: `.cursor/skills/artgraph-impact/SKILL.md`) を手動編集した後に `--force` 無しで再 init した場合、上書きせずに警告。`--force` で強制上書き。
- **既存 AGENTS.md / CLAUDE.md / `.github/copilot-instructions.md` の保護**: ユーザー作成セクションは保持し、artgraph 管理範囲はマーカー (例: `<!-- artgraph:begin -->` 〜 `<!-- artgraph:end -->`) 境界で識別、再実行で冪等。
- **Kiro: Skills と steering の同時呼出し**: `--agents=kiro --integrations=kiro` で Skills (`.kiro/skills/`) と steering (`.kiro/steering/artgraph.md`) を同 init で両方配布できる。両者は責務分離され、片方だけの指定も可能。
- **GitHub Copilot 3 surface (IDE / CLI / Coding Agent) 並走**: `.github/skills/` と `.github/copilot-instructions.md` で 3 surface すべてを同時にカバーするため、surface 別配布は行わない。
- **doctor 実行前に init 未実施**: Tier 1 配布が 1 件も無い場合は「対象 0 件」と明示し終了コード 0 (異常扱いしない)。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `artgraph init` は `--agents=<list>` オプションを受け付け、値は `claude` / `codex` / `cursor` / `copilot` / `kiro` のカンマ区切り集合のみを許容する。未知の値・空要素・大文字小文字違い・重複が含まれる場合は配布を行わず、サポート値一覧を含むエラーで非 0 終了する。
- **FR-002**: `--agents=<list>` は、Skills 配布または agent-context 配布のいずれか少なくとも 1 stage が有効な経路で必須とする。未指定の場合は実行前バリデーションで非 0 終了し、エラーメッセージは (a) `--agents=<list>` を指定する、(b) `--no-skills --no-agent-context` で当該 stage を off にする、(c) `--minimal` で全 stage を off にする、の 3 つの対処法を提示する。プロジェクト内ファイル走査による自動推定は行わない。
- **FR-003**: `artgraph init --agents=<list>` (Skills stage 有効時) は、`templates/skills/` を canonical source として、各エージェントの正規 Skills パス (Claude: `.claude/skills/`、Codex: `.agents/skills/`、Cursor: `.cursor/skills/`、Copilot: `.github/skills/`、Kiro: `.kiro/skills/`) へ SKILL.md ファイル群をバイト一致で配置する。frontmatter (`name` / `description`) と本文は全エージェント間で完全に共通とする。
- **FR-004**: `templates/skills/_shared/` 配下のファイル (DRY 用の install-check / output-schema / package-manager 等の部品) は、各 SKILL.md から `../_shared/<file>.md` 形式で相対参照されるため、SKILL.md と同じ配布先に**同じディレクトリ構造を保ったまま**配布する。`_shared/` 自体は SKILL.md を持たない部品ディレクトリであり、各エージェントの description-trigger 対象 (Skill エントリ) には認識されない (Skill 認識は `<name>/SKILL.md` の存在を要件とする慣習を前提)。
- **FR-005**: `artgraph init --agents=<list>` (agent-context stage 有効時) は AGENTS.md を canonical な agent-context として書き出す。AGENTS.md の artgraph セクションは artgraph 管理マーカー境界付きで冪等更新可能とし、マーカー外のユーザー作成コンテンツは保持する。
- **FR-006**: `--agents=<list>` に `claude` が含まれかつ agent-context stage が有効な場合、`CLAUDE.md` を生成または更新し、artgraph セクションとして `@AGENTS.md` 取り込み参照のみを含む薄ラッパーとする。本文の二重コピーを行わない。
- **FR-007**: `--agents=<list>` に `copilot` が含まれかつ agent-context stage が有効な場合、`.github/copilot-instructions.md` を生成または更新し、artgraph セクションとして `@AGENTS.md` 取り込み参照のみを含む薄ラッパーとする。
- **FR-008**: `--agents=<list>` に `kiro` が含まれる場合、Skills stage は `.kiro/skills/` への配布のみを担当する。`.kiro/steering/artgraph.md` への配布は従来通り SDD 統合 stage (`--integrations=<...,kiro,...>` または `--integrate` boolean による auto-integrate) の責務として独立に動作し、同一 `init` コマンドで併用可能。
- **FR-009**: 再実行 (`init --agents=<list>` を 2 回以上) は冪等とする。配布先ファイルが既存かつ canonical と一致する場合は no-op、artgraph 管理マーカー境界内のラッパーは上書き、それ以外のユーザー作成ファイルは `--force` なしでは保護し警告のみ出す。
- **FR-010**: `--force` 指定時は配布先 SKILL.md とラッパーファイルの artgraph 管理範囲を強制的に canonical に揃える。`--force` でもユーザー管理範囲 (マーカー外) は保護する。
- **FR-011**: Tier 1 配布物の健全性を診断する単一のコマンドを提供する。診断項目は (a) 各 `--agents` 配布先 SKILL.md および `_shared/` 部品の存在と canonical 元との一致、(b) AGENTS.md の artgraph セクションマーカー整合、(c) CLAUDE.md / `.github/copilot-instructions.md` ラッパーの `@AGENTS.md` 参照存在、(d) canonical top-level dir (例: `artgraph-impact/`, `_shared/`) 配下に canonical に無いファイル/ディレクトリが混入していないこと (例: 古いバージョンの残骸)。配布パス (`<agent_skills_path>/`) 直下にある **非 artgraph 由来の dir** (例: `speckit-*/` のような他ツール Skills) は doctor の対象外とし、警告も出さない (= artgraph が自分で書いた範囲だけを診断する)。診断結果は機械可読 (`--format json`) と人間可読 (デフォルト) の両方で出力可能。CLI surface (新規サブコマンド `artgraph doctor` か既存 `artgraph check` のサブフラグか) は plan 段階で決定する。
- **FR-012**: 上記診断コマンドは drift / 欠落 / 不整合を 1 件でも検出した場合は非 0 終了する。本 spec では当該診断を `artgraph check --gate` (PR ゲート) には組み込まない (= ゲート挙動を spec 013 では変更しない)。ゲート組込みの要否は別 spec で評価する。
- **FR-013**: `--agents` は既存フラグ群 (`--minimal` / `--no-skills` / `--no-agent-context` / `--no-integrate` / `--no-hooks` / `--no-scan` / `--integrations=<list>` / `--integrate-gate` / `--force` / `--format`) と直交する。組合せルール: (a) `--minimal` は最強で全 stage を OFF にし `--agents` 指定があっても無視 (警告)、(b) `--no-skills` かつ `--no-agent-context` の併用時は配布対象 stage が両方無効なため `--agents` 不要、(c) `--no-skills` 単独時は agent-context stage が走るため `--agents` 必須、(d) `--no-agent-context` 単独時は Skills stage が走るため `--agents` 必須、(e) `--integrations` は SDD ツール統合の責務であり Skills / agent-context 配布とは独立に動作する。
- **FR-014**: MCP サーバの起動・登録・設定生成は本 spec では一切行わない。`.claude-plugin/marketplace.json` 等のプラグイン配布マニフェスト生成も行わない。Claude Code 以外のエージェント向け hooks (Codex `.codex/hooks.json`、Cursor `.cursor/hooks.json`、Kiro agent hooks 等) の配布も行わない。

### Key Entities

- **Tier 1 Agent**: artgraph がネイティブに配布対象とする 5 エージェント。識別子 (`claude` / `codex` / `cursor` / `copilot` / `kiro`)、canonical Skills パス、agent-context ロード形式 (AGENTS.md ネイティブ / 追加ラッパー要否)、を属性に持つ。
- **Canonical Skill Source**: `templates/skills/<name>/SKILL.md` の集合。`templates/skills/_shared/` は配布対象外。1 つの真実として保持され、Tier 1 Agent の Skills 配布先にバイト一致でコピーされる。
- **Canonical Agent-Context (AGENTS.md)**: artgraph の利用ガイド本文を 1 箇所に集約したファイル。マーカー境界付きセクションを持ち、再実行で冪等更新可能。
- **Agent-Context Wrapper**: `CLAUDE.md` / `.github/copilot-instructions.md` のように、エージェント慣習や IDE 都合で残す表紙ファイル。artgraph 管理範囲は `@AGENTS.md` 参照のみで本文を持たない。
- **Distribution Health Check**: Tier 1 配布物 (SKILL.md 群、AGENTS.md セクション、ラッパー) の PASS/FAIL マトリクス。drift / 欠落 / 不整合 / `_shared/` 混入を判定単位とする。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Tier 1 5 エージェントいずれのユーザーも、artgraph をインストール後に `artgraph init --agents=<one>` を 1 コマンド実行するだけで、対応する canonical Skills パスに正しい frontmatter / 本文の SKILL.md 群がバイト一致で配置される (配布契約の充足、CI 自動検証)。
- **SC-002**: 同一プロジェクトに複数の Tier 1 エージェントを併用するユーザーが、`--agents=<list>` に複数指定するだけで各エージェント正規 Skills パスへ**バイト一致の SKILL.md 群と `_shared/` 部品群**が配布される (`diff -r` で差分ゼロ、各 `<agent_skills_path>/` 内のサブツリー構造も完全一致)。
- **SC-003**: AGENTS.md と CLAUDE.md / `.github/copilot-instructions.md` を併用するプロジェクトで、artgraph セクション本文の重複コピーがゼロ (本文は AGENTS.md 1 箇所のみ、他は `@AGENTS.md` 参照のみ)。
- **SC-004**: `artgraph init --agents=<list>` を 2 回以上連続実行しても、配布先ファイルの内容に変化が無く (完全冪等)、`--force` 指定時のみ canonical 変更が配布先に反映される。
- **SC-005**: 健全診断コマンドは、健全な初期化直後のプロジェクトで PASS、配布先 SKILL.md を 1 文字でも改竄した場合に FAIL を返し、どの配布先・どのエージェント向けかをファイルパス単位で特定できる出力を返す。
- **SC-006**: `--agents` を必要とする経路で未指定の場合、ユーザーは**エラーメッセージのみから 3 つの対処法 (`--agents=<list>` 指定 / `--no-skills --no-agent-context` で当該 stage off / `--minimal` で全 stage off) を理解できる** (人間レビューで verbatim 確認)。
- **SC-007**: 本 spec は MCP サーバ実装・Plugin marketplace 配布・非 Claude エージェント向け hooks を一切含まない。実装 PR に該当ファイル/コードが含まれないことをレビュー時に明示確認できる。
- **SC-008**: artgraph リポジトリ自身に `artgraph init --agents=claude,codex,cursor,copilot,kiro` を適用 (ドッグフーディング) し、5 配布先すべてに正しく SKILL.md が配置されていることが、`artgraph` リポジトリの CI または PR 提出時のチェックで確認できる。

## Assumptions

- **Tier 1 エージェントの canonical Skills パスは固定**: Claude `.claude/skills/`、Codex `.agents/skills/`、Cursor `.cursor/skills/`、Copilot `.github/skills/`、Kiro `.kiro/skills/`。各エージェント公式 docs の 2026-06 時点の仕様に基づく (本 spec 着手前の調査で確認済)。
- **5 エージェントすべてが AGENTS.md をネイティブ自動ロードする**: Claude Code (custom-instructions auto-detect)、Codex CLI (原典)、Cursor (公式対応)、GitHub Copilot (2025-08 から coding agent 対応、IDE も同様)、Kiro (custom agent が default resources として継承)。よって AGENTS.md 1 本で本文流通は実用上完結する。
- **GitHub Copilot は 3 surface (IDE / CLI / Coding Agent) で `.github/skills/` と `.github/copilot-instructions.md` を共有する**: surface 別配布は不要。
- **`templates/skills/<name>/SKILL.md` は 5 エージェントで共通に成立する内容**: 既に Anthropic Skills フォーマット (`name` + `description` frontmatter) が Codex / Cursor / Copilot / Kiro でも採用されているため、本文・frontmatter の改造は不要。
- **`templates/skills/_shared/` の扱い**: DRY 用の install-check / output-schema / package-manager 等の部品を保持するディレクトリ。各 SKILL.md から `../_shared/<file>.md` で参照されるため、配布対象に**含める** (FR-004)。Skill 認識は `<name>/SKILL.md` 存在を要件とする各エージェント慣習により、`_shared/` 自体は description-trigger 対象として誤認識されない。
- **agent-context 注入機構は本 spec で新規実装する**: spec 012 P1 で計画されていた `--with-agent-context` は現状未実装 (cli.ts:120,152 で "P1 deliverable, no effect yet" の WARNING 付き)。本 spec が AGENTS.md / CLAUDE.md / `.github/copilot-instructions.md` の注入を最初に実装する。
- **既存の SDD ツール統合 (Kiro `.kiro/steering/`、Spec Kit `.specify/extensions/artgraph/`) は別責務として残存**: `--integrations=<...>` および `--integrate` boolean フラグで管理される既存 stage は本 spec で改変しない。`.kiro/skills/` への配布は新規 stage として追加する。
- **package manager 非依存基盤 (spec 015, 7cb0fd7 マージ済) の上に乗る**: 配布ロジックは PM 検出に依存する範囲では既存基盤を利用する。
- **`@AGENTS.md` 取り込み記法**: Claude Code は `@file` 取り込みをネイティブにサポート。GitHub Copilot の `.github/copilot-instructions.md` は通常テキストとして読まれるため `@AGENTS.md` 行は agent 側で自動解決されなくても、AGENTS.md は別途自動ロードされるため実害は無い (本文流通は保証される)。
- **doctor の CLI surface 選択**: 新規サブコマンド `artgraph doctor` か既存 `artgraph check --agents-doctor` のサブフラグかは plan 段階で決定する (既存 `check` のフラグ群が複雑化しているため新サブコマンド寄り)。
- **未リリースのため後方互換は意識しない**: 既存挙動 (`init` 引数なしで Skills が `.claude/skills/` に走る) は本 spec で破壊的に変更し、`--agents` 必須化を採用する。
- **未知エージェント追加要件は別 spec**: Tier 2 以降 (Cline / Windsurf / Gemini CLI / Goose / Junie / Tabnine / Aider 等) は本 spec のスコープ外。需要が顕在化したら独立 spec を起こす。
- **Windsurf Cascade EOL (2026-07-01) は本 spec 着手後に到来**: 初版から除外する判断と整合。
- **artgraph リポジトリ内の実機検証は Claude Code を基準エージェントとする**: 私 (= 本 spec 実装者) は Claude Code 環境を持つため、ドッグフーディング (SC-008) は Claude Code で実施。他 4 エージェントは quickstart 手順整備による受け入れテスト化に委ねる。
