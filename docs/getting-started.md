# Getting started — platform and setup notes

The top-level [README](../README.md) covers install and the agent-native
Quickstart. This page captures the platform / setup edge cases that would
otherwise clutter it.

## Windows: CRLF and `.gitattributes` <a id="windows"></a>

Native Windows (PowerShell / cmd) is **not** a supported platform for the
`artgraph` CLI itself — run it inside WSL2. See
[architecture.md §8 Support Scope](./architecture.md#8-support-scope) for the
policy and [#137](https://github.com/mori-shin-x/artgraph/issues/137) for
the deliberate v0.x scope decision.

Even when artgraph itself runs inside WSL2, teammates checking the repo out on
native Windows still interact with the distributed files. artgraph distributes
a `.gitattributes` file into each `<agent-skills-path>/` that forces LF for
the tracked files. **Do NOT set `core.autocrlf=true` globally** — if
`.gitattributes` is not committed, `artgraph doctor` may report drift after
checkout. Alternatively add `.claude/skills/** text eol=lf` (and equivalents
for other agents) to your repo's root `.gitattributes`.

Since [#141](https://github.com/mori-shin-x/artgraph/issues/141), the
distributed Skill instructions themselves are shell-agnostic prose — each
host agent composes the actual commands for its own shell — but the
`artgraph` CLI commands those Skills invoke still require POSIX, so the
overall platform posture is unchanged.

## `--agents=copilot` and CODEOWNERS

Selecting `--agents=copilot` creates `.github/skills/` in your repo. If your
project uses CODEOWNERS / branch protection for `.github/`, coordinate with
your team before running `artgraph init --agents=copilot`.

## Committing distributed Skills

Distributed Skills under `.claude/skills/`, `.agents/skills/`,
`.cursor/skills/`, `.github/skills/`, and `.kiro/skills/` are safe to commit
— they're deterministic byte-identical outputs of
`artgraph init --agents=<list>`. Team members without artgraph installed
still get the Skills via `git pull`. If you prefer to keep them out of git
(e.g. to avoid bumping the diff on every artgraph upgrade), add the paths to
`.gitignore`; teammates then need to run `artgraph init --agents=<list>`
locally.

Trace shards under `.artgraph/trace/` (produced by the `artgraph/vitest`
runner, spec 020) are the opposite: they're per-run execution artifacts, so
add `.artgraph/trace/` to `.gitignore` and regenerate them locally or in CI
by running the test suite. See
[Configuration](./configuration.md) for the `trace.*` options.

## Disabling the Stop hook (troubleshooting)

If `artgraph check` blocks Claude Code unexpectedly (e.g. after an artgraph
upgrade regression), you can temporarily disable the Stop hook by editing
`.claude/settings.json` and removing the `Stop` entry from `hooks`. Re-run
`artgraph init --force` (once the issue is resolved) to reinstall it.
