# Specification Quality Checklist: impact / plan-coverage の symbol-level 入力対応

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-06-28
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
  - spec.md は Assumptions に「TypeScript / `parsers/typescript.ts` 既存 symbol 経路を再利用」と前提条件として記載しているのみ。FR 本文は「`Files:` セクション」「`@impl` claim」「symbol startId」「`implements` edge」等の抽象表現に留めている。実装方式 (どの parser 関数 / どの BFS 実装) は plan.md で確定する。
- [x] Focused on user value and business needs
  - US1 は「過剰検知抑制 + 二軸表示でドリフト追跡」を冒頭に置き、artgraph のコア価値「**実装が機能から漂流するのを避ける**」を symbol 粒度に持ち込む点を Why this priority で明示。US2/US3/US4 はそれを支える経路として優先度配置。
- [x] Written for non-technical stakeholders
  - 「symbol-level」「forward 波及」「`@impl` claim」「ドリフト追跡」等の用語は spec 014 / artgraph README から継続使用しており、本リポジトリの読者層では一般語彙。
- [x] All mandatory sections completed
  - User Scenarios & Testing (US1-4) / Requirements (FR-001..FR-031) / Success Criteria (SC-001..SC-006) / Assumptions すべて記述。Key Entities も SymbolEntry / unresolvedSymbol Diagnostic / ImpactGroup / ImplicitImpactByReq / ReqEntry の 5 つを定義。

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
  - 着手前に 4 つの scope 質問 (Scope=Full, Scan default=opt-in 維持, Syntax=`path:name` のみ, Mixing=同セクション内 OK) + 二軸出力設計の追加質問もすべて事前解消済。
- [x] Requirements are testable and unambiguous
  - FR-001 〜 FR-031 はすべて「MUST + 観察可能な挙動」で記述。特に FR-014/015/016/017/020 は二軸出力 (`impactReqs` / `originReqs` / `sourceLocations`) の契約を機械検証可能な形で固定している。
- [x] Success criteria are measurable
  - SC-001 「50% 以上削減」、SC-002 「2 秒以内」、SC-004 「100 行以下」、SC-006 「E2E ドリフト検知 fixture で `impactReqs \ originReqs = [REQ-007]` を JSON 上で確認」等、数値 / コマンド検証可能。
- [x] Success criteria are technology-agnostic (no implementation details)
  - 「implicit REQ 数」「結果を返す時間」「JSON consumer が差分計算可能」「Skill 本文行数」等で表現。BFS アルゴリズム / `implements` edge トラバースの実装詳細は SC に登場しない。
- [x] All acceptance scenarios are defined
  - US1: 6 scenarios / US2: 7 scenarios / US3: 5 scenarios / US4: 5 scenarios。各 Independent Test も付記。
- [x] Edge cases are identified
  - 11 項目 (symbol 不在、file 不在、`:` 複数、file/symbol 混在、同 symbol 重複、scan mode mismatch、Windows path、symbol のみ入力、annotation 併用、`originReqs` 空、`impactReqs` 空) を網羅。
- [x] Scope is clearly bounded
  - 「qualified name 対象外 (FR-031)」「他言語対象外 (Assumptions)」「scan default 変更なし (FR-024)」「enforcement は spec 015 (Assumptions)」「Stage B での symbol 抽出は対象外 (FR-006)」「US rollup は本 spec 外 (Assumptions)」など 6 つの境界を明示。後方互換 FR (旧 FR-029/030/031 系) は本リライトで撤去済。
- [x] Dependencies and assumptions identified
  - Assumptions 節に「artgraph は未リリース / 後方互換不要」「TypeScript parser に symbol/`@impl` 機能既存」「対象言語は TS/JS」「enforcement は spec 015 と orthogonal」「US rollup 対象外」「Constitution v1.1.0 原則維持」等を列挙。

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
  - FR は US 群の Acceptance Scenarios によって 1:n でカバー。特に FR-014/015/016/017 (二軸出力契約) は US1 Scenario 6 と US2 Scenario 2 で正準形を、FR-020 (`sourceLocations`) は US3 Scenario 4 で検証。
- [x] User scenarios cover primary flows
  - 過剰検知抑制 + 二軸 (US1) → CLI 直接入力 + 二軸 (US2) → 出力 schema 二軸 (US3) → Skill / docs 配布 (US4) で、plan-coverage / impact / 配布 / ドキュメントの 4 軸が揃う。
- [x] Feature meets measurable outcomes defined in Success Criteria
  - SC-001 (削減率) は US1 Acceptance Scenario 1+2 で検証、SC-002 (レイテンシ) はベンチ、SC-003 (二軸出力) は US3 全 5 Scenario、SC-004 (Skill 100 行) は US4 Scenario 5、SC-005 (docs 3 要素) は US4 Scenario 3、SC-006 (E2E ドリフト fixture) は US1 Scenario 6 + Independent Test。
- [x] No implementation details leak into specification
  - parser / traverse / CLI / plan-coverage の実装パスは Assumptions の「既存 symbol 経路を再利用」と Key Entities の `SymbolEntry` / `ImpactGroup` の型定義のみ。BFS の具体実装や `resolveStartIds()` 等の関数名は spec 本文に登場しない。

## Notes

- All quality checks pass. Ready for `/speckit-clarify` (省略可、scope は事前解消済) または `/speckit-tasks` に進める状態。
- 後方互換 FR (旧 FR-029/030/031 系の「既存 field 非破壊」「spec 014 fixture 100% pass」等) は本リライトで撤去済。artgraph 未リリース前提の clean redesign に整合し、`ExtractResult.entries: SymbolEntry[]` 一本化 (FR-007)、`reqs` → `impactReqs` rename + `originReqs` 追加 (FR-016)、`sourceFiles` → `sourceLocations` 置換 (FR-020) を破壊的に行う。
- 二軸出力 (`impactReqs` / `originReqs`) によるドリフト追跡が本 spec のコア価値であることを spec.md US1 Why this priority と SC-003 / SC-006 で明示している。spec 014 (#104) / spec 015 候補 (#105) / spec 013 (#101) との境界は Assumptions と FR-024 / FR-031 で明示。
