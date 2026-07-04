# Phase 0 Research — Cross-Agent Extensions

**Date**: 2026-06-29 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

未解決の "NEEDS CLARIFICATION" は spec 側で 0 件。本 research は plan 段階で設計判断を要する 6 項目を整理する。

---

## R1. `templates/skills/_shared/` の配布扱い (spec FR-004 訂正の根拠)

**Decision**: `_shared/` は SKILL.md と同じ親 (`<agent_skills_path>/`) に同じディレクトリ構造を保ったまま配布する。

**Rationale**:
- `templates/skills/artgraph-impact/SKILL.md` (line 36, 38, 86 ほか) が `../_shared/install-check.md` / `../_shared/package-manager.md` / `../_shared/output-schema.md` を相対参照しており、配布先で `_shared/` が無いと参照が解決できない。
- 各エージェントの Skill 認識は `<name>/SKILL.md` の存在を要件とする (Claude Code / Codex / Cursor / Copilot / Kiro 公式 docs)。`_shared/` 内には SKILL.md が無いため、description-trigger 対象として誤認識されることはない。
- 既存実装 (`src/init.ts:130-167` `readSkillTemplates`) は既に `_shared/` を含む全 top-level ディレクトリを `templates` に push し、`topLevel !== "_shared"` の場合のみ SKILL.md 存在検証を行う。つまり既に「`_shared/` は SKILL.md なしで配布対象」運用が確立している。

**Alternatives considered**:
- 配布から除外し、SKILL.md 内の `../_shared/...` 参照を inline 展開: 部品の DRY が失われ、`_shared/` の意味が消える。却下。
- `_shared/` 内容を各 SKILL.md 末尾に append: SKILL.md が肥大化し description-trigger の精度を損なう。却下。

**Impact**: spec FR-004 / SC-002 / Edge Cases / US1 Acceptance A-6 / Assumptions の `_shared/` 記述をすべて「配布対象に含める」方向で訂正済 (2026-06-29 plan 着手時)。

---

## R2. AGENTS.md / CLAUDE.md / `.github/copilot-instructions.md` のマーカー境界形式

**Decision**: HTML コメント形式 `<!-- artgraph:begin -->` / `<!-- artgraph:end -->` を採用。

**Rationale**:
- Markdown はコメント構文を持たないが HTML コメントは GFM / CommonMark でも非レンダリングのため、ユーザーには見えない安全な境界化が可能 (spec 012 research §3 で確認済)。
- Spec Kit 自身が `<!-- SPECKIT START -->` / `<!-- SPECKIT END -->` で同パターンを採用しており、リポジトリ内の慣習衝突なし。
- artgraph 固有プレフィックスを `artgraph:begin` / `artgraph:end` とすることで、Spec Kit マーカーとの誤検出を回避。

**Alternatives considered**:
- フロントマター YAML を再利用: ユーザー作成 Markdown は frontmatter を持たない or 持っていても他用途で利用しているケースが多い。汎用性に欠ける。却下。
- Markdown 見出し `## artgraph` を境界化: ユーザーが見出しレベルを変えると壊れる、また閉じ位置の表現が難しい。却下。

**Implementation note**: マーカー block の中身は冪等更新時に **block ごと一括差し替え**する。マーカー外のユーザーコンテンツは絶対に触らない (FR-009 / FR-010)。

---

## R3. drift 検出: バイト一致 vs sha256

**Decision**: sha256 比較を採用。canonical 元のハッシュ表をビルド時 (またはランタイム計算) で生成し、配布先と照合。

**Rationale**:
- 配布契約は「canonical 元とのバイト一致」(FR-003) なので、検証手段は同等以上の精度が必要。
- sha256 はバイト一致と数学的に等価 (衝突確率 = 0 と扱える) かつ、Node 標準 `node:crypto` で追加依存なし。
- バイト直接比較も可能だが、配布先 ~50 ファイル × sha256 計算 ~1µs/file = 1ms 未満で、差はない。sha256 の利点は doctor 出力に「期待ハッシュ vs 実ハッシュ」を載せられること (デバッグ容易性)。

**Alternatives considered**:
- 単純な mtime / size 比較: ファイル内容が変わらなくても mtime は変わる (git checkout 等)。誤検出を生む。却下。
- diff ベース比較: 1 ファイルが変わったときに diff を表示できる利点はあるが、doctor の責務は drift 検出 (存在 / 一致) であり、diff の生成は別ツール (`diff -r` / `git diff`) に任せる方が責務が綺麗。却下。

**Implementation note**:
- canonical 側のハッシュ表は init 実行時に `templates/skills/` を再帰 walk して計算 (ランタイム生成)。ビルド時固定化は不要 (templates が dist 配下にバンドルされており、書き換わらない前提)。
- doctor は配布先を同じ walk ロジックで巡回し、各ファイルを sha256 比較。

---

## R4. doctor の CLI surface: 新サブコマンド vs `check` フラグ

**Decision**: 新サブコマンド `artgraph doctor` を採用 (既存 `check` のサブフラグにはしない)。

**Rationale**:
- 既存 `artgraph check` は `--gate` / `--diff` / `--format` を持ち、graph の **構造整合** (drift / orphan / uncovered) を見るコマンドとして責務が確立している。
- 配布物 health は graph 整合と概念的に独立し、(a) 入力 (templates/ + 配布先 vs `.artgraph.json` + `.trace.lock`)、(b) 出力 (配布 PASS/FAIL vs graph 不整合の列挙)、(c) 失敗時の対処 (`artgraph init --force` vs spec/コード修正) がすべて違う。
- 新サブコマンドにすることで、`artgraph doctor --format json` のように既存パターン (commander option) を再利用しつつ、`check` のフラグ表面が単純化される。
- `cc-sdd` や Spec Kit など他ツールも `doctor` 名の独立コマンドを持つ慣習があり、ユーザー期待と整合。

