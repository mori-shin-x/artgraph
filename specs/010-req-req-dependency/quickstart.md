# Quickstart: req→req dependency annotation

Plan: [plan.md](./plan.md) | Spec: [spec.md](./spec.md)

実装完了後、本ガイドの手順を上から順に実行することで feature の E2E 動作を
検証できる。

## 前提

- リポジトリルートで `pnpm install` 済み
- `packages/artgraph` でビルド済み（`pnpm -F artgraph build` または開発時 `pnpm -F artgraph dev`）
- 一時作業ディレクトリ `/tmp/artgraph-req-req-demo` を使用

## Scenario 1: list-item 注釈で req→req エッジ生成（FR-001, FR-004 検証）

### Setup

```bash
mkdir -p /tmp/artgraph-req-req-demo/specs/001-auth
cat > /tmp/artgraph-req-req-demo/specs/001-auth/spec.md <<'EOF'
# Auth

- AUTH-001: 認証
- AUTH-002: セッション管理 (depends_on: AUTH-001)
- AUTH-003: ログアウト (derives_from: AUTH-002)
- AUTH-004: マルチデバイス (depends_on: AUTH-001, AUTH-002)
EOF

cat > /tmp/artgraph-req-req-demo/.artgraph.json <<'EOF'
{
  "specDirs": ["specs/001-auth"],
  "rootDir": "."
}
EOF
```

### Run

```bash
cd /tmp/artgraph-req-req-demo
artgraph graph --format json
```

### Expected

JSON 出力に以下のエッジが含まれる:

```json
{ "source": "AUTH-002", "target": "AUTH-001", "kind": "depends_on", "provenance": "annotation" }
{ "source": "AUTH-003", "target": "AUTH-002", "kind": "derives_from", "provenance": "annotation" }
{ "source": "AUTH-004", "target": "AUTH-001", "kind": "depends_on", "provenance": "annotation" }
{ "source": "AUTH-004", "target": "AUTH-002", "kind": "depends_on", "provenance": "annotation" }
```

## Scenario 2: 注釈追加で drift が発生しないこと（FR-007, SC-003 検証）

### Setup

Scenario 1 の状態を継続使用。

```bash
artgraph reconcile
# .trace.lock 生成（AUTH-002 の contentHash が記録される）
LOCK_BEFORE=$(jq '.["AUTH-002"].contentHash' .trace.lock)
```

### Mutate

AUTH-002 行にもう 1 つ依存を追加:

```bash
sed -i 's/(depends_on: AUTH-001)/(depends_on: AUTH-001, AUTH-005)/' specs/001-auth/spec.md
artgraph reconcile
```

### Expected

```bash
LOCK_AFTER=$(jq '.["AUTH-002"].contentHash' .trace.lock)
[ "$LOCK_BEFORE" = "$LOCK_AFTER" ] && echo "PASS: hash unchanged" || echo "FAIL"
artgraph check
# AUTH-002 由来の drift / re-verify 警告が出ないこと
```

## Scenario 3: heading 形式での注釈（FR-002 検証）

### Setup

```bash
cat > /tmp/artgraph-req-req-demo/specs/001-auth/spec.md <<'EOF'
# Auth

## Requirement 1: 認証

ユーザは email でログインできる。

## Requirement 2: セッション管理

(depends_on: Requirement-1)

セッションは 24 時間有効。
EOF
```

### Run / Expected

```bash
artgraph graph --format json
# 出力に { "source": "Requirement-2", "target": "Requirement-1", "kind": "depends_on", "provenance": "annotation" } が含まれる
```

## Scenario 4: REQ ID rename で注釈追従（FR-010 検証）

### Setup

Scenario 1 の状態を継続使用（list-item 形式 spec.md）。`artgraph rename` は `git ls-files` で対象ファイルを発見するため、demo プロジェクトを git 管理下に置く:

```bash
git init -q && git add -A
```

### Run

```bash
artgraph rename --from AUTH-001 --to AUTH-100
```

### Expected

`specs/001-auth/spec.md` の中身:

```md
- AUTH-100: 認証
- AUTH-002: セッション管理 (depends_on: AUTH-100)
- AUTH-003: ログアウト (derives_from: AUTH-002)
- AUTH-004: マルチデバイス (depends_on: AUTH-100, AUTH-002)
```

`artgraph graph` を再実行し、エッジ本数が rename 前後で同じであることを確認:

```bash
BEFORE_EDGES=$(artgraph graph --format json | jq '.edges | length')
artgraph rename --from AUTH-001 --to AUTH-100   # 再度同じ rename を試みても idempotent
AFTER_EDGES=$(artgraph graph --format json | jq '.edges | length')
[ "$BEFORE_EDGES" = "$AFTER_EDGES" ] && echo "PASS: edge count preserved"
```

実コマンドで検証済み（このリポジトリのスモークテスト）:

```
Renamed AUTH-001 → AUTH-100
  specs/001-auth/spec.md:3  - AUTH-001: 認証 → - AUTH-100: 認証
  specs/001-auth/spec.md:4  - AUTH-002: セッション管理 (depends_on: AUTH-001, AUTH-005) → ... (depends_on: AUTH-100, AUTH-005)
  specs/001-auth/spec.md:6  - AUTH-004: マルチデバイス (depends_on: AUTH-001, AUTH-002) → ... (depends_on: AUTH-100, AUTH-002)
```

## Scenario 5: 散文中の誤検出ゼロ（FR-003, SC-002 検証）

### Setup

```bash
cat > /tmp/artgraph-req-req-demo/specs/001-auth/spec.md <<'EOF'
# Auth

- AUTH-001: 認証
- AUTH-002: セッション管理は AUTH-001 に (depends on AUTH-001) しています
- AUTH-003: ログアウト
EOF
```

### Run / Expected

```bash
artgraph graph --format json
# req→req エッジは 0 本（"depends on" はアンダースコア無しのため検出されない）
# AUTH-002 / AUTH-003 は req ノードとしては登録される
```

## 想定実行時間

各シナリオ < 1 秒（依存スキャン込み）。

## 関連 contract

- [contracts/annotation-grammar.md](./contracts/annotation-grammar.md)
- [contracts/provenance-field.md](./contracts/provenance-field.md)
- [contracts/rename-behavior.md](./contracts/rename-behavior.md)
