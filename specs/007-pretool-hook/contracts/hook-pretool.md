# Contract: spectrace hook-pretool

## コマンド概要

`spectrace hook-pretool` は Claude Code の PreToolUse hook として機能するサブコマンド。
stdin から hook JSON を読み取り、file_path を抽出して impact を実行し、
hookSpecificOutput を stdout に出力する。

## stdin: Claude Code が渡す JSON 構造

Claude Code は PreToolUse hook のコマンドの stdin に以下の JSON を渡す。

### Edit

```json
{
  "tool_name": "Edit",
  "tool_input": {
    "file_path": "src/auth.ts",
    "old_string": "const token = getToken();",
    "new_string": "const token = await getToken();"
  }
}
```

### Write

```json
{
  "tool_name": "Write",
  "tool_input": {
    "file_path": "src/new-handler.ts",
    "content": "export function handleRequest() { ... }"
  }
}
```

### MultiEdit

```json
{
  "tool_name": "MultiEdit",
  "tool_input": {
    "file_path": "src/auth.ts",
    "edits": [
      {
        "old_string": "const x = 1;",
        "new_string": "const x = 2;"
      },
      {
        "old_string": "const y = 3;",
        "new_string": "const y = 4;"
      }
    ]
  }
}
```

### file_path の取得ルール

1. `tool_input.file_path` を取得する（Edit/Write/MultiEdit 共通）
2. `file_path` が存在しない場合 → 影響なしとして exit 0
3. `file_path` が絶対パスの場合 → `path.relative(process.cwd(), filePath)` で相対パスに変換
4. 相対パスはそのまま使用

## stdout: hookSpecificOutput JSON 構造

### 影響ありの場合

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": "spectrace impact: FR-001 (req), SC-001 (req), doc:api-design (doc)"
  }
}
```

additionalContext のフォーマット:
- `spectrace impact: ` プレフィックスの後に、影響を受けるノードをカンマ区切りで列挙
- 各ノードは `ID (kind)` 形式（例: `FR-001 (req)`, `doc:api-design (doc)`）
- req ノードと doc ノードのみを含める（file ノードは含めない）
- 出力順序: affectedReqs を先に、affectedDocs を後に列挙

### 影響なしの場合

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": "spectrace impact: (none)"
  }
}
```

### 設定なし（.spectrace.json 不在）の場合

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": ""
  }
}
```

## exit codes

| code | 意味 | 動作 |
|------|------|------|
| 0 | 正常終了 | stdout の JSON がエージェントに渡される |
| 1 | hook 失敗 | Claude Code はワークフローを続行し、hook の結果は無視する |
| 2 | ブロッキングエラー | Claude Code はアクションをブロックし、stderr をフィードバックする |

v1 では常に exit 0 で返す。以下のケースも全て exit 0:
- .spectrace.json が存在しない
- stdin の JSON パースに失敗
- tool_input に file_path が含まれない
- scan やimpact でエラーが発生
- グラフに対象ファイルのノードが存在しない

理由: spectrace のエラーが Claude Code のワークフローをブロックしてはならない。

## settings.json への hook 登録例

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "spectrace hook-pretool"
          }
        ]
      }
    ]
  }
}
```

matcher に `Edit|Write|MultiEdit` を指定することで、
これらのツール呼び出し時のみ hook が発火する。

npx 経由で実行する場合:
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "npx spectrace hook-pretool"
          }
        ]
      }
    ]
  }
}
```

## エラーハンドリング

全てのエラーケースで exit 0 を返し、エージェントのワークフローに影響を与えない。

| ケース | additionalContext | stderr 出力 |
|--------|-------------------|-------------|
| .spectrace.json 不在 | `""` | なし |
| stdin 読み取り失敗 | `""` | `spectrace: failed to read stdin` |
| JSON パース失敗 | `""` | `spectrace: failed to parse hook input` |
| file_path 不在 | `""` | なし |
| scan 失敗 | `""` | `spectrace: scan failed: {error}` |
| impact 失敗 | `""` | `spectrace: impact failed: {error}` |
| 正常（影響あり） | `"spectrace impact: FR-001 (req), ..."` | `spectrace: hook-pretool completed in Xms` |
| 正常（影響なし） | `"spectrace impact: (none)"` | `spectrace: hook-pretool completed in Xms` |

stderr への出力はデバッグ目的であり、エージェントには影響しない。
