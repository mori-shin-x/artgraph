// spec 013 T003 — Tier 1 AgentDescriptor table.
//
// The 5 entries below are the single source of truth for every cross-agent
// distribution stage: Skills (`<skillsPath>/...`, `null` = distribution
// skip) and agent-context wrappers (`CLAUDE.md` / `.github/copilot-
// instructions.md`). Any future agent-id addition lands here first;
// downstream parsers / distributors / doctor read this table verbatim.
//
// issue #130: Copilot's `skillsPath` is `null` because `.github/skills/`
// is not a Copilot-recognized discovery location — the wrapper +
// AGENTS.md carry the instruction layer for that agent instead.
//
// Contract: specs/013-cross-agent-extensions/data-model.md §1
// Paths   : specs/013-cross-agent-extensions/contracts/distribution-paths.md

export type AgentId = "claude" | "codex" | "cursor" | "copilot" | "kiro";

export type AgentContextLoad = "native-agents-md" | "wrapper-required" | "both";

export interface AgentDescriptor {
  /** CLI `--agents=<list>` identifier (lowercase, no aliases). */
  id: AgentId;
  /** Human-readable name for text output. */
  displayName: string;
  /**
   * Canonical Skills distribution path relative to the repo root, in POSIX
   * form, with no trailing slash. Example: `.claude/skills`.
   *
   * `null` when the agent does NOT receive on-disk Skills (issue #130 for
   * Copilot: `.github/skills/` is not an official Copilot discovery
   * location, so distributing there produces a false-green `doctor` result
   * — the agent-context wrapper + AGENTS.md are the only channel).
   * Callers MUST treat `skillsPath === null` as an inert Skills stage and
   * skip `distribute()` / `writeGitAttributes()` / doctor's skill-file
   * checks for that descriptor.
   */
  skillsPath: string | null;
  /**
   * Repo-root relative wrapper file (POSIX) — `null` when the agent loads
   * AGENTS.md natively without an extra wrapper. Wrappers only ever contain
   * an `@AGENTS.md` import inside the artgraph-managed marker block
   * (FR-006 / FR-007, R6 in research.md).
   */
  wrapperFile: string | null;
  /**
   * How the agent picks up the canonical agent-context (AGENTS.md):
   *   - "native-agents-md": loads AGENTS.md natively, no wrapper needed
   *   - "wrapper-required": needs a wrapper file (legacy / IDE convention)
   *   - "both":             loads AGENTS.md natively AND supports a wrapper
   */
  agentContextLoad: AgentContextLoad;
}

export const AGENT_DESCRIPTORS: readonly AgentDescriptor[] = [
  {
    id: "claude",
    displayName: "Claude Code",
    skillsPath: ".claude/skills",
    wrapperFile: "CLAUDE.md",
    agentContextLoad: "both",
  },
  {
    id: "codex",
    displayName: "Codex CLI",
    skillsPath: ".agents/skills",
    wrapperFile: null,
    agentContextLoad: "native-agents-md",
  },
  {
    id: "cursor",
    displayName: "Cursor",
    skillsPath: ".cursor/skills",
    wrapperFile: null,
    agentContextLoad: "native-agents-md",
  },
  {
    id: "copilot",
    displayName: "GitHub Copilot",
    // issue #130: Copilot's official custom-instructions surfaces are
    // `.github/copilot-instructions.md` (repo-wide) and
    // `.github/instructions/*.instructions.md` (path-scoped) only.
    // `.github/skills/` is not read by any Copilot surface — README, IDE,
    // or Coding Agent — so distributing SKILL.md files there produces a
    // false-green `artgraph doctor` while Copilot silently misses them.
    // Copilot loads AGENTS.md natively (agentContextLoad: "both"), so
    // the artgraph Skills catalogue and usage guidance still reach
    // Copilot through the `.github/copilot-instructions.md` wrapper +
    // AGENTS.md link. No on-disk Skills tree is provisioned.
    skillsPath: null,
    wrapperFile: ".github/copilot-instructions.md",
    agentContextLoad: "both",
  },
  {
    id: "kiro",
    displayName: "Kiro",
    skillsPath: ".kiro/skills",
    wrapperFile: null,
    agentContextLoad: "native-agents-md",
  },
] as const;

/**
 * Frozen, alpha-stable ordering of the 5 Tier 1 ids. Useful for error
 * messages ("Supported values: claude, codex, copilot, cursor, kiro") and
 * for test fixtures that iterate the agents.
 */
export const AGENT_IDS: readonly AgentId[] = AGENT_DESCRIPTORS.map((d) => d.id);

/**
 * Descriptors that receive an on-disk Skills distribution (`skillsPath !==
 * null`). Currently 4 of the 5 Tier 1 agents; Copilot (issue #130) is
 * excluded because `.github/skills/` is not an official Copilot discovery
 * location. Every distribute() / writeGitAttributes() / per-file doctor
 * test that iterates "every Tier 1 agent" should iterate this list
 * instead — otherwise Copilot's inert Skills stage trips assertions that
 * expect a non-empty tree.
 */
export const DISTRIBUTED_AGENT_DESCRIPTORS: readonly AgentDescriptor[] = AGENT_DESCRIPTORS.filter(
  (d) => d.skillsPath !== null,
);

/**
 * Lookup a descriptor by its raw id. Returns `undefined` when the input is
 * not one of the 5 Tier 1 values. This function does NOT normalize case —
 * `findDescriptor("Claude")` returns `undefined` so the CLI parser can emit
 * the canonical "Did you mean ...?" hint instead of silently lowercasing.
 */
export function findDescriptor(id: string): AgentDescriptor | undefined {
  return AGENT_DESCRIPTORS.find((d) => d.id === id);
}
