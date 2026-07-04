# Contract: `artgraph doctor --format json` Output Schema

**Date**: 2026-06-29 | **Spec**: [../spec.md](../spec.md)

`artgraph doctor` の機械可読出力 (JSON) schema。`--format text` は人間向け要約のみで安定契約ではない (CLI UX 改善に応じて変えうる)。

---

## トップレベル構造

```json
{
  "version": 1,
  "summary": {
    "totalFindings": 13,
    "passCount": 12,
    "failCount": 1,
    "agents": ["claude", "codex"]
  },
  "findings": [
    { /* DoctorFinding */ }
  ]
}
```

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `version` | `number` | yes | schema バージョン (本 spec で 1、後方非互換変更時に incr) |
| `summary` | `object` | yes | 集計 (詳細は下記) |
| `findings` | `DoctorFinding[]` | yes | 個別診断結果 (空配列もありうる: 配布対象 0 件の場合) |

### `summary` フィールド

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `totalFindings` | `number` | yes | `findings.length` と一致 |
| `passCount` | `number` | yes | `severity === "pass"` の件数 |
| `failCount` | `number` | yes | `severity === "fail"` の件数 |
| `agents` | `string[]` | yes | 診断対象エージェント `id` の配列 (sorted, unique)。配布検出ゼロなら空配列 |

---

## `DoctorFinding` 個別構造

```json
{
  "severity": "fail",
  "agent": "codex",
  "kind": "skill-file-drift",
  "path": ".agents/skills/artgraph-verify/SKILL.md",
  "expected": "a1b2c3d4e5f6...",
  "actual": "f4e5d6c7b8a9...",
  "message": "Distributed file has drifted from canonical templates/skills/artgraph-verify/SKILL.md. Run `artgraph init --agents=codex --force` to restore."
}
```

| フィールド | 型 | 必須 | 値域 |
|---|---|---|---|
| `severity` | `"pass" \| "fail"` | yes | データモデル §5 参照 |
| `agent` | `string \| null` | yes | `"claude" \| "codex" \| "cursor" \| "copilot" \| "kiro" \| null` (共通リソース AGENTS.md など) |
| `kind` | `string` | yes | 下記の列挙値のいずれか |
| `path` | `string` | yes | repo-root 相対パス、POSIX セパレータ |
| `expected` | `string \| null` | yes (severity=fail のとき必須非 null) | sha256 hex / マーカー文字列 / `"present"` 等 |
| `actual` | `string \| null` | yes (severity=fail のとき必須非 null) | 実測値 |
| `message` | `string` | yes | 人間向け 1 行説明 (text 出力の主要部) |

### `kind` の列挙値

| `kind` | 説明 | `expected` / `actual` の例 |
|---|---|---|
| `skill-file-present` | (pass) 配布先 SKILL.md または `_shared/` 部品が存在し sha256 一致 | `expected`/`actual` 省略可 |
| `skill-file-missing` | (fail) 配布先に期待ファイルが存在しない | `expected="present"` / `actual="missing"` |
| `skill-file-drift` | (fail) 配布先ファイルの sha256 が canonical と不一致 | `expected=<sha256>` / `actual=<sha256>` |
| `agents-md-present` | (pass) AGENTS.md にマーカー block が整合 | `expected`/`actual` 省略可 |
| `agents-md-missing` | (fail) 配布があるのに AGENTS.md 不存在 | `expected="present"` / `actual="missing"` |
| `agents-md-marker-broken` | (fail) マーカー begin/end が片方しかない or 複数 | `expected="single matched pair"` / `actual=<診断詳細>` |
| `wrapper-present` | (pass) wrapper file 存在 + `@AGENTS.md` literal 含む | `expected`/`actual` 省略可 |
| `wrapper-missing` | (fail) `--agents=claude` で `CLAUDE.md` 不存在 / `--agents=copilot` で `.github/copilot-instructions.md` 不存在 | `expected="present"` / `actual="missing"` |
| `wrapper-no-import` | (fail) wrapper 内 artgraph block に `@AGENTS.md` literal が無い | `expected="@AGENTS.md literal in block"` / `actual="not found"` |
| `extraneous-file` | (fail) 配布先に canonical 由来でないファイル/ディレクトリが残存 | `expected="not present"` / `actual="present"` |

---

## サンプル出力 (健全プロジェクト)

```json
{
  "version": 1,
  "summary": {
    "totalFindings": 14,
    "passCount": 14,
    "failCount": 0,
    "agents": ["claude", "codex"]
  },
  "findings": [
    {
      "severity": "pass",
      "agent": "claude",
      "kind": "skill-file-present",
      "path": ".claude/skills/artgraph-impact/SKILL.md",
      "expected": null,
      "actual": null,
      "message": "OK"
    },
    {
      "severity": "pass",
      "agent": "claude",
      "kind": "wrapper-present",
      "path": "CLAUDE.md",
      "expected": null,
      "actual": null,
      "message": "OK"
    },
    {
      "severity": "pass",
      "agent": null,
      "kind": "agents-md-present",
      "path": "AGENTS.md",
      "expected": null,
      "actual": null,
      "message": "OK"
    }
    /* ... 残り 11 件略 ... */
  ]
}
```

## サンプル出力 (drift あり)

```json
{
  "version": 1,
  "summary": {
    "totalFindings": 13,
    "passCount": 12,
    "failCount": 1,
    "agents": ["claude", "codex"]
  },
  "findings": [
    {
      "severity": "fail",
      "agent": "codex",
      "kind": "skill-file-drift",
      "path": ".agents/skills/artgraph-verify/SKILL.md",
      "expected": "a1b2c3d4e5f6789a1b2c3d4e5f6789a1b2c3d4e5f6789a1b2c3d4e5f6789a1b2",
      "actual": "f4e5d6c7b8a9012f4e5d6c7b8a9012f4e5d6c7b8a9012f4e5d6c7b8a9012f4e5",
      "message": "Distributed file has drifted from canonical templates/skills/artgraph-verify/SKILL.md. Run `artgraph init --agents=codex --force` to restore."
    }
    /* ... 残り 12 件略 ... */
  ]
}
```

---

## 互換性ノート

- `version` フィールドは破壊的変更 (field の type 変更 / 必須化 / 削除) があれば incr。**fields の追加**は backward-compatible とみなし version は据え置き。
- `kind` の新規追加は backward-compatible (パーサ側は未知 `kind` を skip or warn 推奨)。
