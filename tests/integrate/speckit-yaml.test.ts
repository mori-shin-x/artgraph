import { describe, expect, it } from "vitest";
import {
  addHookEntry,
  addInstalled,
  parseExtensionsYaml,
  removeAllArtgraphHooks,
  removeHookEntry,
  removeInstalled,
  serializeExtensionsYaml,
} from "../../src/integrate/speckit-yaml.js";
import type { HookEntry } from "../../src/types.js";

const SAMPLE_WITH_OTHER = `# top comment
installed:
- agent-context
settings:
  auto_execute_hooks: true
hooks:
  after_specify:
  - extension: agent-context
    command: speckit.agent-context.update
    enabled: true
    optional: true
    priority: 10
    prompt: Execute speckit.agent-context.update?
    description: Refresh agent context after specification
    condition: null
`;

const SAMPLE_EMPTY_HOOKS = `installed:
- agent-context
settings:
  auto_execute_hooks: true
hooks: {}
`;

function specEntry(overrides: Partial<HookEntry> = {}): HookEntry {
  return {
    extension: "artgraph",
    command: "artgraph.scan-reconcile",
    enabled: true,
    optional: false,
    priority: 50,
    prompt: "Run artgraph scan && reconcile to refresh trace baseline?",
    description: "Refresh artgraph baseline after tasks",
    condition: null,
    ...overrides,
  };
}

describe("parseExtensionsYaml / serializeExtensionsYaml", () => {
  it("preserves top-level comments through a round-trip", () => {
    const doc = parseExtensionsYaml(SAMPLE_WITH_OTHER);
    const out = serializeExtensionsYaml(doc);
    expect(out).toContain("# top comment");
  });

  it("preserves key order through a round-trip (installed → settings → hooks)", () => {
    const doc = parseExtensionsYaml(SAMPLE_WITH_OTHER);
    const out = serializeExtensionsYaml(doc);
    const installedIdx = out.indexOf("installed:");
    const settingsIdx = out.indexOf("settings:");
    const hooksIdx = out.indexOf("hooks:");
    expect(installedIdx).toBeGreaterThanOrEqual(0);
    expect(settingsIdx).toBeGreaterThan(installedIdx);
    expect(hooksIdx).toBeGreaterThan(settingsIdx);
  });

  it("ends with exactly one trailing newline", () => {
    const doc = parseExtensionsYaml(SAMPLE_WITH_OTHER);
    const out = serializeExtensionsYaml(doc);
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
  });
});

describe("addInstalled", () => {
  it("appends artgraph to the installed list", () => {
    const doc = parseExtensionsYaml(SAMPLE_WITH_OTHER);
    const changed = addInstalled(doc, "artgraph");
    expect(changed).toBe(true);
    const out = serializeExtensionsYaml(doc);
    expect(out).toMatch(/installed:\s*\n- agent-context\n- artgraph/);
  });

  it("is idempotent (second call is no-op)", () => {
    const doc = parseExtensionsYaml(SAMPLE_WITH_OTHER);
    addInstalled(doc, "artgraph");
    const before = serializeExtensionsYaml(doc);
    const changed = addInstalled(doc, "artgraph");
    const after = serializeExtensionsYaml(doc);
    expect(changed).toBe(false);
    expect(after).toBe(before);
  });
});

describe("removeInstalled", () => {
  it("removes artgraph from the installed list", () => {
    const doc = parseExtensionsYaml(SAMPLE_WITH_OTHER);
    addInstalled(doc, "artgraph");
    const changed = removeInstalled(doc, "artgraph");
    expect(changed).toBe(true);
    const out = serializeExtensionsYaml(doc);
    expect(out).not.toMatch(/^- artgraph/m);
  });

  it("is no-op when artgraph is absent", () => {
    const doc = parseExtensionsYaml(SAMPLE_WITH_OTHER);
    const changed = removeInstalled(doc, "artgraph");
    expect(changed).toBe(false);
  });
});

