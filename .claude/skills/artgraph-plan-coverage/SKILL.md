---
name: "artgraph-plan-coverage"
description: "Detects implicit impacts: REQs reached by tasks.md `Files:` but not mentioned in `tasks.md` / `plan.md` / `spec.md` (reverse audit). Use after editing tasks.md / plan.md (e.g. after `/speckit-tasks`, or after updating `.kiro/specs/<name>/tasks.md`), before implementation."
allowed-tools:
  - "Bash(npx artgraph plan-coverage *)"
  - "Bash(pnpm exec artgraph plan-coverage*)"
  - "Bash(bunx artgraph plan-coverage*)"
  - "Bash(deno run*)"
  - "Bash(artgraph plan-coverage *)"
user-invocable: true
disable-model-invocation: false
---

## Purpose

Runs `artgraph plan-coverage` to detect **implicit impacts**: REQs that the files listed in `tasks.md` will touch via the artgraph graph, but which are never mentioned in `tasks.md` / `plan.md` / `spec.md`. These are the "I forgot existing requirement X also lives in this file" misses that `artgraph impact` (forward, file-only) and `artgraph check` (drift vs lock) cannot catch on their own.

Complementary to `artgraph-impact`: that Skill answers "what does this file edit touch?" — this Skill answers "of the things this plan touches, what did the human forget to write down?".

## Steps

### 1. Prerequisite check

See [install-check](../_shared/install-check.md) for the standard pre-flight check.

### 2. Pick a mode and run

| Mode | Trigger | Command |
| --- | --- | --- |
| (a) Auto-detect spec | Spec Kit project (`SPECIFY_FEATURE_DIRECTORY` env or `.specify/feature.json`) | `artgraph plan-coverage --format json` |
| (b) Explicit `--spec` | Kiro project, multiple specs in flight, or auto-detect failed | `artgraph plan-coverage --spec <dir> --format json` |

```bash
# (a) auto-detect — Spec Kit canonical lookup order
artgraph plan-coverage --format json

# (b) explicit spec dir — required for Kiro (no canonical current-spec marker)
artgraph plan-coverage --spec .specify/specs/<name>/ --format json
artgraph plan-coverage --spec .kiro/specs/<name>/    --format json
```

### 3. Parse the JSON output

The result has two views of the same implicit-impact data plus a summary:

| field | shape | use |
| --- | --- | --- |
| `implicitImpacts` | `[{ sourceFile, reqs: [{ reqId, kind }] }]` | "Which REQs does each file I'm touching pull in?" (by-sourceFile) |
| `implicitImpactsByReq` | `[{ reqId, sourceFiles: [string] }]` | "Which files does this implicit REQ come from?" (by-FR — inverse view) |
| `summary` | `{ totalAffected, mentioned, implicit, ignored }` | invariant: `totalAffected == mentioned + implicit + ignored` |
| `diagnostics` | `[{ kind, ... }]` | e.g. `missingFilesSection`, `unresolvedFilePath`, `emptyExtraction` |
| `ignored` | `string[]` | the `--ignore` REQ-IDs, echoed back for transparency |

If `implicitImpacts` is empty, report "No implicit impacts." and stop. If `diagnostics` contains `emptyExtraction`, warn explicitly: "No implicit impacts because nothing was extracted — add a `Files:` section." (silent green guard).

### 4. Resolve each implicit REQ — pick one of three paths

For every `reqId` in `implicitImpactsByReq`, help the user choose one of:

1. **Mention it.** Add a reference to the REQ-ID anywhere in `tasks.md`, `plan.md`, or `spec.md` — any label works (e.g. `Considered: REQ-003 — investigated, no impact`, `Affected: REQ-003`, `[REQ-003]`, a heading). The next `plan-coverage` run will see the mention and drop the REQ from `implicitImpacts`.
2. **`--ignore` (one-shot).** For CI-only suppression: `artgraph plan-coverage --gate --ignore REQ-003,REQ-007`. Not persisted anywhere — exists only for the current command. Use sparingly; prefer (1).
3. **Future: `--require-ack-keyword` (strict mode).** Out of scope for this Skill — tracked separately for a future spec.

### 5. Report back

Summarize: how many implicit REQs were found, the by-file breakdown, and the proposed action per REQ (which of the three paths above). If `--gate` was used in CI and any implicit impacts remain, the CLI exits 1 — surface that exit code to the caller.
