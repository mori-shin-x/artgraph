// Issue #123 DoD — LLM-driven bootstrap proposal -> deterministic verification.
//
// Exercises the full `artgraph-bootstrap` Skill loop against a *real* LLM:
//   1. Feed the Skill's own SKILL.md body as the system prompt.
//   2. Feed the tag-stripped `tests/fixtures/bootstrap-basic/` fixture (spec,
//      README, source, test — verbatim) as the user prompt.
//   3. Force a structured tool call (`apply_bootstrap_proposal`) instead of
//      parsing free-form diff prose. This is the "response contract" that
//      keeps the test from being fragile to prompt-format drift.
//   4. Apply the returned edits to an isolated tmp copy of the fixture (the
//      fixture itself is never mutated).
//   5. Run the *real* built CLI (`scan` then `check`) against the tmp copy —
//      this is the determinism boundary the Skill itself documents: link
//      generation may be probabilistic (LLM proposes), but link verification
//      must be reproducible without an LLM in the loop (artgraph verifies).
//      `check` (no `--gate`) must exit 0 even though REQ-002 is intentionally
//      left uncovered — see tests/fixtures/bootstrap-basic/EXPECTED.md.
//   6. Assert the resulting graph actually has shape: >=1 REQ node, >=1
//      `implements` (@impl) edge, >=1 `verifies` (test marker) edge. A clean
//      exit code alone would also be true of an empty no-op proposal.
//
// Skipped entirely when `ANTHROPIC_API_KEY` is absent (the default in CI), so
// this suite never fails an ordinary run — it is an opt-in correctness probe
// invoked deliberately by a developer holding a key, not a merge gate.
//
// No SDK dependency: the Anthropic Messages API is called with the platform
// `fetch` (global since Node 18, and this repo requires Node >=22 per
// package.json `engines`), so this suite adds zero weight to `package.json`
// for a test that mostly does not run.

import { describe, expect, it } from "vitest";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const CLI = resolve(REPO_ROOT, "dist/cli.js");
const FIXTURE_DIR = resolve(REPO_ROOT, "tests/fixtures/bootstrap-basic");
const SKILL_MD = resolve(REPO_ROOT, "templates/skills/artgraph-bootstrap/SKILL.md");

// Model lock + temperature 0 for reproducibility (see module doc). The
// assertion surface is still weak by design (exit codes + edge-kind counts),
// so minor model drift across releases does not flake this test.
const MODEL = process.env.ARTGRAPH_E2E_BOOTSTRAP_MODEL ?? "claude-opus-4-8";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// ---------------------------------------------------------------------------
// Response contract — force structured output via tool-calling so applying
// the proposal is plain file mutation, never fragile diff parsing.
// ---------------------------------------------------------------------------

const APPLY_BOOTSTRAP_TOOL = {
  name: "apply_bootstrap_proposal",
  description: "Apply a bootstrap proposal to a project",
  input_schema: {
    type: "object",
    properties: {
      reqs: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", pattern: "^REQ-\\d{3}$" },
            spec_file: {
              type: "string",
              description: "spec file to append this REQ line to, e.g. specs/auth.md",
            },
            spec_line: {
              type: "string",
              description: "the line to append, e.g. '- REQ-001: Users can sign in ...'",
            },
            impl_sites: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  file: { type: "string" },
                  insert_before_line_matching: {
                    type: "string",
                    description:
                      "regex or literal substring; the @impl comment goes on the line before",
                  },
                },
                required: ["file", "insert_before_line_matching"],
              },
            },
            test_sites: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  file: { type: "string" },
                  match_it_name: {
                    type: "string",
                    description: "the existing it() name text to prepend [REQ-NNN] to",
                  },
                },
                required: ["file", "match_it_name"],
              },
            },
          },
          required: ["id", "spec_file", "spec_line", "impl_sites", "test_sites"],
        },
      },
    },
    required: ["reqs"],
  },
} as const;

interface ImplSite {
  file: string;
  insert_before_line_matching: string;
}
interface TestSite {
  file: string;
  match_it_name: string;
}
interface ReqProposal {
  id: string;
  spec_file: string;
  spec_line: string;
  impl_sites: ImplSite[];
  test_sites: TestSite[];
}
interface BootstrapProposal {
  reqs: ReqProposal[];
}

function cliFailureMessage(r: SpawnSyncReturns<string>): string {
  return `CLI failed: exit ${r.status} signal=${r.signal ?? "none"} error=${r.error?.message ?? "none"}\nstderr:\n${r.stderr}\nstdout:\n${r.stdout}`;
}

