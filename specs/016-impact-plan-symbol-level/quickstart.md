# Quickstart: impact / plan-coverage の symbol-level 入力対応

**Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

本 spec の機能が E2E で動作することを **実装後** に検証するための手順書。テスト fixture (`tests/fixtures/symbol-mode/`) を使うシナリオベース。

> **前提**: artgraph は未リリース。本 quickstart は spec 014 fixture との後方互換確認を **含まない**。spec 016 の clean 置き換え後のスキーマ (`ExtractResult.entries: SymbolEntry[]` / `ImpactGroup.{impactReqs, originReqs}` / `ImplicitImpactByReq.sourceLocations`) に対して直接検証する。

---

## Prerequisites

- Node.js >= 20
- pnpm (リポジトリ標準)
- spec 016 の実装が `feat/impact-plan-symbol-level` ブランチに merge 済 (まだ実装前ならこの手順書は契約レベルでの確認に留まる)

```bash
git checkout feat/impact-plan-symbol-level
pnpm install
pnpm build
```

---

## Scenario A — symbol-level 入力で過剰検知が抑制される + 二軸表示 (US1)

### A.1 セットアップ

```bash
cd tests/fixtures/symbol-mode
pnpm exec artgraph init --mode symbol --force
pnpm exec artgraph scan
```

期待: stdout に `symbol: 3` (3 export = `validateToken` / `issueToken` / `revokeToken`) を含む。それぞれ `@impl REQ-001` / `@impl REQ-005` / `@impl REQ-009`。

### A.2 symbol-level tasks.md で plan-coverage 実行 (二軸一致 = ドリフトなし)

`specs/001-symbol-demo/tasks.md` の `Files:` セクションを以下に固定:

```
Files: src/auth.ts:validateToken
```

実行:

```bash
pnpm exec artgraph plan-coverage --format json | jq '.implicitImpactsByReq[].reqId'
```

期待: `"REQ-001"` のみ。`REQ-005` / `REQ-009` は含まない。

続いて二軸を確認:

```bash
pnpm exec artgraph plan-coverage --format json \
  | jq '.implicitImpacts[0] | {impactReqs, originReqs}'
```

期待:

```json
{
  "impactReqs":  [{"reqId": "REQ-001", "kind": "req"}],
  "originReqs":  [{"reqId": "REQ-001", "kind": "req"}]
}
```

二軸が一致しているため、ドリフトなし。

### A.3 file-level tasks.md と比較

```
Files: src/auth.ts
```

実行:

```bash
pnpm exec artgraph plan-coverage --format json | jq '.implicitImpactsByReq[].reqId'
```

期待: `"REQ-001"`, `"REQ-005"`, `"REQ-009"` の 3 件すべて。

A.2 と比較して、symbol-level 入力で implicit REQ 数が `3 → 1` に削減 (SC-001: 50% 以上削減を満たす)。

`implicitImpacts[0]` も確認:

```bash
pnpm exec artgraph plan-coverage --format json \
  | jq '.implicitImpacts[0] | {sourceFile, hasSourceSymbol: has("sourceSymbol"), originReqs}'
```

期待:

```json
{
  "sourceFile": "src/auth.ts",
  "hasSourceSymbol": false,
  "originReqs": []
}
```

- `sourceSymbol` キー自体が存在しない (省略表現)。
- file-top に `@impl` タグがない fixture のため `originReqs` は空配列。

### A.4 spec.md に depends_on を追加してドリフト候補を JSON 上で検知 (SC-006)

`Files: src/auth.ts:validateToken` のまま、`specs/001-symbol-demo/spec.md` で `REQ-001` の依存関係に `depends_on REQ-007` を追記して再 scan:

```bash
pnpm exec artgraph scan
pnpm exec artgraph plan-coverage --format json \
  | jq '.implicitImpacts[0] | {
      impact: (.impactReqs | map(.reqId)),
      origin: (.originReqs  | map(.reqId)),
      drift:  ((.impactReqs | map(.reqId)) - (.originReqs | map(.reqId)))
    }'
```

期待:

```json
{
  "impact": ["REQ-001", "REQ-007"],
  "origin": ["REQ-001"],
  "drift":  ["REQ-007"]
}
```

