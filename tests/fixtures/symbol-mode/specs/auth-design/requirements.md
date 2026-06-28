# Auth Requirements (external definitions)

Lives outside the analysis target (`specs/001-symbol-demo/`) so the
plan-coverage mention detector does not see these literal IDs. The graph
scanner still picks the requirements up because `specDirs: ["specs"]` is
recursive.

## Requirements

- REQ-001: validateToken must reject empty bearer tokens.
- REQ-002: createSession must establish a fresh session for a user id.
- REQ-005: issueToken must mint a fresh bearer token tied to a user id.
- REQ-009: revokeToken must mark a token as revoked.
