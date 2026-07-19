// spec 013 T024 / T025 / T026 / T027 — `artgraph doctor` engine.
//
// Diagnoses the **Tier 1 distribution health** of a project that has been
// initialized via `artgraph init --agents=<list>` (US1 + US3). The output is
// a deterministic `DoctorReport` containing per-file `DoctorFinding[]` plus a
// short summary; the `--format text|json` CLI flag picks the renderer.
//
// Contract: specs/013-cross-agent-extensions/contracts/doctor-output.md
//           specs/013-cross-agent-extensions/contracts/cli-flags.md §doctor
//           specs/013-cross-agent-extensions/data-model.md §5
//
// Constitution Principle V (structural only): every diagnostic keys off
//   - filesystem existence,
//   - a sha256 byte-equality check against the canonical templates tree, or
//   - a literal-string search inside the artgraph-managed marker block.
// No semantic / NLP / markdown-AST reasoning. The doctor never writes; the
// only side effects are reads of `<rootDir>/...` and `templates/skills/`.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  AGENT_DESCRIPTORS,
  type AgentDescriptor,
  type AgentId,
  findDescriptor,
} from "./agents/descriptors.js";
import { buildAgentsMdBody, inspectMarkerBlock } from "./agents/agent-context.js";
import { detectPackageManager } from "./package-manager.js";
import { readSkillSource, type SkillSource } from "./agents/source.js";
import { loadConfig, missingNodeModulesProtection } from "./config.js";

/** Skip files larger than this when hashing / walking (C-adj-1). Prevents an
 * accidentally-planted multi-GB file inside a Skills dir from OOM-ing the
 * doctor. Canonical Skill files are <1 MB. */
const MAX_HASH_FILE_BYTES = 10 * 1024 * 1024;

// `templates/skills/` lives next to `dist/` (same anchor used in
// `src/init.ts` for `SKILLS_TEMPLATE_DIR`). Resolve relative to the compiled
// module path so the doctor works under `dist/doctor.js` AND
// `src/doctor.ts` (vitest / ts-node).
const SKILLS_TEMPLATE_DIR = resolve(import.meta.dirname, "../templates/skills");

// ---------------------------------------------------------------------------
// Types (T024)
// ---------------------------------------------------------------------------

export type DoctorFindingSeverity = "pass" | "fail";

export type DoctorFindingKind =
  | "skill-file-present"
  | "skill-file-missing"
  | "skill-file-drift"
  | "agents-md-present"
  | "agents-md-missing"
  | "agents-md-marker-broken"
  | "agents-md-body-stale"
  | "wrapper-present"
  | "wrapper-missing"
  | "wrapper-no-import"
  | "wrapper-broken-marker"
  | "extraneous-file"
  | "walk-error"
  | "distribution-absent"
  /**
   * spec 013 follow-up (#158) — `.artgraph.json` has no `agents` field
   * (legacy config predating this feature) while at least one Tier 1 agent
   * distribution is present on disk. Advisory only (severity `pass`) — never
   * flips the doctor exit code.
   */
  | "config-missing-agents-field"
  /**
   * spec 013 follow-up (#158) — `.artgraph.json`'s `agents` field lists an
   * id whose distribution directory is missing on disk. Actionable drift
   * (severity `fail`) — replaces `distribution-absent` when the absent set
   * was derived from config.agents rather than an explicit `opts.agents`
   * override.
   */
  | "agent-recorded-but-missing"
  /**
   * spec 013 follow-up (#158) — a Tier 1 agent has a distribution directory
   * on disk that isn't listed in `.artgraph.json`'s `agents` field. Advisory
   * only (severity `pass`) — the on-disk state itself isn't broken, just
   * unrecorded.
   */
  | "agent-installed-not-recorded"
  /**
   * issue #356 / spec 013 FR-015 — `.artgraph.json`'s `include` /
   * `testPatterns` node_modules-protection negation is asymmetric: one pool
   * has a node_modules-excluding negative pattern (DEFAULT_CONFIG's own, see
   * types.ts), the other doesn't. Advisory only (severity `pass`) — never
   * flips the doctor exit code. Purely structural (Principle V): computed by
   * the same `missingNodeModulesProtection` helper (`config.ts`) the silent
   * `config-pool-protection-asymmetry` `scan` warning uses, so the two
   * surfaces can never disagree. Gated on at least one Tier 1 agent being
   * detected (same gate `config-missing-agents-field` above uses) — this
   * keeps doctor's empty-report short-circuit (no distribution, no config
   * findings → clean empty report) intact; see the gate's own comment at the
   * `runDoctor` call site for why.
   */
  | "config-pool-protection-asymmetry";

export interface DoctorFinding {
  severity: DoctorFindingSeverity;
  /** Agent id when the finding belongs to a specific distribution; `null` for shared resources (AGENTS.md). */
  agent: string | null;
  kind: DoctorFindingKind;
  /** Repo-root relative POSIX path of the inspected file. */
  path: string;
  expected: string | null;
  actual: string | null;
  /** Human-readable 1-line explanation (consumed by the text renderer). */
  message: string;
}

export interface DoctorReportSummary {
  totalFindings: number;
  passCount: number;
  failCount: number;
  /** Sorted, unique list of detected agent ids. */
  agents: string[];
}

