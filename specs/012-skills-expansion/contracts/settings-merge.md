# Contract: `.claude/settings.json` Merge

**Feature**: Agent-Native Toolkit | **Date**: 2026-06-27

`artgraph init` (デフォルトで実行、`--no-hooks` で opt-out) が `.claude/settings.json` に Stop hook を merge する規約を定義する。`init --minimal` モードでは hook merge は実行されない。

参考: [Claude Code Hooks 公式](https://code.claude.com/docs/en/hooks)

---

## 入力ソース

`templates/hooks/settings.json.template`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "npx artgraph check --gate --diff" }
        ]
      }
    ]
  }
}
```

(将来 PostToolUse 等を追加する余地あり。現状 Stop のみ)

---

## マージ規約 (FR-012, FR-013)

### Case A: `.claude/settings.json` が存在しない

→ テンプレ全体をそのまま `.claude/settings.json` として書き出す。
→ exit 0 で success、stdout に `"Created .claude/settings.json with artgraph Stop hook"` を表示。

### Case B: `.claude/settings.json` が存在、`hooks` フィールドが無い

→ 既存 JSON を読み、トップレベルに `"hooks": { "Stop": [...] }` を追加。
→ 他フィールド (例: `permissions`, `env`, `model`) は完全保持。
→ exit 0、`"Added artgraph Stop hook to existing .claude/settings.json"`.

### Case C: `.claude/settings.json` 存在、`hooks` あり、`hooks.Stop` が無い

→ `hooks.Stop` のみ追記。他 hook (`PreToolUse`, `PostToolUse`, `UserPromptSubmit` 等) は完全保持。
→ exit 0、`"Added artgraph Stop hook (other hooks preserved)"`.

### Case D: `.claude/settings.json` 存在、`hooks.Stop` が既に登録済

→ **上書きせず警告**。stderr に以下を出力:

```
[WARN] .claude/settings.json already has a Stop hook configured.
artgraph did NOT modify this file to avoid clobbering your setup.

To add artgraph's gate, manually merge the following into hooks.Stop:

  {
    "hooks": [
      { "type": "command", "command": "npx artgraph check --gate --diff" }
    ]
  }
