import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  DEFAULT_CONFIG,
  type ArtgraphConfig,
  type ArtifactGraph,
  type IntegrateResult,
  type IntegrationProviderId,
  type PackageManager,
  type ScanSummary,
  type SddToolInfo,
  type DetectionResult,
  type InitOptions,
} from "./types.js";
import { scan, reconcile } from "./scan.js";
import type { BuildWarning } from "./graph/builder.js";
import { getProviderStatuses, runIntegrate } from "./integrate/index.js";
import { detectPackageManager, execPrefix } from "./package-manager.js";
import { loadConfig } from "./config.js";
import { renderTemplate } from "./template.js";

const SKILLS_TEMPLATE_DIR = resolve(import.meta.dirname, "../templates/skills");
const SKILLS_DEST_SUBDIR = join(".claude", "skills");
const HOOKS_TEMPLATE_PATH = resolve(import.meta.dirname, "../templates/hooks/settings.json.template");

export class SkillsInstallError extends Error {
  readonly partiallyInstalled: string[];
  constructor(message: string, partiallyInstalled: string[] = []) {
    super(message);
    this.name = "SkillsInstallError";
    this.partiallyInstalled = partiallyInstalled;
  }
}

export interface InitResult {
  configPath: string;
  config: ArtgraphConfig;
  sddTools: SddToolInfo[];
  scanSummary?: ScanSummary;
  warnings: BuildWarning[];
  lockPath?: string;
  skillsInstalled?: string[];
  /**
   * Per-provider result for any one-shot integrations triggered by
   * `--integrate=<tools>` (FR-022/023/024). Empty / undefined when the
   * caller did not request any integration.
   *
   * `id` is included alongside the `IntegrateResult` so the formatter can
   * still report providers that were skipped (no IntegrateResult emitted)
   * via the `integrationWarnings` array.
   */
  integrationResults?: IntegrateResult[];
  /**
   * Human-readable warnings emitted while running `--integrate=<tools>`
   * (e.g. "kiro not detected, skipping integration"). These never fail the
   * init itself but are surfaced in the CLI output.
   */
  integrationWarnings?: string[];
  /**
   * Number of integration providers that threw an exception during
   * `runRequestedIntegrations`. This is distinct from `integrationWarnings`
   * (which also covers "not detected, skipping" no-ops); only hard provider
   * failures are counted here. The CLI uses this to translate provider
   * failures into a non-zero exit code, per
   * `specs/012-skills-expansion/contracts/cli-flags.md` ("statement step
   * failure" must exit 1).
   */
  integrationFailureCount?: number;
  /**
   * Structured outcome of the Stop-hook install stage (FR-012/013,
   * specs/012-skills-expansion/contracts/settings-merge.md). `installHooks`
   * only returns this data — it never writes to stdout/stderr. Formatting
   * the text/JSON output (success messages, the Case D warning block, exit
   * code translation) is the CLI layer's job so init.ts stays print-free.
   * Undefined when the hooks stage did not run (`--no-hooks` / `--minimal`
   * without `--with-hooks`).
   */
  hooksInstall?: {
    action:
      | "created"
      | "merged-b"
      | "merged-c"
      | "conflict"
      | "invalid-json"
      | "io-error"
      | "skipped-no-pm";
    /** Detail for conflict/error outcomes: rendered command or parse/IO error message. */
    reason?: string;
    /** true → CLI translates this into a non-zero exit code. */
    failure?: boolean;
  };
}

export function detectProject(rootDir: string): DetectionResult {
  const abs = resolve(rootDir);
  const sddTools: SddToolInfo[] = [];
  if (existsSync(resolve(abs, ".specify"))) {
    sddTools.push({ name: "Spec Kit", marker: ".specify" });
  }
  if (existsSync(resolve(abs, ".kiro"))) {
    sddTools.push({ name: "Kiro", marker: ".kiro" });
  }

  // FR-019: share the `detect` / `isInstalled` logic with `integrate` by
  // delegating to the registered providers. `getProviderStatuses` lazily
  // registers built-ins so this works even when the CLI was never imported.
  const integrations = getProviderStatuses(abs);

  return {
    hasSrc: existsSync(resolve(abs, "src")),
    hasSpecs: existsSync(resolve(abs, "specs")),
    hasDocs: existsSync(resolve(abs, "docs")),
    sddTools,
    integrations,
  };
}

