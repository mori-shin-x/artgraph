# P1 残タスク — init コマンド + symbol-level 粒度

> ブランチ: `p1/init` + `p1/symbol-level`（並列作業可）
> 前提: main (commit 06341ec) から分岐

## 概要

P1 コアは scan/impact/check/reconcile + lock + drift 検出まで完了済み。
残りは 2 つ: `init` コマンドと symbol-level 粒度。
どちらもグラフモデル（types.ts）やチェックロジック（check.ts）への変更は不要で、
パーサ層（parsers/typescript.ts）と CLI 層（cli.ts）への追加が中心。

---

## 1. `init` コマンド

設計 doc 7 節: 設定・lock の雛形生成。

### やること

`init` は設定生成 + 初回 scan + lock 生成までを一気に実行し、
「動いた」という手応えを返すコマンドにする。

実行フロー:
1. `.spectrace.json` 生成（ディレクトリ検出でデフォルト調整）
2. scan 実行（グラフ構築）
3. 結果サマリ表示（`Nodes: 8  Edges: 12  req: 3  doc: 1 ...`）
4. `.trace.lock` 生成（reconcile）
5. 完了メッセージ + 次のステップ案内

オプション:
- `--force`: 既存ファイルがある場合の上書き許可（デフォルトは上書きせず警告して終了）
- `--no-scan`: 設定ファイル生成のみで scan/reconcile をスキップ（CI・自動化向け）

ディレクトリ検出:
- `src/` や `specs/` の存在を検出して `include` / `specDirs` のデフォルトを調整する
  - 例: `specs/` が無く `docs/` だけある → `specDirs: ["docs"]`
  - 例: `src/` が無い → `include` のパターンを `**/*.ts` に広げる
- SDD ツール検出: `.specify/` (Spec Kit) や `.kiro/` (Kiro) が存在すれば検出メッセージを表示し、`specDirs` の候補を調整する

### 変更対象

| ファイル | 変更内容 |
|---------|---------|
| `src/cli.ts` | `init` サブコマンド追加 |
| `src/init.ts` (新規) | ディレクトリ検出 + ファイル書き出し + scan/reconcile 呼び出し |
| `tests/init.test.ts` (新規) | tmp ディレクトリでの生成テスト |

### 実装メモ

- `.spectrace.json` のスキーマは `SpectraceConfig` (types.ts) そのまま
- ディレクトリ検出は `existsSync` で十分。glob は不要
- scan/reconcile は既存の `scan()` / `reconcile()` をそのまま呼ぶ
- 完了メッセージで次のステップを案内: `Run "spectrace impact --diff" to see impact of your changes.`

### テスト方針

- tmp ディレクトリを作成し `init` を実行 → `.spectrace.json` + `.trace.lock` 生成確認
- `specs/` あり/なし、`src/` あり/なし のパターンで `specDirs` / `include` のデフォルト確認
- `.specify/` あり → SDD ツール検出メッセージ確認
- 既存 `.spectrace.json` がある状態で `init` → エラー終了、`--force` → 上書き
- `--no-scan` → `.spectrace.json` のみ生成、`.trace.lock` なし
- spec/code ファイルがあるプロジェクトで `init` → サマリに正しいノード数が表示される

---

## 2. symbol-level 粒度

設計 doc D6: file-level（速い）と symbol-level（精密）を共通スキーマで持つ。

### 現状

- `parsers/typescript.ts` は全てのコードファイルを `file:path` の単一ノードとして登録
- `@impl` タグはファイルノードに紐付く（`source: "file:src/auth/login.ts"`）
- import エッジもファイル単位
- `types.ts` には `symbol` kind が定義済みだが未使用

### やること

symbol-level モードでは、エクスポートされたシンボル（関数・クラス・変数・型）を
個別の `symbol` ノードとして登録し、`@impl` タグを最寄りのシンボルに紐付ける。

#### 2a. シンボルノードの抽出

