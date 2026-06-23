# Contract: Spec Kit Extension Schema v1.0（凍結）

**Layer**: `packages/artgraph/src/integrate/schemas/speckit-1.0.ts`

**Used by**: `providers/speckit.ts` / `speckit-yaml.ts` / templates loader

**Related**: [research §R1](../research.md#r1-spec-kit-extension-の確定スキーマschema_version-10), [spec FR-001 改訂](../spec.md), [Clarifications Q3](../spec.md#clarifications)

> このスキーマは本機能リリース時点で固定されるコード内定数。Spec Kit 側で破壊的変更が入った場合は、本機能側で明示的なバージョン分岐 PR を起こして対応する（Q3 で確定）。実行時に `.specify/extensions/agent-context/` を参照しない。

---

## 1. 生成する `.specify/extensions/spectrace/extension.yml`

```yaml
schema_version: "1.0"

extension:
  id: spectrace
  name: "artgraph (spectrace) — SDD verification"
  version: "0.1.0"
  description: "Run artgraph scan/reconcile/check at Spec Kit workflow checkpoints."
  author: artgraph
  repository: https://github.com/ShintaroMorimoto/artgraph
  license: MIT

requires:
  # CANONICAL: 本イテレーションのリリース時点で公式サポートする Spec Kit の最低バージョン。
  # 本値は spec FR-016 が参照する唯一の真実ソース。Spec Kit 0.11.0 以上であれば
  # extensions.yml の installed/hooks スキーマと extension.yml の schema_version "1.0"
  # を受理することを確認済み（本リポジトリ自身は 0.11.5 環境で動作確認）。
  speckit_version: ">=0.11.0"

provides:
  commands:
    - name: artgraph.scan-reconcile
      file: commands/artgraph.scan-reconcile.md
      description: "Refresh artgraph baseline (scan && reconcile)"
    - name: artgraph.check-diff
      file: commands/artgraph.check-diff.md
      description: "Verify coverage/orphan/drift on the current diff"
    - name: artgraph.check-gate
      file: commands/artgraph.check-gate.md
      description: "Gate implementation on artgraph check (--gate mode)"

hooks:
  after_tasks:
    command: artgraph.scan-reconcile
    optional: false
    description: "Refresh artgraph baseline after tasks"
  after_implement:
    command: artgraph.check-diff
    optional: false
    description: "Verify artgraph traceability after implementation"
  # before_implement は --gate モード時のみ生成される追加ブロック
  # before_implement:
  #   command: artgraph.check-gate
  #   optional: false
  #   description: "Gate implementation on artgraph traceability"

tags:
  - traceability
  - verification
  - artgraph
```

**コード内表現**：

```ts
import type { HookTrigger } from "../../types.js";

export const SPECKIT_SCHEMA_VERSION = "1.0" as const;

export interface SpecKitExtensionManifest {
  schema_version: typeof SPECKIT_SCHEMA_VERSION;
  extension: SpecKitExtensionMetadata;
  requires: { speckit_version: string };
  provides: { commands: ProvidedCommand[] };
  hooks: Partial<Record<HookTrigger, ManifestHookDeclaration>>;
  tags: string[];
}

export interface SpecKitExtensionMetadata {
  id: string; name: string; version: string;
  description: string; author: string; repository: string; license: string;
}

export interface ProvidedCommand {
  name: string;       // dot-separated, e.g. "artgraph.scan-reconcile"
  file: string;       // relative to extension dir, e.g. "commands/artgraph.scan-reconcile.md"
  description: string;
}

export interface ManifestHookDeclaration {
  command: string;
  optional: boolean;
  description: string;
}
```

**バリデーション関数** (`validateExtensionYaml`):
- `schema_version === "1.0"` 必須（他の値は `UnsupportedSchemaVersionError` を throw）。
- `extension.id` は kebab-case、`[a-z][a-z0-9-]*`。
- `provides.commands[].name` は dot-separated (`[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]+)*`)。
- `provides.commands[].file` は extension dir 配下の相対パス（`..` 含まず、`commands/...` 推奨）。
- `hooks[trigger].command` が `provides.commands[].name` のいずれかに一致すること。

---

## 2. 編集する `.specify/extensions.yml`

本機能は既存ファイルへの追記（installed リスト + hooks 配列）のみを行う。`schema_version` 等の root メタデータは触らない。

```yaml
installed:
- agent-context           # 既存
- spectrace               # 本機能で末尾追記

settings:
  auto_execute_hooks: true  # 既存。触らない

hooks:
  after_tasks:
  - extension: spectrace
    command: artgraph.scan-reconcile
    enabled: true
    optional: false
    priority: 50
    prompt: "Run artgraph scan && reconcile to refresh trace baseline?"
    description: "Refresh artgraph baseline after tasks"
    condition: null

  after_implement:
  - extension: spectrace
    command: artgraph.check-diff
    enabled: true
    optional: false
    priority: 50
    prompt: "Run artgraph check --diff to verify coverage/orphan/drift?"
    description: "Verify artgraph traceability after implementation"
    condition: null

  before_implement:        # --gate モード時のみ追加
  - extension: spectrace
    command: artgraph.check-gate
    enabled: true
    optional: false
    priority: 50
    prompt: "Gate: run artgraph check --gate before implementing?"
    description: "Gate implementation on artgraph traceability"
    condition: null
```

**編集ルール**（`speckit-yaml.ts` の責務）:

| 操作 | 関数 | 冪等条件 |
|---|---|---|
| `installed` 配列に `spectrace` 追加 | `addInstalled(doc, "spectrace")` | 既存なら no-op |
| `installed` 配列から `spectrace` 削除 | `removeInstalled(doc, "spectrace")` | 不在なら no-op |
| `hooks.<trigger>` 配列に spectrace entry 追加 | `addHookEntry(doc, trigger, entry)` | `extension === "spectrace"` の entry が既存なら no-op（priority/command/etc が完全一致時のみ）。完全一致しない既存 spectrace entry は置換 |
| `hooks.<trigger>` 配列から spectrace entry 削除 | `removeHookEntry(doc, trigger, "spectrace")` | 不在なら no-op、他 Extension entry は不変 |
| 全 hook 配列の cleanup（uninstall 用） | `removeAllSpectraceHooks(doc)` | 全 trigger を走査 |

**シリアライズ**:
- `yaml` (eemeli) の `Document` API でパース → 変更 → `doc.toString({ ... })` でシリアライズ。
- 既存コメント・空行・キー順を保持。
- 末尾改行 1 個で終わる（POSIX 慣習）。

---

## 3. 生成する `commands/*.md` ファイル

各 command ファイルは frontmatter + Markdown 3 セクション。テンプレートは `packages/artgraph/templates/integrate/speckit/commands/` に置く。

### `commands/artgraph.scan-reconcile.md`

```markdown
---
description: "Refresh artgraph baseline (scan && reconcile)"
---

# artgraph: scan && reconcile

## Behavior
Rebuilds the artifact graph and refreshes `.trace.lock` to establish a clean baseline after `/speckit-tasks` completes. Run on the host shell.

## Execution
- **Bash**: `artgraph scan && artgraph reconcile`
```

### `commands/artgraph.check-diff.md`

```markdown
---
description: "Verify coverage/orphan/drift on the current diff"
---

# artgraph: check --diff

## Behavior
Runs `artgraph check --diff` scoped to the current git diff. Reports orphan `@impl` tags, drifted nodes, and uncovered claimed REQs. Use after `/speckit-implement`.

## Execution
- **Bash**: `artgraph check --diff`
```

### `commands/artgraph.check-gate.md`

```markdown
---
description: "Gate implementation on artgraph check (--gate mode)"
---

# artgraph: check --gate

## Behavior
Hard-fails the workflow if drift/orphan/uncovered exist (exit 2). Use before `/speckit-implement` when you want a strict gate.

## Execution
- **Bash**: `artgraph check --gate`
```

---

## 4. 生成する `README.md`

```markdown
# artgraph (spectrace) Spec Kit Extension

This extension wires artgraph into the Spec Kit workflow:

- **after_tasks** → `artgraph scan && artgraph reconcile`
- **after_implement** → `artgraph check --diff`
- **before_implement** *(optional, --gate mode)* → `artgraph check --gate`

Generated by `artgraph integrate speckit`. To remove: `artgraph integrate speckit --uninstall`.
```

---

## 5. テスト要件（TDD Red 段階）

| テスト名 | 期待 |
|---|---|
| `validateExtensionYaml` accepts canonical manifest | 上記例が validate を通る |
| `validateExtensionYaml` rejects schema_version != "1.0" | `UnsupportedSchemaVersionError` |
| `validateExtensionYaml` rejects hook command not in provides | エラー |
| `addInstalled` is idempotent | 2 回呼んで重複なし |
| `addHookEntry` preserves other extensions' entries | agent-context 等の同 trigger entry が残る |
| `addHookEntry` is idempotent for same-content entry | 完全一致は no-op |
| `addHookEntry` replaces same-extension different-content entry | spectrace の old → new に置換 |
| `removeHookEntry` only removes own extension's entry | 他 extension の entry は不変 |
| `serializeExtensionsYaml` preserves comments | 既存 YAML コメントが survive |
| `serializeExtensionsYaml` preserves key order | `installed` → `settings` → `hooks` の順 |
| canonical extension.yml round-trips identically | parse → serialize で byte-identical |
