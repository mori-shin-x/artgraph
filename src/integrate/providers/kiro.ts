/**
 * KiroProvider — distributes the artgraph steering file
 * `.kiro/steering/artgraph.md` so that the Kiro agent learns when to call
 * `artgraph impact / check --diff / reconcile`.
 *
 * Kiro currently has no public Hook API, so this provider only writes a
 * Markdown steering file (FR-008 / FR-011, Clarifications Q2). Should Kiro
 * expose a hook trigger system in the future, `install()` accepts forward-
 * compat opts (unknown keys are ignored) so callers can opt-in via
 * `runIntegrate` without breaking existing repos.
 *
 * Contract:
 *  - specs/009-sdd-integration/contracts/integration-provider.md (lifecycle)
 *  - specs/009-sdd-integration/contracts/agent-guidance.md (write semantics)
 *  - specs/009-sdd-integration/research.md §R4 (steering file content)
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeGuidanceFile } from "../guidance.js";
import { loadTemplate } from "../templates.js";
import type { InstallOptions, IntegrateResult, IntegrationProvider } from "../../types.js";

/** Steering file path relative to the repo root. */
const STEERING_REL = ".kiro/steering/artgraph.md";
/** Bundled template under templates/integrate/kiro/. */
const TEMPLATE_REL = "kiro/artgraph.md";

export class KiroProvider implements IntegrationProvider {
  readonly id = "kiro" as const;
  readonly displayName = "Kiro";
  readonly marker = ".kiro";

  detect(rootDir: string): boolean {
    return existsSync(join(rootDir, ".kiro"));
  }

  isInstalled(rootDir: string): boolean {
    return existsSync(join(rootDir, STEERING_REL));
  }

  install(rootDir: string, opts: InstallOptions): IntegrateResult {
    if (!this.detect(rootDir)) {
      throw new Error(`Kiro not detected at ${rootDir} (missing .kiro/)`);
    }

    // FR-011 / T066 — forward-compat: we read only the fields we currently
    // need (`force`). Any other key on `opts` (e.g. a future `mode?:
    // "steering" | "hook"`) is silently ignored, which keeps existing
    // Steering-only callers working when a future PR widens InstallOptions.
    // A future "hook mode" implementation MUST add an explicit branch here
    // *and* a migration step that preserves any existing steering file (see
    // tests/integrate/providers/kiro.test.ts → "FR-011 forward-compat design").
    const force = opts.force === true;

    const created: string[] = [];
    const modified: string[] = [];
    const warnings: string[] = [];

    const destAbs = join(rootDir, STEERING_REL);
    const content = loadTemplate(TEMPLATE_REL);

    // writeGuidanceFile handles: new → write; equal → noop; differs+!force →
    // noop (we warn); differs+force → overwrite. createParentDirs defaults
    // true, which auto-creates `.kiro/steering/` if only `.kiro/` exists.
    const result = writeGuidanceFile({
      destPath: destAbs,
      content,
      force,
    });

    if (result.written) {
      if (result.hadExisting) {
        modified.push(STEERING_REL);
      } else {
        created.push(STEERING_REL);
      }
    } else if (result.hadExisting) {
      // Either byte-for-byte match (silent no-op) or differs without --force
      // (visible warning so the user knows why nothing changed). We can't
      // tell the two apart from GuidanceWriteResult alone, so re-check by
      // reading the file once more would be wasteful — instead, emit the
      // warning only when we know force was not set AND the on-disk content
      // would have changed. Simpler: only warn when !opts.force AND the
      // result is "had existing but didn't write". On a byte-for-byte match
      // even without --force, this still suppresses a confusing warning
      // because the next install would also be a noop — so we re-read to
      // decide.
      if (!force) {
        // Re-read once to distinguish "matches template" from "user edited".
        // This is cheap (small file) and keeps the warning honest.
        const onDisk = readFileSync(destAbs, "utf-8");
        const normalisedTemplate = content.replace(/\n+$/, "") + "\n";
        if (onDisk !== normalisedTemplate) {
          warnings.push(
            `Existing ${STEERING_REL} differs from template (use --force to overwrite)`,
          );
        }
      }
    }

    const noop = created.length === 0 && modified.length === 0;

    return {
      providerId: this.id,
      created,
      modified,
      removed: [],
      noop,
      nextSteps: noop
        ? []
        : [
            "Restart Kiro so the new steering file is picked up.",
            "Run `artgraph scan && artgraph reconcile` to establish a fresh baseline.",
          ],
      warnings,
    };
  }

  uninstall(rootDir: string): IntegrateResult {
    if (!this.isInstalled(rootDir)) {
      return {
        providerId: this.id,
        created: [],
        modified: [],
        removed: [],
        noop: true,
        nextSteps: [],
        warnings: [],
      };
    }

    const destAbs = join(rootDir, STEERING_REL);
    rmSync(destAbs, { force: true });

    return {
      providerId: this.id,
      created: [],
      modified: [],
      removed: [STEERING_REL],
      noop: false,
      nextSteps: [],
      warnings: [],
    };
  }
}
