---
title: "User Authentication"
status: draft
priority: P1
---

# User Authentication Spec

## Requirements

- FEAT-001: ユーザーはメールでログインできる
  - メールとパスワードで認証
  - 成功時にトークンを返す
- FEAT-002: パスワードリセット機能
  - メールアドレスでリセットリンクを送信
- **SC-001**: ログイン完了まで2秒以内

## Non-Functional

- NFR-1: レスポンスタイム 200ms 以内
