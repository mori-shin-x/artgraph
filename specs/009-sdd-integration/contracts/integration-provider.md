# Contract: `IntegrationProvider` インターフェース

**Layer**: `packages/artgraph/src/integrate/providers/types.ts`

**Used by**: `registry.ts` / `runner.ts` / CLI `integrate <tool>` / `init --integrate=...`

**Related**: [data-model.md §1](../data-model.md#1-integrationproviderfr-018-で確定したプロバイダ抽象), [spec FR-018 / FR-019 / FR-020](../spec.md)

---

## ライフサイクル契約

各 provider は以下 3 操作を提供する。すべて純関数的（同入力→同出力、副作用は `install` / `uninstall` の disk 書き込みのみ）。

### 1. `detect(rootDir)` — 検出

**入力**: `rootDir: string`（絶対パス推奨、相対は `resolve` 経由）

**出力**: `boolean`

**契約**:
- 副作用なし（読み取りのみ）。
- 1 秒以内に完了（SC-004）。
- 当該 SDD ツールのルートマーカー（`.specify/` / `.kiro/`）が `rootDir` 直下に存在すれば true。
- マーカーが symlink でも追跡せず `existsSync` の判定をそのまま返す。

### 2. `isInstalled(rootDir)` — 導入状態判定

**入力**: `rootDir: string`

**出力**: `boolean`

**契約**:
- 副作用なし。
- 「artgraph integration が現在この repo に有効化されているか」を返す。
- 判定基準（provider 別）：
  - **SpecKit**: `.specify/extensions.yml` の `installed` 配列に `spectrace` が含まれている **かつ** `.specify/extensions/spectrace/extension.yml` が存在する。両方揃って初めて true。
  - **Kiro**: `.kiro/steering/spectrace.md` が存在する。
- 部分インストール状態（installed リストにあるが extension.yml がない、等）は false を返す。再 install を促す。

### 3. `install(rootDir, opts)` — インストール / 更新

**入力**:
- `rootDir: string`
- `opts: InstallOptions`（`force?: boolean`、`gate?: boolean`）

**出力**: `IntegrateResult`

**契約**:
- **冪等**: 同 `opts` で 2 回呼ぶと 2 回目は `noop: true` を返し disk 不変（FR-004）。
- **atomic**: いずれかのファイル書き込みが失敗したら、この `install` 呼び出しで作成・変更したすべてのファイルを実行前状態に戻す（edge case）。
- **detect 失敗**: `detect(rootDir) === false` の場合は `Error("Spec Kit not detected at <rootDir>")` 相当を throw。disk は不変。
- **力学**:
  - `force: false` かつ既存ファイル衝突あり → 上書きせず `noop: true` でその旨を `warnings` に積む（fail はしない、provider 別に粒度を判断）。
  - `force: true` → 既存を上書き / 削除して新規生成。
- **--gate のセマンティクス**（SpecKitProvider 専用、FR-003）：
  - `gate === true` → `hooks.before_implement` に spectrace の hook entry を追加（既存なら no-op）。
  - `gate === false` → `hooks.before_implement` から spectrace の hook entry を削除（存在しないなら no-op）。
  - `gate === undefined` → before_implement に対して何もしない（追加も削除もしない）。
- **書き込み権限なし**: `EACCES` 等の disk エラーで throw。すでに書いたファイルは巻き戻し済み。

### 4. `uninstall(rootDir)` — 削除

**入力**: `rootDir: string`

**出力**: `IntegrateResult`

**契約**:
- 副作用：当 provider が install で生成したファイル・追記行をすべて削除する。
- 他 Extension が登録した hook entry は触らない（spec edge case）。
- `isInstalled(rootDir) === false` の場合は `noop: true` を返す（fail しない）。
- 削除済みファイルは `removed: string[]` で列挙。

---

## 副作用境界（atomic-write 経由のみ）

provider 内のすべての disk 書き込みは以下のいずれかを経由しなければならない：

| 操作 | 経由するレイヤ | 失敗時の巻き戻し責務 |
|---|---|---|
| 単一ファイル書き込み | `atomicWriteFile` (atomic-write.ts) | 失敗時 tmp は自動削除、target は不変 |
| guidance Markdown 配置 | `writeGuidanceFile` (guidance.ts) | 内部で atomicWriteFile を使う |
| Spec Kit `extensions.yml` 編集 | `speckitYaml.update` (speckit-yaml.ts) | parse → 変更 → serialize → atomicWriteFile |
| ディレクトリ生成 | `mkdirSync({ recursive: true })` 直接 | 巻き戻しは provider 側で `rmSync` |
| ファイル削除 | `rmSync` 直接 | 削除前の content を保持し、エラー時に再書き込み |

provider が直接 `fs.writeFileSync` を呼ぶことは禁止（テストで grep 検査）。

---

## レジストリ契約（`registry.ts`）

```ts
export function registerProvider(provider: IntegrationProvider): void;
export function getProvider(id: IntegrationProviderId): IntegrationProvider | undefined;
export function listProviders(): IntegrationProvider[];
```

- 登録は静的（モジュール初期化時に `speckit` と `kiro` を register）。
- `listProviders()` は登録順を保証（speckit → kiro）。
- 未知 id を `getProvider` に渡すと undefined を返す（throw しない）。CLI 側で fail を判断。

---

## テスト要件（TDD Red 段階で先に書く）

| テスト名 | 期待 |
|---|---|
| `detect` returns true when marker dir exists | tmpdir に `.specify/` 作成 → true |
| `detect` returns false otherwise | 空 tmpdir → false |
| `isInstalled` returns false on partial install | `installed: [spectrace]` あるが extension.yml なし → false |
| `install` is idempotent | 2 回連続 install で 2 回目 `noop: true`、disk 不変 |
| `install` throws when not detected | 空 tmpdir で SpecKitProvider.install → throws、disk 不変 |
| `install --force` overwrites existing | 既存 extension.yml を別内容で上書き |
| `install --gate=true` adds before_implement hook | extensions.yml に該当 entry が追加 |
| `install --gate=false` removes before_implement hook | 既存 spectrace 由来 entry のみ削除、他 Extension entry は残存 |
| `install --gate=undefined` does not touch before_implement | 既存状態を維持 |
| `install` rolls back on disk error | mid-way で EACCES → 部分書き込み無し |
| `uninstall` removes installed marker | installed リストから spectrace 削除、extension.yml dir 削除 |
| `uninstall` preserves other extensions' hooks | 同 hook trigger の他 entry は不変 |
| `uninstall` is no-op when not installed | 未導入 repo で noop: true |