describe("addHookEntry", () => {
  it("adds a new artgraph entry under hooks.after_tasks (creating the array)", () => {
    const doc = parseExtensionsYaml(SAMPLE_WITH_OTHER);
    const changed = addHookEntry(doc, "after_tasks", specEntry());
    expect(changed).toBe(true);
    const out = serializeExtensionsYaml(doc);
    expect(out).toMatch(/after_tasks:/);
    expect(out).toMatch(/command: artgraph\.scan-reconcile/);
  });

  it("creates the hooks map when it does not exist", () => {
    const doc = parseExtensionsYaml(SAMPLE_EMPTY_HOOKS);
    const changed = addHookEntry(doc, "after_tasks", specEntry());
    expect(changed).toBe(true);
    const out = serializeExtensionsYaml(doc);
    expect(out).toMatch(/after_tasks:/);
  });

  it("emits block style (not inline flow) even when the source had `hooks: {}`", () => {
    // Regression guard for M-H1: the yaml lib inherits flow-style from the
    // parent `hooks: {}` node and serializes the new entry as
    // `hooks: { after_tasks: [ {...} ] }` on one line unless we force
    // `.flow = false` on every newly created child node.
    const doc = parseExtensionsYaml(SAMPLE_EMPTY_HOOKS);
    addHookEntry(doc, "after_tasks", specEntry());
    const out = serializeExtensionsYaml(doc);
    // No flow-style hooks block (would start with `hooks: {` or `hooks:{`).
    expect(out).not.toMatch(/hooks:\s*\{/);
    // Trigger sequence is a block list, not inline `[ ... ]`.
    expect(out).not.toMatch(/after_tasks:\s*\[/);
    // Each entry key appears on its own line — the canonical Spec Kit shape.
    expect(out).toMatch(/hooks:\n {2}after_tasks:\n {2}- extension: artgraph\n/);
  });

  it("preserves other extensions' entries when adding under the same trigger", () => {
    const doc = parseExtensionsYaml(SAMPLE_WITH_OTHER);
    // Existing entry is under after_specify, but we add another extension's
    // entry under after_specify to verify both survive.
    addHookEntry(doc, "after_specify", specEntry({ command: "artgraph.check-diff" }));
    const out = serializeExtensionsYaml(doc);
    expect(out).toMatch(/command: speckit\.agent-context\.update/);
    expect(out).toMatch(/command: artgraph\.check-diff/);
  });

  it("is idempotent when the same-content entry already exists", () => {
    const doc = parseExtensionsYaml(SAMPLE_WITH_OTHER);
    addHookEntry(doc, "after_tasks", specEntry());
    const before = serializeExtensionsYaml(doc);
    const changed = addHookEntry(doc, "after_tasks", specEntry());
    const after = serializeExtensionsYaml(doc);
    expect(changed).toBe(false);
    expect(after).toBe(before);
  });

  it("replaces an existing artgraph entry with different content", () => {
    // Use SAMPLE_EMPTY_HOOKS so there are no other priority: 10 entries in
    // the file (the WITH_OTHER fixture has agent-context with priority 10).
    const doc = parseExtensionsYaml(SAMPLE_EMPTY_HOOKS);
    addHookEntry(doc, "after_tasks", specEntry({ priority: 10 }));
    const changed = addHookEntry(doc, "after_tasks", specEntry({ priority: 99 }));
    expect(changed).toBe(true);
    const out = serializeExtensionsYaml(doc);
    expect(out).toMatch(/priority: 99/);
    expect(out).not.toMatch(/priority: 10/);
  });
});

describe("removeHookEntry", () => {
  it("removes only the artgraph entry, leaving other extensions' entries intact", () => {
    const doc = parseExtensionsYaml(SAMPLE_WITH_OTHER);
    // Put both an agent-context entry and a artgraph entry under after_tasks
    addHookEntry(doc, "after_tasks", {
      extension: "agent-context",
      command: "speckit.agent-context.update",
      enabled: true,
      optional: true,
      priority: 10,
      prompt: "Execute speckit.agent-context.update?",
      description: "Refresh agent context",
      condition: null,
    });
    addHookEntry(doc, "after_tasks", specEntry());
    const changed = removeHookEntry(doc, "after_tasks", "artgraph");
    expect(changed).toBe(true);
    const out = serializeExtensionsYaml(doc);
    expect(out).not.toMatch(/extension: artgraph[\s\S]*command: artgraph\.scan-reconcile/);
    expect(out).toMatch(/extension: agent-context[\s\S]*command: speckit\.agent-context\.update/);
  });

  it("is no-op when no artgraph entry exists", () => {
    const doc = parseExtensionsYaml(SAMPLE_WITH_OTHER);
    const changed = removeHookEntry(doc, "after_tasks", "artgraph");
    expect(changed).toBe(false);
  });
});

describe("removeAllArtgraphHooks", () => {
  it("removes artgraph entries across all hook triggers", () => {
    const doc = parseExtensionsYaml(SAMPLE_EMPTY_HOOKS);
    addHookEntry(doc, "after_tasks", specEntry({ command: "artgraph.scan-reconcile" }));
    addHookEntry(doc, "after_implement", specEntry({ command: "artgraph.check-diff" }));
    addHookEntry(doc, "before_implement", specEntry({ command: "artgraph.check-gate" }));
    const removed = removeAllArtgraphHooks(doc);
    // M-M11: exact-3 + the specific trigger names. The previous
    // `>=3` assertion would have masked a bug where the function returned
    // unrelated trigger names (e.g. duplicates) on top of the three artgraph
    // ones.
    expect(removed).toHaveLength(3);
    expect(removed.slice().sort()).toEqual(["after_implement", "after_tasks", "before_implement"]);
    const out = serializeExtensionsYaml(doc);
    expect(out).not.toMatch(/extension: artgraph/);
  });

  it("returns an empty list when nothing to remove", () => {
    const doc = parseExtensionsYaml(SAMPLE_WITH_OTHER);
    const removed = removeAllArtgraphHooks(doc);
    expect(removed).toEqual([]);
  });
});