function readFixtureFile(relPath: string): string {
  return readFileSync(join(FIXTURE_DIR, relPath), "utf-8");
}

// The system prompt is derived directly from the Skill's own body so this
// test exercises the Skill's actual documented reasoning (cold path, closure
// of spec+impl+test, "never fabricate a REQ with no real impl site") rather
// than a hand-rolled paraphrase that could drift from SKILL.md over time.
function buildSystemPrompt(): string {
  const skillBody = readFileSync(SKILL_MD, "utf-8");
  return [
    "You are driving the `artgraph-bootstrap` Skill described below end-to-end",
    "in a single pass (no interactive Bash tool available here — the project",
    "state is given to you directly in the user message). Follow its Step 2-4",
    "reasoning for the cold path (no REQ tags exist yet: propose fresh IDs",
    "starting from REQ-001) and report the resulting proposal ONLY via the",
    "`apply_bootstrap_proposal` tool call — no prose, no clarifying questions.",
    "Per Step 4: if a requirement has no real implementing file, leave its",
    "impl_sites empty rather than fabricating one.",
    "",
    "--- SKILL.md (artgraph-bootstrap) ---",
    skillBody,
  ].join("\n");
}

function buildUserPrompt(): string {
  const readme = readFixtureFile("README.md");
  const spec = readFixtureFile("specs/auth.md");
  const source = readFixtureFile("src/auth.ts");
  const testFile = readFixtureFile("tests/auth.test.ts");
  return [
    "Project tree (already gathered for you — this is the whole scope):",
    "",
    "=== README.md ===",
    readme,
    "",
    "=== specs/auth.md ===",
    spec,
    "",
    "=== src/auth.ts ===",
    source,
    "",
    "=== tests/auth.test.ts ===",
    testFile,
    "",
    "Config (.artgraph.json): specDirs=['specs'], include=['src/**/*.ts'],",
    "testPatterns=['tests/**/*.test.ts'].",
    "",
    "No REQ tags exist anywhere yet (cold path, req count = 0, zero files",
    "carry `@impl REQ-`). Draft the bootstrap proposal for this project and",
    "call apply_bootstrap_proposal with it.",
  ].join("\n");
}