export interface DoctorReport {
  version: 1;
  summary: DoctorReportSummary;
  findings: DoctorFinding[];
}

export interface DoctorOptions {
  /** Project root. Required — every path in `findings` is resolved against this. */
  rootDir: string;
  /**
   * Optional explicit agent filter. Default = auto-detect every Tier 1 agent
   * whose canonical Skills path exists under `rootDir`.
   */
  agents?: AgentId[];
}

// ---------------------------------------------------------------------------
// Engine (T025)
// ---------------------------------------------------------------------------

// @impl 013-cross-agent-extensions/FR-011
/**
 * Run the doctor diagnostics and return a deterministic `DoctorReport`. Pure
 * function modulo `fs.read*` — never writes, never spawns processes, never
 * touches the network.
 */
export function runDoctor(opts: DoctorOptions): DoctorReport {
  const rootAbs = resolve(opts.rootDir);

  // Load canonical Skills source (sha256-stamped) up front — needed by both
  // step 1 (auto-detect canonical top-level check, D5) and step 3.
  // `readSkillSource` throws `SkillsInstallError` on packaging faults; the CLI
  // action wraps this call in a try/catch so the message surfaces as
  // `Error: ...` (C1).
  const source: SkillSource = readSkillSource(SKILLS_TEMPLATE_DIR);
  const canonicalTopLevels = new Set<string>(source.entries.map((e) => e.topLevel));

  // Detect the current PM up front so `addAgentsMdFindings` can compare the
  // AGENTS.md marker body against the canonical `buildAgentsMdBody(detectedPm)`.
  // Quiet mode — doctor never prints its own PM detection warning.
  const detectedPm = detectPackageManager(rootAbs, { quiet: true });

  // spec 013 follow-up (#158) — load `.artgraph.json` so the default
  // (no `opts.agents`) detection path can trust `config.agents` as SSOT
  // instead of blind on-disk observation, when the field is present.
  const config = loadConfig(rootAbs);

  // issue #356 / spec 013 FR-015 — config-shape advisory. The judge itself
  // (`missingNodeModulesProtection`) only reads `config.include` /
  // `config.testPatterns`, so it is computed here, up front, at no extra
  // cost. Whether it actually PRODUCES a finding is decided further below
  // (gated on `detectedDescriptors.length > 0`, same as
  // `config-missing-agents-field`'s own gate) — see that gate's comment for
  // why.
  const missingProtectionPools = missingNodeModulesProtection(config);

  // Step 1 — detect agents.
  //   - explicit `opts.agents`: trust the caller; the CLI parser has already
  //     enforced lowercase + Tier 1 membership. If an id has no distribution
  //     directory on disk, we record it in `absentDescriptors` and emit a
  //     single `distribution-absent` finding (D1) instead of flooding with
  //     N `skill-file-missing` entries. Explicit override — the config.agents
  //     cross-check below is skipped entirely.
  //   - `config.agents` defined (persisted state, #158): trust the config,
  //     cross-checking each recorded id against disk. Ids present on disk go
  //     to `detectedDescriptors`; ids missing on disk go to
  //     `absentDescriptors` and get an `agent-recorded-but-missing` finding
  //     (not `distribution-absent`) below. A separate pass then flags any
  //     on-disk agent NOT recorded in config.agents as
  //     `agent-installed-not-recorded`.
  //   - legacy fallback (config.agents undefined): every descriptor whose
  //     `<rootDir>/<skillsPath>` directory exists on disk AND contains at
  //     least one canonical top-level (D5), using `lstatSync` so a
  //     symlink-to-/dev-null does not crash the doctor (C-adj-2). An
  //     advisory `config-missing-agents-field` finding is emitted once when
  //     at least one agent was detected this way.
  //   Zero detected (and no config cross-check findings) → return an empty
  //   report.
  const detectedDescriptors: AgentDescriptor[] = [];
  const absentDescriptors: AgentDescriptor[] = [];
  const usingConfigAgents = !(opts.agents && opts.agents.length > 0) && config.agents !== undefined;
  if (opts.agents && opts.agents.length > 0) {
    for (const id of opts.agents) {
      const d = findDescriptor(id);
      // D-adj-1 — programmatic caller (`runDoctor({ agents: ["unknown"] })`)
      // must fail loudly. The CLI parser already normalizes this branch, so
      // this is a defensive throw for direct callers.
      if (!d) {
        throw new Error(
          `Unknown agent id: "${id}". Supported values: ${AGENT_DESCRIPTORS.map((x) => x.id).join(", ")}`,
        );
      }
      const dist = resolve(rootAbs, d.skillsPath);
      let stat;
      try {
        stat = lstatSync(dist);
      } catch {
        stat = undefined;
      }
      if (stat && stat.isDirectory()) {
        detectedDescriptors.push(d);
      } else {
        absentDescriptors.push(d);
      }
    }
  } else if (usingConfigAgents) {
    for (const id of config.agents as AgentId[]) {
      const d = findDescriptor(id);
      // Defensive: `validateAgents` already restricts `config.agents` to
      // `AGENT_IDS`, so this only fires for a hand-edited/pre-validation
      // config. Skip rather than throw — unlike the `opts.agents` path this
      // isn't direct per-call caller input.
      if (!d) continue;
      // PR #233 review (any-artifact check) — a recorded agent is only
      // "missing" (→ `agent-recorded-but-missing`) when NEITHER its Skills
      // directory nor its wrapper file is on disk. `--no-skills
      // --agents=X` still leaves the wrapper (CLAUDE.md); requiring the
      // Skills directory alone would flag that as missing.
      if (isAgentDistributionOnDisk(rootAbs, d, canonicalTopLevels)) {
        detectedDescriptors.push(d);
      } else {
        absentDescriptors.push(d);
      }
    }
  } else {
    for (const descriptor of AGENT_DESCRIPTORS) {
      const dist = resolve(rootAbs, descriptor.skillsPath);
      let stat;
      try {
        stat = lstatSync(dist);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      // D5 — reject a directory that contains no canonical top-level (e.g.
      // Kiro or a third-party tool created `.kiro/skills/` on its own and
      // artgraph never installed anything into it).
      let entries: string[];
      try {
        entries = readdirSync(dist);
      } catch {
        continue;
      }
      const hasCanonical = entries.some((e) => canonicalTopLevels.has(e));
      if (!hasCanonical) continue;
      detectedDescriptors.push(descriptor);
    }
  }

  // spec 013 follow-up (#158) — config ↔ disk cross-check findings. Computed
  // before the empty-report short-circuit so a config-only signal (e.g. an
  // agent recorded but never distributed, or an on-disk agent recorded
  // nowhere) still produces output even when both `detectedDescriptors` and
  // `absentDescriptors` are otherwise empty (e.g. `config.agents: []`).
  // Skipped entirely for the explicit `opts.agents` override path.
  const configFindings: DoctorFinding[] = [];
  if (!(opts.agents && opts.agents.length > 0)) {
    if (config.agents === undefined) {
      if (detectedDescriptors.length > 0) {
        configFindings.push({
          severity: "pass",
          agent: null,
          kind: "config-missing-agents-field",
          path: ".artgraph.json",
          expected: "agents field present",
          actual: "agents field absent",
          message:
            '.artgraph.json has no "agents" field — run `artgraph init --force --agents=<csv>` to persist the current install for reliable doctor / rename / uninstall cross-checks.',
        });
      }
    } else {
      const recordedSet = new Set<AgentId>(config.agents);
      for (const d of absentDescriptors) {
        // PR #233 review (MAJOR) — the old message ("update the config to
        // drop it") pointed at a nonexistent CLI affordance: union-only
        // persistence means there is no `artgraph` flag to remove an agent
        // from `.artgraph.json` today. Be honest about the two real options
        // — restore via `--force`, or hand-edit the JSON — and point at the
        // tracked follow-up (#131) for a proper `artgraph uninstall`.
        const artifactsDesc =
          d.wrapperFile !== null
            ? `no ${d.skillsPath}/ and no ${d.wrapperFile}`
            : `no ${d.skillsPath}/`;
        configFindings.push({
          severity: "fail",
          agent: d.id,
          kind: "agent-recorded-but-missing",
          path: d.skillsPath,
          expected: "distribution present",
          actual: "no distribution directory",
          message: `Agent "${d.id}" is recorded in .artgraph.json but no distribution artifacts are on disk (${artifactsDesc}). Re-run \`artgraph init --force --agents=${d.id}\` to restore, or hand-edit .artgraph.json to drop it. (A dedicated \`artgraph uninstall\` command is tracked in #131.)`,
        });
      }
      for (const descriptor of AGENT_DESCRIPTORS) {
        if (recordedSet.has(descriptor.id)) continue;
        if (isAgentDistributionOnDisk(rootAbs, descriptor, canonicalTopLevels)) {
          // Also feed it into `detectedDescriptors` — it IS installed on
          // disk, just unrecorded, so it should still get the full Step
          // 3/4/5 skill-file / wrapper diagnostics (and show up in
          // `summary.agents`) rather than only this advisory.
          detectedDescriptors.push(descriptor);
          configFindings.push({
            severity: "pass",
            agent: descriptor.id,
            kind: "agent-installed-not-recorded",
            path: descriptor.skillsPath,
            expected: "recorded in .artgraph.json agents",
            actual: "not recorded",
            message: `Agent "${descriptor.id}" has a distribution directory at ${descriptor.skillsPath} but is not recorded in .artgraph.json's "agents". Run \`artgraph init --force --agents=${descriptor.id}\` to persist it (union with existing).`,
          });
        }
      }
    }
  }

  // @impl 013-cross-agent-extensions/FR-015
  // issue #356 / spec 013 FR-015 — same gate as `config-missing-agents-field`
  // above (`detectedDescriptors.length > 0`): doctor's empty-report
  // short-circuit right below assumes NO Tier 1 distribution context means
  // "nothing to report" and returns before Step 4 (`addAgentsMdFindings`,
  // which runs unconditionally once past the short-circuit) ever executes.
  // Firing this advisory unconditionally — independent of agent detection —
  // would bypass that short-circuit on a project with zero installed agents
  // and inadvertently pull in Step 4's AGENTS.md check, which would then
  // report a genuine `agents-md-missing` FAIL for a project that never ran
  // `artgraph init` at all — a new non-zero exit code the config-shape
  // advisory alone must never cause. Gating on the same condition
  // `config-missing-agents-field` already uses keeps this finding confined
  // to projects where doctor already has Tier 1 distribution context to
  // report on.
  const poolProtectionFindings: DoctorFinding[] = [];
  if (missingProtectionPools.length > 0 && detectedDescriptors.length > 0) {
    const missingKey = missingProtectionPools[0];
    const protectedKey = missingKey === "include" ? "testPatterns" : "include";
    poolProtectionFindings.push({
      severity: "pass",
      agent: null,
      kind: "config-pool-protection-asymmetry",
      path: ".artgraph.json",
      expected: `node_modules-excluding negative pattern in both "include" and "testPatterns"`,
      actual: `missing from "${missingKey}"`,
      message: `"${protectedKey}" excludes node_modules but "${missingKey}" does not — add a "!**/node_modules/**"-style negative pattern to "${missingKey}" in .artgraph.json, or remove it from "${protectedKey}" if scanning node_modules via "${missingKey}" is intentional.`,
    });
  }

  if (
    detectedDescriptors.length === 0 &&
    absentDescriptors.length === 0 &&
    configFindings.length === 0
  ) {
    return {
      version: 1,
      summary: {
        totalFindings: 0,
        passCount: 0,
        failCount: 0,
        agents: [],
      },
      findings: [],
    };
  }

  const findings: DoctorFinding[] = [];

  // D1 — explicit --agents ids whose distribution dir does not exist get a
  // single `distribution-absent` finding, no per-file scanning. Skipped when
  // `absentDescriptors` was derived from `config.agents` (#158, usingConfigAgents)
  // — those ids get the more specific `agent-recorded-but-missing` finding
  // instead, pushed via `configFindings` below.
  if (!usingConfigAgents) {
    for (const d of absentDescriptors) {
      findings.push({
        severity: "fail",
        agent: d.id,
        kind: "distribution-absent",
        path: d.skillsPath,
        expected: "distribution present",
        actual: "no distribution directory",
        message: `${d.displayName} distribution is not installed under ${d.skillsPath}/. Run \`artgraph init --agents=${d.id}\` to install it.`,
      });
    }
  }

  // spec 013 follow-up (#158) — config ↔ disk cross-check findings computed
  // above (config-missing-agents-field / agent-recorded-but-missing /
  // agent-installed-not-recorded).
  findings.push(...configFindings);

  // issue #356 — config-pool-protection-asymmetry advisory, computed above
  // (gated on `detectedDescriptors.length > 0`, same as
  // `config-missing-agents-field`).
  findings.push(...poolProtectionFindings);

  // Step 3 — per-agent Skills + extraneous-file diagnostics.
  for (const descriptor of detectedDescriptors) {
    addSkillFindings(rootAbs, descriptor, source, findings);
    addExtraneousFindings(rootAbs, descriptor, source, findings);
  }

  // Step 4 — AGENTS.md (single shared resource; `agent: null`).
  addAgentsMdFindings(rootAbs, detectedPm, findings);

  // Step 5 — wrappers (claude / copilot only).
  for (const descriptor of detectedDescriptors) {
    if (descriptor.wrapperFile !== null) {
      addWrapperFindings(rootAbs, descriptor, findings);
    }
  }

  // Compose summary. `agents` is alpha-sorted unique by descriptor id and
  // includes both fully-detected and distribution-absent agents so the CLI
  // renderer surfaces the requested set.
  const passCount = findings.filter((f) => f.severity === "pass").length;
  const failCount = findings.length - passCount;
  const agents = [
    ...new Set([...detectedDescriptors.map((d) => d.id), ...absentDescriptors.map((d) => d.id)]),
  ].sort();

  return {
    version: 1,
    summary: {
      totalFindings: findings.length,
      passCount,
      failCount,
      agents,
    },
    findings,
  };
}

// ---------------------------------------------------------------------------
// Sub-checks
// ---------------------------------------------------------------------------

// spec 013 follow-up (#158) — same D5 "has at least one canonical top-level"
// test as the legacy auto-detect loop in `runDoctor`, factored out so
// `isAgentDistributionOnDisk` (and any other caller needing the Skills-only
// half of the check) can reuse it.
function skillsDirHasCanonicalTopLevel(
  rootAbs: string,
  descriptor: AgentDescriptor,
  canonicalTopLevels: Set<string>,
): boolean {
  const dist = resolve(rootAbs, descriptor.skillsPath);
  let stat;
  try {
    stat = lstatSync(dist);
  } catch {
    return false;
  }
  if (!stat.isDirectory()) return false;
  let entries: string[];
  try {
    entries = readdirSync(dist);
  } catch {
    return false;
  }
  return entries.some((e) => canonicalTopLevels.has(e));
}

// PR #233 review — an agent is "installed" if EITHER its Skills directory
// has canonical content OR its wrapper file exists. `--no-skills
// --agents=X` still leaves CLAUDE.md, so requiring both would produce a
// false-positive `agent-recorded-but-missing` (BLOCKER, #158 review).
// `existsSync` (not `lstatSync`) is enough here — the wrapper is a regular
// file the init writer creates; symlinks aren't an expected shape.
function isAgentDistributionOnDisk(
  rootAbs: string,
  descriptor: AgentDescriptor,
  canonicalTopLevels: Set<string>,
): boolean {
  const skillsPresent = skillsDirHasCanonicalTopLevel(rootAbs, descriptor, canonicalTopLevels);
  const wrapperPresent =
    descriptor.wrapperFile !== null && existsSync(resolve(rootAbs, descriptor.wrapperFile));
  return skillsPresent || wrapperPresent;
}

function addSkillFindings(
  rootAbs: string,
  descriptor: AgentDescriptor,
  source: SkillSource,
  out: DoctorFinding[],
): void {
  for (const entry of source.entries) {
    for (const file of entry.files) {
      const distAbs = resolve(rootAbs, descriptor.skillsPath, file.relPath);
      const relPath = toRepoRel(rootAbs, distAbs);
      // C3 — collapse existsSync + hashFile into a single try/catch pass so a
      // concurrent `rm` between the two syscalls cannot surface an ENOENT
      // raw-stack. Non-ENOENT errors bubble to the CLI action's try/catch (C1).
      let actualSha: string;
      try {
        actualSha = hashFile(distAbs);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException | undefined)?.code;
        if (code === "ENOENT") {
          out.push({
            severity: "fail",
            agent: descriptor.id,
            kind: "skill-file-missing",
            path: relPath,
            expected: "present",
            actual: "missing",
            message: `Distributed Skill file is missing. Run \`artgraph init --agents=${descriptor.id} --force\` to restore.`,
          });
          continue;
        }
        // C-adj-1 — hashFile threshold rejection surfaces as walk-error.
        if (code === "E_FILE_TOO_LARGE") {
          out.push({
            severity: "fail",
            agent: descriptor.id,
            kind: "walk-error",
            path: relPath,
            expected: `size <= ${MAX_HASH_FILE_BYTES} bytes`,
            actual: (e as Error).message,
            message: `Skipped hashing ${relPath}: file exceeds the ${MAX_HASH_FILE_BYTES}-byte threshold.`,
          });
          continue;
        }
        throw e;
      }
      if (actualSha !== file.sha256) {
        out.push({
          severity: "fail",
          agent: descriptor.id,
          kind: "skill-file-drift",
          path: relPath,
          expected: file.sha256,
          actual: actualSha,
          message: `Distributed file has drifted from canonical templates/skills/${file.relPath}. Run \`artgraph init --agents=${descriptor.id} --force\` to restore.`,
        });
        continue;
      }
      out.push({
        severity: "pass",
        agent: descriptor.id,
        kind: "skill-file-present",
        path: relPath,
        expected: null,
        actual: null,
        message: "OK",
      });
    }
  }
}

