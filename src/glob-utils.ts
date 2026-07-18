// issue #335 (Step 0-pre HIGH-1) — a single fast-glob-based file-enumeration
// wrapper shared by the markdown spec-file loop (`graph/builder.ts`) and the
// TypeScript code-file loop (`globCodeFiles` in `parsers/typescript.ts`).
//
// Before this module existed, the two loops used TWO DIFFERENT glob
// libraries with OPPOSITE failure semantics: the markdown loop used the
// `glob` package (via `path-scurry`), whose internal `#readdirFail` handler
// maps an UNKNOWN errno (which includes EMFILE/ENFILE — file-descriptor
// exhaustion) to `children().provisional = 0` and returns silently — i.e. a
// readdir failure during spec-file enumeration made `globSync` return an
// EMPTY match list with NO error and NO warning, so an entire specDir (every
// REQ/task/doc it defines) could vanish from the graph without a trace. The
// TS side's `globCodeFiles` already used `fast-glob`, which THROWS on the
// same failure — already guarded at its one call site in `graph/builder.ts`.
//
// This wrapper does not change that asymmetry in throw/return contract
// (`listFilesOrThrow` still throws on EMFILE/ENFILE, matching
// `globCodeFiles`'s pre-existing external behavior byte-for-byte — see its
// own doc comment) — it exists to give both call sites ONE shared,
// explicitly-pinned option set and ONE shared sort step, plus a ready-made
// fail-safe variant (`listFilesGuarded`) for callers that want the markdown
// loop's NEW behavior: catch EMFILE/ENFILE, warn, and continue with an empty
// list instead of losing the whole scan.
import { resolve } from "node:path";
import fastGlob from "fast-glob";

export interface ListFilesOptions {
  /** Defaults to `resolve()` (process.cwd()), matching every existing
   * fast-glob call site in this codebase. */
  cwd?: string;
  ignore?: string[];
}

// Options are fast-glob's OWN defaults, pinned explicitly here rather than
// left implicit so a future fast-glob upgrade changing its defaults can
// never silently change this tool's enumeration semantics out from under it:
//
//   - onlyFiles: true            — directories never appear in the match set
//   - followSymbolicLinks: true  — a symlinked spec/code file (or a symlinked
//     DIRECTORY containing spec/code files) IS followed and ingested. This is
//     a deliberate, documented behavior change for the markdown side (the
//     `glob` package it used to call defaults to `follow: false`, so a
//     symlinked spec subdirectory was previously invisible to a scan) — see
//     docs/commands.md / docs/configuration.md for the CHANGELOG-relevant
//     note. The TS side already had this exact default via fast-glob, so
//     this is a no-op for `globCodeFiles`.
//   - dot: false                 — dotfiles excluded (both `glob` and
//     fast-glob already agreed on this default; unchanged for both sides).
//   - absolute: true             — every call site already resolves back to
//     a root-relative path itself; matches the pre-existing `globCodeFiles`
//     behavior.
//
// Results are explicitly `.sort()`ed before returning: fast-glob (like the
// `glob` package) does not sort its own output — match order otherwise
// depends on OS `readdir` order, which is not guaranteed stable across
// platforms or even across two runs on the same machine. Sorting here is a
// structural fix, not a cosmetic one: every downstream consumer of file
// enumeration order (spec-node id-collision "last write wins",
// `inferConventionEdges`'s stem-collision "first write wins", …) becomes
// deterministic by construction instead of by accident of directory-listing
// order.
function fastGlobOptions(options: ListFilesOptions) {
  return {
    cwd: options.cwd ?? resolve(),
    absolute: true,
    onlyFiles: true,
    followSymbolicLinks: true,
    dot: false,
    ignore: options.ignore,
  };
}

/**
 * Throws on ANY fast-glob failure, including EMFILE/ENFILE — matches
 * `globCodeFiles`'s pre-existing external contract exactly (its callers,
 * `graph/builder.ts` chief among them, already guard EMFILE/ENFILE
 * themselves and need every other error to keep propagating uncaught).
 */
export function listFilesOrThrow(
  pattern: string | string[],
  options: ListFilesOptions = {},
): string[] {
  const matches = fastGlob.sync(pattern, fastGlobOptions(options));
  return matches.sort();
}

export interface ListFilesResult {
  files: string[];
  /** Set (and `files` is `[]`) when the underlying `fastGlob.sync` call
   * threw EMFILE/ENFILE. Any OTHER error still propagates uncaught — a
   * malformed pattern is a real bug, not something to paper over. */
  resourceExhaustedCode?: "EMFILE" | "ENFILE";
}

/**
 * Fail-safe variant: EMFILE/ENFILE is caught internally and reported back via
 * `resourceExhaustedCode` (with `files: []`) instead of throwing, so a
 * scan-wide file-descriptor-exhaustion condition degrades to "this directory
 * enumerated no files" (with `resourceExhaustedCode` set) rather than
 * crashing (or, pre-#335 on the markdown side, silently doing the same thing
 * with no way for the caller to even know it happened). Every OTHER glob
 * failure still throws — callers must not swallow a genuine bug (e.g. a
 * malformed pattern) as if it were resource exhaustion.
 */
export function listFilesGuarded(
  pattern: string | string[],
  options: ListFilesOptions = {},
): ListFilesResult {
  try {
    return { files: listFilesOrThrow(pattern, options) };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "EMFILE" || code === "ENFILE") {
      return { files: [], resourceExhaustedCode: code };
    }
    throw e;
  }
}
