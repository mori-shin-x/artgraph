---
description: "Gate implementation on artgraph check (--gate mode)"
---

# artgraph: check --gate

## Behavior

Hard-fails the workflow if drift/orphan/uncovered exist (exit 2). Use before `/speckit-implement` when you want a strict gate.

> **WARNING — 新規 spec の初回実装では必ず失敗します**: `artgraph check --gate`
> は全 REQ の絶対チェックです。まだ何も実装していない新規 spec では全 REQ が
> UNCOVERED のため、初回の `/speckit-implement` 直前では **必ず exit 2 になり
> ます。これは想定内であり、無視して実装に進んで構いません。** 詳細は拡張の
> `README.md` を参照。gating ポリシーの本設計は
> [#178](https://github.com/mori-shin-x/artgraph/issues/178) で継続中。

## Execution

- **Bash**: `artgraph check --gate`

> CI note (spec 023): CI で PR をゲートする場合は `artgraph check --diff --base origin/<base-branch> --gate` を使う (PR のコミット範囲が新規に導入した問題のみで判定。`fetch-depth: 0` の checkout が必要)。