function addExtraneousFindings(
  rootAbs: string,
  descriptor: AgentDescriptor,
  source: SkillSource,
  out: DoctorFinding[],
): void {
  const distRoot = resolve(rootAbs, descriptor.skillsPath);
  // Rooted lstat guard — the auto-detect step already checked existence but
  // for the explicit-agents path a concurrent rm may have removed it since.
  try {
    if (!lstatSync(distRoot).isDirectory()) return;
  } catch {
    return;
  }

  // spec 013 FR-011 (d) — extraneous-file detection is scoped to artgraph's
  // own canonical top-level dirs (e.g. `artgraph-impact/`, `_shared/`). Any
  // dir under `<agent_skills_path>/` that is NOT one of those canonical
  // top-levels belongs to another tool's Skills (e.g. `.claude/skills/
  // speckit-implement/SKILL.md`) and is out of artgraph's scope; we ignore
  // it entirely so doctor does not spuriously flag third-party Skills.
  //
  // Within each canonical top-level dir, every file MUST match a canonical
  // relPath; mismatches (old version remnants, manually added files) are
  // reported as `extraneous-file`.
  const canonicalTopLevels = new Set<string>(source.entries.map((e) => e.topLevel));
  const canonical = new Set<string>();
  for (const entry of source.entries) {
    for (const file of entry.files) {
      canonical.add(file.relPath);
    }
  }

  // Enumerate `<distRoot>/<topLevel>` only for topLevels that appear in the
  // canonical set; everything else (non-artgraph Skills) is left untouched.
  let topLevelDirs: string[];
  try {
    topLevelDirs = readdirSync(distRoot);
  } catch {
    return;
  }
  for (const topLevel of topLevelDirs) {
    // D2 — dot entries (`.DS_Store`, `.swp`, `.gitkeep`) never live inside a
    // canonical top-level. Mirror source.ts:walk's skip so macOS / editor
    // droppings do not turn every `doctor` into a FAIL.
    if (topLevel.startsWith(".")) continue;
    if (!canonicalTopLevels.has(topLevel)) continue;
    const subRoot = resolve(distRoot, topLevel);
    // C2 — lstat + symlink skip so a `ln -s .` loop inside a Skill dir does
    // not overflow the recursion.
    let stat;
    try {
      stat = lstatSync(subRoot);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (!stat.isDirectory()) continue;

    const onDisk: string[] = [];
    walk(subRoot, subRoot, onDisk, out, descriptor, rootAbs);
    for (const abs of onDisk) {
      // Compute the file's relPath relative to `distRoot`, matching the
      // POSIX form used by `SkillFile.relPath`.
      const relPosix = toPosix(abs.slice(distRoot.length + 1));
      if (!canonical.has(relPosix)) {
        out.push({
          severity: "fail",
          agent: descriptor.id,
          kind: "extraneous-file",
          path: toRepoRel(rootAbs, abs),
          expected: "not present",
          actual: "present",
          message: `Distribution contains a file not in canonical templates/skills/. Remove it (or report a stale artgraph version that left it behind).`,
        });
      }
    }
  }
}

function addAgentsMdFindings(
  rootAbs: string,
  detectedPm: ReturnType<typeof detectPackageManager>,
  out: DoctorFinding[],
): void {
  const absPath = resolve(rootAbs, "AGENTS.md");
  // C3 / C-adj-4 — single defensive readFileSync so an ENOENT race with a
  // concurrent rm surfaces as `agents-md-missing`, and an EACCES surfaces as
  // `agents-md-marker-broken` (rather than a raw uncaught throw).
  let content: string;
  try {
    content = readFileSync(absPath, "utf-8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      out.push({
        severity: "fail",
        agent: null,
        kind: "agents-md-missing",
        path: "AGENTS.md",
        expected: "present",
        actual: "missing",
        message: `AGENTS.md is missing. Re-run \`artgraph init --agents=<list>\` to regenerate it.`,
      });
      return;
    }
    // Non-ENOENT (EACCES / EPERM / EISDIR): report as marker-broken with the
    // filesystem message so the doctor's exit code still flips to 1 and the
    // user sees a hint at the root cause. The CLI action's try/catch (C1)
    // is the last resort for truly unrecoverable errors.
    out.push({
      severity: "fail",
      agent: null,
      kind: "agents-md-marker-broken",
      path: "AGENTS.md",
      expected: "readable file with single matched marker pair",
      actual: `read error: ${(e as Error).message}`,
      message: `AGENTS.md could not be read: ${(e as Error).message}.`,
    });
    return;
  }
  const health = inspectMarkerBlock(content);
  if (!health.hasMatchedPair) {
    out.push({
      severity: "fail",
      agent: null,
      kind: "agents-md-marker-broken",
      path: "AGENTS.md",
      expected: "single matched pair",
      actual: brokenMarkerDescription(content, health),
      message: `AGENTS.md artgraph marker block is broken. Re-run \`artgraph init --agents=<list> --force\` to repair.`,
    });
    return;
  }
  // Compare the marker-block body to the canonical rendering for the
  // currently detected PM. If they differ, the user's AGENTS.md is running
  // an outdated snippet (the template changed since their last `init`) —
  // flag it so they know to re-run `init --force`. Severity is `pass`
  // (NOTICE-style) so a plain artgraph upgrade doesn't silently break CI
  // gates that treat any `fail` finding as a hard stop.
  const currentBody = health.bodyText ?? "";
  let canonicalBody: string | null = null;
  try {
    canonicalBody = buildAgentsMdBody(detectedPm);
  } catch {
    // Packaging fault reading the template — do not synthesize a false
    // stale finding. `readSkillSource` above will surface the packaging
    // error on the same path elsewhere.
    canonicalBody = null;
  }
  if (canonicalBody !== null) {
    const currentHash = createHash("sha256").update(currentBody).digest("hex");
    const canonicalHash = createHash("sha256").update(canonicalBody).digest("hex");
    if (currentHash !== canonicalHash) {
      out.push({
        severity: "pass",
        agent: null,
        kind: "agents-md-body-stale",
        path: "AGENTS.md",
        expected: canonicalHash,
        actual: currentHash,
        message: `NOTICE: AGENTS.md artgraph marker block body is out of date. Re-run \`artgraph init --agents=<list> --force\` to refresh it against the current template.`,
      });
      return;
    }
  }
  out.push({
    severity: "pass",
    agent: null,
    kind: "agents-md-present",
    path: "AGENTS.md",
    expected: null,
    actual: null,
    message: "OK",
  });
}