async function requestBootstrapProposal(): Promise<BootstrapProposal> {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY as string,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      temperature: 0,
      system: buildSystemPrompt(),
      messages: [{ role: "user", content: buildUserPrompt() }],
      tools: [APPLY_BOOTSTRAP_TOOL],
      tool_choice: { type: "tool", name: APPLY_BOOTSTRAP_TOOL.name },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API request failed: ${res.status} ${res.statusText}\n${body}`);
  }

  const payload = (await res.json()) as {
    content: Array<{ type: string; name?: string; input?: unknown }>;
  };
  const toolUse = payload.content.find(
    (block) => block.type === "tool_use" && block.name === APPLY_BOOTSTRAP_TOOL.name,
  );
  if (!toolUse || typeof toolUse.input !== "object" || toolUse.input === null) {
    throw new Error(
      `Model did not return an apply_bootstrap_proposal tool call: ${JSON.stringify(payload)}`,
    );
  }
  return toolUse.input as BootstrapProposal;
}

// ---------------------------------------------------------------------------
// Applying the proposal — plain file mutation on the isolated tmp copy.
// ---------------------------------------------------------------------------

const COMMENT_PREFIX_BY_EXT: Record<string, string> = {
  ".ts": "//",
  ".tsx": "//",
  ".js": "//",
  ".jsx": "//",
  ".go": "//",
  ".rs": "//",
  ".java": "//",
  ".py": "#",
};

function commentPrefixFor(file: string): string {
  const ext = file.slice(file.lastIndexOf("."));
  return COMMENT_PREFIX_BY_EXT[ext] ?? "//";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findMatchingLineIndex(lines: string[], pattern: string): number {
  let re: RegExp | undefined;
  try {
    re = new RegExp(pattern);
  } catch {
    re = undefined;
  }
  return lines.findIndex((line) => (re !== undefined && re.test(line)) || line.includes(pattern));
}

function applyProposal(tmpDir: string, proposal: BootstrapProposal): void {
  for (const req of proposal.reqs) {
    // Spec entry — append the proposed line to the target spec file.
    const specPath = join(tmpDir, req.spec_file);
    const specContent = readFileSync(specPath, "utf-8");
    const withTrailingNewline = specContent.endsWith("\n") ? specContent : `${specContent}\n`;
    writeFileSync(specPath, `${withTrailingNewline}${req.spec_line}\n`, "utf-8");

    // Impl tags — one `@impl REQ-NNN` comment line inserted above each
    // matched line. REQs with no impl_sites (Step 4: no real impl site)
    // simply produce no edits here — that is the expected uncovered case.
    for (const site of req.impl_sites) {
      const implPath = join(tmpDir, site.file);
      const lines = readFileSync(implPath, "utf-8").split("\n");
      const idx = findMatchingLineIndex(lines, site.insert_before_line_matching);
      if (idx === -1) {
        throw new Error(
          `impl_site pattern not found for ${req.id} in ${site.file}: ${site.insert_before_line_matching}`,
        );
      }
      const indent = /^\s*/.exec(lines[idx] ?? "")?.[0] ?? "";
      lines.splice(idx, 0, `${indent}${commentPrefixFor(site.file)} @impl ${req.id}`);
      writeFileSync(implPath, lines.join("\n"), "utf-8");
    }

    // Test markers — prefix the matched it() name with `[REQ-NNN] `.
    for (const site of req.test_sites) {
      const testPath = join(tmpDir, site.file);
      const content = readFileSync(testPath, "utf-8");
      const nameRe = new RegExp(`(it\\((["'\`]))(${escapeRegExp(site.match_it_name)})`);
      if (!nameRe.test(content)) {
        throw new Error(
          `test_site match_it_name not found for ${req.id} in ${site.file}: ${site.match_it_name}`,
        );
      }
      const updated = content.replace(nameRe, `$1[${req.id}] $3`);
      writeFileSync(testPath, updated, "utf-8");
    }
  }
}

function runCli(cwd: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync("node", [CLI, ...args], { cwd, encoding: "utf-8", timeout: 30000 });
}

describe("artgraph-bootstrap Skill: LLM -> deterministic verification (issue #123 DoD)", () => {
  // Skip the whole suite when no key is present — this is an opt-in
  // correctness probe, never a merge gate. Ordinary CI runs must not fail.
  const shouldSkip = !process.env.ANTHROPIC_API_KEY;
  const testFn = shouldSkip ? it.skip : it;

  testFn(
    "bootstrap proposal applied to tag-stripped fixture -> artgraph check succeeds",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "artgraph-bootstrap-e2e-"));
      try {
        // 1. Isolated copy of the tag-stripped fixture — the fixture itself
        // (tests/fixtures/bootstrap-basic/) must never be mutated.
        cpSync(FIXTURE_DIR, tmp, { recursive: true });

        // 2-4. Ask the model to draft a bootstrap proposal via the forced
        // tool call, using the Skill body itself as the system prompt.
        const proposal = await requestBootstrapProposal();
        expect(Array.isArray(proposal.reqs), "proposal.reqs must be an array").toBe(true);
        expect(proposal.reqs.length).toBeGreaterThan(0);

        // 5-6. Apply the edits to the tmp copy — plain file mutation.
        applyProposal(tmp, proposal);

        // 7. `artgraph scan` must succeed against the now-tagged tree.
        const scanResult = runCli(tmp, ["scan"]);
        expect(scanResult.status, cliFailureMessage(scanResult)).toBe(0);

        // 8. `artgraph check` (no --gate) must exit 0 — uncovered / untagged
        // REQs are a warning at default gating, not a failure. This mirrors
        // examples/basic/README.md's documented `check` contract and is the
        // exact DoD for issue #123 (see EXPECTED.md).
        const checkResult = runCli(tmp, ["check"]);
        expect(checkResult.status, cliFailureMessage(checkResult)).toBe(0);

        // 9. Graph-shape assertions: the LLM run must have produced a real
        // traceability closure — at least one REQ node, one `implements`
        // (@impl) edge, and one `verifies` (test marker) edge — not just a
        // clean exit code (which an empty no-op proposal would also yield).
        const graphResult = runCli(tmp, ["graph", "--format", "json"]);
        expect(graphResult.status, cliFailureMessage(graphResult)).toBe(0);
        const graph = JSON.parse(graphResult.stdout) as {
          nodes: Array<{ kind: string }>;
          edges: Array<{ kind: string }>;
        };
        const reqNodes = graph.nodes.filter((n) => n.kind === "req");
        const implEdges = graph.edges.filter((e) => e.kind === "implements");
        const verifiesEdges = graph.edges.filter((e) => e.kind === "verifies");
        expect(reqNodes.length, `graph: ${graphResult.stdout}`).toBeGreaterThanOrEqual(1);
        expect(implEdges.length, `graph: ${graphResult.stdout}`).toBeGreaterThanOrEqual(1);
        expect(verifiesEdges.length, `graph: ${graphResult.stdout}`).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
