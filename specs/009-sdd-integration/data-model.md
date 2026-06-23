# Phase 1: Data Model — SDD ツールワークフロー統合

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Date**: 2026-06-23

本機能は永続データを生成しない（lock ファイル更新なし）。以下はランタイム上のドメイン型と、`packages/artgraph/src/types.ts` および `src/integrate/providers/types.ts` に追加する TypeScript 型定義。

---

## 1. `IntegrationProvider`（FR-018 で確定したプロバイダ抽象）

```ts
export interface IntegrationProvider {
  /** Provider 識別子。CLI で `integrate <id>` の引数になる。例: "speckit", "kiro" */
  readonly id: IntegrationProviderId;

  /** ヒューマンリーダブル名。`integrate list` 出力で使う。例: "Spec Kit", "Kiro" */
  readonly displayName: string;

  /** 検出マーカー（init での案内・list の表で利用）。例: ".specify", ".kiro" */
  readonly marker: string;

  /** リポジトリにこのツールがあるかを判定。副作用なし。 */
  detect(rootDir: string): boolean;

  /** すでに本機能でインストール済みかを判定。副作用なし。 */
  isInstalled(rootDir: string): boolean;

  /**
   * 統合をインストール/更新する。冪等。
   * `opts.force` で既存ファイルの上書きを許可、`opts.gate` で --gate モード（speckit のみ意味あり）。
   * `opts.gate === false` は明示的削除（--no-gate）。`opts.gate === undefined` は「指定なし＝gate なし」。
   * 戻り値は適用結果（生成・変更ファイル一覧と人間向け次手順）。失敗時は throw。
   */
  install(rootDir: string, opts: InstallOptions): IntegrateResult;

  /** 統合を削除する（installed リスト entry + hook + 生成ディレクトリ）。 */
  uninstall(rootDir: string): IntegrateResult;
}

export type IntegrationProviderId = "speckit" | "kiro";
// 注: 将来 OpenSpec 対応時は "openspec" を union に追加（FR-018 のプロバイダ追加余地）。

export interface InstallOptions {
  /** 既存ファイルの上書きを許可（--force） */
  force?: boolean;
  /**
   * Spec Kit の --gate / --no-gate 宣言型フラグ（FR-003）。
   * - true: before_implement に check --gate hook を追加
   * - false: spectrace が登録した before_implement hook を削除
   * - undefined: 何もしない（gate なし状態と等価。明示削除はしない）
   *
   * 注: speckit 以外の provider は本フラグを無視する。
   */
  gate?: boolean;
}
```

**不変条件**:
- `detect()` と `isInstalled()` は純関数（同じ入力で同じ結果）。
- `install()` を同じ `(rootDir, opts)` で 2 回呼んだ後の disk 状態は 1 回目と一致（FR-004）。
- `uninstall()` 後に `isInstalled() === false`。
- `install()` のエラー時、disk は実行前の状態に戻っている（edge case「途中失敗時の巻き戻し」）。

---

## 2. `IntegrateResult`（FR-015 の構造化出力）

```ts
export interface IntegrateResult {
  /** どの provider の結果か */
  providerId: IntegrationProviderId;

  /** この実行で新規生成されたファイル（rootDir からの相対パス） */
  created: string[];

  /** この実行で内容が変更されたファイル（rootDir からの相対パス） */
  modified: string[];

  /** この実行で削除されたファイル（uninstall や --no-gate 時の hook 削除）（rootDir からの相対パス） */
  removed: string[];

  /** 何も変わらなかった場合 true（冪等再実行・統合済みなど） */
  noop: boolean;

  /** ユーザーに次に推奨するコマンド（CLI text 出力用、複数行を想定） */
  nextSteps: string[];

  /** 警告（非エラー、例: --gate なしで実行されたが gate が既存）。CLI 出力で表示 */
  warnings: string[];
}
```

---

## 3. `DetectionResult` 拡張（既存 `src/types.ts` の `DetectionResult` に integrations を追加）

既存：
```ts
export interface DetectionResult {
  hasSrc: boolean;
  hasSpecs: boolean;
  hasDocs: boolean;
  sddTools: SddToolInfo[];
}
```

拡張：
```ts
export interface DetectionResult {
  hasSrc: boolean;
  hasSpecs: boolean;
  hasDocs: boolean;
  sddTools: SddToolInfo[];
  /** 検出された SDD ツールごとの artgraph integration 導入状態 */
  integrations: IntegrationStatus[];
}

export interface IntegrationStatus {
  providerId: IntegrationProviderId;
  displayName: string;
  marker: string;
  detected: boolean;     // 当該 SDD ツールがこのリポジトリにあるか
  installed: boolean;    // artgraph integration が既に導入済みか
}
```

