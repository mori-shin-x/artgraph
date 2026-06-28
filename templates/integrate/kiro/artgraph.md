# artgraph — Kiro integration

This steering file tells the Kiro agent how to use artgraph to keep code, specs, and tests in sync.

## When to run artgraph

- **Before implementation** — run `artgraph impact <path>` to see which requirements/docs are affected.
- **After implementation** — run `artgraph check --diff` to verify coverage / orphan / drift.
- **On drift detection** — run `artgraph reconcile` to refresh the lock baseline (only after human review of the drift).

## Commands

| Command                  | Use                                                   |
| ------------------------ | ----------------------------------------------------- |
| `artgraph impact <file>` | List affected REQs/docs/files for a given path        |
| `artgraph check --diff`  | Validate the current git diff against the trace graph |
| `artgraph reconcile`     | Update `.trace.lock` to current graph (use with care) |
| `artgraph coverage`      | Inspect per-requirement coverage status               |

---

## `Files:` セクション規約 (推奨)

`artgraph plan-coverage` が tasks.md / plan.md から起点 file 群を抽出して暗黙波及 REQ を検出するため、各タスクに **`Files:` セクション** を書くことを推奨します。

例 (inline 形 / bullet 形どちらでも可):

```markdown
### T013: 2FA login flow [FR-005]

Files: src/auth.ts, src/auth-2fa.ts, tests/auth.test.ts
```

```markdown
### T013: 2FA login flow [FR-005]

Files:
- src/auth.ts
- src/auth-2fa.ts (new)
- tests/auth.test.ts
```

詳細文法は [`contracts/sdd-files-parser.md`](https://github.com/ShintaroMorimoto/artgraph/blob/main/specs/014-reinvent-impact-cli/contracts/sdd-files-parser.md) を参照。Stage A (`Files:` セクション) 抽出ゼロ時のみ Stage B (regex フォールバック) が実在 path のみ採用します。

`Files:` セクションを必須化したいプロジェクトは:

```json
// .artgraph.json
{ "planCoverage": { "requireFilesSection": true } }
```

または CLI に `--require-files-section` を渡してください。デフォルトは lenient。

---

## 暗黙波及 REQ の mention 規約 (推奨)

`artgraph plan-coverage` が「tasks 内で言及されていないが impact が及ぶ REQ」を検出した場合、対応が必要なら tasks.md にタスク追加、影響なしと確認できたら tasks.md / plan.md / spec.md のいずれかで REQ-ID を **mention** して記録することを推奨します。

mention は **ラベル無依存** — REQ-ID 文字列が境界マッチで現れていれば「考慮済」とみなされます:

```markdown
Considered: REQ-003 — investigated src/auth.ts:120-140, no actual impact
Affected: REQ-007 — will fix in T014
```

`Considered:` / `Affected:` 等のラベルは parser から見て区別されないため、Kiro spec 規約に合わせたラベルを自由に作って構いません。

一時的に CI を通すための one-shot 抑止:

```bash
artgraph plan-coverage --gate --ignore REQ-003,REQ-007
```

`--ignore` は永続化されません。永続的な記録は mention で行ってください。

---

## 推奨ワークフロー

Kiro spec が更新された後、`artgraph plan-coverage` を実行して暗黙波及を確認することを推奨します。

**Kiro には canonical な current spec 指標が存在しない** (`SPECIFY_FEATURE_DIRECTORY` 環境変数や `.specify/feature.json` に相当するものが Kiro 公式 docs `kiro.dev/docs/specs/` に無い) ため、`--spec` で対象 spec dir を明示する必要があります:

```bash
artgraph plan-coverage --spec .kiro/specs/<your-feature>/
```

出力に暗黙波及 REQ が現れたら、上記「暗黙波及 REQ の mention 規約」のフローに従って tasks.md / spec.md を更新してください。

**enforcement(`plan-coverage --gate` を blocking する自動化)は本ステアリングのスコープ外** です。Kiro はそもそも public Hook API を持たないため (KiroProvider 実装メモ参照)、現状は推奨に留めます。将来的な enforcement は spec 015 候補 ([#105](https://github.com/ShintaroMorimoto/artgraph/issues/105)) で扱う予定。