JSON consumer (Skill / エージェント) が二軸差分を計算でき、`REQ-007` を **ドリフト候補** として観測可能 (SC-006)。

---

## Scenario B — `artgraph impact` の symbol 直接入力 + 二軸出力 (US2)

### B.1 symbol mode fixture で symbol 直接入力 (二軸)

```bash
cd tests/fixtures/symbol-mode
pnpm exec artgraph impact src/auth.ts:validateToken --format json \
  | jq '{impactReqs, originReqs}'
```

期待 (A.4 の depends_on 追記 **前** の状態):

```json
{
  "impactReqs": ["REQ-001"],
  "originReqs":   ["REQ-001"]
}
```

`REQ-005` / `REQ-009` は含まれない。

### B.2 存在しない symbol

```bash
pnpm exec artgraph impact src/auth.ts:doesNotExist
```

期待: exit 1。stderr に `ERROR: No matching symbol found for: src/auth.ts:doesNotExist` 相当のメッセージ (FR-011)。

### B.3 file-mode graph に symbol 入力

```bash
cd tests/fixtures/specs/                       # 既存 file-mode fixture
pnpm exec artgraph impact src/foo.ts:bar       # path/symbol は架空
```

期待: exit 1。stderr に ``ERROR: symbol-level input requires `artgraph scan --mode symbol` `` 相当のメッセージ (FR-013)。

### B.4 REQ-ID と symbol 入力の混在

```bash
cd tests/fixtures/symbol-mode
pnpm exec artgraph impact REQ-001 src/auth.ts:validateToken
```

期待: exit 1。REQ-ID rejection (4-path navigational error) が symbol 検出より先に評価される (FR-012)。stderr に「REQ-ID inputs are not accepted」相当のメッセージ。

### B.5 text 出力で Drift candidates セクション (FR-015)

A.4 と同じく spec.md に `REQ-001 depends_on REQ-007` を追加した状態で:

```bash
cd tests/fixtures/symbol-mode
pnpm exec artgraph scan
pnpm exec artgraph impact src/auth.ts:validateToken
```

期待 (抜粋):

```
Impact reqs:
  REQ-001  (req)
  REQ-007  (req)

Origin reqs (@impl claims):
  REQ-001  (req)

Drift candidates (impact \ origin):
  REQ-007  (req)
```

`depends_on REQ-007` を spec.md から削除すると `impactReqs == originReqs` となり、`Drift candidates:` セクションは **省略** される (空集合の場合は出さない、FR-015)。

---

## Scenario C — `plan-coverage` 出力スキーマの二軸 + symbol 情報 (US3)

### C.1 単一 symbol entry (二軸)

`Files: src/auth.ts:validateToken` で:

```bash
pnpm exec artgraph plan-coverage --format json | jq '.implicitImpacts[0]'
```

期待 (A.4 の depends_on 追記 **前** の状態):

```json
{
  "sourceFile":   "src/auth.ts",
  "sourceSymbol": "validateToken",
  "impactReqs":   [{"reqId": "REQ-001", "kind": "req"}],
  "originReqs":   [{"reqId": "REQ-001", "kind": "req"}]
}
```

`reqs` field は出力に **存在しない** (FR-016)。

### C.2 file unit entry (sourceSymbol 省略)

`Files: src/auth.ts` で:

```bash
pnpm exec artgraph plan-coverage --format json \
  | jq '.implicitImpacts[0] | {hasSourceSymbol: has("sourceSymbol"), originReqs}'
```

期待:

```json
{
  "hasSourceSymbol": false,
  "originReqs":      []
}
```

- `sourceSymbol` キー自体が存在しない (JSON key 省略、`null` ではない)。
- file-top に `@impl` タグがない fixture のため `originReqs` は空配列 (FR-017)。

### C.3 多 symbol entry (各 origin 独立)

`Files: src/auth.ts:validateToken, src/auth.ts:issueToken` で:

```bash
pnpm exec artgraph plan-coverage --format json | jq '.implicitImpacts | length'
```

期待: `2`。同 file の 2 つの symbol entry は別 group (FR-019)。

