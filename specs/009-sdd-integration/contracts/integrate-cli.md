# Contract: CLI コマンド表面

**Layer**: `packages/artgraph/src/cli.ts`（既存ファイルへの追記）

**Related**: [spec FR-015 / FR-022 / FR-023 / FR-024](../spec.md), [Clarifications Q5](../spec.md#clarifications)

---

## 1. `artgraph integrate <tool>` — Provider 経由の統合

```text
Usage: artgraph integrate <tool> [options]

Arguments:
  tool              SDD tool to integrate with: speckit | kiro

Options:
  --gate            (speckit only) Add before_implement gate hook
  --no-gate         (speckit only) Remove before_implement gate hook
  --force           Overwrite existing files
  --uninstall       Remove the integration (delete files / hook entries)
  --format <fmt>    Output format: text | json (default: text)
  -h, --help        Display help
```

**Exit codes**:
- `0`: 成功（生成・更新・no-op いずれも含む）
- `1`: detect 失敗 / 引数エラー / write 失敗
- 部分適用は edge case 通り発生させない（失敗時は disk 不変）

**Text 出力フォーマット**:

```text
✓ Integrated: speckit (Spec Kit)

Created (3):
  .specify/extensions/spectrace/extension.yml
  .specify/extensions/spectrace/README.md
  .specify/extensions/spectrace/commands/artgraph.scan-reconcile.md

Modified (1):
  .specify/extensions.yml

Next:
  Run /speckit-tasks to verify the after_tasks hook fires
  Run /speckit-implement to verify the after_implement hook fires
```

冪等再実行時：
```text
✓ Already integrated: speckit (Spec Kit) — no changes
```

**JSON 出力**:

```json
{
  "providerId": "speckit",
  "created": [...],
  "modified": [...],
  "removed": [],
  "noop": false,
  "nextSteps": [...],
  "warnings": []
}
```

---

## 2. `artgraph integrate list` — Provider 一覧と状態

```text
Usage: artgraph integrate list [options]

Options:
  --format <fmt>    Output format: text | json (default: text)
```

**Text 出力**:

```text
Available integrations:

  speckit    Spec Kit    [ detected: yes, installed: yes ]
  kiro       Kiro        [ detected: yes, installed: no  ] → run: artgraph integrate kiro

(Future providers: openspec — coming soon)
```

**JSON 出力**:

```json
{
  "providers": [
    { "id": "speckit", "displayName": "Spec Kit", "marker": ".specify",
      "detected": true, "installed": true },
    { "id": "kiro",    "displayName": "Kiro",     "marker": ".kiro",
      "detected": true, "installed": false }
  ]
}
```

**契約**:
- 出力順は `registry.listProviders()` の登録順（speckit → kiro）。
- detect 失敗ツールも entry に含める（`detected: false`）— ユーザーが将来導入予定のツールを把握できる。
- 「Future providers」行は OpenSpec 等が増えたタイミングで追記するヒントとして残す（現時点では hard-coded コメント）。

---

## 3. `artgraph init --integrate=<tools>` — one-shot 統合（FR-022/023/024）

既存 `artgraph init` への追加オプション：

```text
Options (additions to existing init):
  --integrate <tools>     Comma-separated tools to integrate one-shot.
                          Values: speckit, kiro, all
  --integrate-gate        Pass --gate to speckit integration (no-op for others)
  --no-integrate-gate     Pass --no-gate to speckit integration
```

**振る舞い**:
- `--integrate=speckit,kiro` → 順に `integrate <tool>` と完全同等の処理を実行（FR-024：プロバイダ抽象経由）。
- `--integrate=all` → `detectProject().integrations.filter(i => i.detected)` の全 provider に対して順に実行。
- 指定したが未検出のツールは `WARNING: spec kit not detected, skipping integration` を表示してその tool 分のみスキップ。init 全体は exit 0（FR-022 末尾）。
- 出力はツール別ブロックに分け、各ブロックの先頭に `=== Integration: speckit ===` のような明示見出しを付ける（FR-023）。
- `--integrate-gate` / `--no-integrate-gate` は対象 tool が speckit のときのみ反映、それ以外は警告なしで無視。

**Text 出力例**（`artgraph init --integrate=all`）:

```text
Spec Kit detected (.specify/)
Kiro detected (.kiro/)

Nodes: 12  Edges: 4
  req: 3  doc: 2  file: 5  test: 2

Created .artgraph.json
Created .trace.lock

=== Integration: speckit ===
✓ Integrated: speckit (Spec Kit)
Created (3): .specify/extensions/spectrace/extension.yml, ..., ...
Modified (1): .specify/extensions.yml

=== Integration: kiro ===
✓ Integrated: kiro (Kiro)
Created (1): .kiro/steering/spectrace.md

Run "artgraph check" to verify traceability.
Run "artgraph impact --diff" to see impact of your changes.
```

---

## 4. `artgraph init` の案内表示（FR-012/013）

`--integrate` 未指定時の追加挙動：

```text
... existing init output ...

Run "artgraph check" to verify traceability.

Tip: Spec Kit detected. Run "artgraph integrate speckit" to wire artgraph into the SDD workflow.
Tip: Kiro detected. Run "artgraph integrate kiro" to add a steering file for the agent.
```

- `detect == true && installed == false` の provider のみ案内を表示。
- すべて installed 済みの場合は案内行を表示しない。
- 検出ツールが複数あれば各々の `Tip:` 行を別行で表示。

---

## 5. テスト要件（TDD Red 段階、`integrate-cli.test.ts`）

| テスト名 | 期待 |
|---|---|
| `integrate speckit` on empty repo without `.specify/` | exit 1、stderr に「not detected」、disk 不変 |
| `integrate speckit` on `.specify/` repo | exit 0、`Created/Modified` 出力、`.specify/extensions/spectrace/` 生成 |
| `integrate speckit` twice in a row | 2 回目 exit 0、`Already integrated` 出力、disk 不変 |
| `integrate speckit --gate` adds gate hook | extensions.yml に before_implement 行追加 |
| `integrate speckit --no-gate` removes gate hook | 既存 before_implement 行削除、他 hook 不変 |
| `integrate speckit --uninstall` | installed 削除、extension dir 削除、hook 削除 |
| `integrate kiro` on `.kiro/` repo | `.kiro/steering/spectrace.md` 生成 |
| `integrate kiro` without `.kiro/` | exit 1、disk 不変 |
| `integrate list --format=text` | 全 provider が表形式で表示、detect/install 状態が一致 |
| `integrate list --format=json` | JSON が schema 準拠 |
| `init --integrate=speckit` on `.specify/` repo | init 完了 + integrate speckit と同等の効果 |
| `init --integrate=all` on `.specify/`+`.kiro/` repo | 両 provider の output セクションが順に表示 |
| `init --integrate=speckit` on no-`.specify/` repo | init 成功（exit 0）+ 警告 + skip |
| `init --integrate-gate --integrate=speckit` | speckit に --gate が伝搬、gate hook 追加 |
| `init --integrate-gate --integrate=kiro` (without speckit) | --integrate-gate は警告なしで無視 |
| Existing `init` output unchanged when `--integrate` absent | regression test — 既存 init テストが green を維持 |
