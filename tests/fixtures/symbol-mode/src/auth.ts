// Fixture for spec 016 symbol-mode end-to-end tests. Three exports, each
// claiming a distinct REQ via `@impl` so the file-vs-symbol over-detection
// scenario (US1, SC-001) has 3 REQs to differentiate.
//
// `@impl` MUST be a `//` line comment (matched by `IMPL_RE = /\/\/.*@impl/`)
// AND must sit on a line that falls inside the function's source range so
// the symbol-mode parser attributes the edge to the symbol (not the file).
// Placing the tag inside the body, on its own line, satisfies both.

export function validateToken(token: string): boolean {
  // @impl REQ-001
  return token.length > 0;
}

export function issueToken(userId: string): string {
  // @impl REQ-005
  return `token:${userId}`;
}

export function revokeToken(token: string): void {
  // @impl REQ-009
  void token;
}