**用途**:
- `init` の案内表示（FR-012/013）で `detected && !installed` の provider について「`artgraph integrate <id>` で統合できます」を表示。
- `integrate list` の出力で全 provider × 検出状態 × 導入状態のクロス表を生成。
- FR-019: `init` と `integrate` で同じ `IntegrationProvider.detect` を呼ぶことを保証する単一データ構造。

---

## 4. `HookEntry`（Spec Kit `extensions.yml` の hook 配列要素）

```ts
export interface HookEntry {
  extension: string;
  command: string;
  enabled: boolean;
  optional: boolean;
  priority: number;
  prompt: string;
  description: string;
  condition: string | null;
}

export type HookTrigger =
  | "before_specify" | "after_specify"
  | "before_clarify" | "after_clarify"
  | "before_plan"    | "after_plan"
  | "before_tasks"   | "after_tasks"
  | "before_implement" | "after_implement";
```

**バリデーション**:
- `priority` は非負整数。
- `condition: null` は「常に発火」、文字列の場合は本機能では生成せず（条件式解釈はランナー側責務、`/speckit-clarify` で確認済み）。
- `extension` 値は `installed:` リストに登場している必要がある（speckit-yaml editor がチェック）。

---

## 5. `GuidanceWriteRequest`（共通 agent-guidance generator の入力）

```ts
export interface GuidanceWriteRequest {
  /** 出力先（rootDir からの相対 or 絶対）。例: ".kiro/steering/spectrace.md" */
  destPath: string;

  /** 書き込む内容。テンプレート展開済みの最終 string */
  content: string;

  /** 既存ファイルがあるときに上書きするか（CLI --force と直結） */
  force: boolean;

  /** 親ディレクトリが存在しない場合に自動作成するか（既定 true） */
  createParentDirs?: boolean;
}

export interface GuidanceWriteResult {
  /** 実際に書き込みが起きたか（既存 == content で no-op の場合は false） */
  written: boolean;

  /** 既存ファイルがあったか */
  hadExisting: boolean;

  /** 親ディレクトリを新規作成したか */
  createdParentDirs: boolean;
}
```

**用途**: 本機能では `KiroProvider` のみが利用。将来 OpenSpec 等の Skills 配布も同 generator を経由する設計（FR-020）。

---

## 6. `SpecKitExtensionManifest` / `SpecKitInstalledExtensionsYaml`（凍結スキーマ v1.0）

詳細スキーマは [contracts/speckit-extension-schema.md](./contracts/speckit-extension-schema.md) を参照。`src/integrate/schemas/speckit-1.0.ts` で次の 2 型をエクスポートする：

```ts
export interface SpecKitExtensionManifest {
  schema_version: "1.0";
  extension: {
    id: string;
    name: string;
    version: string;
    description: string;
    author: string;
    repository: string;
    license: string;
  };
  requires: { speckit_version: string };
  provides: {
    commands: Array<{ name: string; file: string; description: string }>;
  };
  hooks: Partial<Record<HookTrigger, { command: string; optional: boolean; description: string }>>;
  tags: string[];
}

export interface SpecKitInstalledExtensionsYaml {
  installed: string[];
  settings: { auto_execute_hooks: boolean };
  hooks: Partial<Record<HookTrigger, HookEntry[]>>;
}
```

---

## エンティティ関係図（概要）

```
CLI (cli.ts integrate <tool>)
   └─ runIntegrate (runner.ts)
        └─ Registry.get(tool) → IntegrationProvider
             ├─ SpecKitProvider
             │    ├─ SpecKitTemplate (templates/integrate/speckit/)
             │    ├─ SpecKitExtensionManifest (schemas/speckit-1.0.ts)
             │    └─ SpecKitYamlEditor (speckit-yaml.ts)
             │         └─ HookEntry[] / SpecKitInstalledExtensionsYaml
             └─ KiroProvider
                  ├─ KiroTemplate (templates/integrate/kiro/)
                  └─ GuidanceGenerator (guidance.ts)
                       └─ GuidanceWriteRequest → GuidanceWriteResult

DetectionResult.integrations: IntegrationStatus[]    ← init.ts と integrate-list で共有
IntegrateResult                                       ← CLI text/JSON フォーマッタの入力
```