function addWrapperFindings(
  rootAbs: string,
  descriptor: AgentDescriptor,
  out: DoctorFinding[],
): void {
  // `wrapperFile` is non-null per the call-site guard.
  const wrapperRel = descriptor.wrapperFile as string;
  const absPath = resolve(rootAbs, wrapperRel);
  // C3 — defensive readFileSync collapsing the existsSync + readFileSync race.
  let content: string;
  try {
    content = readFileSync(absPath, "utf-8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      out.push({
        severity: "fail",
        agent: descriptor.id,
        kind: "wrapper-missing",
        path: wrapperRel,
        expected: "present",
        actual: "missing",
        message: `${descriptor.displayName} wrapper file is missing. Re-run \`artgraph init --agents=${descriptor.id} --force\` to regenerate it.`,
      });
      return;
    }
    // Non-ENOENT: report as broken-marker so the CLI's exit code flips
    // without crashing.
    out.push({
      severity: "fail",
      agent: descriptor.id,
      kind: "wrapper-broken-marker",
      path: wrapperRel,
      expected: "readable wrapper with intact marker block",
      actual: `read error: ${(e as Error).message}`,
      message: `${descriptor.displayName} wrapper could not be read: ${(e as Error).message}.`,
    });
    return;
  }
  const health = inspectMarkerBlock(content);
  // A6 — differentiate "block markers are broken" from "block is intact but
  // missing the @AGENTS.md line". The old code lumped both into
  // `wrapper-no-import`, which pushed the user to re-add `@AGENTS.md` while
  // the real fix was to repair the markers. Report `wrapper-broken-marker`
  // when `hasMatchedPair === false`.
  if (!health.hasMatchedPair) {
    out.push({
      severity: "fail",
      agent: descriptor.id,
      kind: "wrapper-broken-marker",
      path: wrapperRel,
      expected: "single matched pair",
      actual: brokenMarkerDescription(content, health),
      message: `${descriptor.displayName} wrapper artgraph marker block is broken. Re-run \`artgraph init --agents=${descriptor.id} --force\` to repair.`,
    });
    return;
  }
  const blockBody = health.bodyText ?? "";
  if (!blockBody.includes("@AGENTS.md")) {
    out.push({
      severity: "fail",
      agent: descriptor.id,
      kind: "wrapper-no-import",
      path: wrapperRel,
      expected: "@AGENTS.md literal in block",
      actual: "not found",
      message: `${descriptor.displayName} wrapper does not import AGENTS.md. Re-run \`artgraph init --agents=${descriptor.id} --force\` to restore the @AGENTS.md line.`,
    });
    return;
  }
  out.push({
    severity: "pass",
    agent: descriptor.id,
    kind: "wrapper-present",
    path: wrapperRel,
    expected: null,
    actual: null,
    message: "OK",
  });
}

