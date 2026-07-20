import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
// Whole templates/ tree: skills/ + hooks/settings.json.template (#109) +
// agent-context/agents-md-snippet.md (#110). All are read at runtime by
// `artgraph init`, so a file missing from the tarball is a hard init failure.
const TEMPLATES_DIR = join(REPO_ROOT, "templates");
const CLI_ENTRY = join(REPO_ROOT, "dist", "cli.js");

function listAllTemplateFiles(): string[] {
  const out: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile()) out.push(relative(REPO_ROOT, full));
    }
  }
  walk(TEMPLATES_DIR);
  return out;
}

// `npm pack --dry-run --json`'s top-level shape changed between major npm
// versions: npm <=11 prints an array (`[{ id, files, ... }]`), npm >=12
// prints an object keyed by package name (`{ "artgraph": { id, files, ... } }`,
// presumably to disambiguate multi-workspace packs). `publish.yml` runs
// `npm install -g npm@latest` right before `prepublishOnly` (Trusted
// Publishing's OIDC exchange needs npm >=11.5.1), so this suite is the
// FIRST place in CI that ever exercises a non-bundled npm version — every
// other job keeps whatever npm ships with the pinned Node version. Handle
// both shapes rather than pinning to whichever one happens to be current.
function getPackedFiles(): string[] {
  const raw = execSync("npm pack --dry-run --json", {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const parsed: unknown = JSON.parse(raw);
  const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed as object)[0];
  return (entry as { files: { path: string }[] }).files.map((f) => f.path);
}

describe("npm packaging", () => {
  it.skipIf(!existsSync(TEMPLATES_DIR))("ships every templates/** file in the tarball", () => {
    const expected = listAllTemplateFiles();
    expect(expected.length).toBeGreaterThan(0);
    // Runtime-critical templates that must never silently drop out of the
    // walk (e.g. via a stray .npmignore or a directory rename).
    expect(expected).toContain("templates/agent-context/agents-md-snippet.md");
    expect(expected).toContain("templates/hooks/claude/settings.json.template");
    // License compliance: the vendored cytoscape bundle must never ship
    // without its MIT notice (copied by scripts/copy-vendor.mjs).
    expect(expected).toContain("templates/graph/vendor/cytoscape.LICENSE");

    const packed = getPackedFiles();

    for (const file of expected) {
      expect(packed, `expected ${file} in tarball`).toContain(file);
    }
  });

  it.skipIf(!existsSync(CLI_ENTRY))("ships dist/cli.js (entry point)", () => {
    const packed = getPackedFiles();
    expect(packed).toContain("dist/cli.js");
  });
});