```bash
pnpm exec artgraph plan-coverage --format json \
  | jq '.implicitImpacts | map({sourceSymbol, origin: (.originReqs | map(.reqId))})'
```

期待:

```json
[
  {"sourceSymbol": "validateToken", "origin": ["REQ-001"]},
  {"sourceSymbol": "issueToken",    "origin": ["REQ-005"]}
]
```

各 entry の `originReqs` がそれぞれ独立した `@impl` claim と一致。

### C.4 unresolvedSymbol diagnostic

`Files: src/auth.ts:doesNotExist` で:

```bash
pnpm exec artgraph plan-coverage --format json \
  | jq '.diagnostics[] | select(.kind == "unresolvedSymbol")'
```

期待:

```json
{
  "kind":       "unresolvedSymbol",
  "sourceFile": "src/auth.ts",
  "symbol":     "doesNotExist",
  "line":       <N>
}
```

当該 entry は `implicitImpacts` から **除外** される (FR-021)。

### C.5 implicitImpactsByReq の sourceLocations 形式

`Files: src/auth.ts:validateToken` で:

```bash
pnpm exec artgraph plan-coverage --format json | jq '.implicitImpactsByReq[0]'
```

期待:

```json
{
  "reqId": "REQ-001",
  "sourceLocations": [
    {"file": "src/auth.ts", "symbol": "validateToken"}
  ]
}
```

- `sourceFiles` field は **存在しない** (spec 014 から廃止、FR-020)。
- symbol 起点なら `symbol` が populate、file 起点なら `symbol` キー省略。

---

## Scenario D — text 出力フォーマット確認

ドリフト **なし** の状態 (A.2 と同条件):

```bash
pnpm exec artgraph plan-coverage
```

期待 (抜粋):

```
Implicit impacts (1 REQ(s) impacted but not mentioned):

  By source file:
    src/auth.ts#validateToken
      Impact reqs:
        REQ-001  (req)
      Origin reqs (@impl claims):
        REQ-001  (req)
      Drift candidates (impact \ origin):
        (none)

  By requirement:
    REQ-001  <- src/auth.ts#validateToken
```

- symbol 起点エントリは `#` 区切りで `src/auth.ts#validateToken` 表記 (FR-023)。
- `Impact reqs` と `Origin reqs` は別セクションで併記 (FR-023)。
- Drift なしの場合は `Drift candidates: (none)` または該当セクション省略のいずれかを実装が選ぶ。

ドリフト **あり** の状態 (A.4 と同条件、`REQ-001 depends_on REQ-007` を追加):

```bash
pnpm exec artgraph scan
pnpm exec artgraph plan-coverage
```

期待 (抜粋):

```
  By source file:
    src/auth.ts#validateToken
      Impact reqs:
        REQ-001  (req)
        REQ-007  (req)
      Origin reqs (@impl claims):
        REQ-001  (req)
      Drift candidates (impact \ origin):
        REQ-007  (req)
```

人間がそのまま `REQ-007` をドリフト候補として読み取れる。

---

## Scenario E — ドリフト検知 E2E (SC-006)

`tests/fixtures/symbol-mode/` で spec.md と src/auth.ts を編集する hand-of-time シナリオ。Scenario A.4 / B.5 / D の縦串を 1 つの E2E として確認する。

### E.1 初期状態

```bash
cd tests/fixtures/symbol-mode
pnpm exec artgraph init --mode symbol --force
pnpm exec artgraph scan
```

固定値:

- `src/auth.ts` で `validateToken` が `@impl REQ-001`
- `specs/001-symbol-demo/spec.md` で `REQ-001` が独立 (depends_on なし)
- `specs/001-symbol-demo/tasks.md` の Files セクション = `Files: src/auth.ts:validateToken`

### E.2 ドリフトなしの確認

```bash
pnpm exec artgraph plan-coverage --format json \
  | jq '.implicitImpacts[0] | {
      impact: (.impactReqs | map(.reqId)),
      origin: (.originReqs  | map(.reqId))
    }'
```

期待: 両方 `["REQ-001"]`。

### E.3 spec.md に depends_on を追加して再 scan

