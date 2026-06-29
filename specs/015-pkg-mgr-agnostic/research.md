# Phase 0 Research: Bun / Deno 実動作と `npm:artgraph/cli` 解決

**Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Date**: 2026-06-28

本 spec の最大リスクは「PM 非依存を謳うが Bun / Deno で実際に動かない」ことだった (とくに `ts-morph` の Deno 互換性)。Phase 1 実装前に**実測**して確定する。以下はこのリポジトリの `dist/cli.js` (`pnpm build` 出力) を各ランタイムで走らせた結果。

## 検証環境

| ランタイム | バージョン |
|---|---|
| Node.js | v22.22.2 |
| Bun | 1.3.11 |
| Deno | 2.9.0 (typescript 6.0.3, v8 14.9) |

fixture: `package.json` (`type: module`) + `specs/auth.md` (`REQ-001`) + `src/auth.ts` (`@impl REQ-001`) の最小プロジェクト。

## R1: Bun での CLI 動作 — ✅ 完全動作

`bun /path/to/dist/cli.js <cmd>` で実行:

| コマンド | 結果 |
|---|---|
| `init --minimal --no-skills` | exit 0、`.artgraph.json` 生成 |
| `scan` (**ts-morph 経由**) | exit 0、`Nodes: 3 Edges: 2` |
| `check` | exit 0、`REQ-001: impl-only` / `All checks passed.` |

**結論**: Bun は Node-compat で artgraph CLI を問題なく実行できる。`fs.promises` / `process.argv` / `ts-morph` (TypeScript compiler) すべて動作。`bunx artgraph` を正式サポートとする。

## R2: Deno での CLI 動作 + ts-morph 互換性 — ✅ 動作 (懸念は杞憂)

事前の懸念: 「Deno は独自 TS パーサを持つため `ts-morph` (TypeScript compiler 依存) が動かないかもしれない」。

`deno run -A /path/to/dist/cli.js <cmd>` で実行:

| コマンド | 結果 |
|---|---|
| `init --minimal --no-skills` | exit 0 |
| `scan` (**ts-morph 経由**) | exit 0、`Nodes: 3 Edges: 2` |

**結論**: Deno 2.x の Node 互換レイヤで `ts-morph` は**そのまま動作する**。Deno は独自 TS パーサを「型チェック」に使うが、npm パッケージとして読み込まれた `typescript` パッケージはそのまま実行されるため、`ts-morph` が内部で持つ TS compiler が機能する。**Deno を正式サポート対象にできる** (best-effort 降格は不要)。

> 注意: Deno のバージョン要件。`deno add` subcommand は Deno >= 1.42 で導入 (`npm:` specifier 自体は Deno 1.28 で stable)。本検証は 2.9.0。対応表には「Deno >= 1.42 (`deno add`)」を明記する。

## R3: `deno run -A npm:artgraph/cli` の解決 — ⚠️ `exports` に `./cli` 追加が必須

`npm:<pkg>/<subpath>` は npm パッケージの `exports` マップに従ってサブパスを解決する (Deno も Node も同じ Node.js exports 仕様)。現状の `package.json` を `npm pack` → ローカル install し、Node の `require.resolve` (= exports マップ解決の忠実な代理) で確認:

| `exports` の状態 | `artgraph/cli` の解決 |
|---|---|
| 現状 (`{ "./package.json": "./package.json" }`) | ❌ `ERR_PACKAGE_PATH_NOT_EXPORTED` |
| `"./cli": "./dist/cli.js"` を追加 | ✅ `.../dist/cli.js` に解決 |

加えて、現状は bare `artgraph` (main) も `exports` 未定義のため module 解決不可 (`No "exports" main defined`)。CLI 起動は `bin` 経由 (`npx`/`bunx`/`pnpm exec`) なので bare import は不要だが、`deno run -A npm:artgraph/cli` だけは **サブパス export が必須**。

**結論**: `package.json` の `exports` に `"./cli": "./dist/cli.js"` を追加する (FR-016 の前提)。これは Node/Bun の `npx`/`bunx`/`pnpm exec` (bin 経由) には影響しない安全な追加。

## R4: artgraph の npm 公開状況 — 未公開

`npm view artgraph` は 404。README の npm バッジは公開予定のプレースホルダ。

**含意**: CI の Deno smoke test は **`deno run -A npm:artgraph/cli`** (レジストリ依存) を直接は使えない。代わりに、ビルド済 `dist/cli.js` を **`deno run -A ./dist/cli.js`** で実行する形か、`npm pack` → ローカル install したパッケージを `deno run -A npm:artgraph/cli`(--node-modules-dir + ローカルレジストリ) で実行する形にする。最小コストは前者 (`dist/cli.js` 直接実行) で、これは R2 で動作確認済。`npm:artgraph/cli` 経路 (exports `./cli`) の正当性は R3 の Node resolve 代理検証でカバーする。公開後に E2E で `npm:` 経路を本検証する旨を docs に残す。

## CI 方針の確定 (FR-017)

- **npm / pnpm / bun**: それぞれの runner で `init` → `scan` → `check` を実行する smoke job。すべて exit 0 を期待 (実測済)。
- **deno**: `deno run -A ./dist/cli.js init/scan/check` を実行 (未公開のため `npm:` ではなくビルド成果物を直接実行)。exit 0 を期待 (実測済)。**continue-on-error は不要** — Deno は正式サポート。
- deno のセットアップは `denoland/setup-deno` action か、CI 環境で利用可能なら `npm i -g deno` でも可 (本調査環境では後者で 2.9.0 を取得できた)。

## 設計判断の更新

| 判断 | 確定内容 |
|---|---|
| Deno を best-effort/未サポートにするか | **正式サポート** (ts-morph 動作確認済)。spec.md / 対応表の「未サポートなら降格」分岐は発火しない |
| `exports` 変更 | `"./cli": "./dist/cli.js"` を追加する (必須) |
| CI の Deno 実行方法 | 未公開のため `deno run -A ./dist/cli.js` を使う。`npm:artgraph/cli` 経路は exports 追加 + Node resolve 代理で担保し、公開後に本 E2E |
| Bun の exec | `bunx artgraph` を正式サポート |
