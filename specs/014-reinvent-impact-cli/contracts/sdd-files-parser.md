# Contract: SDD Files Parser (`Files:` セクション抽出 + regex フォールバック)

**Feature**: impact CLI 再設計 + plan-coverage 新設 | **Date**: 2026-06-28

`--from-tasks <path>` / `--from-plan <path>` / `plan-coverage` が共有する 2 段ファイル抽出戦略を定義する。実装は `src/parsers/sdd-files.ts`(新規)に集約。

---

## 二段戦略

### Stage A: `Files:` セクション抽出(優先)

1 ファイル内に Stage A で抽出できた file が **1 件以上** あれば、Stage B は実行しない。

### Stage B: regex フォールバック

Stage A の抽出がゼロ件の場合のみ実行。

### 抽出ゼロ時の挙動

Stage A / B ともゼロ件なら **警告 + exit 1**(無音終了しない)。

```
error: no file paths could be extracted from <path>.
add a "Files:" section, or check that referenced paths exist in graph or filesystem.
```

---

## Stage A: `Files:` セクションの文法

### Header

- Regex: `^Files:\s*` (行頭、case-sensitive `Files:`、末尾コロン必須)
- ラベルバリアント(`File:`, `files:`, `FILES:`)は **マッチさせない**(明示性優先 / parser シンプル化)

### Scope

- ヘッダ行から次の **markdown heading 行**(`^#+\s`)、または **空行 2 連** まで
- 同一 task block 内のみ考慮(`### T013` のような heading で区切られた区間)

### 値の書き方(2 形式サポート)

#### Inline 形(同行)

```markdown
### T013: 2FA login flow [FR-005]

Files: src/auth.ts, src/auth-2fa.ts, tests/auth.test.ts
```

- カンマ区切り(`,`)+ 任意空白
- 末尾セミコロン / ピリオドは strip

#### Bullet 形(複数行)

```markdown
### T013: 2FA login flow

Files:
- src/auth.ts
- src/auth-2fa.ts (new)
- tests/auth.test.ts
```

- 各行 `^\s*[-*]\s+`(`-` または `*` 始まり)
- 末尾の括弧アノテーション(`(new)` / `(deleted)` 等)は **値から除外**(path のみ抽出)

### 値の正規化

- 前後空白 trim
- 末尾 `/` は保持(ディレクトリ指定として尊重)
- 絶対 path (`/foo/...`) は **スキップ**(警告 `unresolvedFilePath`)。相対 path のみ採用
- `./`, `../` 始まりは許容(正規化して保持)

### Validation

- 抽出した path について `graph.nodes.has('file:<path>')` または `fs.existsSync(<path>)`(repo root 相対)を確認
- どちらも false の場合: 値は **採用するが** `diagnostics[].kind: "unresolvedFilePath"` を追加(typo 警告)
- 新規作成予定 file(まだ存在しない)も Stage A では採用する — 人間の明示宣言を信頼する

---

## Stage B: regex フォールバック

### Pattern

```regex
(?<![\w./-])([\w./-]+\.\w+)(?![\w./-])
```

- 前後の boundary は `\w` / `.` / `/` / `-` 以外で区切る(path 文字の継続を防ぐ)
- 末尾必須拡張子(`\.\w+`)で「拡張子のない単語」を除外
- 候補例: `src/auth.ts`, `./README.md`, `tests/auth.test.ts`, `package.json`

### Scope

- 入力ファイル全文をスキャン(heading や code fence で区切らない)
- code fence(```` ``` ````)内も検出対象に含める(false positive 許容)

### Validation(必須)

Stage A と違い、Stage B は **「実在する path のみ採用」** で厳格化:

- `graph.nodes.has('file:<path>')` または `fs.existsSync(<path>)` の両方を試す
- どちらも false なら **その候補は採用しない**(警告も出さない — 自由テキスト中のたまたまの一致だから)

理由: Stage B は free-text scan なので、validation を緩めると README に書かれた `node_modules/foo.js` のような無関係 path を起点にしてしまう。

### 候補の dedup

抽出後 `Set` で重複排除(同 file が複数箇所で言及されても 1 度だけ起点に含める)。

---

## 出力 contract

`extractFiles(text: string): ExtractResult` の戻り値:

```ts
type ExtractResult = {
  files: string[];               // 抽出された file path 群 (dedup + sort 済み)
  stage: "files-section" | "regex-fallback" | "empty";
  diagnostics: Diagnostic[];     // Stage A の unresolvedFilePath 警告等
};
```

`plan-coverage` の出力 `diagnostics[]` にはこの `ExtractResult.diagnostics` がそのまま flatten される。

---

## エッジケース

### `Files:` セクションだが値が空

```markdown
Files:

### Next task
```

→ Stage A は抽出ゼロ → Stage B を実行(Stage A 失敗時のみ Stage B にフォールバック)。

### Bullet 形の入れ子リスト

```markdown
Files:
- src/auth.ts
  - subdir/foo.ts        # ネストされた bullet
- src/session.ts
```

→ ネスト bullet も同じ regex でマッチさせ採用(深さは無視)。

### Inline 形と Bullet 形の混在

```markdown
Files: src/auth.ts
- src/session.ts
```

→ Inline 行で抽出した後、続く bullet 行も追加で抽出(明示的に separation しない)。

### 同 path の繰り返し

→ dedup(`Set` ベース)。

### 絶対 path

```markdown
Files: /home/user/repo/src/auth.ts
```

→ Stage A: スキップ + `diagnostics: unresolvedFilePath`。Stage B: pattern マッチ後 validation で fs.existsSync が false なら drop(true なら採用、稀ケース)。

### 拡張子なし path(ディレクトリ等)

```markdown
Files: src/auth/, tests/
```

→ Stage A: 採用(末尾 `/` のディレクトリ表記)。Stage B: regex `\.\w+` に引っかからないので拾わない。

→ ディレクトリ表記の場合、後段の `impact()` は `graph.nodes.has('file:src/auth/')` で解決を試み、失敗時は `diagnostics: unresolvedFilePath` 追加(拡張機能、優先度 P3 — 初版では絶対 path 同様に警告で済ます)。

### URL や HTML タグの誤検出(Stage B)

`https://example.com/foo.md` や `<img src="logo.png">`:
- Stage B regex の前 boundary `(?<![\w./-])` は `:` や `=`, `"` 以降の path を拾うが、validation の `fs.existsSync` / `graph.nodes.has` で外部 path は実在しないため drop される

→ 副作用なし(validation が安全網)。

---

## 共有 API

```ts
// src/parsers/sdd-files.ts
export function extractFiles(
  text: string,
  options: {
    graph: ArtifactGraph;
    repoRoot: string;
  },
): ExtractResult;
```

呼び出し側:
- `artgraph impact --from-tasks <path>`: `extractFiles(fs.readFileSync(path, 'utf8'), { graph, repoRoot })`
- `artgraph impact --from-plan <path>`: 同上
- `artgraph plan-coverage`: 同上(tasks と plan の両方を結合してから extract、または別々に extract して union)

`plan-coverage` は **tasks.md と plan.md を別々に extract** し、`ExtractResult.files` を union する(diagnostics は flatten)。
