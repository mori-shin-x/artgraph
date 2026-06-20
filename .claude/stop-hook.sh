#!/bin/bash
INPUT=$(cat)

if [ "$(echo "$INPUT" | jq -r '.stop_hook_active')" = "true" ]; then
  exit 0
fi

if git diff --quiet HEAD -- src/ tests/ 2>/dev/null && git diff --quiet --cached -- src/ tests/ 2>/dev/null; then
  exit 0
fi

pnpm run build 2>&1 && pnpm run test 2>&1 && pnpm knip 2>&1 || exit 2
