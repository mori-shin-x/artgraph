# Contract: CLI Flag Surface

**Feature**: Agent-Native Toolkit | **Date**: 2026-06-27

本 feature で追加・改修される `artgraph` CLI フラグの最終形を定義する。既存フラグの後方互換 (constraint) を保つ。

---

## `artgraph init`

### 既存フラグ (改変なし)

| flag | type | default | 説明 |
|------|------|---------|------|
| `--force` | boolean | false | 既存 `.artgraph.json` を上書き |
| `--no-scan` | boolean | false | init 後の scan + reconcile をスキップ |
| `--with-skills` | boolean | false | `templates/skills/*` を `.claude/skills/` にコピー (P0 で対象拡大、フラグ仕様は不変) |
| `--integrate <tools>` | string (csv) | "" | カンマ区切りで指定された SDD ツール統合を順次実行 (例: `--integrate=speckit,kiro`) |
| `--integrate-gate` / `--no-integrate-gate` | boolean | true | `--integrate` 経由で配備される統合に `--gate` を含めるか |
| `--format <json\|text>` | string | text | 出力形式 |

### 新規フラグ

| flag | type | default | 説明 | Phase |
|------|------|---------|------|-------|
| `--integrate=auto` | special value | — | `--integrate` の特殊値。検出された全 SDD ツールを順次統合 (R11)。`--integrate=auto` と `--integrate=speckit,kiro` は排他 (両指定はエラー) | **P0** (FR-003) |
| `--with-hooks` | boolean | false | `.claude/settings.json` に Stop hook (`npx artgraph check --gate --diff`) を merge 配備 (R4 fail-on-conflict)。`templates/hooks/settings.json.template` を ソースとする | **P1** (FR-012, FR-013) |
| `--with-agent-context` | boolean | false | CLAUDE.md / AGENTS.md に `<!-- artgraph: BEGIN ... END -->` で囲った 30 行スニペットを注入 (R3 境界マーカー)。両ファイル無ければ CLAUDE.md を新規作成 | **P1** (FR-014, FR-015) |

### `artgraph-setup` Skill が組み立てる典型コマンド

```bash
# 新規プロジェクト
npx artgraph init --with-skills --integrate=auto --with-hooks --with-agent-context

# 既存 .artgraph.json があるが Skills/Hooks 未配備
npx artgraph init --force --with-skills --integrate=auto --with-hooks --with-agent-context
```

### 既存挙動の保持 (後方互換 constraint)

- フラグなし `artgraph init` は今まで通り `.artgraph.json` のみ生成 (新規フラグは default で off)
- 既存 4 Skill ファイル (`templates/skills/artgraph-{plan,verify,coverage,rename}.md`) が単一ファイル → ディレクトリ形式へ移行 (P0) するが、`installSkills()` は両形式を扱えるよう拡張する (P0 完了後は単一ファイル形式は不要)

---

## `artgraph integrate`

### 既存サブコマンド (改変なし)

| invocation | 説明 |
|------------|------|
| `artgraph integrate list` | 利用可能 provider 一覧と detect/installed 状況を出力 |
| `artgraph integrate <tool>` | 指定 tool 用配備物を配置 |
| `artgraph integrate <tool> --gate` | `--gate` モード (Spec Kit の before_implement hook など、ゲート用配備物を含めて配置) |
| `artgraph integrate <tool> --force` | 既存配備物を上書きして再配置 |
| `artgraph integrate <tool> --uninstall` | 配備物を撤去 |
| `artgraph integrate <tool> --format <json\|text>` | 出力形式 |

### 新規 tool 値

| tool 値 | 説明 | Phase |
|---------|------|-------|
| `openspec` | OpenSpec community schema (`openspec/schemas/artgraph/`) を配備 | **P3** (FR-025, FR-026) |

### 新規 オプション

| flag | provider 対象 | 説明 | Phase |
|------|---------------|------|-------|
| `--with-hooks` | `kiro` のみ | `.kiro/hooks/artgraph-verify.json` Smart Hook テンプレを配備 (`after_save` で `artgraph verify --diff`) | **P3** (FR-024) |

### `--gate` の意味 (provider 別、参考)

| provider | `--gate` で配備される追加物 |
|----------|----------------------------|
| `speckit` | `commands/artgraph.check-gate.md` + `extension.yml` の `hooks.before_implement` |
| `kiro` | (現状特になし。steering 本文に gate 案内を含むのみ) |
| `openspec` | `schema.yaml` の apply フェーズ verify ステップで `artgraph check --diff` を必須化 |

### `artgraph integrate list` 出力 (text 形式)

```text
Available integrations:
  speckit    [detected] [not installed]
  kiro       [detected] [installed]
  openspec   [not detected]
```

JSON 形式:
```json
{
  "providers": [
    { "id": "speckit", "detected": true, "installed": false },
    { "id": "kiro", "detected": true, "installed": true },
    { "id": "openspec", "detected": false, "installed": false }
  ]
}
```

### exit code 規約

| 状況 | exit code |
|------|-----------|
| 正常 (配備成功 / no-op の auto integrate) | 0 |
| 一般エラー (引数不正、tool 名不正、書込失敗等) | 1 |
| 既存ファイルとの衝突 (`--force` なしで `isInstalled()` true) | 1 (既存挙動) |
| **Stop hook 衝突 (P1: `--with-hooks` での既存設定衝突)** | **1** (FR-013 fail-on-conflict)。stderr に手動マージ手順を出力 |

---

## 後方互換性チェックリスト

- [ ] 既存スクリプトで `artgraph init` (フラグなし) を呼んでいるユーザーに影響なし (新規フラグは default off)
- [ ] 既存 `artgraph init --with-skills` の挙動が変わらない (P0 改修後も `.claude/skills/` への Skill コピーは同じ動作。ファイル名は ディレクトリ + `SKILL.md` 形式に変更だが install 結果のセット名は変わらない)
- [ ] 既存 `artgraph integrate speckit --gate` の挙動が変わらない
- [ ] `--integrate=speckit,kiro` の挙動が変わらない (`auto` は新規予約値)

これらは `tests/init.test.ts` および `tests/integrate-cli.test.ts` 内の既存テストで自動検証されることを confirm する (新規テスト追加と並行)。
