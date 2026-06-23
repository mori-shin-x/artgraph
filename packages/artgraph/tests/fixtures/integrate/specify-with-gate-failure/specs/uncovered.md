# Uncovered REQ fixture (T064)

This spec intentionally declares requirements with no `@impl` tag pointing
back at them, so that `artgraph check --gate` reports them as **uncovered**
and exits with code 2. The fixture is consumed by T063 to verify SC-006 /
FR-017 (Spec Kit Hook 経由で発火する artgraph check --gate が drift /
orphan / uncovered を検出した場合は SDD ワークフローの当該段階を停止
させる).

## Requirements

- GATE-001: Gate halt requirement intentionally has no implementation reference.
- GATE-002: Second uncovered requirement so the failure list has more than one entry.
