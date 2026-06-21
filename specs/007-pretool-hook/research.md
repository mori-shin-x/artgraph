# Research: PreToolUse Hook (hook-pretool サブコマンド)

## R1. Claude Code PreToolUse hook の仕様

Decision: Claude Code の PreToolUse hook は、ツール実行前に外部コマンドを呼び出し、stdout の JSON から
hookSpecificOutput.additionalContext をエージェントに注入する仕組みを利用する

仕様の詳細:

stdin に渡される JSON:
```json
{
  "tool_name": "Edit",
  "tool_input": {
    "file_path": "src/auth.ts",
    "old_string": "...",
    "new_string": "..."
  }
}
```

stdout に期待される JSON:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": "Impact: FR-001 (req), doc:api-design (doc)"
  }
}
```

exit code のセマンティクス:
- exit 0: 正常終了。stdout の JSON がエージェントに渡される
- exit 1: hook 失敗。Claude Code はワークフローを続行し、hook の結果は無視する
- exit 2: ブロッキングエラー。Claude Code はアクションをブロックし、stderr をフィードバックする

permissionDecision:
- 返さない場合のデフォルト動作は defer（元のポリシーに委任）
- v1 では permissionDecision を返さず、情報提供（additionalContext）のみ行う

Rationale:
- spectrace の目的は「影響範囲の情報提供」であり、ツール実行のブロックは行わない
- exit 0 で常に返すことで、spectrace のエラーが Claude Code のワークフローを阻害しない
- additionalContext は自由形式のテキストとして、エージェントのプロンプトに注入される

## R2. Edit / Write / MultiEdit の tool_input 構造

Decision: 3 つのツールの tool_input から file_path を抽出するロジックを実装する

Edit の tool_input:
```json
{
  "file_path": "src/auth.ts",
  "old_string": "const x = 1;",
  "new_string": "const x = 2;"
}
```

Write の tool_input:
```json
{
  "file_path": "src/new-file.ts",
  "content": "export function hello() { ... }"
}
```

MultiEdit の tool_input:
```json
{
  "file_path": "src/auth.ts",
  "edits": [
    { "old_string": "...", "new_string": "..." },
    { "old_string": "...", "new_string": "..." }
  ]
}
```

file_path の抽出ロジック:
- Edit: `tool_input.file_path` を直接取得
- Write: `tool_input.file_path` を直接取得
- MultiEdit: `tool_input.file_path` を直接取得（MultiEdit は単一ファイル内の複数編集）

注意: Claude Code の MultiEdit は単一ファイルに対する複数箇所の編集であり、
tool_input.file_path は1つ。複数ファイルを同時に編集する場合は、
Claude Code が MultiEdit を複数回呼び出す（各呼び出しで hook が発火する）。

Rationale:
- 3 ツールとも tool_input.file_path フィールドが存在するため、共通のロジックで処理可能
- MultiEdit が単一ファイル内の複数編集であることを確認し、file_path の取得を簡素化

Alternatives considered:
- MultiEdit を複数ファイル対応と仮定する設計: spec.md の FR-001 では `tool_input.edits` 配列から
  各ファイルの file_path を取得する想定があったが、実際の Claude Code の MultiEdit は
  単一ファイル内の編集。ただし将来の変更に備え、edits 配列内に file_path がある場合にも
  対応できる防御的な実装とする

## R3. 絶対パス→相対パス変換のロジック

Decision: process.cwd() をプロジェクトルートとして、絶対パスを相対パスに変換する

方式:
1. tool_input.file_path が絶対パスかどうかを `path.isAbsolute()` で判定
2. 絶対パスの場合、`path.relative(process.cwd(), filePath)` で相対パスに変換
3. 相対パスの場合、そのまま使用
4. 変換後のパスを `resolveStartIds()` に渡す

Rationale:
- Claude Code はツール呼び出し時にプロジェクトルートからの相対パスを渡すことが多いが、
  絶対パスを渡す場合もある
- spectrace のグラフノードはプロジェクトルートからの相対パスで管理されているため、
  一貫した形式に変換する必要がある
- `process.cwd()` は spectrace コマンドが実行されるディレクトリであり、
  通常はプロジェクトルートと一致する

Alternatives considered:
- `.spectrace.json` からルートを推定: 設定ファイルが存在しない場合に対応できない
- git リポジトリのルートを使用: git 依存を増やす。spectrace は git なしでも動作すべき

## R4. レイテンシの内訳と計測方法

Decision: v1 ではレイテンシ計測は行わず、hook の全体実行時間のみを stderr に出力する

レイテンシの見込み（小規模プロジェクト、< 100 ファイル）:
- Node.js プロセス起動: ~200-500ms
- ts-morph 初期化（scan 内部）: ~500-1500ms
- グラフ構築（scan）: ~200-500ms
- impact 計算: ~10-50ms（BFS のため高速）
- JSON 出力: ~1ms

合計見込み: ~1-3 秒

計測方法（v1）:
- `process.hrtime.bigint()` で hook-pretool の開始から終了までの時間を計測
- stderr に `spectrace: hook-pretool completed in Xms` と出力（デバッグ用）

Rationale:
- v1 では個別コンポーネントの計測は不要。全体の応答時間のみで判断する
- 5 秒を超過する場合は P3 のデーモン化（`spectrace daemon`）で対応する
- stderr への出力はエージェントに影響しない（stdout のみが hook 結果として処理される）

## R5. hookSpecificOutput の additionalContext フォーマット

Decision: 影響を受けるノードの ID とノード種別を簡潔なテキスト形式で出力する

フォーマット:
```
spectrace impact: FR-001 (req), SC-001 (req), doc:api-design (doc)
```

影響なしの場合:
```
spectrace impact: (none)
```

設定なし（.spectrace.json が存在しない）の場合:
- additionalContext は空文字列

Rationale:
- additionalContext はエージェントのプロンプトに注入されるため、簡潔で読みやすい形式が望ましい
- ノード ID とノード種別（req/doc）を含めることで、エージェントが影響の種類を判断できる
- file ノード（影響を受けるソースファイル）は含めない。エージェントが自身で把握できる情報であり、
  additionalContext を冗長にしないため
- drift 情報は additionalContext には含めず、将来の拡張として検討する

Alternatives considered:
- JSON 形式で出力: 人間が読みにくく、additionalContext としてエージェントが処理しづらい
- ファイルパスも含める: 冗長になりすぎる。エージェントは変更対象のファイルを既に知っている
- drift 情報も含める: v1 のスコープでは影響範囲の通知のみに集中する