// ---------------------------------------------------------------------------
// Formatters (T026 / T027)
// ---------------------------------------------------------------------------

/**
 * Render the report as a human-readable summary. Format is intentionally
 * unstable across releases (CLI UX may change) — machine consumers should
 * parse the JSON output instead.
 */
export function formatDoctorReportText(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push("artgraph doctor — Tier 1 distribution health check");
  lines.push("");

  if (report.findings.length === 0) {
    // No distribution detected → soft-success path (per FR-011 + quickstart §3-5).
    lines.push("No Tier 1 distribution detected. Run `artgraph init --agents=<list>` to set up.");
    return lines.join("\n");
  }

  // Group by agent (sorted) then surface AGENTS.md as a trailing section so
  // the per-agent blocks line up. `null`-agent findings (AGENTS.md) are kept
  // out of the per-agent loop.
  for (const agentId of report.summary.agents) {
    const descriptor = findDescriptor(agentId);
    if (!descriptor) continue;
    const agentFindings = report.findings.filter((f) => f.agent === agentId);
    if (agentFindings.length === 0) continue;

    lines.push(`[${agentId}] ${descriptor.skillsPath}/`);
    const failures = agentFindings.filter((f) => f.severity === "fail");
    const passCount = agentFindings.length - failures.length;
    if (failures.length === 0) {
      lines.push(`  ${passCount} pass`);
    } else {
      lines.push(`  ${passCount} pass, ${failures.length} fail`);
      for (const f of failures) {
        lines.push(`  ✗ ${f.path}    (${f.kind})`);
        if (f.kind === "skill-file-drift" && f.expected && f.actual) {
          lines.push(
            `       expected: ${f.expected.slice(0, 12)}…  actual: ${f.actual.slice(0, 12)}…`,
          );
        } else if (f.expected !== null && f.actual !== null) {
          lines.push(`       expected: ${f.expected}  actual: ${f.actual}`);
        }
      }
    }
    lines.push("");
  }

  // AGENTS.md section — single shared finding (or its FAIL variants). Scoped
  // to `agents-md-*` kinds specifically (not just `agent === null`) since
  // #158 added a second `agent: null` finding kind (config-missing-agents-field)
  // that is NOT about AGENTS.md's marker block.
  const agentsMdFindings = report.findings.filter(
    (f) => f.agent === null && f.kind.startsWith("agents-md"),
  );
  for (const f of agentsMdFindings) {
    if (f.severity === "pass") {
      lines.push(`AGENTS.md: ✓ marker block intact`);
    } else {
      lines.push(`AGENTS.md: ✗ ${f.kind} — ${f.message}`);
    }
  }
  if (agentsMdFindings.length > 0) lines.push("");

  // spec 013 follow-up (#158) — config-level advisory, surfaced once as a
  // NOTICE line (mirrors the agents-md-body-stale NOTICE convention).
  // issue #356 — `config-pool-protection-asymmetry` joins the same NOTICE
  // treatment: same shape (agent: null, severity: "pass", config-only).
  const configLevelFindings = report.findings.filter(
    (f) =>
      f.agent === null &&
      (f.kind === "config-missing-agents-field" || f.kind === "config-pool-protection-asymmetry"),
  );
  for (const f of configLevelFindings) {
    lines.push(`NOTICE: ${f.message}`);
  }
  if (configLevelFindings.length > 0) lines.push("");

  lines.push(`Summary: ${report.summary.passCount} pass, ${report.summary.failCount} fail`);
  return lines.join("\n");
}

