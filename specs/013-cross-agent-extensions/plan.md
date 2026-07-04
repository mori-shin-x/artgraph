# Implementation Plan: Cross-Agent Extensions — Tier 1 多エージェント Skills + AGENTS.md canonical 配布

**Branch**: `feat/cross-agent-extensions` | **Date**: 2026-06-29 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/013-cross-agent-extensions/spec.md`

## Summary

artgraph の Skills と agent-context (システムプロンプト相当) 配布を、Claude Code 専用から **Tier 1 5 エージェント** (Claude Code / Codex CLI / Cursor / GitHub Copilot / Kiro) へ横展開する。`artgraph init` に **`--agents=<list>` 必須フラグ**を追加し、列挙されたエージェントの canonical Skills パス (`.claude/skills/` / `.agents/skills/` / `.cursor/skills/` / `.github/skills/` / `.kiro/skills/`) へ `templates/skills/` をバイト一致で配布。agent-context は **AGENTS.md を canonical** とし、`CLAUDE.md` と `.github/copilot-instructions.md` は `@AGENTS.md` 取り込みの薄ラッパーとして書く (spec 012 P1 で計画され未実装の agent-context 注入機構を本 spec で新規実装)。配布物の健全性を診断する **`artgraph doctor`** 新サブコマンドも追加 (実装裁量で確定: 既存 `check` のフラグ群が複雑化しているため、Skill 配布 drift と graph drift を別概念として分離)。MCP / Plugin marketplace / 非 Claude hooks は **明示的にスコープ外**。

## Technical Context

**Language/Version**: TypeScript (Node.js >= 20、`"type": "module"` ESM、constitution §技術基盤と制約)

**Primary Dependencies**:
- 既存: `commander` (CLI parsing)、`yaml` (frontmatter)、`unified` + `remark-parse` (Markdown)、Node 標準の `fs`/`path`/`crypto`
- 新規追加なし (sha256 ハッシュは `node:crypto`、ディレクトリ走査は既存 `walkDir` を流用)

**Storage**: ファイルシステムのみ。配布先 (`.claude/skills/` ほか) と AGENTS.md / CLAUDE.md / `.github/copilot-instructions.md` の生成・更新。

**Testing**: vitest (unit / integration / e2e、既存 `tests/init.test.ts` / `tests/skills-templates.test.ts` / `tests/e2e/` を拡張)。各 Tier 1 エージェント配布先について `tests/agents/<agent>.test.ts` または既存 init テストへの追記。

**Target Platform**: Linux / macOS / Windows (Node.js CLI)。配布先パスは POSIX セパレータと `path.join` で正規化。

**Project Type**: CLI tool (`src/` 単一パッケージ、constitution §技術基盤と制約)。配布物 = `dist/` + `templates/`。

**Performance Goals**: `artgraph init --agents=<5 agents>` の所要時間は、5 配布先 × 8 Skill × 数ファイル = 約 50〜80 ファイル copy で **500ms 以内** (既存単一エージェント init が ~100ms の延長線上)。doctor の所要時間は **1s 以内** (sha256 計算が支配的、配布物 ~200 ファイル程度)。

**Constraints**:
- **冪等**: 同じ `--agents=<list>` での再実行は no-op (FR-009)
- **バイト一致保証**: canonical → 配布先で sha256 一致 (FR-003 + FR-011 で診断)
- **既存ユーザー保護**: マーカー外のユーザー作成コンテンツは保持 (FR-009, FR-010)
- **`@AGENTS.md` 取り込み記法のフォールバック**: Copilot は plain text として読むため `@`記法を実行しないが、AGENTS.md が別経路で auto-load されるため実害なし (spec Assumptions)

**Scale/Scope**:
- Tier 1 = 5 エージェント (固定、Tier 2 以降は別 spec)
- 配布対象 Skill = 8 (artgraph-coverage / detect / impact / integrate / plan-coverage / rename / setup / verify) + `_shared/` 部品 3 ファイル
- 配布マトリクス = 5 × (8 + 3) = 55 ファイル/最大
- AGENTS.md セクション = 1 マーカー境界ブロック
- ラッパーファイル = 最大 2 (CLAUDE.md, `.github/copilot-instructions.md`)

## Constitution Check

*GATE: Phase 0 research 前に通過すること。Phase 1 design 後に再評価。*

| 原則 | 関連性 | 評価 |
|------|--------|------|
| **I. 決定的グラフ第一** (NON-NEGOTIABLE) | 配布ロジックの決定性 | ✅ PASS — 配布は canonical → 配布先のバイトコピーのみ。LLM/確率/統計推定を一切含まない。doctor 判定は sha256 比較のみ。 |
| **II. 単一型付き 4 層グラフ** | グラフモデルへの追加なし | ✅ PASS — 本 spec は配布物管理のみ。`req`/`doc`/`symbol`/`test` ノードと各エッジ型を一切変更しない。 |
| **III. Spec が ID を所有、コードが claim する** (NON-NEGOTIABLE) | 要求 ID 運用 | ✅ PASS — 本 spec 自身は `FR-001..FR-014` を発行し、実装側は `@impl FR-NNN` で claim する通常の運用に従う。 |
| **IV. SDD ツール ID 直接利用** | SDD 統合層 | ✅ PASS — Kiro `.kiro/steering/` 配布は既存 `KiroProvider` (spec 009) に委ね、本 spec の `--agents=kiro` は `.kiro/skills/` のみを担当 (FR-008)。Kiro Spec ID 体系には触れない。 |
| **V. 構造整合のみ保証** (NON-NEGOTIABLE) | doctor の判定境界 | ✅ PASS — doctor が判定するのは「ファイル存在」「sha256 一致」「マーカー存在」のみの**構造整合**。SKILL.md の本文意味解釈や「正しい Skill が選ばれるか」のような意味判定は一切行わない (実機 description-trigger 確認は人間/エージェント側の責務、US1 Acceptance B に対応)。 |

**結論**: Constitution Check **PASS、違反なし**。Complexity Tracking 表は空のまま。

## Project Structure

### Documentation (this feature)

```text
specs/013-cross-agent-extensions/
├── plan.md                            # This file
├── research.md                        # Phase 0: 設計判断の根拠
├── data-model.md                      # Phase 1: エンティティと不変条件
├── quickstart.md                      # Phase 1: 受け入れテスト手順 (5 エージェント分)
├── contracts/
│   ├── cli-flags.md                   # init/doctor CLI フラグ契約
│   ├── distribution-paths.md          # 5 エージェント × canonical パス対応表
│   ├── agent-context-format.md        # AGENTS.md / ラッパーのマーカー形式
│   └── doctor-output.md               # doctor の json 出力 schema
├── checklists/
│   └── requirements.md                # /speckit-specify 生成済 (validation)
└── tasks.md                           # Phase 2 で /speckit-tasks が生成
```

### Source Code (repository root)

constitution `§技術基盤と制約` に従い**単一パッケージ** (`src/` のみ)。新規 / 改修ファイル:

```text
src/
├── cli.ts                             # CHANGED: --agents=<list> フラグ追加、doctor サブコマンド登録
├── init.ts                            # CHANGED: 多エージェント配布フロー、agent-context 注入呼出し
├── agents/                            # NEW: Tier 1 エージェント記述子と配布ロジック
│   ├── descriptors.ts                 # NEW: 5 エージェントの canonical パス table と検証
│   ├── distribute.ts                  # NEW: SKILL.md + _shared/ をエージェント配布先へバイト一致で配置
│   └── agent-context.ts               # NEW: AGENTS.md セクション注入 + CLAUDE.md/copilot-instructions.md ラッパー生成 (spec 012 P1 の責務を本 spec が引取り)
├── doctor.ts                          # NEW: artgraph doctor サブコマンド本体 (Tier 1 配布物の sha256/存在診断)
└── ... (既存ファイル変更なし: scan.ts, check.ts, coverage.ts, etc.)

