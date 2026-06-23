/**
 * SpecKitProvider — generates and maintains the
 * `.specify/extensions/spectrace/` Extension and corresponding entries in
 * `.specify/extensions.yml`.
 *
 * Contract: specs/009-sdd-integration/contracts/integration-provider.md
 * (lifecycle), specs/009-sdd-integration/contracts/speckit-extension-schema.md
 * (frozen schema v1.0).
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import * as atomicWrite from "../atomic-write.js";
import { loadTemplate } from "../templates.js";
import {
  addHookEntry,
  addInstalled,
  parseExtensionsYaml,
  removeAllSpectraceHooks,
  removeHookEntry,
  removeInstalled,
  serializeExtensionsYaml,
} from "../speckit-yaml.js";
import { validateExtensionYaml, type SpecKitExtensionManifest } from "../schemas/speckit-1.0.js";
import type {
  HookEntry,
  InstallOptions,
  IntegrateResult,
  IntegrationProvider,
} from "../../types.js";

const EXT_DIR_REL = ".specify/extensions/spectrace";
const EXT_YML_REL = ".specify/extensions.yml";

const EXT_FILES = [
  { rel: "extension.yml", template: "speckit/extension.yml" },
  { rel: "README.md", template: "speckit/README.md" },
  {
    rel: "commands/artgraph.scan-reconcile.md",
    template: "speckit/commands/artgraph.scan-reconcile.md",
  },
  {
    rel: "commands/artgraph.check-diff.md",
    template: "speckit/commands/artgraph.check-diff.md",
  },
  {
    rel: "commands/artgraph.check-gate.md",
    template: "speckit/commands/artgraph.check-gate.md",
  },
] as const;

const HOOK_ENTRIES = {
  after_tasks: {
    extension: "spectrace",
    command: "artgraph.scan-reconcile",
    enabled: true,
    optional: false,
    priority: 50,
    prompt: "Run artgraph scan && reconcile to refresh trace baseline?",
    description: "Refresh artgraph baseline after tasks",
    condition: null,
  } satisfies HookEntry,
  after_implement: {
    extension: "spectrace",
    command: "artgraph.check-diff",
    enabled: true,
    optional: false,
    priority: 50,
    prompt: "Run artgraph check --diff to verify coverage/orphan/drift?",
    description: "Verify artgraph traceability after implementation",
    condition: null,
  } satisfies HookEntry,
  before_implement: {
    extension: "spectrace",
    command: "artgraph.check-gate",
    enabled: true,
    optional: false,
    priority: 50,
    prompt: "Gate: run artgraph check --gate before implementing?",
    description: "Gate implementation on artgraph traceability",
    condition: null,
  } satisfies HookEntry,
} as const;

/**
 * Rollback log used by install() to undo partial work when a mid-install
 * disk error happens. Each entry knows how to revert one filesystem
 * mutation (file create or overwrite).
 */
interface RollbackOp {
  apply(): void;
}

export class SpecKitProvider implements IntegrationProvider {
  readonly id = "speckit" as const;
  readonly displayName = "Spec Kit";
  readonly marker = ".specify";

  detect(rootDir: string): boolean {
    return existsSync(join(rootDir, ".specify"));
  }

  isInstalled(rootDir: string): boolean {
    const ymlPath = join(rootDir, EXT_YML_REL);
    const extYmlPath = join(rootDir, EXT_DIR_REL, "extension.yml");
    if (!existsSync(ymlPath) || !existsSync(extYmlPath)) return false;
    try {
      const doc = parseExtensionsYaml(readFileSync(ymlPath, "utf-8"));
      const installed = doc.get("installed") as unknown;
      // Use toJSON to coerce YAMLSeq → plain array
      const plain = Array.isArray(installed)
        ? installed
        : ((doc.toJSON() as { installed?: string[] }).installed ?? []);
      if (!plain.includes("spectrace")) return false;
      // M-M5 / FR-013: a half-broken `extension.yml` (truncated, malformed,
      // wrong schema_version) must not count as "installed" — otherwise the
      // init Tip would be wrongly suppressed and the user would never see the
      // recovery hint. Validate against the frozen v1.0 schema.
      const extManifest = parseYaml(readFileSync(extYmlPath, "utf-8")) as SpecKitExtensionManifest;
      validateExtensionYaml(extManifest);
      return true;
    } catch {
      // YAML parse error or schema violation → treat as not installed so the
      // user sees the integrate Tip again and can re-install / --force.
      return false;
    }
  }

