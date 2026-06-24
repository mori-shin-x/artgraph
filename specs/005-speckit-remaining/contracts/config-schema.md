# Contract: `.artgraph.json` `taskConventions` スキーマ

**File**: `packages/artgraph/src/config.ts`（読み込み）+ ユーザ提供の `.artgraph.json`

---

## JSON スキーマ (informal)

```jsonc
{
  "taskConventions": [
    {
      "name": "openspec",                // string, required, unique
      "fileStems": ["tasks", "todo"],    // string[], required, non-empty
      "taskIdRe": "^- \\[[xX ]\\]\\s+(\\w+-\\d+)"  // string, required, valid regex with capture group 1
    }
  ]
}
```

### JSON Schema 風

```jsonc
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "taskConventions": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["name", "fileStems", "taskIdRe"],
        "properties": {
          "name": { "type": "string", "minLength": 1 },
          "fileStems": {
            "type": "array",
            "items": { "type": "string", "minLength": 1 },
            "minItems": 1
          },
          "taskIdRe": { "type": "string", "minLength": 1, "maxLength": 200 }
        }
      }
    }
  }
}
```

---

## 検証ルール（`config.ts` 内で実装）

`reqPatterns` 検証 (`validateReqPatterns` `config.ts:28`) を**踏襲**して以下を実装する:

| ルール | エラーメッセージ |
|---|---|
| `name` 空文字 | `Invalid taskConventions[{idx}].name: must not be empty` |
| `name` 重複（builtin 含む） | `Invalid taskConventions: duplicate name "{name}". Built-in presets are "spec-kit", "kiro" — choose another name.` |
| `fileStems` 空配列 | `Invalid taskConventions[{idx}].fileStems: must not be empty` |
| `taskIdRe` 空文字 | `Invalid taskConventions[{idx}].taskIdRe: must not be empty` |
| `taskIdRe` 長さ > 200 | `Invalid taskConventions[{idx}].taskIdRe: pattern must not exceed 200 characters` |
| `taskIdRe` nested quantifier | `Invalid taskConventions[{idx}].taskIdRe: nested quantifiers (e.g. "(a+)+") are rejected to prevent catastrophic backtracking` |
| `taskIdRe` 無効 regex | `Invalid taskConventions[{idx}].taskIdRe: invalid regular expression — {detail}` |
| `taskIdRe` capture group ゼロ | `Invalid taskConventions[{idx}].taskIdRe: regex must contain at least one capture group (group 1 is used as the task ID)` |

---

## 既定値（builtin）

`taskConventions` を `.artgraph.json` に書かない場合、内部で以下が適用される:

```jsonc
[
  {
    "name": "spec-kit",
    "fileStems": ["plan", "tasks"],
    "taskIdRe": "^(?:\\[[xX ]\\][\\s\\u00A0]+)?(T\\d+)\\b"
  },
  {
    "name": "kiro",
    "fileStems": ["tasks"],
    "taskIdRe": "^(?:\\[[xX ]\\][\\s\\u00A0]+)?(\\d+(?:\\.\\d+)*)\\.?[\\s\\u00A0]"
  }
]
```

---

## ユーザ拡張例: OpenSpec 追加

```jsonc
{
  "taskConventions": [
    {
      "name": "openspec",
      "fileStems": ["tasks"],
      "taskIdRe": "^- \\[[xX ]\\]\\s+(OS-\\d+)"
    }
  ]
}
```

→ builtin の `spec-kit` / `kiro` に加えて `openspec` が適用される。`tasks.md` ファイル内で `T001` / 階層数字 / `OS-NNN` のすべてが認識される（実プロジェクトで衝突しない想定）。

---

## DEFAULT_CONFIG 反映

`packages/artgraph/src/types.ts:289` の `DEFAULT_CONFIG` には `taskConventions` を **含めない**。理由:

- `DEFAULT_CONFIG` は CLI が外部入力なし時のフォールバック値。`taskConventions` 未指定 = builtin のみ適用、というセマンティクスを `DEFAULT_CONFIG = undefined` で表現するのが既存 `reqPatterns` / `docGraph` と一貫している。
- builtin は `parsers/markdown.ts` 内のコード定数として保持し、`DEFAULT_CONFIG` には漏れ出さない。
