# Contract: Agent-Context File Format

**Date**: 2026-06-29 | **Spec**: [../spec.md](../spec.md)

AGENTS.md (canonical) と CLAUDE.md / `.github/copilot-instructions.md` (wrapper) に挿入する artgraph 管理 block の確定形式。

---

## マーカー境界 (R2 で決定)

```text
<!-- artgraph:begin -->
... artgraph 管理コンテンツ (block 全体は冪等差し替え対象) ...
<!-- artgraph:end -->
```

- HTML コメント形式: GFM / CommonMark 双方で非レンダリング、ユーザーには見えない安全な境界。
- artgraph 固有プレフィックス `artgraph:` で Spec Kit (`SPECKIT START/END`) との誤検出を回避。
- block 内コンテンツは init 実行のたびに **block 全体を差し替え**。block 外のユーザーコンテンツは絶対に触らない (FR-009 / FR-010)。

---

## AGENTS.md (canonical, FR-005)

### 既存 AGENTS.md が無い場合

新規作成:

```markdown
<!-- artgraph:begin -->
## artgraph — Cross-agent traceability

artgraph manages the trace lock and provides 8 Skills for spec ↔ code ↔ test traceability.

### Available Skills

- `artgraph-setup` — install artgraph in this project
- `artgraph-detect` — report artgraph installation state
- `artgraph-integrate` — wire artgraph into Spec Kit / Kiro
- `artgraph-impact` — file/symbol → REQs impact
- `artgraph-plan-coverage` — reverse audit of tasks.md / plan.md
- `artgraph-coverage` — per-REQ coverage status
- `artgraph-verify` — `artgraph check --diff` self-check
- `artgraph-rename` — safe rename / split / merge of REQ IDs

See `<agent_skills_path>/<skill-name>/SKILL.md` for each Skill's full description (where `<agent_skills_path>` is `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.kiro/skills/` depending on your agent).

### Common workflows

- After editing `tasks.md` / `plan.md`: run **artgraph-plan-coverage** to catch implicit REQ impacts.
- Before review: run **artgraph-verify** (`artgraph check --diff`).
- When proposing a code change: invoke **artgraph-impact** with `path:symbol`.

### Quickstart

\`\`\`bash
artgraph init --agents=<list>          # provision Skills + agent-context
artgraph doctor                        # diagnose distribution health
\`\`\`

For full CLI reference, run `artgraph --help` or see https://github.com/ShintaroMorimoto/artgraph.
<!-- artgraph:end -->
```

### 既存 AGENTS.md がある場合

- ファイルを Read。
- マーカー block が**ある**: 差し替え (block 全体を新コンテンツで置換、block 外は保持)。
- マーカー block が**ない**: ファイル末尾に空行 + 新規 block を append。

---

## CLAUDE.md (wrapper for `claude`, FR-006)

### 既存 CLAUDE.md が無い場合

新規作成:

```markdown
<!-- artgraph:begin -->
## artgraph

See [AGENTS.md](./AGENTS.md) for cross-agent artgraph instructions.

@AGENTS.md
<!-- artgraph:end -->
```

- `@AGENTS.md` literal は Claude Code が `@<file>` 取り込み記法でネイティブ解決し、context に AGENTS.md 本文を展開する (R6)。
- `[AGENTS.md](./AGENTS.md)` Markdown リンクは人間レビュアー向けの可読性ヘルパー (二重コピーではない、リンク参照のみ)。

### 既存 CLAUDE.md がある場合

AGENTS.md と同じ規則: マーカー block 差し替え or append。block 外ユーザーコンテンツは保護。

---

## `.github/copilot-instructions.md` (wrapper for `copilot`, FR-007)

### 既存ファイルが無い場合

新規作成 (CLAUDE.md と同形式):

```markdown
<!-- artgraph:begin -->
## artgraph

See [AGENTS.md](../AGENTS.md) for cross-agent artgraph instructions.

@AGENTS.md
<!-- artgraph:end -->
```

- リンクは相対パス `../AGENTS.md` (`.github/copilot-instructions.md` から見た repo root の AGENTS.md)。
- `@AGENTS.md` literal は GitHub Copilot 側で `@` 記法を解決しないため plain text として読まれるが、AGENTS.md は別経路 (GitHub Copilot 2025-08 から native 対応) で auto-load されるため本文流通は保証される (R6)。
- `.github/` ディレクトリが存在しない場合は `mkdir -p` で作成する。

### 既存ファイルがある場合

AGENTS.md と同じ規則: マーカー block 差し替え or append。block 外ユーザーコンテンツは保護。

---

## マーカー block パース仕様

正規表現 (実装側):

```text
/<!--\s*artgraph:begin\s*-->[\s\S]*?<!--\s*artgraph:end\s*-->/
```

- 大文字小文字を区別。
- `begin` と `end` の間に空白許容 (改行は含む)。
- block 内コンテンツは greedy / lazy match で `<!-- artgraph:end -->` の最初の出現まで。
- block が複数ある場合は 1 つ目を採用、残りは doctor で `agents-md-marker-broken` finding として警告 (将来拡張)。
- `begin` のみ / `end` のみが存在する場合は doctor で `agents-md-marker-broken` finding を発行。

---

## ファイル書き込み仕様

1. **Read 既存ファイル** (存在しなければ空文字列扱い)。
2. **マーカー block を find** (上記正規表現)。
3. **block が見つかった** → 新コンテンツで block 全体を replace (block 外は保持)。
4. **block が見つからない** → 既存ファイル末尾 + `\n\n` + 新規 block (新規作成時は末尾 newline のみ)。
5. **Write 結果ファイル**。書き込みは atomic (一時ファイル → rename) を推奨 (init.ts 既存パターン踏襲)。

---

## 出力契約サマリ (SC-003)

- AGENTS.md には **artgraph 利用ガイド本文**を 1 箇所のみに置く。
- CLAUDE.md / `.github/copilot-instructions.md` には **`@AGENTS.md` 参照のみ**を置き、本文は持たない (重複ゼロ)。
- doctor は `wrapper-no-import` finding で literal `@AGENTS.md` の存在を検証し、削除されたら FAIL。