**Alternatives considered**:
- `artgraph check --agents-doctor`: フラグが既存と重なって意味が拡散。例えば `check --gate --agents-doctor` の組合せ意味が不明瞭になる。却下。
- 既存 `artgraph integrate list` のように `artgraph agents <subcommand>`: 将来 `artgraph agents add` 等の拡張余地が魅力的だが、現状は doctor だけのため YAGNI。サブコマンド階層化は Tier 2 拡張時に再検討。却下。

**Implementation note**:
- フラグ: `artgraph doctor [--format text|json] [--agents=<list>]`。`--agents` 省略時は配布検出されたエージェントすべてを診断。`--format` は既存 CLI コマンドの慣習に従う。
- 終了コード: PASS = 0、FAIL (drift / 欠落 / 不整合 1 件以上) = 非 0 (FR-012)。
- gate 統合は本 spec ではしない (FR-012)。

---

## R5. Codex CLI `.agents/skills/` の precedence と repo root 配置

**Decision**: repo root の `.agents/skills/` への配布で十分。多層ディレクトリ配布は行わない。

**Rationale**:
- Codex 公式 docs (developers.openai.com/codex/skills) によれば、Codex は `$CWD/.agents/skills` から `$REPO_ROOT/.agents/skills` まで上向きに走査し、`$HOME/.agents/skills` → `/etc/codex/skills` の順で発見する。
- repo root に置けばリポジトリ内のどの CWD から Codex を起動しても発見される。サブディレクトリ配布は不要 (むしろ重複・drift リスク)。
- 既存 Claude `.claude/skills/` の慣習 (repo root 配置) と一致するため、Tier 1 5 エージェント共通で「repo root 配置」モデルが成立。

**Alternatives considered**:
- サブディレクトリ別配布 (`packages/*/.agents/skills/` 等): monorepo で各 package 単位に Skill を局所化する手段だが、(a) 本リポジトリは単一パッケージ (constitution §技術基盤と制約)、(b) Tier 1 他エージェントは多層配置を Codex ほどネイティブにサポートしない、ため YAGNI。却下。

---

## R6. `@AGENTS.md` 取り込み記法の各エージェント挙動

**Decision**: `@AGENTS.md` をラッパー内に literal text として書き込む。エージェント側が `@` 記法を解決しなくても AGENTS.md は別経路で自動ロードされるため、実害なし。

**Rationale**:
- Claude Code は `@<file>` 記法をネイティブ解決し、その場で AGENTS.md 本文を context に展開する (公式 Claude Code docs)。
- GitHub Copilot の `.github/copilot-instructions.md` は plain text として読まれる。`@AGENTS.md` 行は agent 側で解決されないが、Copilot Coding Agent / IDE / CLI のいずれも AGENTS.md を独立に auto-load するため、本文流通は保証される (本 spec Assumptions)。
- ラッパー内に literal `@AGENTS.md` を書く副次効果として、人間レビュアーが「ここで AGENTS.md を参照しています」と即座に理解できる (可読性)。

**Alternatives considered**:
- ラッパーに AGENTS.md 本文を inline コピー: spec US3 / FR-005 / FR-006 / SC-003 で「本文の二重コピーゼロ」を要件としているため不可。却下。
- Copilot 用ラッパーだけ AGENTS.md 本文を inline、Claude 用は `@` 記法: 一貫性が崩れ、保守単位が増える。却下。

**Implementation note**:
- ラッパーファイルの artgraph 管理ブロックは以下の形式:
  ```markdown
  <!-- artgraph:begin -->
  ## artgraph

  See [AGENTS.md](./AGENTS.md) for cross-agent artgraph instructions.

  @AGENTS.md
  <!-- artgraph:end -->
  ```
- `@AGENTS.md` 単独行と、人間向けの `[AGENTS.md](./AGENTS.md)` リンクを併記することで、どちらのエージェント解釈系でも fallback できる。

---

## まとめ

| ID | 主題 | 決定 | spec への反映 |
|----|------|------|----------------|
| R1 | `_shared/` 配布 | 配布対象に含める | spec FR-004 / SC-002 / Edge Cases / Assumptions 訂正済 |
| R2 | マーカー境界形式 | `<!-- artgraph:begin/end -->` | spec Edge Cases に既に方向性記載、本 research で確定 |
| R3 | drift 検出方式 | sha256 比較 | spec FR-011 で「canonical 元との一致」とのみ書かれ、本 research で実装方式確定 |
| R4 | doctor CLI surface | 新サブコマンド `artgraph doctor` | spec FR-011 / Assumptions の "plan 段階で決定" を本 research で確定 |
| R5 | Codex `.agents/skills/` 配置 | repo root のみ | spec Assumptions と整合、追加注記不要 |
| R6 | `@AGENTS.md` 記法 | literal text + `[AGENTS.md](./AGENTS.md)` 併記 | spec Assumptions と整合、本 research でラッパー雛形確定 |

すべての NEEDS CLARIFICATION 相当論点は解決済。Phase 1 (data-model / contracts / quickstart) に進める。
