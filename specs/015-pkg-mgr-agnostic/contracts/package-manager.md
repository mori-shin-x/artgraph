# Contract: package manager 検出 / コマンド組み立て / config schema

**Spec**: [../spec.md](../spec.md) | **Plan**: [../plan.md](../plan.md)

この contract は `src/package-manager.ts` (TS) と `templates/skills/_shared/package-manager.md` (bash) の**共通正解 (SSOT)**。両実装はこの表に一致させ、`tests/package-manager-detection.test.ts` はこの表を検証する (SC-001 / SC-003 / SC-007)。

**デフォルト PM は pnpm** (未リリースのため後方互換は考慮しない)。シグナル無し時のデフォルト・Yarn fallback・真の検出不能時の後続フォールバックを**すべて pnpm に寄せる**。明示シグナル (`package-lock.json` / `packageManager: npm@x`) がある場合のみ npm を返す (= 検出結果として尊重)。

## 1. 検出真理値表 (`detectPackageManager(rootDir)`)

検出は **上から順に評価し、最初にマッチした分岐で返す** (first match wins)。

| # | 入力条件 | 戻り値 | warning |
|---|---|---|---|
| 1a | `package.json#packageManager` が `pnpm@*` | `pnpm` | — |
| 1b | `package.json#packageManager` が `bun@*` | `bun` | — |
| 1c | `package.json#packageManager` が `npm@*` | `npm` | — |
| 1d | `package.json#packageManager` が `yarn@*` | `pnpm` | ✅ "Yarn is not supported; falling back to pnpm" |
| 2a | `bun.lockb` または `bun.lock` が存在 | `bun` | — |
| 2b | `package.json` 無し かつ (`deno.lock` / `deno.json` / `deno.jsonc` のいずれか) | `deno` | — |
| 2c | `pnpm-lock.yaml` が存在 | `pnpm` | — |
| 2d | `yarn.lock` が存在 | `pnpm` | ✅ "yarn.lock found but Yarn is not supported; falling back to pnpm" |
| 2e | `package-lock.json` が存在 | `npm` | — |
| 3 | 上記いずれも該当せず `package.json` が存在 | `pnpm` (default) | — |
| 4 | いずれも該当しない | `null` (検出不能) | ✅ "Cannot detect package manager" |

**注**:
- 評価順は 1a–1d (field) → 2a–2e (lockfile) → 3 (pkg.json default) → 4 (fail) を厳守。
- **deno の検出は row 2b の 1 箇所のみ** (`package.json` 無し かつ deno マーカーのいずれか)。`deno.lock` (lockfile) と `deno.json(c)` (config) を 1 つの分岐に統合する (元の bash スニペットの combined check と一致)。`package.json` があれば Node プロジェクトとして扱い deno 判定はしない。
- `packageManager` field のパースは `^([a-z]+)@` 形 (Corepack-style `<pm>@<version>` 形式。Corepack 本体は npm/pnpm/yarn のみ対応だが、artgraph は同形を Bun にも拡張して解釈する)。値が壊れている (`@` 抜きの bare 値含む) / 4 PM 以外の未知値なら field 分岐をスキップして lockfile sniff へフォールスルー。
- 1d / 2d の Yarn fallback 先は **pnpm** (spec 012 の bash は npm だったが本 spec で変更)。

### テスト fixture (最小 8 系統 — SC-001)

| fixture | 期待 |
|---|---|
| `package.json#packageManager: "pnpm@9"` | `pnpm` (1a) |
| `bun.lockb` のみ | `bun` (2a) |
| `package.json` 無し + `deno.json` | `deno` (2b/4) |
| `pnpm-lock.yaml` のみ | `pnpm` (2c) |
| `yarn.lock` のみ | `pnpm` + warn (2d) |
| `package-lock.json` のみ | `npm` (2e) |
| `package.json` のみ (lockfile/field 無し) | `pnpm` (3) |
| 空 dir (package.json も lockfile も deno も無し) | `null` + warn (4) |

## 2. exec コマンドマッピング (`buildExecCommand(pm, subcommand)`)

| pm | 出力 (`subcommand = "check --diff"` の例) |
|---|---|
| `npm` | `npx artgraph check --diff` |
| `pnpm` | `pnpm exec artgraph check --diff` |
| `bun` | `bunx artgraph check --diff` |
| `deno` | `deno run -A npm:artgraph/cli check --diff` |

- `subcommand` は空文字も許容 (`buildExecCommand("pnpm", "")` → `pnpm exec artgraph`)。末尾の余分な空白はトリムする。
- `_shared/package-manager.md` の Command mapping 表とこのマッピングは**完全一致**させる (SC-003)。

## 3. install コマンドマッピング (`buildInstallCommand(pm)`)

| pm | 出力 |
|---|---|
| `npm` | `npm install -D artgraph` |
| `pnpm` | `pnpm add -D artgraph` |
| `bun` | `bun add -d artgraph` |
| `deno` | `deno add npm:artgraph` |

本 spec では未使用だが、#109 / #110 が consume できるよう基盤として提供する。

## 4. `.artgraph.json` config schema 追加

```jsonc
{
  // ... 既存フィールド ...
  "packageManager": "pnpm"   // optional: "npm" | "pnpm" | "bun" | "deno"
}
```

- 型: `PackageManager = "npm" | "pnpm" | "bun" | "deno"` (`src/types.ts` で export)。`ArtgraphConfig.packageManager?: PackageManager`。
- **記録 (`runInit`)**: `detectPackageManager(rootDir)` が non-null のときのみ `config.packageManager` にセットして書き出す。`null` のときはフィールドを省略 (記録しない) + 警告。
- **読み込み (`loadConfig`)**: `raw.packageManager` が 4 値 union のいずれかなら採用、それ以外 (未知文字列 / 型違い) は無視して `undefined` 扱い (既存の lenient validate パターンに合わせる)。
- `init --force` での再実行時は再検出して上書き。`--force` 無しは既存 init 同様 `.artgraph.json` 存在でエラー。

## 5. `package.json` exports 追加 (Deno 用, research R3)

```jsonc
"exports": {
  "./package.json": "./package.json",
  "./cli": "./dist/cli.js"        // 追加: deno run -A npm:artgraph/cli の解決に必須
}
```

`bin` 経由の `npx`/`bunx`/`pnpm exec` には影響しない安全な追加。