export function generateConfig(detection: DetectionResult): ArtgraphConfig {
  const include = detection.hasSrc ? [...DEFAULT_CONFIG.include] : ["**/*.ts", "**/*.tsx"];

  const specDirs: string[] = [];
  if (detection.hasSpecs) specDirs.push("specs");
  if (detection.hasDocs) specDirs.push("docs");
  if (specDirs.length === 0) specDirs.push(...DEFAULT_CONFIG.specDirs);

  return {
    include,
    specDirs,
    testPatterns: [...DEFAULT_CONFIG.testPatterns],
    lockFile: DEFAULT_CONFIG.lockFile,
  };
}

interface SkillTemplate {
  /** Top-level entry name under templates/skills (e.g. "_shared" or "artgraph-impact"). */
  topLevel: string;
  /** All files belonging to this entry, as paths relative to templates/skills. */
  files: string[];
}

function walkDir(root: string, current: string, out: string[]): void {
  for (const entry of readdirSync(current)) {
    // Skip hidden entries (e.g. .DS_Store, .git) so junk files dropped into
    // templates/skills/ never end up copied into the user's repo.
    if (entry.startsWith(".")) continue;
    const full = join(current, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkDir(root, full, out);
    } else if (stat.isFile()) {
      out.push(relative(root, full));
    }
  }
}

function readSkillTemplates(templateDir: string): SkillTemplate[] {
  if (!existsSync(templateDir)) {
    throw new SkillsInstallError(
      `Skills template directory not found at ${templateDir}. This is likely a packaging issue.`,
    );
  }
  const topEntries = readdirSync(templateDir).filter(
    (name) => !name.startsWith(".") && statSync(join(templateDir, name)).isDirectory(),
  );
  if (topEntries.length === 0) {
    throw new SkillsInstallError(
      `No skill template directories found in ${templateDir}. Expected templates/skills/<name>/SKILL.md or templates/skills/_shared/. This is likely a packaging issue.`,
    );
  }
  const templates: SkillTemplate[] = [];
  for (const topLevel of topEntries) {
    const files: string[] = [];
    walkDir(templateDir, join(templateDir, topLevel), files);
    if (topLevel !== "_shared") {
      // Every skill directory MUST contain SKILL.md (Claude Code Skills contract).
      const hasSkillMd = files.some((f) => f === join(topLevel, "SKILL.md"));
      if (!hasSkillMd) {
        throw new SkillsInstallError(
          `Skill directory ${topLevel}/ is missing SKILL.md. This is likely a packaging issue.`,
        );
      }
    }
    templates.push({ topLevel, files });
  }
  return templates;
}

// `templateDir` is for test injection only; production callers omit it and the
// constant `SKILLS_TEMPLATE_DIR` (resolved relative to dist/) is used.
export interface SkillsInstallOptions {
  force?: boolean;
  templateDir?: string;
}

function findConflicts(destDir: string, templates: SkillTemplate[]): string[] {
  const conflicts: string[] = [];
  for (const t of templates) {
    for (const rel of t.files) {
      const dst = join(destDir, rel);
      let s: ReturnType<typeof lstatSync> | undefined;
      try {
        s = lstatSync(dst);
      } catch {
        // ENOENT (or any stat failure): treat as no conflict and let the
        // copy step surface the real error if there is one.
        continue;
      }
      if (s.isSymbolicLink()) {
        // Refuse to follow symlinks even with --force: copyFileSync would
        // overwrite the symlink target (potentially a sensitive file
        // outside the skills tree). Always flag as a hard conflict.
        conflicts.push(`${rel} (symlink — refusing to overwrite)`);
      } else {
        conflicts.push(rel);
      }
    }
  }
  return conflicts;
}

/**
 * Returns true if any symlink-flagged conflict is present in the list
 * produced by `findConflicts`. Symlink conflicts are non-overridable: even
 * `--force` must refuse them to avoid clobbering files outside the skills
 * tree via a malicious or accidental symlink.
 */
function hasSymlinkConflict(conflicts: string[]): boolean {
  return conflicts.some((c) => c.includes("(symlink"));
}