```

→ exit code: **1** (FR-013 fail-on-conflict)
→ `--force` フラグでも上書きしない (settings は ユーザー設定の中で最も繊細なため、明示的に「artgraph がこれを書き換えるべきではない」設計判断)

---

## `--force` フラグの扱い

`artgraph init --force` は **`hooks.Stop` 衝突に対しても上書きしない**。`--force` は `.artgraph.json` の生成にのみ作用する。

settings.json merge に追加で flag を増やす案も検討したが (`--force-hooks`)、R4 の trade-off 通り「ユーザー設定の破壊リスク > 自動化の便益」と判断して採用しない (ユーザーデータ保護の原則)。

---

## べき等性 (idempotency)

`artgraph init` を 2 回連続実行した場合:
- 1 回目: Case A → 新規作成
- 2 回目: Case D → 警告 + exit 1 ✗ (idempotent ではない)

これは設計上の意図的選択。理由:
- ユーザーが Stop hook を編集した可能性があり、それを artgraph が「同じだから問題なし」と再上書きするのは危険
- 「artgraph が前回書いた hook と完全一致なら no-op」をサポートするには JSON deep-equal が必要だが、ユーザー編集 (順序入替・コメント追加・別 `artgraph` 派生コマンドへの変更) を検出できない

代替: P1 の Skill `artgraph-setup` が Case D を検出した場合、ユーザーに「現状 OK か手動マージするか」を確認する設計にする。

---

## 実装ガイド (`src/init.ts`)

```typescript
// 擬似コード (実装時に具体化)
async function installHooks(targetDir: string): Promise<HookInstallResult> {
  const settingsPath = path.join(targetDir, '.claude', 'settings.json');
  const templatePath = path.join(repoRoot, 'templates/hooks/settings.json.template');
  const template = JSON.parse(await readFile(templatePath, 'utf-8'));

  if (!(await fs.exists(settingsPath))) {
    await writeFile(settingsPath, JSON.stringify(template, null, 2));
    return { action: 'created', conflict: false };
  }

  const existing = JSON.parse(await readFile(settingsPath, 'utf-8'));

  if (existing.hooks?.Stop?.length > 0) {
    // Case D: 衝突
    console.error(buildConflictMessage(template.hooks.Stop[0]));
    return { action: 'skipped', conflict: true, exitCode: 1 };
  }

  // Case B/C: merge
  existing.hooks ??= {};
  existing.hooks.Stop = template.hooks.Stop;
  await writeFile(settingsPath, JSON.stringify(existing, null, 2));
  return { action: 'merged', conflict: false };
}
```

実装時は既存の `installSkills()` (`src/init.ts:136-166`) と同じスタイルで `runInit()` から呼ばれる。

---

## テスト (`tests/hooks-merge.test.ts`, P1)

| Case | 入力 | 期待 |
|------|------|------|
| A | settings.json なし | 新規作成、exit 0 |
| B | `{}` | `hooks.Stop` 追加、他保持、exit 0 |
| C | `{ hooks: { PreToolUse: [...] } }` | `hooks.Stop` 追加、`PreToolUse` 保持、exit 0 |
| D | `{ hooks: { Stop: [{ hooks: [{ type: "command", command: "..." }] }] } }` | 上書きせず、stderr に警告、exit 1 |
| D + `--force` | 同上 | **同じく** 上書きせず、警告、exit 1 (`--force` は無視) |
| 不正 JSON | `not a json` | JSON parse エラー、exit 1 |

各 case で `.claude/settings.json` の前後の状態を fixture で比較する。

---

## 補足事項 (#109 実装で確定)

- **Case D 判定式**: `Array.isArray(existing.hooks?.Stop) && existing.hooks.Stop.length > 0`。非配列 (`hooks.Stop = {}` / `42` 等) / 空配列 (`hooks.Stop = []`) / `null` はいずれも Case D ではなく Case B/C 扱い (上書き対象)。
- **`.claude/settings.json` が directory / symlink の場合**: `lstatSync` で通常ファイルでないことを検出し、明示的に拒否する (`action: "io-error"`)。ファイルは生成・変更しない。
- **BOM 対応**: 既存ファイル読み込み時、`JSON.parse` の前に UTF-8 BOM (`﻿` / `charCodeAt(0) === 0xfeff`) を strip する。`src/package-manager.ts:90` の既存ロジックと同水準の扱い。
- **JSONC 非サポート**: `//` コメント付き JSON (JSONC) はサポート対象外。`JSON.parse` が失敗するため `action: "invalid-json"` として扱う (ファイル無変更)。
- **PM 検出優先度**: `installHooks` に渡す PM は (1) 呼び出し元が明示する `detectedPm` 引数 → (2) `.artgraph.json#packageManager` → (3) `null` の順で解決する。`null` の場合は graceful skip (`action: "skipped-no-pm", failure: false`)。ただし `--minimal --with-hooks` のように hooks stage を明示 opt-in している場合は、PM 未検出を `failure: true` に昇格させる (ユーザーが明示的に要求した stage が実行できないため)。
- **部分状態 (graceful degradation)**: Case D (衝突) や `skipped-no-pm` / `invalid-json` / `io-error` が発生しても、`.artgraph.json` の生成と Skills のインストールはそのまま残る。Stop hook のみがスキップされる。
- **`InitResult` との連携**: `installHooks` は `InitResult.hooksInstall = { action, reason?, failure? }` を返す構造化データのみを扱い、stdout/stderr への出力は行わない。text/JSON 出力のフォーマットは `src/cli.ts` に集約し、`init.ts` の print-free な既存慣習を維持する。
