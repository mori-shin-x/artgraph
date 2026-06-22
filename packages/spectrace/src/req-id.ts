// Canonical requirement-ID *token* shared across the code parser
// (`@impl` / `[tag]` / `req:` annotations in src/parsers/typescript.ts) and the
// test-result REQ tags (src/test-results.ts). Keeping a single source of truth
// ensures that an ID written as `[Requirement-3]` or `[Auth-1]` in a test name
// is recognized exactly the same way the parsers recognize it in code — without
// this, mixed-case prefixes (e.g. Kiro's `Requirement-N`) silently fail to match
// and the requirement is downgraded to `impl-only` even though its test passed.
//
// The token matches the bare ID only; namespace prefixes (`ns/ID`) and the
// surrounding brackets are added by each call site.
export const REQ_ID_TOKEN = "[A-Z][A-Za-z]*-\\d+|Requirement-\\d+";

// The token as it appears in code, optionally prefixed by a `namespace/`. The
// whole match is the ID (namespace included).
export const NAMESPACED_ID_TOKEN = `(?:[\\w-]+/)?(?:${REQ_ID_TOKEN})`;