// Throws if installation cannot proceed cleanly. Mirrors installSkills's
// validation (templates available, no conflicts unless --force) without writing.
// Use this as a pre-flight check before any other side effects.
export function validateSkillsInstall(rootDir: string, options: SkillsInstallOptions = {}): void {
  const abs = resolve(rootDir);
  const destDir = resolve(abs, SKILLS_DEST_SUBDIR);
  const templateDir = options.templateDir ?? SKILLS_TEMPLATE_DIR;
  const templates = readSkillTemplates(templateDir);

  const conflicts = findConflicts(destDir, templates);
  // Symlinks are NEVER overwritten, even with --force. copyFileSync would
  // follow them and clobber whatever they point at, which is a security
  // hazard outside the skills tree.
  if (hasSymlinkConflict(conflicts)) {
    const symlinks = conflicts.filter((c) => c.includes("(symlink"));
    throw new SkillsInstallError(
      `Refusing to overwrite symlink(s) in ${SKILLS_DEST_SUBDIR}: ${symlinks.join(", ")}. Remove the symlink(s) and rerun.`,
    );
  }
  if (!options.force && conflicts.length > 0) {
    throw new SkillsInstallError(
      `Skill file(s) already exist in ${SKILLS_DEST_SUBDIR}: ${conflicts.join(", ")}. Use --force to overwrite.`,
    );
  }
}

