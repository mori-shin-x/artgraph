# Quickstart: PreToolUse Hook (hook-pretool) の検証

## Prerequisites

- Node.js 20+
- pnpm
- artgraph がビルド可能な状態（`pnpm build` が通る）
- Claude Code がインストール済み

## Setup

```bash
pnpm install
pnpm build
```

## 検証シナリオ 1: hook-pretool の単体実行

spec.md と `@impl` タグ付きのコードファイルがあるプロジェクトで、
hook-pretool を手動で実行して動作を確認する。

```bash
# Edit ツールの hook 入力を模擬して実行
echo '{"tool_name":"Edit","tool_input":{"file_path":"src/auth.ts","old_string":"x","new_string":"y"}}' \
  | node dist/cli.js hook-pretool
```

期待される出力（影響ありの場合）:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": "artgraph impact: FR-001 (req), doc:api-design (doc)"
  }
}
```

期待される出力（影響なしの場合）:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": "artgraph impact: (none)"
  }
}
```

確認ポイント:
- exit code が 0 であること
- stdout が有効な JSON であること
- additionalContext に影響を受ける仕様ノードの ID が含まれること

## 検証シナリオ 2: Write ツールでの動作

```bash
echo '{"tool_name":"Write","tool_input":{"file_path":"src/new-file.ts","content":"..."}}' \
  | node dist/cli.js hook-pretool
```

確認ポイント:
- グラフ上に存在しないファイルの場合、`artgraph impact: (none)` が返ること
- exit code が 0 であること

## 検証シナリオ 3: MultiEdit ツールでの動作

```bash
echo '{"tool_name":"MultiEdit","tool_input":{"file_path":"src/auth.ts","edits":[{"old_string":"x","new_string":"y"}]}}' \
  | node dist/cli.js hook-pretool
```

確認ポイント:
- Edit と同等の impact 結果が返ること

## 検証シナリオ 4: 絶対パスの変換

```bash
echo '{"tool_name":"Edit","tool_input":{"file_path":"/home/user/project/src/auth.ts","old_string":"x","new_string":"y"}}' \
  | node dist/cli.js hook-pretool
```

確認ポイント:
- 絶対パスがプロジェクトルートからの相対パスに変換され、impact が正常に実行されること

## 検証シナリオ 5: .artgraph.json が存在しない環境

```bash
# .artgraph.json がないディレクトリで実行
cd /tmp
echo '{"tool_name":"Edit","tool_input":{"file_path":"src/auth.ts","old_string":"x","new_string":"y"}}' \
  | /path/to/artgraph hook-pretool
```

確認ポイント:
- exit code が 0 であること
- additionalContext が空文字列であること
- stderr にエラーが出力されないこと

## 検証シナリオ 6: Claude Code への設定と動作確認

`.claude/settings.json` に以下を追加:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "npx artgraph hook-pretool"
          }
        ]
      }
    ]
  }
}
```

確認手順:
1. 上記の設定を `.claude/settings.json` に追加する
2. Claude Code セッションを開始する
3. 仕様に紐づくファイル（例: `src/auth.ts`）を Edit するようエージェントに依頼する
4. エージェントが Edit 実行前に impact 情報を参照していることを確認する

確認ポイント:
- hook が正常に発火すること
- エージェントが additionalContext の内容を認識していること
- hook のレイテンシが体感的に許容範囲内であること（目安: 3 秒以内）

## テスト実行

```bash
# 全テスト実行
pnpm test

# hook-pretool テストのみ
pnpm test tests/hook-pretool.test.ts
```
