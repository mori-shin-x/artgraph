# Contract: CLI Flag Surface

**Feature**: impact CLI 再設計 + plan-coverage 新設 | **Date**: 2026-06-28

本 feature で改修される `artgraph impact` と新設される `artgraph plan-coverage` の CLI フラグ最終形を定義する。仕様の単一情報源。実装と test はこの contract を起点に書く。

---

## `artgraph impact` (改修)

### Synopsis

```
artgraph impact [targets...] [options]
```

### Positional arguments

| arg | type | 説明 |
|---|---|---|
| `[targets...]` | string[] | **file path のみ**(REQ-ID / `doc:` prefix は受け付けない) |

### Options

| flag | type | default | 説明 |
|---|---|---|---|
| `--from-tasks <path>` | string | — | tasks.md から file 群を抽出して起点にする(抽出戦略: `sdd-files-parser.md`) |
| `--from-plan <path>` | string | — | plan.md から同様に抽出 |
| `--diff` | boolean | false | `git diff` から file 群を起点にする |
| `--depth <n>` | int(≥0) | undefined | BFS の最大深度 |
| `--format <fmt>` | enum(`json`\|`text`) | `text` | 出力形式 |
| `--mode <m>` | enum(`file`\|`symbol`) | (config) | analysis mode(既存) |

### 起点入力の制約

- `[targets...]` / `--from-tasks` / `--from-plan` / `--diff` は **mutually exclusive**(2 種類以上を同時指定するとエラー)
- いずれも指定が無い場合はエラー(無音終了しない)

### Exit codes

| code | 条件 |
|---|---|
| 0 | 正常終了 |
| 1 | 引数エラー / file 抽出ゼロ / 起点 file の graph node 解決失敗 / **REQ-ID 風入力**(FR-003 専用エラー、4 経路案内付き) |

### REQ-ID 風入力時の専用エラー

`/^[A-Z]+-\d+$/` にマッチする positional 引数が来た場合:

```
error: REQ-ID inputs are not accepted by `artgraph impact`.
use one of the following start sources:
  artgraph impact <file>...          # explicit file paths
  artgraph impact --from-tasks <p>   # extract files from tasks.md
  artgraph impact --from-plan <p>    # extract files from plan.md
  artgraph impact --diff             # use git diff
```

### Examples

```bash
# 明示 file 起点
artgraph impact src/auth.ts src/session.ts

# tasks.md 起点
artgraph impact --from-tasks specs/014-reinvent-impact-cli/tasks.md --format json

# git diff 起点
artgraph impact --diff --depth 3
```

---

## `artgraph plan-coverage` (新設)

### Synopsis

```
artgraph plan-coverage [options]
```

### Options

| flag | type | default | 説明 |
|---|---|---|---|
| `--spec <dir>` | string | (auto-detect) | spec ディレクトリ明示(下記探索順序) |
| `--tasks <path>` | string | `<spec-dir>/tasks.md` | tasks.md 明示 |
| `--plan <path>` | string | `<spec-dir>/plan.md`(存在すれば) | plan.md 明示 |
| `--format <fmt>` | enum(`json`\|`text`) | `text` | 出力形式 |
| `--gate` | boolean | false | 暗黙波及非空 or diagnostics 非空 → exit 1 |
| `--ignore <csv>` | string | "" | カンマ区切り REQ-ID を当回限定で除外(永続化しない) |
| `--require-files-section` | boolean | (config) | tasks.md の各 task block に `Files:` セクション必須化。`.artgraph.json` の `{ "planCoverage": { "requireFilesSection": bool } }` を override |

### `--spec` 自動探索順序

`--spec` 未指定時:

1. `SPECIFY_FEATURE_DIRECTORY` 環境変数(Spec Kit canonical)
2. `.specify/feature.json` の `feature_directory` キー(Spec Kit canonical, `github/spec-kit:scripts/bash/common.sh:get_feature_paths()` 準拠)
3. どちらも無ければエラー(下記)

```
error: cannot resolve spec directory.
either set SPECIFY_FEATURE_DIRECTORY, or run from a Spec Kit project,
or pass --spec explicitly:
  artgraph plan-coverage --spec .specify/specs/<name>/
  artgraph plan-coverage --spec .kiro/specs/<name>/        # Kiro
```

**Kiro 利用時は `--spec` 必須**(Kiro 公式 docs 上 canonical な current spec 指標が存在しないため)。

### Exit codes

| code | 条件 |
|---|---|
| 0 | (a) `--gate` 無し、または (b) `--gate` あり and `implicitImpacts` 空 and `diagnostics` 空 |
| 1 | `--gate` あり and (`implicitImpacts` 非空 or `diagnostics` 非空) |
| 1 | 引数エラー / `--spec` 解決失敗 / `--tasks` ファイル不在 / file 抽出ゼロ |

`--ignore` で除外した結果 `implicitImpacts` がゼロになれば `--gate` 付きでも exit 0。

### Examples

```bash
# auto-detect (Spec Kit canonical lookup)
artgraph plan-coverage

# 明示 spec dir
artgraph plan-coverage --spec .specify/specs/014-reinvent-impact-cli/

# Kiro project (--spec 必須)
artgraph plan-coverage --spec .kiro/specs/auth-2fa/

# CI gating
artgraph plan-coverage --gate --format json

# 一時的に特定 REQ を除外して CI 通す
artgraph plan-coverage --gate --ignore REQ-003,REQ-007

# Files: セクション強制 (opt-in 厳格モード)
artgraph plan-coverage --require-files-section
```

---

## Cross-cutting

### Format 共通

- `--format text`: human-readable、デフォルト
- `--format json`: 機械可読、スキーマは `plan-coverage-json.md` 参照

### `--mode` の意味(既存 impact)

`--mode file` は file ノード起点 BFS、`--mode symbol` は symbol ノード起点 BFS。本 feature では `impact` のみが受け付け、`plan-coverage` は内部で `impact()` を呼ぶ際に config の mode を継承する(`plan-coverage` 自体に `--mode` フラグは追加しない — config 経由)。

### Removed (撤去) フラグ / 引数

- `artgraph impact` の REQ-ID 起点入力(`artgraph impact REQ-001` 等): FR-001 で撤去。撤去理由と移行先は上記専用エラー参照
- `artgraph impact` の `doc:` prefix 入力(`artgraph impact doc:specs/foo.md` 等): FR-001/FR-002 で撤去。`resolveStartIds` から `doc:` 解決パスを削除
