# list-item 形式 req に対するインライン注釈の受理／非受理／警告サンプル

要求リスト:

- AUTH-001: 認証
- AUTH-002: セッション管理 (depends_on: AUTH-001)
- AUTH-003: ログアウト (derives_from: AUTH-002)
- AUTH-004: マルチデバイス (depends_on: AUTH-001, AUTH-002, AUTH-003)
- AUTH-005: 強制ログアウト (depends_on: **AUTH-001**)
- AUTH-006: 整形バリエーション ( depends_on : AUTH-001 , AUTH-002 )
- AUTH-007: 並列注釈 (depends_on: AUTH-001)(derives_from: AUTH-002)

誤検出ゼロ確認の散文セクション。AUTH-002 は AUTH-001 に (depends on AUTH-001) しています。
これは英語表現であり注釈ではありません。

大文字キーワードは注釈として認識されない例: (DEPENDS_ON: AUTH-001)。

> 引用ブロック内の注釈: (depends_on: AUTH-001)
> これも注釈位置外（list-item / heading 直下段落でない）として扱われる。

fenced code block 内のサンプル（こちらも非対象）:

```md
- AUTH-009: コード内 (depends_on: AUTH-001)
```