/**
 * Render the report as the wire-compatible JSON described in
 * contracts/doctor-output.md. Stable across patch releases (the `version`
 * field tracks breaking changes).
 */
export function formatDoctorReportJson(report: DoctorReport): string {
  return JSON.stringify(report, null, 2);
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function hashFile(abs: string): string {
  // C-adj-1 — refuse to hash multi-GB files. lstat first so we don't follow a
  // symlink into a device file. When the file is too large, we throw a
  // synthetic ENOENT-shaped error with `code = "E_FILE_TOO_LARGE"` so the
  // caller can convert it to a `walk-error` finding.
  let stat;
  try {
    stat = lstatSync(abs);
  } catch (e) {
    throw e;
  }
  if (stat.isSymbolicLink()) {
    const err = new Error(
      `Refused to hash symlink at ${abs} (structural check does not follow links).`,
    ) as NodeJS.ErrnoException;
    err.code = "E_FILE_TOO_LARGE";
    throw err;
  }
  if (stat.size > MAX_HASH_FILE_BYTES) {
    const err = new Error(
      `File at ${abs} exceeds the ${MAX_HASH_FILE_BYTES}-byte hashing threshold (${stat.size} bytes).`,
    ) as NodeJS.ErrnoException;
    err.code = "E_FILE_TOO_LARGE";
    throw err;
  }
  const buf = readFileSync(abs);
  return createHash("sha256").update(buf).digest("hex");
}

function walk(
  distRoot: string,
  current: string,
  out: string[],
  findings: DoctorFinding[],
  descriptor: AgentDescriptor,
  rootAbs: string,
): void {
  // C4 — guard `readdirSync` so a `chmod 000` subtree does not crash the
  // entire doctor. We emit a single `walk-error` finding and continue with
  // the rest of the walk.
  let entries: string[];
  try {
    entries = readdirSync(current);
  } catch (e) {
    findings.push({
      severity: "fail",
      agent: descriptor.id,
      kind: "walk-error",
      path: toRepoRel(rootAbs, current),
      expected: "readable directory",
      actual: `readdir error: ${(e as Error).message}`,
      message: `Failed to enumerate directory: ${(e as Error).message}.`,
    });
    return;
  }
  for (const entry of entries) {
    // D2 — skip dot files (`.DS_Store`, editor `.swp`, `.gitkeep`). source.ts
    // already excludes these from the canonical set, so leaving them
    // unchecked would always produce a spurious `extraneous-file`.
    if (entry.startsWith(".")) continue;
    const full = current + sep + entry;
    // C2 — `lstatSync` (not `statSync`) so a symlink loop cannot recurse.
    let stat;
    try {
      stat = lstatSync(full);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      walk(distRoot, full, out, findings, descriptor, rootAbs);
    } else if (stat.isFile()) {
      // C-adj-1 — reject over-threshold files with a `walk-error` finding so
      // extraneous-file scanning does not OOM on a rogue multi-GB drop.
      if (stat.size > MAX_HASH_FILE_BYTES) {
        findings.push({
          severity: "fail",
          agent: descriptor.id,
          kind: "walk-error",
          path: toRepoRel(rootAbs, full),
          expected: `size <= ${MAX_HASH_FILE_BYTES} bytes`,
          actual: `${stat.size} bytes`,
          message: `Skipped extraneous-file check for ${toRepoRel(rootAbs, full)}: exceeds the ${MAX_HASH_FILE_BYTES}-byte threshold.`,
        });
        continue;
      }
      out.push(full);
    }
  }
}

function toPosix(p: string): string {
  return p.split(/\\|\//).join("/");
}

function toRepoRel(rootAbs: string, abs: string): string {
  const stripped =
    abs.startsWith(rootAbs + sep) || abs.startsWith(rootAbs + "/")
      ? abs.slice(rootAbs.length + 1)
      : abs;
  return toPosix(stripped);
}

// A-adj-1 — count strays with a global regex so the message can distinguish
// "1 begin without end" from "3 begins + 3 ends but unpaired". Non-global
// `match()` collapses N strays into 1.
const BEGIN_RE_G = /<!--\s*artgraph:begin\s*-->/g;
const END_RE_G = /<!--\s*artgraph:end\s*-->/g;

function brokenMarkerDescription(
  content: string,
  h: ReturnType<typeof inspectMarkerBlock>,
): string {
  const beginCount = Array.from(content.matchAll(BEGIN_RE_G)).length;
  const endCount = Array.from(content.matchAll(END_RE_G)).length;
  if (!h.hasBegin && !h.hasEnd) return "no markers found";
  if (h.hasBegin && !h.hasEnd) {
    return beginCount === 1 ? "1 begin marker without end" : `${beginCount} begin markers, 0 ends`;
  }
  if (!h.hasBegin && h.hasEnd) {
    return endCount === 1 ? "1 end marker without begin" : `0 begins, ${endCount} end markers`;
  }
  return `markers present but unpaired (${beginCount} begins, ${endCount} ends)`;
}