  install(rootDir: string, opts: InstallOptions): IntegrateResult {
    if (!this.detect(rootDir)) {
      throw new Error(`Spec Kit not detected at ${rootDir} (missing .specify/)`);
    }

    const created: string[] = [];
    const modified: string[] = [];
    const removed: string[] = [];
    const warnings: string[] = [];
    const rollback: RollbackOp[] = [];

    try {
      // 1) Extension files under .specify/extensions/spectrace/
      const extDirAbs = join(rootDir, EXT_DIR_REL);
      const extDirCreated = !existsSync(extDirAbs);
      if (extDirCreated) {
        mkdirSync(extDirAbs, { recursive: true });
        rollback.push({
          apply: () => {
            try {
              rmSync(extDirAbs, { recursive: true, force: true });
            } catch {
              /* ignore */
            }
          },
        });
      }

      for (const f of EXT_FILES) {
        const absPath = join(extDirAbs, f.rel);
        const parent = dirname(absPath);
        if (!existsSync(parent)) {
          mkdirSync(parent, { recursive: true });
        }
        const content = loadTemplate(f.template);
        const exists = existsSync(absPath);
        if (exists) {
          const current = readFileSync(absPath, "utf-8");
          if (current === content) {
            // identical → no-op for this file
            continue;
          }
          if (!opts.force) {
            // Don't overwrite user edits unless --force was given.
            warnings.push(
              `Existing ${relPath(rootDir, absPath)} differs from template (use --force to overwrite)`,
            );
            continue;
          }
          // overwrite: stash original so we can restore on rollback
          const prev = current;
          atomicWrite.atomicWriteFile(absPath, content);
          modified.push(relPath(rootDir, absPath));
          rollback.push({
            apply: () => {
              try {
                atomicWrite.atomicWriteFile(absPath, prev);
              } catch {
                /* ignore */
              }
            },
          });
        } else {
          atomicWrite.atomicWriteFile(absPath, content);
          created.push(relPath(rootDir, absPath));
          rollback.push({
            apply: () => {
              try {
                rmSync(absPath, { force: true });
              } catch {
                /* ignore */
              }
            },
          });
        }
      }

      // 2) .specify/extensions.yml — installed + hooks
      const ymlAbs = join(rootDir, EXT_YML_REL);
      const ymlExisted = existsSync(ymlAbs);
      const ymlBefore = ymlExisted ? readFileSync(ymlAbs, "utf-8") : "";
      const doc = ymlExisted
        ? parseExtensionsYaml(ymlBefore)
        : parseExtensionsYaml("installed: []\nsettings:\n  auto_execute_hooks: true\nhooks: {}\n");

      let ymlChanged = false;
      if (addInstalled(doc, "spectrace")) ymlChanged = true;
      if (addHookEntry(doc, "after_tasks", HOOK_ENTRIES.after_tasks)) ymlChanged = true;
      if (addHookEntry(doc, "after_implement", HOOK_ENTRIES.after_implement)) ymlChanged = true;

      if (opts.gate === true) {
        if (addHookEntry(doc, "before_implement", HOOK_ENTRIES.before_implement)) {
          ymlChanged = true;
        }
      } else if (opts.gate === false) {
        if (removeHookEntry(doc, "before_implement", "spectrace")) {
          ymlChanged = true;
        }
      }
      // gate === undefined: leave before_implement alone.

      if (ymlChanged) {
        const serialized = serializeExtensionsYaml(doc);
        atomicWrite.atomicWriteFile(ymlAbs, serialized);
        if (ymlExisted) {
          modified.push(EXT_YML_REL);
          rollback.push({
            apply: () => {
              try {
                atomicWrite.atomicWriteFile(ymlAbs, ymlBefore);
              } catch {
                /* ignore */
              }
            },
          });
        } else {
          created.push(EXT_YML_REL);
          rollback.push({
            apply: () => {
              try {
                rmSync(ymlAbs, { force: true });
              } catch {
                /* ignore */
              }
            },
          });
        }
      }

      const noop = created.length === 0 && modified.length === 0 && removed.length === 0;

      return {
        providerId: this.id,
        created,
        modified,
        removed,
        noop,
        nextSteps: noop
          ? []
          : [
              "Run /speckit-tasks to verify the after_tasks hook fires",
              "Run /speckit-implement to verify the after_implement hook fires",
            ],
        warnings,
      };
    } catch (err) {
      // Rollback in reverse order.
      for (let i = rollback.length - 1; i >= 0; i--) {
        rollback[i]!.apply();
      }
      throw err;
    }
  }

  uninstall(rootDir: string): IntegrateResult {
    const removed: string[] = [];
    const modified: string[] = [];
    const warnings: string[] = [];

    if (!this.isInstalled(rootDir)) {
      return {
        providerId: this.id,
        created: [],
        modified: [],
        removed: [],
        noop: true,
        nextSteps: [],
        warnings,
      };
    }

    // 1) Extension dir
    const extDirAbs = join(rootDir, EXT_DIR_REL);
    if (existsSync(extDirAbs)) {
      rmSync(extDirAbs, { recursive: true, force: true });
      removed.push(EXT_DIR_REL);
    }

    // 2) extensions.yml: drop installed entry + every spectrace hook entry
    const ymlAbs = join(rootDir, EXT_YML_REL);
    if (existsSync(ymlAbs)) {
      const doc = parseExtensionsYaml(readFileSync(ymlAbs, "utf-8"));
      const a = removeInstalled(doc, "spectrace");
      const trigs = removeAllSpectraceHooks(doc);
      if (a || trigs.length > 0) {
        atomicWrite.atomicWriteFile(ymlAbs, serializeExtensionsYaml(doc));
        modified.push(EXT_YML_REL);
      }
    }

    return {
      providerId: this.id,
      created: [],
      modified,
      removed,
      noop: false,
      nextSteps: [],
      warnings,
    };
  }
}

function relPath(rootDir: string, abs: string): string {
  return relative(rootDir, abs).split(/[\\/]/).join("/");
}
