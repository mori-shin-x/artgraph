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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  AGENT_DESCRIPTORS,
  type AgentDescriptor,
  type AgentId,
  findDescriptor,
} from "./agents/descriptors.js";
import { inspectMarkerBlock } from "./agents/agent-context.js";
import { readSkillSource, type SkillSource } from "./agents/source.js";

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
  | "extraneous-file";

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

  // Step 1 — detect agents.
  //   - explicit `opts.agents`: trust the caller; the CLI parser has already
  //     enforced lowercase + Tier 1 membership.
  //   - default: every descriptor whose `<rootDir>/<skillsPath>` directory
  //     exists on disk. Zero detected → return an empty report.
  const detectedDescriptors: AgentDescriptor[] = [];
  if (opts.agents && opts.agents.length > 0) {
    for (const id of opts.agents) {
      const d = findDescriptor(id);
      if (d) detectedDescriptors.push(d);
    }
  } else {
    for (const descriptor of AGENT_DESCRIPTORS) {
      const dist = resolve(rootAbs, descriptor.skillsPath);
      if (existsSync(dist) && statSync(dist).isDirectory()) {
        detectedDescriptors.push(descriptor);
      }
    }
  }

  if (detectedDescriptors.length === 0) {
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

  // Step 2 — load canonical Skills source (sha256-stamped). `readSkillSource`
  // throws `SkillsInstallError` on packaging faults; let it bubble — the CLI
  // surfaces the message as an `Error:` line and exits 1.
  const source: SkillSource = readSkillSource(SKILLS_TEMPLATE_DIR);

  const findings: DoctorFinding[] = [];

  // Step 3 — per-agent Skills + extraneous-file diagnostics.
  for (const descriptor of detectedDescriptors) {
    addSkillFindings(rootAbs, descriptor, source, findings);
    addExtraneousFindings(rootAbs, descriptor, source, findings);
  }

  // Step 4 — AGENTS.md (single shared resource; `agent: null`).
  addAgentsMdFindings(rootAbs, findings);

  // Step 5 — wrappers (claude / copilot only).
  for (const descriptor of detectedDescriptors) {
    if (descriptor.wrapperFile !== null) {
      addWrapperFindings(rootAbs, descriptor, findings);
    }
  }

  // Compose summary. `agents` is alpha-sorted unique by descriptor id.
  const passCount = findings.filter((f) => f.severity === "pass").length;
  const failCount = findings.length - passCount;
  const agents = [...new Set(detectedDescriptors.map((d) => d.id))].sort();

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
  for (const entry of source.entries) {
    for (const file of entry.files) {
      const distAbs = resolve(rootAbs, descriptor.skillsPath, file.relPath);
      const relPath = toRepoRel(rootAbs, distAbs);
      if (!existsSync(distAbs)) {
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
      const actualSha = hashFile(distAbs);
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
  if (!existsSync(distRoot)) return;

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
  const canonicalTopLevels = new Set<string>(
    source.entries.map((e) => e.topLevel),
  );
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
    if (!canonicalTopLevels.has(topLevel)) continue;
    const subRoot = resolve(distRoot, topLevel);
    let stat;
    try {
      stat = statSync(subRoot);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const onDisk: string[] = [];
    walk(subRoot, subRoot, onDisk);
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

function addAgentsMdFindings(rootAbs: string, out: DoctorFinding[]): void {
  const absPath = resolve(rootAbs, "AGENTS.md");
  if (!existsSync(absPath)) {
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
  const content = readFileSync(absPath, "utf-8");
  const health = inspectMarkerBlock(content);
  if (!health.hasMatchedPair) {
    out.push({
      severity: "fail",
      agent: null,
      kind: "agents-md-marker-broken",
      path: "AGENTS.md",
      expected: "single matched pair",
      actual: brokenMarkerDescription(health),
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
  if (!existsSync(absPath)) {
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
  const content = readFileSync(absPath, "utf-8");
  const health = inspectMarkerBlock(content);
  // For the wrapper, we want the @AGENTS.md literal to be inside the
  // artgraph-managed block. If the block is broken, we still report
  // `wrapper-no-import` (rather than two cascading fails) so the doctor
  // surfaces a single actionable line per wrapper.
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
    lines.push(
      "No Tier 1 distribution detected. Run `artgraph init --agents=<list>` to set up.",
    );
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
          lines.push(`       expected: ${f.expected.slice(0, 12)}…  actual: ${f.actual.slice(0, 12)}…`);
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
  const buf = readFileSync(abs);
  return createHash("sha256").update(buf).digest("hex");
}

function walk(_root: string, current: string, out: string[]): void {
  for (const entry of readdirSync(current)) {
    const full = current + sep + entry;
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walk(_root, full, out);
    } else if (stat.isFile()) {
      out.push(full);
    }
  }
}

function toPosix(p: string): string {
  return p.split(/\\|\//).join("/");
}

function toRepoRel(rootAbs: string, abs: string): string {
  const stripped = abs.startsWith(rootAbs + sep) || abs.startsWith(rootAbs + "/")
    ? abs.slice(rootAbs.length + 1)
    : abs;
  return toPosix(stripped);
}

function brokenMarkerDescription(h: ReturnType<typeof inspectMarkerBlock>): string {
  if (!h.hasBegin && !h.hasEnd) return "no markers found";
  if (h.hasBegin && !h.hasEnd) return "begin marker without end";
  if (!h.hasBegin && h.hasEnd) return "end marker without begin";
  return "markers present but unpaired";
}
