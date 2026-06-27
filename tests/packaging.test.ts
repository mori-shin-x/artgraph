import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const TEMPLATES_DIR = join(REPO_ROOT, "templates", "skills");
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

function getPackedFiles(): string[] {
  const raw = execSync("npm pack --dry-run --json", {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return JSON.parse(raw)[0].files.map((f: { path: string }) => f.path);
}

describe("npm packaging", () => {
  it.skipIf(!existsSync(TEMPLATES_DIR))(
    "ships every templates/skills/** file in the tarball",
    () => {
      const expected = listAllTemplateFiles();
      expect(expected.length).toBeGreaterThan(0);

      const packed = getPackedFiles();

      for (const file of expected) {
        expect(packed, `expected ${file} in tarball`).toContain(file);
      }
    },
  );

  it.skipIf(!existsSync(CLI_ENTRY))("ships dist/cli.js (entry point)", () => {
    const packed = getPackedFiles();
    expect(packed).toContain("dist/cli.js");
  });
});
