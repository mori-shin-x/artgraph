# rename 用 multi-id サンプル

- AUTH-001: 認証
- AUTH-002: セッション管理 (depends_on: AUTH-001)
- AUTH-003: ログアウト (depends_on: AUTH-001, AUTH-002)
- AUTH-004: 強制ログアウト (depends_on: **AUTH-001**)
- AUTH-005: 重複参照 (depends_on: AUTH-001, AUTH-002, AUTH-001)
- AUTH-006: 整形 ( depends_on : AUTH-001 , AUTH-002 )

fenced code block 内の注釈（書き換え非対象）:

```md
- AUTH-009: コード内 (depends_on: AUTH-001)
```
