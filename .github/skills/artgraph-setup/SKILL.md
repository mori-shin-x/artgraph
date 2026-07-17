---
name: "artgraph-setup"
description: "Installs artgraph in the current project, detects the package manager (npm / pnpm / Bun / Deno; default and Yarn fallback are pnpm), and wires up Skills, hooks, agent-context snippet, and any detected SDD-tool integration. Use when the user asks to install / set up / add artgraph, asks whether artgraph is set up or what is installed, or wants to wire artgraph into an SDD tool (Spec Kit / Kiro) added after artgraph. Make sure to use this skill whenever the user mentions artgraph for the first time and `artgraph` CLI is not yet available."
allowed-tools:
  - "Bash(npm install*)"
  - "Bash(npm i*)"
  - "Bash(pnpm add*)"
  - "Bash(pnpm install*)"
  - "Bash(bun add*)"
  - "Bash(bun install*)"
  - "Bash(deno add*)"
  - "Bash(deno install*)"
  - "Bash(npx artgraph *)"
  - "Bash(npx --no-install artgraph *)"
  - "Bash(pnpm exec artgraph *)"
  - "Bash(bunx artgraph *)"
  - "Bash(bunx --no-install artgraph *)"
  - "Bash(deno run -A npm:artgraph/cli *)"
  - "Bash(artgraph *)"
user-invocable: true
disable-model-invocation: false
---

## Purpose

Installs artgraph using the project's detected package manager and runs `artgraph init` to lay down the full agent-native setup — Skills, hooks, agent-context snippet, and SDD-tool integration. If artgraph is already installed, it inspects and reports the current setup state instead of reinstalling.

## Steps

Every Bash tool call is a **fresh shell** — variables do not persist across calls. Each step below is one self-contained Bash invocation; carry the detected PM across steps as plain text in your reasoning, not as a shell variable.

### 1. Confirm CLI is not yet installed

See [install-check](../_shared/install-check.md). For this Skill the probe is expected to FAIL — if it succeeds (CLI already on PATH or installed locally), tell the user "artgraph is already installed", skip steps 2-6, and report the current state instead (see "Already installed? Report the state" below).

### 2. Detect the package manager

Inspect the project root and apply these rules in order — first match wins. The Corepack `packageManager` field wins over lockfile sniffing (Corepack convention: an explicit `packageManager` field always overrides a lockfile signal, even when the two disagree — e.g. `packageManager: bun@*` with a stale `pnpm-lock.yaml` still selects bun). The canonical rules and rationale live in [package-manager](../_shared/package-manager.md), which must stay in sync with `src/package-manager.ts`.

1. If `package.json` exists, read it as UTF-8 and strip a leading UTF-8 BOM (`U+FEFF`, byte sequence `EF BB BF`) before parsing (the TS detector strips the BOM too — SC-007). Then read its **top-level** `"packageManager"` field (Corepack-style `<pm>@<version>`, e.g. `pnpm@9.0.0`; a nested key does not count, the PM name must be lowercase, and the `@version` suffix must contain at least one digit — bare names or trailing `@` are ignored):
   - `npm` / `pnpm` / `bun` -> use that PM.
   - `yarn` -> use **pnpm** and warn the user with the verbatim wording `packageManager=yarn but Yarn is not supported; falling back to pnpm`.
   - Field absent, malformed, or any other value -> continue to rule 2.
2. Lockfile / config sniffing — first matching **regular file** wins, in this order:
   - `bun.lockb` or `bun.lock` -> **bun**
   - `deno.lock`, `deno.json`, or `deno.jsonc`, and **no** `package.json` -> **deno**
   - `pnpm-lock.yaml` -> **pnpm**
   - `yarn.lock` -> **pnpm**, warn the user with the verbatim wording `yarn.lock found but Yarn is not supported; falling back to pnpm`.
   - `package-lock.json` -> **npm**
3. `package.json` exists but nothing above matched -> default to **pnpm**.
4. Nothing matched at all -> detection fails: tell the user you cannot detect the package manager and ask which to use (npm / pnpm / bun / deno).

Relay any warning to the user verbatim (see the backticked wording above — the TS detector writes the same strings to stderr, and CI enforces the match). On detection failure, ask which PM (npm / pnpm / bun / deno) and use that answer for the rest of the steps. Remember the chosen PM for steps 3-6.

### 2.5 Determine the target agents

Decide the `--agents=<list>` value used in Step 3's table and Step 5's `init`, in order:

1. Enumerate all five canonical skills paths (`.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, `.kiro/skills/`) and use the agent id(s) (`claude` / `codex` / `cursor` / `copilot` / `kiro`) of every path that already contains an `artgraph-*` subdirectory with a `SKILL.md` — respect the distribution the repo already chose.
2. If none of the five paths contains an `artgraph-*` Skill yet, use the id of the host agent you are currently running as (e.g. `claude` for Claude Code).
3. If still undetermined, ask the user which agent(s) to target (supported: claude, codex, copilot, cursor, kiro).

### 3. Get explicit user consent

Look up the detected PM in this table and show the user the three commands that will run. Wait for confirmation before proceeding; if the user declines, exit and tell them they can run the commands manually.

| PM | install | init | check |
| --- | --- | --- | --- |
| npm | `npm install -D artgraph` | `npx artgraph init --agents=<agents>` | `npx artgraph check` |
| pnpm | `pnpm add -D artgraph` | `pnpm exec artgraph init --agents=<agents>` | `pnpm exec artgraph check` |
| bun | `bun add -d artgraph` | `bunx artgraph init --agents=<agents>` | `bunx artgraph check` |
| deno | `deno add npm:artgraph` | `deno run -A npm:artgraph/cli init --agents=<agents>` | `deno run -A npm:artgraph/cli check` |

`<agents>` is the comma-separated list decided in Step 2.5. `init` runs the full default flow (config + scan + Skills + integrate-auto for detected SDD tools + Stop hook + agent context).

### 4. Install the CLI

Check whether artgraph is already a declared dependency: for npm/pnpm/bun, check `package.json`'s `dependencies`/`devDependencies`; for deno (which by definition has no `package.json` — see Step 2 rule 2), check `deno.json` / `deno.jsonc`'s `imports` map for an `artgraph` entry instead. If already declared, run the plain install command for the detected PM instead of the row's install command — `npm install` / `pnpm install` / `bun install` / `deno install`. A plain install restores the lockfile-pinned version; the row's add-style command re-resolves the registry's latest and can drift from a committed lockfile.

Otherwise, pick the row in the table above for the detected PM and run the **install** command as one Bash call.

Either way, if the install command fails (network, registry timeout, lockfile conflict, etc.), report the stderr to the user and stop. Do not retry without consent.

### 5. Run init

Check the project root for both `.artgraph.json` and its configured lock file (the config's `lockFile` field, default `.trace.lock`) — a config without a lock is a partial init, not a full one, since a missing lock reads as empty and would let `check` pass with nothing to compare against.

- **Both present** -> already fully initialized (e.g. a teammate committed distributed Skills and config already); **skip init** and go straight to Step 6. Also check the "SDD tool installed after artgraph" section below in case an SDD tool was added after that init.
- **Config present, lock missing** -> partially initialized (a fresh clone of a repo that doesn't commit the lock, or a prior `init --minimal`). Do not run init or pass `--force`; instead run the **scan** command once via the PM runner (e.g. `pnpm exec artgraph scan`) to generate the lock locally, tell the user you did so, then go to Step 6.
- **Neither present** -> run the **init** command from the same row as one Bash call. On non-zero exit, surface the stderr to the user without retry — `init` reports which sub-step failed (config / scan / Skills / integrate / hook / agent context).

In the first two cases, do not pass `--force`: it would overwrite the team's committed config.

### 6. Verify

Run the **check** command from the same row as one Bash call. `check` exits 0 by default even when it reports drift or uncovered requirements (that gating only happens with `--gate`, which this Skill does not pass) — do not read the exit code as pass/fail. Inspect the printed output instead: no drift/uncovered lines means the graph reconciled cleanly; if any lines are reported, relay them to the user verbatim.

If the `init` output from Step 5 included `Zero-tag ready:` (no specs or `@impl` claims detected yet), a clean `check` here is expected but not meaningful — there are no req/doc nodes yet for it to reconcile. Note that to the user and recommend `artgraph impact --diff` instead (or in addition): it already works off the project's TS imports and demonstrates value before any tagging is done.

Report the result to the user.

## Already installed? Report the state

When the Step 1 probe succeeds, inspect and report instead of reinstalling. The steps below describe intent, not literal shell commands — compose each check with your own shell's syntax or file-inspection tools, whichever fits your environment:

- Whether `.artgraph.json` exists at the project root -> `config: present` or `config: missing`.
- Whether `.specify/` exists -> Spec Kit detected; whether `.specify/extensions/artgraph/` exists -> Spec Kit integrated.
- Whether `.kiro/` exists -> Kiro detected; whether `.kiro/steering/artgraph.md` exists -> Kiro integrated.
- Which `artgraph-*` Skills are installed: enumerate all five canonical skills paths (`.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, `.kiro/skills/` — a project may have any subset) and list the subdirectories that contain a `SKILL.md`.
- Whether the Stop hook is wired: check `.claude/settings.json`. If `hooks.Stop` contains an entry whose `command` includes `check --gate --diff` (the artgraph gate rendered from `templates/hooks/settings.json.template`) -> `hook: wired`. If `hooks.Stop` exists but no entry includes `check --gate --diff` (a pre-existing Stop hook for something else) -> report `hook: present, not artgraph` rather than `missing` — the completion command below will hit this as a conflict and exit non-zero. If `.claude/settings.json` exists but is not valid JSON -> report `hook: settings.json invalid JSON` rather than `missing`, for the same reason. Otherwise (no `.claude/settings.json`, or one with no `hooks.Stop`) -> `hook: missing`.
- Whether the agent-context snippet is wired per target agent (see Step 2.5 for how the target agents are decided): run `artgraph doctor` via the PM runner from the Step 3 table (e.g. `pnpm exec artgraph doctor`) and read its findings instead of inspecting markers by hand. `agents-md-*` findings cover the shared `AGENTS.md` marker block (applies to every agent); `wrapper-*` findings cover the per-agent wrapper file, emitted only for agents whose descriptor carries one (`claude` -> `CLAUDE.md`, `copilot` -> `.github/copilot-instructions.md`). An agent is `agent-context: wired` when its applicable findings are all `pass` severity, `agent-context: missing` otherwise. On a mixed-agent project this can differ per agent (e.g. `claude` reports missing because `CLAUDE.md`'s marker is broken while `kiro`, which has no wrapper file, still reports wired) — report per agent, not as one overall verdict.

Report which `artgraph-*` Skills are present. The canonical set is: `artgraph-bootstrap`, `artgraph-impact`, `artgraph-plan-coverage`, `artgraph-rename`, `artgraph-setup`, `artgraph-verify`. Missing entries suggest the user ran `init --minimal` or `--no-skills`, or deleted Skills manually. To reinstall only the Skills without touching hooks / integration, run the **init** command from the Step 3 table with `--force --agents=<list> --no-scan --no-integrate --no-hooks --no-agent-context` appended (`--force` is required because `.artgraph.json` already exists). Check the exit code afterward: non-zero means a conflict at the Skills stage (e.g. a pre-existing non-artgraph file at a Skill's destination path) — surface the stderr to the user rather than assuming success.

If the Stop hook or the agent-context snippet is missing, run the **init** command from the Step 3 table with `--force --agents=<list> --no-scan --no-skills --no-integrate` appended instead (`<list>` is the agents decided per Step 2.5). `--force` merges the user's existing `.artgraph.json` customizations rather than overwriting them, with one exception: `packageManager` is always re-detected from the lockfile/Corepack signals and updated regardless of the previously recorded value (intended behavior) — tell the user if this changes their recorded PM. The hooks stage itself never overwrites an already-populated `hooks.Stop`, with or without `--force` (settings-merge contract Case D always refuses to touch a pre-existing Stop hook not written by artgraph). The command can still exit non-zero — Case D conflict or invalid JSON in `.claude/settings.json` both fail the run — so check the exit code and stderr afterward and do not assume success just because the command completed; when it fails, only the hook stage is affected, the agent-context stage still applies. After running, re-run the state-report checks above (or the Step 6 `check`) to confirm the completion actually took effect. If Skills, the Stop hook, and the agent-context snippet are **all** missing, skip the two commands above and run just one: the **init** command from the Step 3 table with `--force --agents=<list> --no-scan --no-integrate` appended runs the Skills, hooks, and agent-context stages together.

If the state report shows `config: missing`, this is not a dead end: rejoin the numbered flow at Step 2.5 (determine agents, get consent, then run init) instead of stopping.

## SDD tool installed after artgraph

`init` auto-integrates every SDD tool detected at init time, so the only manual case is a Spec Kit / Kiro marker (`.specify/` / `.kiro/`) that appeared **after** artgraph was set up — i.e. the state report above says "detected" but "not integrated". Confirm with `integrate list` (run via the PM runner from the Step 3 table), then run `integrate speckit` or `integrate kiro` the same way. Spec Kit accepts `--gate` / `--no-gate` to add / remove the `before_implement` gate hook, and `--uninstall` removes an integration.