`specs/001-symbol-demo/spec.md` で `REQ-001 depends_on REQ-007` を追加 (REQ-007 のエントリも追加):

```bash
pnpm exec artgraph scan
```

### E.4 plan-coverage 再実行で二軸が乖離

```bash
pnpm exec artgraph plan-coverage --format json \
  | jq '.implicitImpacts[0] | {
      impact: (.impactReqs | map(.reqId)),
      origin: (.originReqs  | map(.reqId))
    }'
```

期待:

```json
{
  "impact": ["REQ-001", "REQ-007"],
  "origin": ["REQ-001"]
}
```

### E.5 JSON consumer でドリフトを抽出

```bash
pnpm exec artgraph plan-coverage --format json \
  | jq '{
      file:  .implicitImpacts[0].sourceFile,
      sym:   .implicitImpacts[0].sourceSymbol,
      drift: (
        (.implicitImpacts[0].impactReqs | map(.reqId)) -
        (.implicitImpacts[0].originReqs | map(.reqId))
      )
    }'
```

期待:

```json
{
  "file":  "src/auth.ts",
  "sym":   "validateToken",
  "drift": ["REQ-007"]
}
```

エージェント / Skill 側で `drift.length > 0` を条件にプロンプトを差し込めば、ドリフトを自動的に表面化できる (SC-006 達成)。

---

## Scenario F — Skill / docs の symbol mode + 二軸言及確認 (US4)

```bash
grep -n "symbol-level\|originReqs\|src/auth.ts:validateToken" \
  templates/skills/artgraph-impact/SKILL.md

grep -n "impactReqs\|originReqs\|drift" \
  templates/skills/artgraph-plan-coverage/SKILL.md

grep -n "symbol mode\|scan --mode symbol\|impactReqs and originReqs" \
  docs/skills-guide.md

wc -l templates/skills/artgraph-impact/SKILL.md \
      templates/skills/artgraph-plan-coverage/SKILL.md
```

期待:

- `artgraph-impact/SKILL.md` に `symbol-level` / `originReqs` / `src/auth.ts:validateToken` が含まれる (FR-026)。
- `artgraph-plan-coverage/SKILL.md` に `impactReqs` / `originReqs` / `drift` が含まれる (FR-027)。
- `docs/skills-guide.md` に `symbol mode` / `scan --mode symbol` / `impactReqs and originReqs` (またはそれに準じた日本語表現) が含まれる (FR-028)。
- 各 SKILL.md が **100 行以下** (SC-004 / FR-030)。

`README.md` の Skills 表に対応 mode 列または注釈が入っていることも目視で確認 (FR-029)。

---

## トラブルシューティング

| 症状 | 原因 | 対処 |
|---|---|---|
| 全 symbol entry が `unresolvedSymbol` で落ちる | `.artgraph.json` の `mode` が `file` | `mode: "symbol"` に変更して `artgraph scan` を再実行 |
| Stage A の出力に `entries` が undefined | tasks.md に `Files:` セクションが無い (Stage B fallback) | `Files:` セクションを追記 |
| symbol 入力したのに `--mode` 警告が出る | `--mode file` を明示している | フラグを外すか `--mode symbol` を指定 |
| C.2 で `sourceSymbol` が `null` で返ってくる | 実装が `null` を出している (本契約は **field 省略** が正) | implementation を見直し: serializer 側で undefined field を strip する経路を確認 |
| `originReqs: []` だが `impactReqs` に何か入っている | start node (file / symbol) に `@impl` タグが付いていない、または `implements` edge が graph に届いていない | `grep "@impl" src/<file>` で tag の存在を確認、必要なら `@impl REQ-NNN` を追記し `artgraph scan` を再実行 |
| 二軸 (`impactReqs` / `originReqs`) の差分が想定外 | spec.md の `depends_on` / `relates_to` が想定と違う、または scan が古い | `specs/<n>/spec.md` の依存関係を再確認、`artgraph scan` を再実行してから plan-coverage を回す |
| `Drift candidates:` セクションが text 出力に出ない | `impactReqs == originReqs` のためセクションが省略されている (FR-015 の正常動作) | ドリフト検知の検証時は spec.md に `depends_on` を追加して再 scan |
