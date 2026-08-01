// Single source of truth for the requirement-ID grammar. Every module that
// *recognizes* requirement IDs (src/parsers/markdown.ts,
// src/parsers/typescript.ts, src/test-results.ts) and every module that
// *rewrites* or *validates* them (src/rename.ts, src/rename-validate-id.ts)
// must import these constants from here, so discovery and rewriting can never
// drift apart. Before this module existed that parity was comment-based
// ("mirror the parser defaults") — a change on one side could silently strand
// the other.
//
// The same rule covers `splitAtxHeading` at the bottom of this file: the
// recognition side reads mdast heading *text*, every rewriting side reads the
// *raw line*, and the only way those two agree is for every raw-line reader to
// derive its heading text from one shared normalization rather than re-spelling
// an ATX pattern of its own.

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

// A Kiro-style requirement heading. Both spellings occur in real Kiro output
// and neither is rare — measured over 549 requirement headings in 62 files
// across 26 repositories with `.kiro/specs/` committed: 41.5% bare
// (`### Requirement 1`), 58.5% titled (`### Requirement 1: Some Title`).
// Four repositories use both, and one file uses both. Kiro's own spec-agent
// prompt templates the bare form; the model adds titles anyway.
//
// The alternative is `$`, NOT `:?` — `:?` would also accept prose headings
// like `### Requirement 1 is important`, which are not requirement
// definitions. Group 1 is the number; consumers canonicalize it to
// `Requirement-<n>`.
export const KIRO_HEADING_RE = /^Requirement\s+(\d+)\s*(?::|$)/;

// Bare code-side ID shape (no namespace, whole-string match) used to validate
// annotation targets when no custom `reqPatterns.codeId` is set.
export const DEFAULT_CODE_ID_RE = /^[A-Z][A-Za-z]*-\d+$/;

/** The pieces a raw ATX heading line splits into (see splitAtxHeading). */
export interface AtxHeadingParts {
  /** Opening `#`s plus the whitespace run after them. */
  prefix: string;
  /** Heading text as the recognition side sees it — closing sequence removed. */
  text: string;
  /** The stripped closing sequence with its surrounding spaces ("" when absent). */
  suffix: string;
}

// Everything before the heading text: the opening `#` run and the whitespace
// that separates it from the text. Capped at 6 `#`s because that is where
// CommonMark stops calling it a heading — `####### Requirement 1` is a
// paragraph, so the recognition side never produces a requirement from it and
// neither may any rewriter.
const ATX_OPENING_RE = /^(#{1,6}\s+)(.*)$/;

// An ATX *closing* sequence: a run of `#`s that ends the line, preceded by at
// least one space/tab (or sitting at the very start of the text, which is the
// empty-heading spelling `### ###`) and followed by nothing but spaces/tabs.
// The "preceded by a space" half is load-bearing in both directions — without
// it `### Requirement 1#` would look like a heading whose text is
// `Requirement 1`, which is the opposite of what mdast reports.
const ATX_CLOSING_RE = /(?:^|[ \t])[ \t]*#+[ \t]*$/;

/**
 * Split a raw markdown line into its ATX heading parts, or null when the line
 * is not an ATX heading.
 *
 * This is the ONE place a raw-line consumer is allowed to turn a line into
 * heading text. The recognition side (src/parsers/markdown.ts) reads mdast,
 * which has already dropped the opening `#`s and any closing sequence; every
 * rewriting side (src/rename.ts's `specDefinitionId` and `rewriteSpecHeading`,
 * and through the former, split/merge in src/rename-executor.ts) reads the raw
 * line instead. When those spell their own ATX pattern they drift: shipping
 * closing-sequence support in one rewriter but not its sibling left
 * `rename --merge` deleting one definition of a pair, rewriting both `@impl`
 * tags and reporting success while the surviving heading turned into an orphan.
 *
 * `prefix + text + suffix === line`, so a caller rewrites `text` and
 * reassembles without having to know what it was handed.
 */
export function splitAtxHeading(line: string): AtxHeadingParts | null {
  const opening = line.match(ATX_OPENING_RE);
  if (!opening) return null;
  const body = opening[2];
  const closing = body.match(ATX_CLOSING_RE);
  const cut = closing ? (closing.index ?? body.length) : body.length;
  return { prefix: opening[1], text: body.slice(0, cut), suffix: body.slice(cut) };
}
