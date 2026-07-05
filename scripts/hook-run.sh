#!/usr/bin/env bash
# Sanitize the git-related environment variables that git injects into
# hook processes (pre-commit, pre-push, ...) before exec'ing the given
# command.
#
# Why: when git invokes a hook it sets GIT_DIR (and friends) so that any
# child process's git operations transparently target the invoking repo.
# Test suites that spawn `git commit` inside a temp directory expect git
# to auto-discover `.git` from `cwd` — but with GIT_DIR inherited from
# the hook, those `git commit` calls silently retarget the hook's own
# HEAD instead of the temp dir. Result: pre-push runs the test suite,
# which then commits dozens of test-fixture commits onto the pushing
# branch.
#
# Stripping these vars before pnpm typecheck / knip / test:* lets tests
# use plain cwd-based git discovery.
unset \
  GIT_DIR \
  GIT_WORK_TREE \
  GIT_INDEX_FILE \
  GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES \
  GIT_COMMON_DIR \
  GIT_NAMESPACE \
  GIT_PREFIX \
  GIT_INTERNAL_GETTEXT_SH_SCHEME \
  ANTHROPIC_API_KEY
exec "$@"
