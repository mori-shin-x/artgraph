# Phase 1 Data Model — Cross-Agent Extensions

**Date**: 2026-06-29 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

本 spec は永続データ (DB / `.trace.lock` 等) を追加しない。本 model は **メモリ上のドメインエンティティ** と **ファイルシステム上の不変条件** を定義する。

---

## エンティティ

### 1. `AgentDescriptor`

Tier 1 5 エージェントを識別する静的記述子。`src/agents/descriptors.ts` に table として 5 件を宣言。

| Field | Type | 説明 |
|---|---|---|
| `id` | `"claude" \| "codex" \| "cursor" \| "copilot" \| "kiro"` | CLI `--agents=<list>` で受け付ける識別子 |
| `displayName` | `string` | 人間向け表示名 ("Claude Code" / "Codex CLI" / 等) |
| `skillsPath` | `string \| null` (repo-root relative) | canonical Skills 配布先 (`.claude/skills/` ほか)。`null` = Skills 配布対象外 (wrapper と AGENTS.md 経由でのみ指示層を提供)。 |
| `wrapperFile` | `string \| null` | agent-context ラッパーファイル相対パス (`CLAUDE.md` / `.github/copilot-instructions.md` / null) |
| `agentContextLoad` | `"native-agents-md" \| "wrapper-required" \| "both"` | AGENTS.md ネイティブ読込 / 慣習ラッパー要 / 両方サポート |

**5 件の確定値:**

| id | displayName | skillsPath | wrapperFile | agentContextLoad |
|----|---|---|---|---|
| `claude` | Claude Code | `.claude/skills/` | `CLAUDE.md` | `both` |
| `codex` | Codex CLI | `.agents/skills/` | `null` | `native-agents-md` |
| `cursor` | Cursor | `.cursor/skills/` | `null` | `native-agents-md` |
| `copilot` | GitHub Copilot | `null` | `.github/copilot-instructions.md` | `both` |
| `kiro` | Kiro | `.kiro/skills/` | `null` | `native-agents-md` |

**不変条件**:
- `id` は同一 table 内で一意。
- `skillsPath` は非 null の場合 `<agent_key>/skills/` 形式に正規化される (POSIX セパレータ)。
- `skillsPath === null` の agent は Skills を配布しない (wrapper と AGENTS.md 経由でのみ指示層を提供)。ただし `wrapperFile !== null` を伴うこと (agent-context の supply chain が保たれる)。
- `wrapperFile` が `null` の場合 `agentContextLoad === "native-agents-md"` (AGENTS.md のみで完結)。
- `wrapperFile` が非 null の場合 `agentContextLoad ∈ {"wrapper-required", "both"}`。