export function installSkills(rootDir: string, options: SkillsInstallOptions = {}): string[] {
  const abs = resolve(rootDir);
  const destDir = resolve(abs, SKILLS_DEST_SUBDIR);
  const templateDir = options.templateDir ?? SKILLS_TEMPLATE_DIR;
  const templates = readSkillTemplates(templateDir);

  const conflicts = findConflicts(destDir, templates);
  // Symlinks: refuse always (see validateSkillsInstall).
  if (hasSymlinkConflict(conflicts)) {
    const symlinks = conflicts.filter((c) => c.includes("(symlink"));
    throw new SkillsInstallError(
      `Refusing to overwrite symlink(s) in ${SKILLS_DEST_SUBDIR}: ${symlinks.join(", ")}. Remove the symlink(s) and rerun.`,
    );
  }
  if (!options.force && conflicts.length > 0) {
    throw new SkillsInstallError(
      `Skill file(s) already exist in ${SKILLS_DEST_SUBDIR}: ${conflicts.join(", ")}. Use --force to overwrite.`,
    );
  }

  // Track every absolute path we wrote and every directory we created so
  // that a mid-loop failure can roll back to the pre-install state. Without
  // this, a partial copy leaves orphan files in `.claude/skills/` that the
  // user then has to clean up by hand before retrying.
  const writtenAbs: string[] = [];
  const dirsCreated: string[] = [];

  const ensureDir = (path: string): void => {
    if (existsSync(path)) return;
    mkdirSync(path, { recursive: true });
    dirsCreated.push(path);
  };

  ensureDir(destDir);
  const installed: string[] = [];
  let currentRel = "";
  try {
    for (const t of templates) {
      for (const rel of t.files) {
        currentRel = rel;
        const src = join(templateDir, rel);
        const dst = join(destDir, rel);
        ensureDir(join(dst, ".."));
        copyFileSync(src, dst);
        writtenAbs.push(dst);
        installed.push(join(SKILLS_DEST_SUBDIR, rel));
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Roll back in reverse order: files first, then empty directories.
    for (const f of [...writtenAbs].reverse()) {
      try {
        unlinkSync(f);
      } catch {
        // best-effort cleanup
      }
    }
    for (const d of [...dirsCreated].reverse()) {
      try {
        rmdirSync(d);
      } catch {
        // best-effort: leave non-empty dirs (likely held user content)
      }
    }
    throw new SkillsInstallError(
      `Failed to copy ${currentRel} into ${SKILLS_DEST_SUBDIR}: ${msg}`,
      installed,
    );
  }
  return installed;
}

/**
 * Decide which stages of `init` to run based on the new flag matrix
 * (spec 012-skills-expansion, contracts/cli-flags.md).
 *
 * Default (no flags) → every stage on. `--minimal` flips every gateable stage
 * off; `--with-*` flags re-enable individual stages on top of `--minimal`.
 * `--no-*` flags opt out of individual stages in the default mode.
 * Explicit `integrations` (non-empty) also acts as an opt-in under `--minimal`.
 */
export function computeStageGates(opts: InitOptions): {
  scan: boolean;
  skills: boolean;
  integrate: boolean;
  hooks: boolean;
  agentContext: boolean;
} {
  const explicitIntegrations =
    opts.integrations !== undefined &&
    (Array.isArray(opts.integrations) ? opts.integrations.length > 0 : true);

  if (opts.minimal) {
    return {
      scan: false,
      skills: opts.withSkills === true,
      integrate: opts.withIntegrate === true || explicitIntegrations,
      hooks: opts.withHooks === true,
      agentContext: opts.withAgentContext === true,
    };
  }

  return {
    scan: !opts.noScan,
    // withSkills is a redundant opt-in under default mode but preserved so
    // callers passing it explicitly behave the same as before.
    skills: !opts.noSkills,
    integrate: !opts.noIntegrate,
    hooks: !opts.noHooks,
    agentContext: !opts.noAgentContext,
  };
}

/**
 * Merge the artgraph Stop hook into `<rootDir>/.claude/settings.json`
 * (Claude Code specific) following the 4-case strategy in
 * specs/012-skills-expansion/contracts/settings-merge.md.
 *
 * Support for other agent environments (Cursor / Windsurf / Kiro Custom
 * Agents) is out of scope for spec 012; when a cross-agent hook spec lands,
 * this function will be renamed to `installClaudeCodeHooks` and a per-agent
 * dispatch layer will be added on top.
 *
 * Never throws: every fs / JSON / template failure is caught and converted
 * into a structured `{ action, reason?, failure? }` result so a Stop-hook
 * install problem never aborts the rest of `init` (config + Skills already
 * landed by the time this runs).
 *
 * `options.force` is accepted for signature symmetry with the other stage
 * installers but is deliberately ignored on the Case D (conflict) branch —
 * see contract §--force フラグの扱い ("settings.json is the most sensitive
 * user config; artgraph never overwrites a pre-existing Stop hook, even with
 * --force").
 */
function installHooks(
  rootDir: string,
  detectedPm: PackageManager | null,
  options: { force?: boolean; explicitOptIn?: boolean } = {},
): NonNullable<InitResult["hooksInstall"]> {
  if (detectedPm === null) {
    return { action: "skipped-no-pm", failure: options.explicitOptIn === true };
  }

  // Narrow the parsed template shape so downstream lookups (Case D reason,
  // Case B/C merge) work off a single typed handle rather than repeated
  // `unknown` casts.
  type RenderedTemplate = {
    hooks: {
      Stop: Array<{ hooks: Array<{ type: string; command: string }> }>;
    };
  };
  let rendered: RenderedTemplate;
  try {
    const raw = readFileSync(HOOKS_TEMPLATE_PATH, "utf-8");
    const substituted = renderTemplate(raw, { ARTGRAPH_EXEC: execPrefix(detectedPm) });
    rendered = JSON.parse(substituted) as RenderedTemplate;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { action: "io-error", reason: msg, failure: true };
  }

  const settingsPath = resolve(rootDir, ".claude", "settings.json");

  // D1: `lstatSync({ throwIfNoEntry: false })` only suppresses ENOENT — EACCES
  // / EPERM / ELOOP still throw and would escape the JSDoc "never throws"
  // contract without this try/catch. Convert any lstat failure into an
  // `io-error` result so the caller sees the same structured outcome as
  // every other fs failure in this function.
  let existingStat: ReturnType<typeof lstatSync> | undefined;
  try {
    existingStat = lstatSync(settingsPath, { throwIfNoEntry: false });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { action: "io-error", reason: msg, failure: true };
  }
  // Refuse to follow/overwrite anything that isn't a regular file (symlink,
  // directory, socket, ...). Mirrors installSkills' symlink refusal — never
  // override even with --force, since that could clobber a file outside the
  // .claude/ tree via a malicious or accidental symlink.
  if (existingStat && !existingStat.isFile()) {
    return { action: "io-error", reason: "settings.json is not a regular file", failure: true };
  }

  // B1+B2: single atomic-write helper with symmetric cleanup on failure.
  // Pre-clears any stale `.tmp` (which may itself be a symlink planted by an
  // attacker) — `unlinkSync` removes the symlink itself, not the target, so
  // the subsequent `writeFileSync` lands on a fresh regular file.
  const writeAtomic = (data: unknown): void => {
    const tmpPath = `${settingsPath}.tmp`;
    try {
      unlinkSync(tmpPath);
    } catch {
      // no stale tmp file — expected happy path
    }
    try {
      writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
      renameSync(tmpPath, settingsPath);
    } catch (e) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // best-effort cleanup — nothing to remove or a lower-level failure
      }
      throw e;
    }
  };

  // Case A: no existing settings.json — write the template verbatim.
  // `.tmp` cleanup is handled inside writeAtomic itself, so this branch is
  // now free of a redundant unlinkSync.
  if (!existingStat) {
    try {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeAtomic(rendered);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { action: "io-error", reason: msg, failure: true };
    }
    return { action: "created", failure: false };
  }

  let raw: string;
  try {
    raw = readFileSync(settingsPath, "utf-8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { action: "io-error", reason: msg, failure: true };
  }
  // Strip a leading UTF-8 BOM before parsing (same treatment as
  // package-manager.ts's packageManager-field reader).
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

  let existing: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("settings.json root must be a JSON object");
    }
    existing = parsed as Record<string, unknown>;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { action: "invalid-json", reason: msg, failure: true };
  }

  // H9: an ARRAY `hooks` field would otherwise slip past the object check
  // (`typeof [] === "object"`) — its `.Stop` is undefined, so Case D would
  // not fire and Case B/C would overwrite the array wholesale, silently
  // destroying whatever the user had encoded. Reject it up front so nothing
  // is lost.
  if (Array.isArray(existing.hooks)) {
    return {
      action: "invalid-json",
      reason: "settings.json 'hooks' field must be an object, not an array",
      failure: true,
    };
  }

  const existingHooks =
    existing.hooks && typeof existing.hooks === "object"
      ? (existing.hooks as Record<string, unknown>)
      : undefined;

  // Case D: a populated hooks.Stop array already exists — never overwrite,
  // even with --force (contract §--force フラグの扱い). Non-array / empty-
  // array / null hooks.Stop are NOT conflicts and fall through to Case B/C.
  if (Array.isArray(existingHooks?.Stop) && existingHooks.Stop.length > 0) {
    // A3: derive the reason string from the SAME `rendered` object we would
    // have written on the merge path. Duplicating the command literal here
    // was drifting silently whenever the template changed (e.g. the
    // `--mode symbol` suffix in spec 012 G1).
    const conflictCmd = rendered.hooks.Stop[0]?.hooks[0]?.command ?? "";
    return {
      action: "conflict",
      reason: conflictCmd,
      failure: true,
    };
  }

  // Case B/C: merge Stop into (possibly absent/non-object) hooks, preserving
  // any other top-level fields and any other hook keys (e.g. PreToolUse).
  // Extension point: if the template ever grows beyond Stop, spread
  // rendered.hooks here instead of setting Stop alone.
  //
  // The array-hooks case was already rejected above (H9), so at this point
  // `existing.hooks` is either undefined or a plain object.
  const originalHooks = existingHooks ?? {};
  // C1: distinguish "user had a genuine sibling hook" (→ merged-c) from
  // "user had `{hooks: {Stop: []}}`" (→ merged-b). Counting Stop itself
  // would tag the latter as "other hooks preserved" — technically true,
  // but only of a placeholder Stop that we're about to overwrite.
  const hadOtherHookKeys = Object.keys(originalHooks).some((k) => k !== "Stop");
  existing.hooks = { ...originalHooks, Stop: rendered.hooks.Stop };

  try {
    writeAtomic(existing);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { action: "io-error", reason: msg, failure: true };
  }

  return { action: hadOtherHookKeys ? "merged-c" : "merged-b", failure: false };
}