- ts-morph でソースファイルのトップレベルエクスポートを列挙
  - `getExportedDeclarations()` で取得
  - 各シンボルの ID: `symbol:path/to/file.ts#functionName`
  - contentHash: シンボルの宣言テキストの SHA256
- ファイルノード (`file:path`) もそのまま残す（file-level フォールバック用）
- ファイルノードとシンボルノード間に暗黙の包含関係は不要（エッジ型を増やさない）

#### 2b. `@impl` タグの symbol-level 解決

- `// @impl REQ-xxxx` が書かれた行番号から、それを含む最寄りのエクスポートシンボルを特定
- 該当シンボルがあれば `source: "symbol:path#name"`、なければ `source: "file:path"` にフォールバック
- ts-morph の `getDescendantAtPos()` や各 Declaration の `getStartLineNumber()` / `getEndLineNumber()` で範囲判定

#### 2c. import エッジの symbol-level 解決

- named import (`import { foo } from "./bar"`) → `symbol:source#caller` → `symbol:bar#foo`
- namespace import (`import * as bar from "./bar"`) → file-level にフォールバック
- default import → `symbol:bar#default` (default export のシンボル名解決)
- 動的 import (`import("./bar")`) → file-level にフォールバック

#### 2d. モード切り替え

- `SpectraceConfig` に `mode: "file" | "symbol"` を追加（デフォルト: `"file"`）
- CLI の `scan` / `impact` / `check` に `--mode file|symbol` フラグ追加
- file モード: 現行動作そのまま
- symbol モード: 2a-2c を有効化
- 設計 doc の指針: Hook のレイテンシ対応で PreToolUse → file、Stop/Plan → symbol

### 変更対象

| ファイル | 変更内容 |
|---------|---------|
| `src/types.ts` | `SpectraceConfig` に `mode` 追加 |
| `src/config.ts` | `mode` のデフォルト値 `"file"` |
| `src/parsers/typescript.ts` | シンボル抽出 + `@impl` 行→シンボル解決 + import symbol-level 解決 |
| `src/cli.ts` | `--mode` フラグ追加 |
| `src/graph/traverse.ts` | 変更不要（ノード/エッジの型は同じ） |
| `tests/typescript.test.ts` | symbol-level テスト追加 |
| `tests/fixtures/` | symbol-level 用の fixture ファイル追加 |

### 制約・スコープ外

- barrel/re-export の貫通解決は P3 に送る（設計 doc で最難所と記載）
  - 例: `export { foo } from "./bar"` → 直接的な re-export は解決するが、
    動的パターンや `export *` の symbol-level 解決は P3
- symbol の contentHash は宣言テキスト全体のハッシュ
  - JSDoc やコメントの変更でもハッシュが変わる（drift ノイズ）が、P1 では許容
- `symbol` kind のノードは lock にも載る（file と同じ LockEntry 構造）
- 注: PR #6 で `slug` フィールドは `specFile` に変更済み。symbol-level の実装はこの変更を前提とする

### テスト方針

- fixture: エクスポート関数 2 つ + `@impl` タグ付き → symbol ノード 2 つ + file ノード 1 つ確認
- named import → symbol-level エッジ確認
- `import *` → file-level フォールバック確認
- `@impl` が関数内 → 該当シンボルに解決、関数外 → file にフォールバック

---

## 作業順序

init と symbol-level は並列で実装可能（変更箇所の重なりは `cli.ts` のみで、触る箇所が別）。
別 worktree / 別ブランチで同時進行し、それぞれ独立して main にマージできる。

- `p1/init`: init コマンド（S、1-2 時間）
- `p1/symbol-level`: symbol-level 粒度（M、半日〜1 日）
  - 2a → 2b → 2c → 2d の順で進める
  - 2a 単体でテストを通してから 2b に進む

## 完了基準

- `spectrace init` でプロジェクトセットアップが完了する
- `spectrace scan --mode symbol` で symbol ノードが表示される
- `spectrace impact --mode symbol src/auth/login.ts` で symbol 粒度の影響が返る
- 既存の file-level テストが全て通る（リグレッションなし）
