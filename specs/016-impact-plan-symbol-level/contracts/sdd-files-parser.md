# Contract: sdd-files parser (path:symbol syntax)

**Spec**: [spec.md](../spec.md)

本契約は `extractFiles` parser の最終形を宣言する。Stage A (inline / bullet `Files:` セクション)、Stage B (本文中の path を regex で拾う fallback)、Diagnostic、TaskBlock の Stage 分割は維持し、Stage A エントリの返却形を `SymbolEntry` に統一する。

---

## 1. Stage A: `path:symbol` syntax 受理

### 1.1 受理する syntax

```
Files: src/auth.ts:validateToken
Files: src/auth.ts:validateToken, src/session.ts:createSession
Files: src/auth.ts:validateToken, src/legacy.ts
Files:
  - src/auth.ts:validateToken
  - src/session.ts
```

### 1.2 分割ルール

エントリ文字列 (annotation 剥がし済) を正規表現 `^([^:\s]+\.[\w]+):([^\s,()]+)$` で評価:

- **マッチ**: `path = group(1)`, `symbol = group(2)`。entry は `SymbolEntry` として記録。
- **非マッチ**: 従来通り path 全体として扱い、`symbol === undefined` の `SymbolEntry` として記録 (file unit)。

### 1.3 制約

- `path` は拡張子付き (`\.[\w]+` 必須)。拡張子なしのエントリ (`auth:validateToken`) は path として認識せず、Stage A の entry に含まれない。
- `symbol` は `\s` / `,` / `(` / `)` を含まない。`:` は最初の 1 つで split し、後続は symbol 名の一部として保持する (Edge Case `symbol 名に : が含まれる` / FR-005)。
- `(new)` / `(deleted)` 等の trailing annotation は Stage A の `stripTrailingAnnotation` で剥がしてから本処理 (FR-003)。
- Stage A scope の終端は、次の markdown heading 行 (`^#+\s`)、次の checklist item 行 (`^\s*[-*]\s+\[[ xX]\]` — Spec Kit 標準フラットチェックリストの次タスク境界、issue #219)、または空行 2 連のいずれか早い方。基底文法の詳細は [specs/014-reinvent-impact-cli/contracts/sdd-files-parser.md](../../014-reinvent-impact-cli/contracts/sdd-files-parser.md) を参照。

### 1.4 出力との対応

- `ExtractResult.entries: SymbolEntry[]` は Stage A が抽出した全エントリ (`{ path, symbol?, line }`) を、行番号順に push し、order を保つ。file 単位エントリは `symbol === undefined` で表現する。
- Stage A が 1 件以上の entry を返した場合、`entries` は必ず populate される (length >= 1)。
- Stage B (regex fallback) のみで結果が返るケースでは `entries` は Stage B の path を `{ path, line }` の SymbolEntry として並べ、`symbol` は常に省略。
- `ExtractResult` には `files: string[]` 並走 field を **持たない**。caller は `entries` のみを参照する。

---

## 2. Stage A: `unresolvedSymbol` diagnostic

### 2.1 発出条件

`path:symbol` を Stage A で抽出した後:

1. `path` が graph の `file:<path>` ノードとして登録、または fs に実在 → path は OK。
2. `symbol` が graph の `symbol:<path>#<name>` ノードとして登録されているか確認。
3. 1 が OK かつ 2 が miss → `unresolvedSymbol` を 1 件発出。
4. 1 が miss (path 自体が見つからない) → `unresolvedFilePath` を発出し、`unresolvedSymbol` は発出しない (per entry 排他、INV-S2)。
5. 両方 OK → diagnostic 無し、entry は採用。

### 2.2 diagnostic の形

```json
{
  "kind": "unresolvedSymbol",
  "sourceFile": "src/auth.ts",
  "symbol": "doesNotExist",
  "line": 17
}
```

- `kind` の string は `"unresolvedSymbol"` (camelCase, `"unresolvedFilePath"` と整合)。
- `sourceFile` は normalize 後の repo-relative path。
- `symbol` は entry の `:` 後ろの生文字列 (case 保持)。
- `line` は entry の 1-based 行番号。

### 2.3 `entries[]` への影響

`unresolvedSymbol` を発出しても entry は `entries[]` に残る (caller 側で diagnostic を見て filter する責務)。startId 解決は traverse.ts 側 (`resolveStartIds`) で diagnostic と独立に行うため、parser 段では graph に無い symbol も entry として保持する。

---

## 3. テスト合意 (parser unit)

`tests/sdd-files-parser.test.ts` で必要なケース:

1. `Files: src/auth.ts:validateToken` 単独 → `entries.length === 1`, `entries[0] = { path: "src/auth.ts", symbol: "validateToken", line: N }`。
2. file + symbol 混在 → `entries[0]` は file (symbol undefined)、`entries[1]` は symbol。order は行番号順。
3. symbol 名に `:` 含む (`Files: src/a.ts:fn:sub`) → `entries[0].symbol === "fn:sub"`。
4. trailing annotation (`Files: src/a.ts:fn (new)`) → `entries[0].symbol === "fn"`、annotation は剥がし済。
5. path 未登録 + symbol 未登録 → `diagnostics` に `unresolvedFilePath` のみ、`unresolvedSymbol` は発出されない (排他)。
6. path 登録済 + symbol 未登録 → `diagnostics` に `unresolvedSymbol` のみ。
7. path 登録済 + symbol 登録済 → `diagnostics` は空。
8. Stage B fallback (本文中の `src/a.ts` を regex で拾うケース) → `entries` は Stage B 検出 path を `{ path, line }` で並べ、`symbol` は全件 undefined。
9. フラットチェックリスト境界 (issue #219): `Files:` ブロック直後の `- [ ] T003 ...` 行で Stage A scope が終端 → 次タスク行は entry にも diagnostic にもならない (`[x]` / `[X]` / `*` bullet / インデント付きも同様)。
