# Requirements Checklist: Spec Kit 残対応（FR-007/008 + 層2/3）

Feature Branch: `005-speckit-remaining`

Created: 2026-06-20

## Functional Requirements

- [ ] FR-007: `.artgraph.json` の `reqPatterns.listItem` にカスタム正規表現を指定してリスト項目の ID パターンを変更できる
- [ ] FR-007: `.artgraph.json` の `reqPatterns.heading` にカスタム正規表現を指定して見出しの ID パターンを変更できる
- [ ] FR-007: `reqPatterns` 未設定時は `LIST_ITEM_RE` / `KIRO_HEADING_RE` がデフォルトとして使用される
- [ ] FR-007: `listItem` のみ設定された場合、`heading` はデフォルトが適用される（部分設定対応）
- [ ] FR-007: 無効な正規表現が設定された場合、明確なエラーメッセージが表示される
- [ ] FR-007: キャプチャグループを含まない正規表現が設定された場合、エラーメッセージでキャプチャグループの必要性を示す
- [ ] FR-008: frontmatter の `title` フィールドが `GraphNode.metadata` に格納される
- [ ] FR-008: frontmatter の `status` フィールドが `GraphNode.metadata` に格納される
- [ ] FR-008: frontmatter の `priority` フィールドが `GraphNode.metadata` に格納される
- [ ] FR-008: frontmatter の `owner` フィールドが `GraphNode.metadata` に格納される
- [ ] FR-008: frontmatter に該当フィールドが存在しない場合、`metadata` にそのキーは含まれない
- [ ] FR-008: frontmatter 自体が存在しない場合、`metadata` は `undefined` のまま
- [ ] FR-008: `status: "implemented"` が設定されていても coverage 判定に影響しない
- [ ] FR-008: `artgraph.node_id` と Spec Kit メタデータの両方が存在する場合、両方が独立して処理される
- [x] FR-009: plan.md / tasks.md 内の `@impl(xxx)` タグから `task` ノード → 実装先への `implements` エッジが生成される（U1 対称認識）
- [x] FR-010: plan.md / tasks.md 内の `[REQ-xxxx]` タグから `task` ノード → 要件への `verifies` エッジが生成される（target は bracket 内文字列をそのまま使用）
- [x] FR-012: 規約プリセット方式で task ID を抽出する。Built-in `spec-kit` / `kiro` + `.artgraph.json` `taskConventions` で OpenSpec 等のカスタムプリセット追加可能
- [ ] FR-011: `specs/NNN-feature/` ディレクトリ構造内のファイルが自動的にスキャン対象に含まれる
- [ ] FR-011: 特定フィーチャー番号を指定した選択的スキャンが可能

## Non-Functional Requirements

- [ ] NFR-001: 無効な正規表現のバリデーションがパース開始前に実行される
- [ ] NFR-001: エラーメッセージにエラー箇所の特定に十分な情報が含まれる
- [ ] NFR-002: frontmatter メタデータ読み取りによるパフォーマンス劣化が 5% 未満
- [ ] NFR-003: FR-007 / FR-008 の追加で既存テストが全て通過する
- [x] NFR-004 (Phase 2): FR-009 / FR-010 / FR-012 の追加で既存テスト 565 件 + 新規テストが全て通過する
- [x] NFR-001 拡張: `taskConventions` の無効パターン (regex / nested quantifier / 重複 name / 空 fileStems / capture group 欠落) でも `loadConfig` がパース開始前に明示エラーを発生させる

## Type Definitions

- [ ] `GraphNode` に `metadata?: Record<string, string>` フィールドを追加（`types.ts`）
- [ ] `ReqPatternConfig` 型は既存のまま使用（変更不要であることを確認）
- [ ] `ArtgraphConfig.reqPatterns` は既存のまま使用（変更不要であることを確認）
- [x] (Phase 2) `NodeKind` union に `"task"` を追加（既存 5 NodeKind → 6 NodeKind、`types.ts`）
- [x] (Phase 2) `TaskConventionPreset` interface を `types.ts` に追加（`name: string; fileStems: string[]; taskIdRe: string`）
- [x] (Phase 2) `ArtgraphConfig.taskConventions?: TaskConventionPreset[]` フィールドを追加（`types.ts`）

## Integration Points

- [ ] `config.ts` で読み込んだ `reqPatterns` が `markdown.ts` のパーサに渡される
- [ ] `markdown.ts` の `parseMarkdown` 関数がオプショナルな `reqPatterns` 引数を受け取る
- [ ] frontmatter メタデータの読み取りが既存の `artgraph.node_id` 処理と共存する
- [x] (Phase 2) `config.ts` で読み込んだ `taskConventions` が `markdown.ts` のパーサに渡される
- [x] (Phase 2) `graph/builder.ts` で `task` ノードを req と同じ衝突解決パスに通す
- [x] (Phase 2) `graph/builder.ts` の `contains` エッジ生成が `doc → task` を含む（`autoContains` 有効時）

## Success Criteria (Phase 2)

- [x] SC-004: plan.md / tasks.md の `@impl` タグから `implements` エッジが正しく生成される（FR-009 検証）
- [x] SC-005: plan.md / tasks.md の `[REQ-xxxx]` タグから `verifies` エッジが正しく生成される（FR-010 検証、target は bracket 内文字列をそのまま使用）
- [x] SC-007: 規約プリセット方式により Built-in (`spec-kit`, `kiro`) およびユーザ追加プリセット (例: OpenSpec) が同一の経路で動作する（FR-012 検証）
- [x] SC-008: Phase 2 後の `pnpm --filter artgraph test` で既存 565 件 + 新規テスト全件が PASS（NFR-004 運用化）

## Edge Cases

- [ ] `reqPatterns.listItem` に空文字列が指定された場合、エラーとして扱う
- [ ] `reqPatterns.heading` に空文字列が指定された場合、エラーとして扱う
- [ ] frontmatter の `status` に任意の文字列が入ってもバリデーションエラーにならない
- [ ] plan.md / tasks.md が Spec Kit フォーマットに従わない場合、エラーなく通常の Markdown としてパースされる
- [ ] 同一フィーチャーディレクトリ内で名前空間衝突が発生した場合、既存の `specDir/ID` 修飾が適用される
- [x] (Phase 2) `@impl()` 空内容は edge 生成スキップ（warning なし）
- [x] (Phase 2) `[REQ-]` の bracket 内に `REQ-` prefix が無い `[FOO-001]` 形式も regex がマッチすれば認識
- [x] (Phase 2) 階層 task ID (`1.1`, `1.1.1`) が独立した task ノードとして扱われ、親子関係は本 PR では生成しない

## Backward Compatibility

- [ ] `reqPatterns` 未設定時の動作が PR #6 時点と完全に同一
- [ ] `metadata` フィールド未設定時の `GraphNode` が既存コードに影響しない
- [ ] 既存の frontmatter（`artgraph.node_id` 等）の処理が変更されない
- [x] (Phase 2) `taskConventions` 未設定時に builtin プリセットが有効化されても、既存 fixture (`tests/fixtures/conventions/specs/**/*.{plan,tasks}.md`) には task ID 行が無いため task ノード生成数ゼロを維持（NFR-004 と同義）
