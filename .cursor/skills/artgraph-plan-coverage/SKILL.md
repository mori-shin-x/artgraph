---
name: "artgraph-plan-coverage"
description: "Detects implicit impacts: REQs reached by tasks.md `Files:` but not mentioned in `tasks.md` / `plan.md` / `spec.md` (reverse audit). Use after editing tasks.md / plan.md (e.g. after `/speckit-tasks`, or after updating `.kiro/specs/<name>/tasks.md`), before implementation."
allowed-tools:
  - "Bash(npx artgraph plan-coverage *)"
  - "Bash(npx --no-install artgraph plan-coverage *)"
  - "Bash(pnpm exec artgraph plan-coverage *)"
  - "Bash(bunx artgraph plan-coverage *)"
  - "Bash(bunx --no-install artgraph plan-coverage *)"
  - "Bash(deno run -A npm:artgraph/cli plan-coverage *)"
  - "Bash(artgraph plan-coverage *)"
user-invocable: true
disable-model-invocation: false
---

## Purpose

Runs `artgraph plan-coverage` to detect **implicit impacts**: REQs that the files (or `path:symbol` pairs) listed in `tasks.md` will touch via the artgraph graph, but which are never mentioned in `tasks.md` / `plan.md` / `spec.md`. These are the "I forgot existing requirement X also lives in this file" misses that `artgraph impact` (forward) and `artgraph check` (drift vs lock) cannot catch on their own.

Complementary to `artgraph-impact`: that Skill answers "what does this edit touch?" — this Skill answers "of the things this plan touches, what did the human forget to write down?".

## Steps

### 1. Prerequisite check

See [install-check](../_shared/install-check.md) for the standard pre-flight check. If artgraph is not installed, stop and invoke the `artgraph-setup` Skill instead.

> `<PM-exec>` is the project's package runner: `npx` (npm), `pnpm exec`, `bunx`, or `deno run -A npm:artgraph/cli`. Substitute the one detected by `_shared/package-manager.md` (or written in `.artgraph.json#packageManager`).

**Symbol-level entries** (`Files: src/auth.ts:validateToken`) require `.artgraph.json` to be set to `"mode": "symbol"` and the graph re-scanned. See [Skills Guide — file vs symbol mode](../../../docs/skills-guide.md#file-mode-vs-symbol-mode) for trade-offs.

### 2. Pick a mode and run

| Mode | Trigger | Command |
| --- | --- | --- |
| (a) Auto-detect spec | Spec Kit project (`SPECIFY_FEATURE_DIRECTORY` env or `.specify/feature.json`) | `<PM-exec> plan-coverage --format json` |
| (b) Explicit `--spec` | Kiro project, multiple specs in flight, or auto-detect failed | `<PM-exec> plan-coverage --spec <dir> --format json` |

```bash
# (a) auto-detect — Spec Kit canonical lookup order
<PM-exec> plan-coverage --format json

# (b) explicit spec dir — required for Kiro (no canonical current-spec marker)
<PM-exec> plan-coverage --spec .specify/specs/<name>/ --format json
<PM-exec> plan-coverage --spec .kiro/specs/<name>/    --format json
```

### 3. Parse the JSON output

The result carries the **dual-axis impact view** (per `implicitImpacts` entry) plus a summary:

| field | shape | use |
| --- | --- | --- |
| `implicitImpacts` | `[{ sourceFile, sourceSymbol?, impactReqs: ReqEntry[], originReqs: ReqEntry[] }]` | "Which REQs does each file or symbol I'm touching pull in?" `impactReqs` = forward BFS reach; `originReqs` = 1-hop `@impl` claim of that start id |
| `implicitImpactsByReq` | `[{ reqId, sourceLocations: Array<{file, symbol?}> }]` | "Which file or symbol does this implicit REQ come from?" (inverse view) |
| `summary` | `{ totalAffected, mentioned, implicit, ignored }` | invariant: `totalAffected == mentioned + implicit + ignored` |
| `diagnostics` | `[{ kind, ... }]` | `missingFilesSection` / `unresolvedFilePath` / `unresolvedSymbol` / `emptyExtraction` |
| `ignored` | `string[]` | the `--ignore` REQ-IDs, echoed back for transparency |

#### Reading the two axes — drift detection

Compare per-entry `impactReqs` against `originReqs`:

- **`impactReqs \ originReqs` non-empty → drift candidate.** The start id reaches a REQ it does not `@impl`-claim. Surface those REQs and ask the user to either tag the symbol with `@impl REQ-XXX` or update the spec graph.
  - **Exception (c) — barrel-side namespace re-export.** If the entry is `Files: barrel.ts:ns` where `ns` is defined by `export * as ns from "./o"` (S2) or `import * as ns from "./m"; export { ns }` (S3-namespace), `entryOriginIds` cannot follow the `symbol:barrel#ns → file:O` file-grain edge, so `originReqs` is empty and every reached REQ appears as a drift candidate. **This is expected and does not require `@impl` on the barrel — the barrel is a re-export shim, not an implementation site.** Either (i) switch the entry to file-level (`Files: barrel.ts`) to include all origin REQs, or (ii) target the underlying origin directly (`Files: o.ts:actualSymbol`).
- **Sets equal → no drift.** Claim and reach match.
- **`originReqs \ impactReqs` non-empty → orphan claim.** Out of scope for this Skill — `artgraph check --gate` (Stop hook) will report it.

#### Diagnostics

- `unresolvedSymbol` (`{ sourceFile, symbol, line }`): the file exists but no exported symbol of that name was found in the symbol-mode graph. The entry is excluded from `implicitImpacts`. Ask the user whether to (a) fix the typo, (b) drop the `:symbol` suffix to fall back to file unit, or (c) re-run `<PM-exec> scan` if the symbol was just added.
- `emptyExtraction`: nothing was extracted — warn "add a `Files:` section."
- `missingFilesSection` (opt-in via `planCoverage.requireFilesSection` in `.artgraph.json`): some task blocks lack a `Files:` section.

If `implicitImpacts` is empty and no warnings fire, report "No implicit impacts." and stop.

### 4. Resolve each implicit REQ — pick one of three paths

For every `reqId` in `implicitImpactsByReq`, help the user choose one of:

1. **Mention it.** Add a reference to the REQ-ID anywhere in `tasks.md`, `plan.md`, or `spec.md` — any label works (e.g. `Considered: REQ-003 — investigated, no impact`, `Affected: REQ-003`, `[REQ-003]`, a heading). The next run drops the REQ from `implicitImpacts`.
2. **`--ignore` (one-shot).** For CI-only suppression: `<PM-exec> plan-coverage --gate --ignore REQ-003,REQ-007`. Not persisted; exists only for the current command. Use sparingly; prefer (1).
3. **Future: `--require-ack-keyword` (strict mode).** Out of scope for this Skill.

### 5. Report back

Summarize: implicit REQ count, by-source-location breakdown (note `file` vs `file:symbol`), drift candidates per entry, and the proposed action per REQ. If `--gate` was used in CI and any implicit impacts remain, the CLI exits 1 — surface that exit code to the caller.
