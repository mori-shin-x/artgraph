# Kiro 形式 heading req に対する注釈サンプル

## Requirement 1: 認証

ユーザは email/password でログインできる。

## Requirement 2: セッション管理

(depends_on: Requirement-1)

セッションは 24 時間有効とする。

## Requirement 3: 自動ログアウト

セッション期限切れで自動的に logout する。 (depends_on: Requirement-2)

## Requirement 4: 単一行段落

短い要約のみ (depends_on: Requirement-1)

## Requirement 5: heading 行内括弧式 (depends_on: Requirement-X)

これは heading 行自体に括弧式があるが、注釈位置外なので edge を作らない。

別段落の説明。

## Requirement 6: 中間行配置

最初の説明行（注釈位置）。
ここは中間行 (depends_on: Requirement-Y) — 中間行の括弧式も注釈位置外。
最後の行 — 注釈位置だが本テストでは検出される側に注釈は置かない。
