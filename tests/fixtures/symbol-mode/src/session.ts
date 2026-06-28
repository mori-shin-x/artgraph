// spec 016 — companion fixture for cross-file symbol entries (US1 AS#3).
// Pairs with src/auth.ts so `Files: src/auth.ts:validateToken,
// src/session.ts:createSession` can produce two ImpactGroups in the same
// run (data-model.md §3.2 dedup rule).

export function createSession(userId: string): string {
  // @impl REQ-002
  return `session:${userId}`;
}
