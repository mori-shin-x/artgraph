# Contract: Agent-Guidance Generator

**Layer**: `packages/artgraph/src/integrate/guidance.ts`

**Used by**: `providers/kiro.ts`（および将来の OpenSpec provider）

**Related**: [data-model.md §5](../data-model.md#5-guidancewriterequest共通-agent-guidance-generator-の入力), [spec FR-020 / FR-021](../spec.md), [Clarifications Q2](../spec.md#clarifications)

> Clarification Q2 で確定: Hook API を持たない SDD ツール向けのガイド文書生成（Kiro Steering、将来の OpenSpec Skills 等）を共通レイヤとして 1 つだけ実装し、provider は「配置先 path」「テンプレート本体」「変数」のみを提供する。Spec Kit Extension の YAML 追記は別レイヤ（FR-021）。

---

## シグネチャ

```ts
import type { GuidanceWriteRequest, GuidanceWriteResult } from "../types.js";

/**
 * Hook API を持たない SDD ツール向けに、エージェント挙動を導く Markdown 文書を
 * 指定の path に冪等に書き込む。
 *
 * 冪等条件:
 *  - 既存ファイルの内容が `content` と byte-for-byte 一致 → `written: false`
 *  - 既存ファイルがあるが内容が異なる → `force: true` なら上書き、false なら no-op + warnings
 *  - 親ディレクトリが無い → `createParentDirs !== false` で自動作成（既定 true）
 *
 * 副作用は disk 書き込みのみ。失敗時は throw（呼び出し側 provider が rollback）。
 */
export function writeGuidanceFile(req: GuidanceWriteRequest): GuidanceWriteResult;
```

---

## 振る舞いマトリクス

| 既存ファイル | 内容一致 | `force` | 結果 |
|---|---|---|---|
| なし | — | — | 新規書き込み、`written: true`、`hadExisting: false` |
| あり | 一致 | — | no-op、`written: false`、`hadExisting: true` |
| あり | 不一致 | `false` | no-op、`written: false`、`hadExisting: true`（warning は呼び出し側 provider が積む） |
| あり | 不一致 | `true` | 上書き、`written: true`、`hadExisting: true` |

`createParentDirs`:
- 既定 `true`。`destPath` の親ディレクトリが無ければ `mkdirSync({ recursive: true })`。
- `false` で親不在 → `ENOENT` で throw。

書き込み:
- 必ず `atomicWriteFile()` 経由（[contracts/integration-provider.md §副作用境界](./integration-provider.md#副作用境界atomic-write-経由のみ)）。
- 末尾改行 1 個を必ず付与する。

---

## テンプレート変数仕様

provider 側でテンプレート展開（`{{varName}}` プレースホルダ置換）を済ませた最終 string を `content` に渡す前提。Generator 側で変数置換は行わない（責務分離）。テンプレートエンジンはサブセットを内製で：

```ts
// templates.ts に置く小さい util。guidance.ts 自体は使わない。
export function renderTemplate(template: string, vars: Record<string, string>): string;
```

- サポートする構文は `{{ key }}` のみ（前後空白許容、ネスト・条件分岐なし）。
- 未定義 key の参照は `MissingTemplateVarError` を throw（デバッグ性のため）。
- ループ・条件分岐が必要なら provider 側で content を組み立てる（YAGNI）。

---

## 失敗モード

| エラー | 原因 | provider 側の扱い |
|---|---|---|
| `EACCES` on tmp create | 親 dir に書き込み権限なし | install 全体を throw、rollback |
| `EACCES` on rename | target ファイルに上書き権限なし | install 全体を throw、rollback |
| `ENOSPC` | disk full | install 全体を throw、rollback |
| `EXDEV` | tmp と target が別 FS | atomic-write 内で自動的に同 dir に tmp を置くので発生しない設計 |

---

## テスト要件（TDD Red 段階）

| テスト名 | セットアップ | 期待 |
|---|---|---|
| writes new file when target absent | tmpdir 空 | ファイル作成、`written: true`、`hadExisting: false` |
| no-op when target equals content | 既存 = content | `written: false`、`hadExisting: true` |
| no-op when target differs & force=false | 既存 ≠ content、force=false | disk 不変、`written: false`、`hadExisting: true` |
| overwrites when target differs & force=true | 既存 ≠ content、force=true | 内容置換、`written: true`、`hadExisting: true` |
| creates parent dirs when missing | 親 dir 不在 | 親 dir 生成、ファイル作成、`createdParentDirs: true` |
| fails when parent missing & createParentDirs=false | 親 dir 不在、`createParentDirs: false` | throws `ENOENT` |
| writes are atomic | crash 中の tmp が target を破壊しないことを擬似的に検証 | target が部分内容になっていない |
| trailing newline always present | content が `\n` で終わらない入力 | 書き込み後の末尾は `\n` 1 個 |
| `renderTemplate` substitutes vars | `"{{name}}"` + `{name: "foo"}` | `"foo"` |
| `renderTemplate` throws on missing var | `"{{x}}"` + `{}` | `MissingTemplateVarError` |
