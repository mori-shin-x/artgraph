// Single source of truth for the requirement-ID grammar. Every module that
// *recognizes* requirement IDs (src/parsers/markdown.ts,
// src/parsers/typescript.ts, src/test-results.ts) and every module that
// *rewrites* or *validates* them (src/rename.ts, src/rename-validate-id.ts)
// must import these constants from here, so discovery and rewriting can never
// drift apart. Before this module existed that parity was comment-based
// ("mirror the parser defaults") — a change on one side could silently strand
// the other.

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
// whole match is the ID (namespace included), e.g. `FR-001`, `auth/AUTH-2`,
// `Requirement-3`. This is also the default requirement-ID token when no
// custom `reqPatterns.codeId` is set: the code/test parser and the
// rename-target-ID validator both resolve their default from this constant so
// they track the exact same grammar the parser emits (avoids regex drift
// between discovery and rewriting).
export const NAMESPACED_ID_TOKEN = `(?:[\\w-]+/)?(?:${REQ_ID_TOKEN})`;

// Default markdown grammar used when no custom `reqPatterns` are set.
//
// Callers detect "is the default grammar active?" by comparing against these
// exact objects — src/parsers/markdown.ts by object identity
// (`headingRE === KIRO_HEADING_RE`) and src/rename.ts by `.source` equality —
// so both sides must import these constants rather than re-declaring
// equivalent literals.

// A requirement defined as a markdown list item, e.g. `- REQ-001: ...` or
// `- **FR-2**: ...`. Group 1 is the bare ID.
export const LIST_ITEM_RE = /^(?:\*\*)?([A-Z][A-Za-z]*-\d+)(?:\*\*)?[:\s]/;

// A Kiro-style requirement heading, e.g. `### Requirement 1: ...`. Group 1 is
// the number; consumers canonicalize it to `Requirement-<n>`.
export const KIRO_HEADING_RE = /^Requirement\s+(\d+)\s*:/;

// Bare code-side ID shape (no namespace, whole-string match) used to validate
// annotation targets when no custom `reqPatterns.codeId` is set.
export const DEFAULT_CODE_ID_RE = /^[A-Z][A-Za-z]*-\d+$/;