/**
 * Agent-context snippet injection. P1 (T027) replaces this stub.
 */
function installAgentContext(_rootDir: string, _options: { force?: boolean } = {}): void {
  // P1 (T027): inject the CLAUDE.md / AGENTS.md snippet between the
  // <!-- artgraph: BEGIN agent context --> markers.
}

/**
 * Review A3 (issue #122 follow-up): detect a dangling `@impl`/`@verifies`
 * code tag — an `implements`/`verifies` edge sourced from an inline code tag
 * (`provenances` includes `"code-tag"`) whose target REQ/doc node isn't in
 * the graph. `buildGraph`'s existing "orphan-edge" warning only fires for
 * `annotation` provenance (spec-authored `(implements: FR-001)` relations),
 * so a stray `@impl FR-001` left in code with no matching spec is otherwise
 * silent. `init`'s brownfield closing hint uses this to avoid claiming "no
 * @impl claims detected yet" when the repo actually has one, just unmatched.
 */
function graphHasDanglingCodeTag(graph: ArtifactGraph): boolean {
  for (const edge of graph.edges) {
    if (
      (edge.kind === "implements" || edge.kind === "verifies") &&
      edge.provenances.includes("code-tag") &&
      !graph.nodes.has(edge.target)
    ) {
      return true;
    }
  }
  return false;
}