**Copilot だけ `skillsPath: null` である理由 (issue #130):**
GitHub Copilot が認識する custom-instructions のパスは公式に `.github/copilot-instructions.md` (repo-wide) と `.github/instructions/*.instructions.md` (path-scoped) の 2 系統のみで、`.github/skills/` は README・IDE・Coding Agent いずれの surface でも discovery 対象外。従って `.github/skills/` に SKILL.md を配置しても Copilot はそれらを実行時に参照しない。Copilot は AGENTS.md をネイティブロードするため、Skills 一覧と使い方は AGENTS.md 本文 + `.github/copilot-instructions.md` ラッパー経由で伝える方針とし、Skills 配布は skip する。

---

### 2. `SkillSource`

canonical な配布元 (`templates/skills/`)。実体は読取専用 (本 spec で書き換えなし)。

| Field | Type | 説明 |
|---|---|---|
| `sourceRoot` | `string` (abs path) | `templates/skills/` の絶対パス |
| `entries` | `SkillEntry[]` | top-level 配下の Skill ディレクトリ + `_shared/` |

#### `SkillEntry`

| Field | Type | 説明 |
|---|---|---|
| `topLevel` | `string` | top-level 名 (`artgraph-impact` / `_shared` 等) |
| `isShared` | `boolean` | `topLevel === "_shared"` |
| `files` | `SkillFile[]` | 配下全ファイル (再帰 walk 結果) |

#### `SkillFile`

| Field | Type | 説明 |
|---|---|---|
| `relPath` | `string` | `templates/skills/` からの相対パス |
| `sha256` | `string` (hex, 64 char) | ファイル内容の sha256 ハッシュ |
| `byteSize` | `number` | バイトサイズ (sanity check 用) |

**不変条件**:
- `isShared === false` の `SkillEntry` は `files` の中に `<topLevel>/SKILL.md` を必ず 1 つ含む (既存 `src/init.ts:readSkillTemplates` の契約)。
- `isShared === true` の `SkillEntry` は SKILL.md を含まなくて良い。
- 全 `SkillFile.sha256` は init 実行時に再計算され、`distributeSkills` の前後で配布先と照合される。

---

### 3. `DistributionTarget`

`AgentDescriptor` × `SkillSource` の直積で生成される配布計画単位。各 entry は配布先 1 ファイルに対応。

| Field | Type | 説明 |
|---|---|---|
| `agent` | `AgentDescriptor` | 配布対象エージェント |
| `srcRelPath` | `string` | `SkillFile.relPath` (templates/skills/ 起点) |
| `dstAbsPath` | `string` | 配布先絶対パス (`<repo>/<agent.skillsPath>/<srcRelPath>`)。`agent.skillsPath === null` の agent は `DistributionTarget` を生成しない。 |
| `expectedSha256` | `string` | `SkillFile.sha256` (配布後の期待値) |

**生成ルール**:
- `--agents=<list>` で指定された各 `AgentDescriptor` (ただし `skillsPath !== null` のもの) × `SkillSource.entries[].files[]` の直積で `DistributionTarget[]` を作る。
- `skillsPath === null` の agent (現在は Copilot のみ) は `DistributionTarget` を生成しない。distribute stage 全体を skip する。
- `_shared/` の `SkillEntry` も含める (R1 の決定)。
- 重複排除は不要 (異なるエージェントで `dstAbsPath` は必ず異なる)。

---

### 4. `AgentContextBlock`

AGENTS.md / CLAUDE.md / `.github/copilot-instructions.md` に挿入される artgraph 管理セクション。

| Field | Type | 説明 |
|---|---|---|
| `targetFile` | `string` (abs path) | 書き込み先ファイル絶対パス |
| `markerBegin` | `string` | 既定値 `<!-- artgraph:begin -->` (R2) |
| `markerEnd` | `string` | 既定値 `<!-- artgraph:end -->` (R2) |
| `body` | `string` | マーカー間に挿入する Markdown 本文 |
| `kind` | `"canonical" \| "wrapper"` | canonical = AGENTS.md / wrapper = CLAUDE.md or copilot-instructions.md |

**不変条件**:
- `kind === "canonical"` の場合、`body` は artgraph 利用ガイド全文 (Skills 一覧 / 使い方 / FR 参照)。
- `kind === "wrapper"` の場合、`body` は `@AGENTS.md` literal と `[AGENTS.md](./AGENTS.md)` リンクを含む数行のみ (R6)。本文の二重コピー禁止 (SC-003)。
- 既存 `targetFile` が存在する場合: マーカー block を見つけて差し替え。マーカーが見つからない場合: ファイル末尾に append (新規ブロック挿入)。マーカー外のコンテンツは絶対に触らない (FR-009)。

---

### 5. `DoctorFinding`

`artgraph doctor` が出力する診断項目 1 件。

| Field | Type | 説明 |
|---|---|---|
| `severity` | `"pass" \| "fail"` | 診断結果 |
| `agent` | `string \| null` | 関連エージェント `id` (5 値のいずれか or null = AGENTS.md など共通) |
| `kind` | `DoctorFindingKind` | 何を検査したか (列挙) |
| `path` | `string` | 検査対象ファイル相対パス |
| `expected` | `string \| null` | 期待値 (sha256 / マーカー文字列 / 参照存在 / etc.) |
| `actual` | `string \| null` | 実測値 |
| `message` | `string` | 人間向け説明 (text 出力の主要部) |

#### `DoctorFindingKind`

| 値 | 説明 |
|----|------|
| `skill-file-missing` | 配布先に期待 SKILL.md or `_shared/` ファイルが存在しない |
| `skill-file-drift` | 配布先ファイルの sha256 が canonical と不一致 |
| `agents-md-missing` | `--agents` 配布があるのに AGENTS.md が存在しない |
| `agents-md-marker-broken` | AGENTS.md にマーカー block が無い or 半壊 |
| `wrapper-missing` | `--agents=claude` で `CLAUDE.md` 不存在、`--agents=copilot` で `.github/copilot-instructions.md` 不存在 |
| `wrapper-no-import` | wrapper に `@AGENTS.md` literal が含まれていない |
| `extraneous-file` | 配布先に canonical に存在しないファイル/ディレクトリが混入 (古いバージョンの残骸など) |
| `legacy-copilot-skills-path` | `.github/skills/` が残存 (旧版で作られた Copilot 用 Skills tree — 手動削除の案内) |

**不変条件**:
- `severity === "pass"` の finding には `expected` / `actual` を空文字または null で記録 (出力上は省略可)。
- `severity === "fail"` の finding は必ず `expected` と `actual` を含む。
- 同一 (`agent`, `path`, `kind`) は重複しない (1 ファイル 1 検査結果)。

---

## エンティティ間の関係

```
AgentDescriptor (5 fixed) ──┐
                            ├─→ DistributionTarget[] (init 実行時に展開)
SkillSource (templates/) ───┘            │
                                          ↓
                          配布実行 (sha256 検証含む)
                                          │
                                          ↓
AgentContextBlock (AGENTS.md / CLAUDE.md / copilot-instructions.md)
                                          │
                                          ↓
                          doctor 走査 ─→ DoctorFinding[]
```

---

## 状態遷移

本 spec のドメインに「状態を持つエンティティ」は存在しない。配布物はファイルシステム上のスナップショットであり、init 実行時に冪等に再構成される。

doctor の結果は瞬時計算 (キャッシュなし、状態なし)。

---

## バリデーション規則 (まとめ)

| ルール | 出所 | 違反時の振舞い |
|------|------|----------------|
| `--agents=<list>` の要素は 5 識別子のいずれか | FR-001 | 非 0 終了、サポート値一覧をエラーメッセージで提示 |
| `--agents=<list>` は Skills/agent-context stage が走る経路で必須 | FR-002 | 非 0 終了、3 つの対処法を提示 |
| 配布先 SKILL.md は canonical とバイト一致 (sha256 等価) | FR-003 | doctor で `skill-file-drift` finding (FAIL) |
| `_shared/` も配布対象に含める | FR-004 | doctor で `skill-file-missing` finding (FAIL) |
| AGENTS.md セクションはマーカー境界付き冪等更新 | FR-005 | マーカー破壊時 doctor で `agents-md-marker-broken` |
| ラッパーは `@AGENTS.md` literal のみ (本文二重コピー禁止) | FR-006 / FR-007 / SC-003 | レビューで担保 (テキスト linter で禁止フレーズチェック可能) |
| `--agents` と既存フラグの直交ルール | FR-013 | conflict 検出時に明確エラー (`init.ts` の C1/M24 既存パターン踏襲) |
