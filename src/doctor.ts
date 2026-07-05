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
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  AGENT_DESCRIPTORS,
  type AgentDescriptor,
  type AgentId,
  findDescriptor,
} from "./agents/descriptors.js";
import { inspectMarkerBlock } from "./agents/agent-context.js";
import { readSkillSource, type SkillSource } from "./agents/source.js";

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
  | "wrapper-present"
  | "wrapper-missing"
  | "wrapper-no-import"
  | "wrapper-broken-marker"
  | "extraneous-file"
  | "walk-error"
  | "distribution-absent"
  | "legacy-copilot-skills-path";

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

  // Step 1 — detect agents.
  //   - explicit `opts.agents`: trust the caller; the CLI parser has already
  //     enforced lowercase + Tier 1 membership. If an id has no distribution
  //     directory on disk, we record it in `absentDescriptors` and emit a
  //     single `distribution-absent` finding (D1) instead of flooding with
  //     N `skill-file-missing` entries. Descriptors with `skillsPath === null`
  //     (Copilot, issue #130) are always considered "detected" — they carry
  //     no Skills tree to look for, so wrapper checks are the only thing
  //     the doctor can meaningfully do for them.
  //   - default: every descriptor whose `<rootDir>/<skillsPath>` directory
  //     exists on disk AND contains at least one canonical top-level (D5),
  //     using `lstatSync` so a symlink-to-/dev-null does not crash the
  //     doctor (C-adj-2). For `skillsPath === null` descriptors, presence
  //     of the wrapper file (or a legacy `.github/skills/` residue) is the
  //     detection signal instead. Zero detected → return an empty report.
  const detectedDescriptors: AgentDescriptor[] = [];
  const absentDescriptors: AgentDescriptor[] = [];
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
      // issue #130 — Copilot has no Skills tree. Explicit selection always
      // "detects" it so the wrapper check runs; there is no
      // distribution-absent state to report for a non-distribution agent.
      if (d.skillsPath === null) {
        detectedDescriptors.push(d);
        continue;
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
  } else {
    for (const descriptor of AGENT_DESCRIPTORS) {
      // issue #130 — auto-detect for a no-Skills descriptor keys off wrapper
      // presence (the only on-disk artifact artgraph writes for it). A
      // legacy `.github/skills/` residue also counts as "detected" so the
      // doctor can surface it via `legacy-copilot-skills-path` rather than
      // silently ignoring it.
      if (descriptor.skillsPath === null) {
        const wrapperAbs =
          descriptor.wrapperFile !== null ? resolve(rootAbs, descriptor.wrapperFile) : null;
        // C1 (issue #130 follow-up review): distinguish artgraph-managed
        // wrappers from hand-written Copilot custom instructions. Only
        // treat the wrapper as an artgraph signal when it carries at least
        // one of our marker lines. A broken/partial marker still counts as
        // artgraph-managed so `wrapper-broken-marker` diagnostics can fire.
        // Non-marker files (raw hand-written Copilot instructions) are NOT
        // detected — otherwise doctor emits false-positive
        // `wrapper-broken-marker` fails at users who never used artgraph.
        let wrapperExists = false;
        if (wrapperAbs !== null) {
          try {
            if (lstatSync(wrapperAbs).isFile()) {
              const content = readFileSync(wrapperAbs, "utf-8");
              const health = inspectMarkerBlock(content);
              wrapperExists = health.hasBegin || health.hasEnd;
            }
          } catch {
            wrapperExists = false;
          }
        }
        // B2 (issue #130 follow-up review): mirror the D5 canonical
        // top-level guard used by other agents' auto-detect — a
        // `.github/skills/` that contains only third-party Skills (e.g.
        // speckit-*) must NOT be interpreted as artgraph residue. Detecting
        // it would trigger a "safe to delete" nudge that would destroy
        // unrelated tooling.
        let legacyResidueExists = false;
        if (descriptor.id === "copilot") {
          const legacyDir = resolve(rootAbs, ".github", "skills");
          try {
            if (lstatSync(legacyDir).isDirectory()) {
              const entries = readdirSync(legacyDir);
              legacyResidueExists = entries.some((e) => canonicalTopLevels.has(e));
            }
          } catch {
            legacyResidueExists = false;
          }
        }
        if (wrapperExists || legacyResidueExists) {
          detectedDescriptors.push(descriptor);
        }
        continue;
      }
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

  if (detectedDescriptors.length === 0 && absentDescriptors.length === 0) {
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
  // single `distribution-absent` finding, no per-file scanning. Note:
  // `absentDescriptors` only ever contains descriptors with a non-null
  // `skillsPath` — the null-skillsPath branch above never pushes here.
  for (const d of absentDescriptors) {
    const skillsPath = d.skillsPath as string;
    findings.push({
      severity: "fail",
      agent: d.id,
      kind: "distribution-absent",
      path: skillsPath,
      expected: "distribution present",
      actual: "no distribution directory",
      message: `${d.displayName} distribution is not installed under ${skillsPath}/. Run \`artgraph init --agents=${d.id}\` to install it.`,
    });
  }

  // Step 3 — per-agent Skills + extraneous-file diagnostics. Descriptors
  // with `skillsPath === null` (Copilot, issue #130) skip these entirely
  // — they carry no on-disk Skills tree, so a per-file scan would be
  // vacuous. In their place, step 3b flags any legacy residue.
  for (const descriptor of detectedDescriptors) {
    if (descriptor.skillsPath === null) continue;
    addSkillFindings(rootAbs, descriptor, source, findings);
    addExtraneousFindings(rootAbs, descriptor, source, findings);
  }

  // Step 3b — legacy `.github/skills/` residue (issue #130). Previously
  // artgraph distributed Copilot Skills to `.github/skills/`; that path is
  // no longer official (Copilot doesn't discover it) and current init
  // skips it. A leftover dir is safe to keep but misleading, so surface
  // it as a fail-severity finding pointing the user at manual cleanup.
  for (const descriptor of detectedDescriptors) {
    if (descriptor.id !== "copilot") continue;
    addLegacyCopilotSkillsFindings(rootAbs, source, findings);
  }

  // Step 4 — AGENTS.md (single shared resource; `agent: null`).
  addAgentsMdFindings(rootAbs, findings);

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

function addSkillFindings(
  rootAbs: string,
  descriptor: AgentDescriptor,
  source: SkillSource,
  out: DoctorFinding[],
): void {
  // Call sites gate on `descriptor.skillsPath !== null`; narrow it once here
  // so the loop body can pass it to `resolve()` without repeated casts.
  const skillsPath = descriptor.skillsPath as string;
  for (const entry of source.entries) {
    for (const file of entry.files) {
      const distAbs = resolve(rootAbs, skillsPath, file.relPath);
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
  // Call sites gate on `descriptor.skillsPath !== null`; narrow it once here.
  const skillsPath = descriptor.skillsPath as string;
  const distRoot = resolve(rootAbs, skillsPath);
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

/**
 * issue #130 — surface a leftover `.github/skills/` dir as a fail-severity
 * `legacy-copilot-skills-path` finding when Copilot is in scope. Copilot's
 * `descriptor.skillsPath` is now `null` (the path is not an official
 * Copilot discovery location), so init no longer touches `.github/skills/`.
 * A residual dir from an earlier artgraph version is safe to keep but
 * misleading — the file is not read by Copilot. This finding points the
 * user at manual cleanup without artgraph auto-deleting anything (per the
 * issue #130 user decision: warn only).
 */
function addLegacyCopilotSkillsFindings(
  rootAbs: string,
  source: SkillSource,
  out: DoctorFinding[],
): void {
  const legacyDir = resolve(rootAbs, ".github", "skills");
  let isDir = false;
  try {
    isDir = lstatSync(legacyDir).isDirectory();
  } catch {
    return;
  }
  if (!isDir) return;

  // B2 (issue #130 follow-up review): only flag as legacy artgraph residue
  // when the directory contains at least one canonical top-level (artgraph-*
  // or _shared). This mirrors the D5 guard in `addExtraneousFindings` and
  // prevents a "safe to delete" nudge when `.github/skills/` holds only
  // third-party tool Skills (e.g. speckit-*).
  const canonicalTopLevels = new Set<string>(source.entries.map((e) => e.topLevel));
  let hasCanonical = false;
  try {
    const entries = readdirSync(legacyDir);
    hasCanonical = entries.some((e) => canonicalTopLevels.has(e));
  } catch {
    return;
  }
  if (!hasCanonical) return;

  out.push({
    severity: "fail",
    agent: "copilot",
    kind: "legacy-copilot-skills-path",
    path: ".github/skills",
    expected: "not present",
    actual: "present",
    message: `.github/skills/ is a legacy artgraph distribution path that GitHub Copilot does not discover. Copilot now reads instructions from .github/copilot-instructions.md + AGENTS.md only. Remove .github/skills/ manually when convenient (safe to delete).`,
  });
}

function addAgentsMdFindings(rootAbs: string, out: DoctorFinding[]): void {
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

    // issue #130 — Copilot has `skillsPath: null` (no on-disk Skills tree).
    // Emit `(wrapper-only)` instead of the raw `null` so the header stays
    // meaningful for text output consumers.
    const pathLabel =
      descriptor.skillsPath === null ? "(wrapper-only)" : `${descriptor.skillsPath}/`;
    lines.push(`[${agentId}] ${pathLabel}`);
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

  // AGENTS.md section — single shared finding (or its FAIL variants).
  const sharedFindings = report.findings.filter((f) => f.agent === null);
  for (const f of sharedFindings) {
    if (f.severity === "pass") {
      lines.push(`AGENTS.md: ✓ marker block intact`);
    } else {
      lines.push(`AGENTS.md: ✗ ${f.kind} — ${f.message}`);
    }
  }
  if (sharedFindings.length > 0) lines.push("");

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