export function runInit(rootDir: string, options: InitOptions = {}): InitResult {
  const abs = resolve(rootDir);
  const configPath = resolve(abs, ".artgraph.json");

  const hasExistingConfig = existsSync(configPath);
  if (hasExistingConfig && !options.force) {
    throw new Error(".artgraph.json already exists. Use --force to overwrite.");
  }

  const stages = computeStageGates(options);

  // Pre-flight: fail before any write if the Skills stage cannot proceed
  // cleanly (templates missing, conflicts without --force). Keeps partial
  // -state windows closed: validation failure leaves disk untouched.
  if (stages.skills) {
    validateSkillsInstall(abs, { force: options.force });
  }

  const detection = detectProject(abs);

  // On `--force` over an existing config, MERGE the user's customizations
  // (reqPatterns / taskConventions / planCoverage / docGraph / mode / lockFile
  // / include / etc.) instead of nuking them. Only the detection-driven
  // `packageManager` field is refreshed below. Initial inits (no existing
  // config) keep the generateConfig path so detection-derived defaults
  // (include, specDirs) are still applied.
  const config: ArtgraphConfig = hasExistingConfig
    ? loadConfig(abs)
    : generateConfig(detection);

  // Record the detected package manager so downstream tooling (hooks /
  // agent-context / plugin templating in #109/#110/#111) can build exec
  // commands without re-sniffing lockfiles. `detectPackageManager` returns
  // null when nothing is detectable; in that case we leave the existing
  // `packageManager` value alone (preserving any prior detection recorded in
  // the file) instead of clobbering it with undefined (FR-008).
  //
  // F3-caller: pass `quiet: true` so the low-level `ERROR:` message is
  // suppressed here — the CLI's `skipped-no-pm` branch emits its own
  // user-facing `WARNING:` line, and having both fire produced a confusing
  // ERROR + WARNING pair for the same event.
  const detectedPm = detectPackageManager(abs, { quiet: true });
  if (detectedPm) {
    config.packageManager = detectedPm;
  }

  // Partial-state guard: install Skills BEFORE writing `.artgraph.json` so a
  // mid-loop copy failure (which `installSkills` already rolls back) never
  // leaves an orphan config file on disk. The order is:
  //   1. validate Skills (pre-flight, no write)
  //   2. install Skills (writes to .claude/skills/, self-rollback on failure)
  //   3. scan + reconcile (writes .trace.lock)
  //   4. write .artgraph.json (final, only reached if everything above
  //      succeeded)
  const skillsInstalled = stages.skills
    ? installSkills(abs, { force: options.force })
    : undefined;

  let scanSummary: ScanSummary | undefined;
  let warnings: BuildWarning[] = [];
  let lockPath: string | undefined;

  if (stages.scan) {
    const scanResult = scan(abs, config);
    reconcile(abs, config, scanResult.graph);
    scanSummary = {
      nodeCount: scanResult.nodeCount,
      edgeCount: scanResult.edgeCount,
      reqCount: scanResult.reqCount,
      docCount: scanResult.docCount,
      fileCount: scanResult.fileCount,
      testCount: scanResult.testCount,
      taskCount: scanResult.taskCount,
      hasDanglingCodeTag: graphHasDanglingCodeTag(scanResult.graph),
    };
    warnings = scanResult.warnings;
    lockPath = resolve(abs, config.lockFile);
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

  const integration = stages.integrate
    ? runRequestedIntegrations(abs, detection, options)
    : { failureCount: 0 };

  // PM resolution priority for the hooks stage (contract §PM 検出優先度):
  // (1) live detection this run, (2) the value already recorded in
  // .artgraph.json (covers repos where lockfiles were removed/rotated after
  // the initial init), (3) null → graceful skip.
  const pmForHooks = detectedPm ?? config.packageManager ?? null;
  const hooksInstall = stages.hooks
    ? installHooks(abs, pmForHooks, {
        force: options.force,
        // E1: `explicitOptIn` is only meaningful under `--minimal`, where the
        // user has to opt IN to each stage. In default mode `--with-hooks` is
        // redundant (hooks are already on) and MUST NOT escalate PM-missing
        // to a failure — otherwise `init --with-hooks` in a repo without a
        // detectable PM exits 1 while plain `init` exits 0 for the exact
        // same on-disk state.
        explicitOptIn: options.minimal === true && options.withHooks === true,
      })
    : undefined;

  if (stages.agentContext) {
    installAgentContext(abs, { force: options.force });
  }

  return {
    configPath,
    config,
    sddTools: detection.sddTools,
    scanSummary,
    warnings,
    lockPath,
    skillsInstalled,
    integrationResults: integration.results,
    integrationWarnings: integration.warnings,
    integrationFailureCount: integration.failureCount > 0 ? integration.failureCount : undefined,
    hooksInstall,
  };
}

/**
 * Apply integrate-auto for `init` (P0 redesign, contracts/cli-flags.md).
 *
 * Resolution order:
 *   1. Explicit array `options.integrations` → exactly those providers.
 *   2. `options.integrations === "all"` OR no `integrations` set → every
 *      detected provider (auto mode, the new default).
 *
 * Each provider runs via `runIntegrate` so the on-disk effect is identical
 * to the standalone `artgraph integrate <tool>` command. Tools that aren't
 * detected are warned about and skipped — `init` always exits 0.
 */
function runRequestedIntegrations(
  rootDir: string,
  detection: DetectionResult,
  options: InitOptions,
): { results?: IntegrateResult[]; warnings?: string[]; failureCount: number } {
  // Resolve the requested ids. Empty array also triggers auto-mode.
  const statuses = detection.integrations ?? [];
  let requested: IntegrationProviderId[];
  if (Array.isArray(options.integrations) && options.integrations.length > 0) {
    requested = options.integrations;
  } else {
    // Auto-detect (default behavior). "all" sentinel also lands here.
    requested = statuses.filter((s) => s.detected).map((s) => s.providerId);
  }
  if (requested.length === 0) return { failureCount: 0 };

  const results: IntegrateResult[] = [];
  const warnings: string[] = [];
  // Count only hard exceptions thrown by providers — NOT "not detected"
  // warnings, which are an expected no-op. The CLI converts a non-zero
  // failure count into a non-zero exit code per contracts/cli-flags.md.
  let failureCount = 0;

  for (const id of requested) {
    const status = statuses.find((s) => s.providerId === id);
    if (!status) {
      warnings.push(`unknown integration provider: ${id}`);
      continue;
    }
    if (!status.detected) {
      warnings.push(`WARNING: ${status.displayName} not detected, skipping integration`);
      continue;
    }
    try {
      const r = runIntegrate(rootDir, id, {
        // Only speckit consumes `gate`; other providers ignore unknown opts.
        gate: options.integrateGate,
        // FR-024: --force on `init` must reach the integration provider so
        // that drifted extension/steering files are regenerated alongside
        // the rest of the project. Previously this was dropped silently,
        // which made `init --integrate=<tool> --force` indistinguishable
        // from `init --integrate=<tool>` once any user edit existed.
        force: options.force,
      });
      results.push(r);
    } catch (e) {
      // Record as a warning (for human-readable output) AND increment the
      // failure counter so the CLI can exit non-zero. Without this, a
      // crashing provider was indistinguishable from a successful run.
      const msg = e instanceof Error ? e.message : String(e);
      warnings.push(`WARNING: ${id} integration failed: ${msg}`);
      failureCount += 1;
    }
  }

  return {
    results: results.length > 0 ? results : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
    failureCount,
  };
}