templates/
└── skills/                            # 既存、SKILL.md + _shared/ 構造を維持 (本 spec で追加・改変なし)
    ├── _shared/
    │   ├── install-check.md
    │   ├── output-schema.md
    │   └── package-manager.md
    ├── artgraph-coverage/SKILL.md
    ├── artgraph-detect/SKILL.md
    ├── artgraph-impact/SKILL.md
    ├── artgraph-integrate/SKILL.md
    ├── artgraph-plan-coverage/SKILL.md
    ├── artgraph-rename/SKILL.md
    ├── artgraph-setup/SKILL.md
    └── artgraph-verify/SKILL.md

tests/
├── agents/                            # NEW: エージェント別配布契約テスト
│   ├── distribute-claude.test.ts      # NEW: .claude/skills/ への配布契約
│   ├── distribute-codex.test.ts       # NEW: .agents/skills/
│   ├── distribute-cursor.test.ts      # NEW: .cursor/skills/
│   ├── distribute-copilot.test.ts     # NEW: .github/skills/
│   ├── distribute-kiro.test.ts        # NEW: .kiro/skills/
│   └── distribute-multi.test.ts       # NEW: --agents=claude,codex,cursor の同期検証
├── agent-context.test.ts              # NEW: AGENTS.md セクション + ラッパー注入の冪等性
├── doctor.test.ts                     # NEW: artgraph doctor の PASS/FAIL/出力
├── init.test.ts                       # CHANGED: --agents 必須 / --minimal / --no-* 直交ルール
└── ... (既存テスト変更なし)
```

**Structure Decision**: 単一パッケージ構成を維持。配布ロジックを `src/agents/` に新規モジュール化することで、(a) 5 エージェント分の descriptors を 1 箇所に集中させ、(b) Tier 2 エージェント追加時の影響範囲を `src/agents/descriptors.ts` への 1 行追加で完結させる。doctor は `src/doctor.ts` 独立モジュール、CLI surface は `artgraph doctor` 新サブコマンド (`artgraph check` のフラグ群が既に `--gate`/`--diff` 等で複雑化しており、配布物 drift と graph drift は概念的に独立)。

## Complexity Tracking

> Constitution Check 違反なし。本表は空。

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| (なし) | — | — |
