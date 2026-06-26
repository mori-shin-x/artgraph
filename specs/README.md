# specs/

このディレクトリは artgraph 自身の SDD アーティファクト（[Spec Kit](https://github.com/github/spec-kit) 形式の `spec.md` / `plan.md` / `tasks.md` 一式）を機能単位で保管している。artgraph は SDD ツール用の整合性検証ツールであり、`artgraph scan` をこのリポジトリに対して実行すると、ここに並ぶ要求 ID と `src/` 配下コードの紐付き・drift・カバレッジが検証される（＝自己ドッグフーディング）。

新規機能の追加フローは [CONTRIBUTING.md](../CONTRIBUTING.md) を参照。番号付きディレクトリは履歴アーティファクトとして保持し、完了済みのものも削除しない。
