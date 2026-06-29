# Contract: CLI Flags

**Date**: 2026-06-29 | **Spec**: [../spec.md](../spec.md)

`artgraph init` の `--agents=<list>` フラグ追加と新サブコマンド `artgraph doctor` の CLI 契約。

---

## `artgraph init --agents=<list>`

### シグネチャ

```text
artgraph init [既存フラグ群] --agents=<csv>
```

### 値仕様

| 項目 | 仕様 |
|---|---|
| `<csv>` の許容値 | `claude` / `codex` / `cursor` / `copilot` / `kiro` のカンマ区切り集合 |
| 区切り文字 | カンマ `,` のみ (空白はトリム) |
| 大文字小文字 | 完全一致 (`Claude` は許容しない、`claude` のみ) |
| 重複 | エラー (例: `claude,claude` → 非 0 終了) |
| 空要素 | エラー (例: `claude,,codex` / 末尾カンマ `claude,` → 非 0 終了) |
| 空文字列 | エラー (`--agents=` 単独 → 非 0 終了) |
| 順序 | 任意 (内部正規化で alpha sort) |

### 必須条件 (FR-002)

`--agents` が以下のいずれかの **Skills/agent-context 配布 stage** が走る経路で必須:

| stage | 既定 ON | OFF にする方法 |
|---|---|---|
| Skills 配布 | ON | `--no-skills` または `--minimal` |
| agent-context 配布 | ON | `--no-agent-context` または `--minimal` |

→ `--no-skills` かつ `--no-agent-context` の両方を指定した場合のみ `--agents` 不要。それ以外は必須。

### エラーメッセージ仕様

`--agents` 未指定で必須経路に入った場合の標準エラー出力 (SC-006):

```text
ERROR: --agents=<list> is required when Skills or agent-context distribution runs.

Supported values: claude, codex, cursor, copilot, kiro

To resolve, choose one:
  1. Specify target agents:
       artgraph init --agents=<list>          (e.g. --agents=claude,codex)
  2. Skip Skills and agent-context distribution:
       artgraph init --no-skills --no-agent-context
  3. Skip every extra setup stage:
       artgraph init --minimal
```

未知の値が含まれる場合:

```text
ERROR: Unknown agent identifier(s): "windsurf", "cline"
Supported values: claude, codex, cursor, copilot, kiro
```

### 既存フラグとの直交ルール (FR-013)

| 組合せ | 振舞い |
|---|---|
| `--agents=<list>` + 既定 (`init` 単体) | 列挙エージェントへ Skills + agent-context を配布 |
| `--agents=<list>` + `--minimal` | `--minimal` が最強、`--agents` は無視され WARNING を stderr に出力 |
| `--agents=<list>` + `--no-skills` | Skills 配布は skip、agent-context 配布のみ実行 |
| `--agents=<list>` + `--no-agent-context` | agent-context skip、Skills 配布のみ実行 |
| `--agents=<list>` + `--no-skills --no-agent-context` | `--agents` は無視され WARNING (両 stage off) |
| (`--agents` 未指定) + `--no-skills --no-agent-context` | `--agents` 不要、SDD integrate / hooks / scan のみ実行 |
| `--agents=<list>` + `--integrations=<sdds>` | 独立に並行実行。Kiro 例: `--agents=kiro` で `.kiro/skills/`、`--integrations=kiro` で `.kiro/steering/` を両方配布 |
| `--agents=<list>` + `--force` | 配布先 artgraph 管理範囲 (SKILL.md / マーカー block) を強制上書き、マーカー外ユーザーコンテンツは保護 |

### 終了コード

| 終了コード | 意味 |
|---|---|
| 0 | 配布成功 (新規 or 冪等 no-op) |
| 非 0 | 引数エラー / 配布中断 / 既存ファイル conflict 検出 (`--force` なし) |

---

## `artgraph doctor`

### シグネチャ

```text
artgraph doctor [--agents=<csv>] [--format text|json]
```

新規サブコマンド (R4 で決定)。`artgraph check` のフラグ群とは独立。

### オプション

| フラグ | 既定値 | 説明 |
|---|---|---|
| `--agents=<csv>` | (省略時 = 配布検出された全エージェント) | 診断対象を絞る。値仕様は init と同じ |
| `--format <fmt>` | `text` | `text` (人間向け) または `json` (機械可読) |

### 診断項目 (FR-011)

1. **Skill 配布物の存在 + sha256 一致** (各 Tier 1 配布先について全 `templates/skills/` 由来ファイル)
2. **`_shared/` 部品の配布** (上記に含む)
3. **AGENTS.md セクションマーカー整合** (`<!-- artgraph:begin -->` 〜 `<!-- artgraph:end -->` のペアが揃っているか)
4. **ラッパーファイル存在** (`claude` 配布あり → `CLAUDE.md` 存在、`copilot` 配布あり → `.github/copilot-instructions.md` 存在)
5. **ラッパー内 `@AGENTS.md` literal 存在** (artgraph 管理 block 内に literal 文字列があるか)
6. **`extraneous-file` 検出**: 配布先 `<agent>/skills/` 配下に canonical (`templates/skills/`) に存在しないパスが居残っていないか

### 終了コード

| 終了コード | 意味 |
|---|---|
| 0 | 全 finding が PASS (or 配布対象 0 件で診断スキップ) |
| 非 0 | 1 件以上の FAIL finding |

### text 出力例

```text
artgraph doctor — Tier 1 distribution health check

[claude] .claude/skills/
  ✓ artgraph-impact/SKILL.md            (sha256 match)
  ✓ _shared/install-check.md            (sha256 match)
  ...
  ✓ wrapper CLAUDE.md exists, @AGENTS.md import present

[codex] .agents/skills/
  ✗ artgraph-verify/SKILL.md            (sha256 drift)
       expected: a1b2c3...  actual: f4e5d6...
  ...

AGENTS.md: ✓ marker block intact

Summary: 12 pass, 1 fail
Exit: 1
```

### json 出力 schema

[doctor-output.md](./doctor-output.md) 参照。

---

## 互換性ノート

- 既存 `artgraph init` の他フラグ (`--no-scan` / `--integrations=<>` / `--integrate-gate` / `--force` / `--format` ほか) は本 spec で**変更しない**。
- `--with-skills` / `--with-agent-context` (現状 `--minimal` 補助の opt-in) は **将来削除候補**だが本 spec のスコープ外。互換維持のため当面残す (実質的に `--agents` 必須化により `--with-skills` は冗長化するが、削除は別 PR で評価)。
- 未リリースのため広域な後方互換意識は不要 (spec Assumptions)。
