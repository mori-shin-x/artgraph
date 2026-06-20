---
spectrace:
  node_id: "doc:auth-design"
  depends_on:
    - { id: "REQ-7f3a", relation: implements }
---

# Auth Module Design

## REQ-7f3a (auth-login): ユーザーはメールでログインできる

- メールとパスワードでログインできること
- ログイン成功時にセッショントークンを返すこと
- 不正な認証情報では401を返すこと

## REQ-a1b2 (auth-session): セッション管理

- セッショントークンは24時間で失効する
- リフレッシュトークンで延長可能

## REQ-c3d4 (auth-logout): ログアウト機能

- ログアウト時にセッションを無効化する
