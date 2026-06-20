---
spectrace:
  node_id: "doc:auth-design"
  depends_on:
    - { id: "AUTH-001", relation: implements }
---

# Auth Module Design

## Requirements

- AUTH-001: ユーザーはメールでログインできる
  - メールとパスワードでログインできること
  - ログイン成功時にセッショントークンを返すこと
  - 不正な認証情報では401を返すこと

- AUTH-002: セッション管理
  - セッショントークンは24時間で失効する
  - リフレッシュトークンで延長可能

- AUTH-003: ログアウト機能
  - ログアウト時にセッションを無効化する
