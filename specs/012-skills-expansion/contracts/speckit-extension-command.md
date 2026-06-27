# Contract: Spec Kit Extension Command Output

**Feature**: Agent-Native Toolkit | **Date**: 2026-06-27

Spec Kit Issue [#2730](https://github.com/github/spec-kit/issues/2730) (副作用のみ hook の dispatch 信頼性問題) に対応するため、`templates/integrate/speckit/commands/artgraph.scan-reconcile.md` (および将来追加されうる類似コマンド) は **出力消費型** として設計する。

---

## 背景

Spec Kit Issue #2730 (2026-06-25 closed) の事実:

- `templates/commands/<phase>.md` から発火される `EXECUTE_COMMAND:` directive は pure Claude Code 経由で常に dispatch されるわけではない
- **出力を消費する hook (gate / classifier / status query)** → 確実に dispatch される
- **副作用のみの hook (ファイル書込・状態遷移のみで agent に返却なし)** → emit されるが skip されうる

修正は templates 側で投入済 (PR #2713) だが、信頼性向上のため artgraph 側も出力消費型に揃える方針。

---

## 対象コマンド

### `artgraph.scan-reconcile`

**現状** (P3 改修前): "Run `artgraph scan && artgraph reconcile`" のみ (副作用のみ、agent に返却なし)

**改修後** (P3): コマンド md の最後で agent に **stdout に 1 行の JSON サマリを emit させる** ことを命令する。

#### 改修後の `commands/artgraph.scan-reconcile.md` 構造

```markdown
---
description: Refresh artgraph baseline (scan && reconcile)
---

## Purpose

Refresh the artgraph baseline by running `artgraph scan` followed by `artgraph reconcile`.

## Steps

1. Run `npx artgraph scan` to rebuild the integrated graph.
2. Run `npx artgraph reconcile` to refresh `.trace.lock` to the current graph state.
3. **Capture the output of step 2** and emit a single line to stdout in the following format:

   ```
   ARTGRAPH: {"reconciled": <node count>, "drift": <pre-reconcile drift count>}
   ```

   The exact prefix `ARTGRAPH:` MUST be included so downstream consumers can parse the line unambiguously.

## Why this format

This hook is invoked by Spec Kit `after_tasks` and Spec Kit's dispatch is more reliable for hooks whose output the agent consumes. The 1-line JSON summary is consumed by the agent (which surfaces it to the user as "Reconciled N nodes, M drifts were resolved"), ensuring the hook is treated as output-consuming.
```

#### 出力契約

| 形式 | 例 |
|------|-----|
| 必須 prefix | `ARTGRAPH:` |
| body 形式 | JSON (1 行) |
| 必須 keys | `reconciled` (integer), `drift` (integer) |
| 任意 keys | `lockUpdated` (boolean), `errors` (string[]) |

具体例:
```
ARTGRAPH: {"reconciled": 42, "drift": 3}
```

---

## 他コマンドへの適用

| Spec Kit hook | 配備コマンド | 出力消費型? | 改修要 |
|---------------|--------------|-------------|--------|
| `after_tasks` | `artgraph.scan-reconcile` | **改修必要** | **P3** |
| `after_implement` | `artgraph.check-diff` | 既に出力消費 (pass/fail を返す) | 不要 |
| `before_implement` (--gate モード) | `artgraph.check-gate` | gate (exit code) で消費 | 不要 |

---

## フォールバック (FR-022)

dispatch が万一失敗した場合 (Spec Kit 側の dispatch ロジック未来変更等)、ユーザーは slash command として手動で呼び出せる:

```
/artgraph.scan-reconcile
```

これは Spec Kit が extension の `provides.commands` を自動で `.claude/commands/` に展開するため、`integrate speckit` 配備済 repo では常に利用可能。

`templates/integrate/speckit/README.md` に以下を明記 (P3):

```markdown
## Troubleshooting

### `after_tasks` hook が無音で skip された場合

Spec Kit の dispatch ロジック (Issue [#2730](https://github.com/github/spec-kit/issues/2730)) で稀に hook が emit のみで実行されないことがあります。その場合は以下を手動で実行してください:

    /artgraph.scan-reconcile

artgraph の baseline は同期されます。
```

---

## テスト (`tests/speckit-extension-command.test.ts`, P3)

| Case | 期待 |
|------|------|
| `commands/artgraph.scan-reconcile.md` の本文に `ARTGRAPH:` prefix の例が含まれる | pass |
| 同 md に `npx artgraph scan` と `npx artgraph reconcile` の呼び出しが含まれる | pass |
| 同 md に出力 emit の指示 ("emit a single line") が含まれる | pass |
| `templates/integrate/speckit/README.md` に troubleshooting セクションがある | pass |
| `extension.yml#requires.speckit_version` が `>=0.11.0` 以上 | pass |

これらは静的検証 (markdown grep + YAML parse) で実施する。実際の Spec Kit dispatch 動作は E2E で smoke-test 化する (SC-005 達成、20 trials のうち 95% 以上で 2 hook が dispatch される)。

---

## 注意

本 contract は Spec Kit テンプレ側の dispatch 信頼性が将来変わった場合 (例: Spec Kit が副作用のみ hook も常に dispatch するよう修正) には不要になる。その時点で `commands/artgraph.scan-reconcile.md` を従来形式に戻すことも可能だが、出力消費型は害がないため P3 改修後も維持する (両環境で動く)。
