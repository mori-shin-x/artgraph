# Requirements Checklist: Spec Kit 残対応（FR-007/008 + 層2/3）

Feature Branch: `005-speckit-remaining`

Created: 2026-06-20

## Functional Requirements

- [ ] FR-007: `.spectrace.json` の `reqPatterns.listItem` にカスタム正規表現を指定してリスト項目の ID パターンを変更できる
- [ ] FR-007: `.spectrace.json` の `reqPatterns.heading` にカスタム正規表現を指定して見出しの ID パターンを変更できる
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
- [ ] FR-008: `spectrace.node_id` と Spec Kit メタデータの両方が存在する場合、両方が独立して処理される
- [ ] FR-009: plan.md 内の `@impl(xxx)` タグからタスクノード → 実装先への `implements` エッジが生成される
- [ ] FR-010: tasks.md 内の `[REQ-xxxx]` タグからタスクノード → 要件への `verifies` エッジが生成される
- [ ] FR-011: `specs/NNN-feature/` ディレクトリ構造内のファイルが自動的にスキャン対象に含まれる
- [ ] FR-011: 特定フィーチャー番号を指定した選択的スキャンが可能

## Non-Functional Requirements

- [ ] NFR-001: 無効な正規表現のバリデーションがパース開始前に実行される
- [ ] NFR-001: エラーメッセージにエラー箇所の特定に十分な情報が含まれる
- [ ] NFR-002: frontmatter メタデータ読み取りによるパフォーマンス劣化が 5% 未満
- [ ] NFR-003: FR-007 / FR-008 の追加で既存テストが全て通過する

## Type Definitions

- [ ] `GraphNode` に `metadata?: Record<string, string>` フィールドを追加（`types.ts`）
- [ ] `ReqPatternConfig` 型は既存のまま使用（変更不要であることを確認）
- [ ] `SpectraceConfig.reqPatterns` は既存のまま使用（変更不要であることを確認）

## Integration Points

- [ ] `config.ts` で読み込んだ `reqPatterns` が `markdown.ts` のパーサに渡される
- [ ] `markdown.ts` の `parseMarkdown` 関数がオプショナルな `reqPatterns` 引数を受け取る
- [ ] frontmatter メタデータの読み取りが既存の `spectrace.node_id` 処理と共存する

## Edge Cases

- [ ] `reqPatterns.listItem` に空文字列が指定された場合、エラーとして扱う
- [ ] `reqPatterns.heading` に空文字列が指定された場合、エラーとして扱う
- [ ] frontmatter の `status` に任意の文字列が入ってもバリデーションエラーにならない
- [ ] plan.md / tasks.md が Spec Kit フォーマットに従わない場合、エラーなく通常の Markdown としてパースされる
- [ ] 同一フィーチャーディレクトリ内で名前空間衝突が発生した場合、既存の `specDir/ID` 修飾が適用される

## Backward Compatibility

- [ ] `reqPatterns` 未設定時の動作が PR #6 時点と完全に同一
- [ ] `metadata` フィールド未設定時の `GraphNode` が既存コードに影響しない
- [ ] 既存の frontmatter（`spectrace.node_id` 等）の処理が変更されない
