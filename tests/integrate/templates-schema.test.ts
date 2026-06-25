/**
 * M-H3 / M-M10 regression guard.
 *
 * `validateExtensionYaml` exists in `src/integrate/schemas/speckit-1.0.ts`
 * but until now nothing in production ever called it on the bundled
 * `templates/integrate/speckit/extension.yml`. If a future PR breaks the
 * manifest (e.g. mistypes a hook command), the runtime CLI would still
 * happily install it. This file pins the bundled template to the frozen
 * v1.0 schema so CI fails the moment the two diverge.
 */
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { loadTemplate } from "../../src/integrate/templates.js";
import {
  validateExtensionYaml,
  type SpecKitExtensionManifest,
} from "../../src/integrate/schemas/speckit-1.0.js";

/** Pull `description:` out of a `--- ... ---` frontmatter block. */
function parseFrontmatterDescription(md: string): string | null {
  const match = md.match(/^---\s*\n([\s\S]+?)\n---/);
  if (!match) return null;
  const desc = match[1]!.match(/^description:\s*(?:"([^"]+)"|'([^']+)'|(.+))$/m);
  if (!desc) return null;
  return (desc[1] ?? desc[2] ?? desc[3] ?? "").trim();
}

describe("bundled speckit/extension.yml — schema conformance", () => {
  it("validates against the frozen v1.0 schema (validateExtensionYaml)", () => {
    const raw = loadTemplate("speckit/extension.yml");
    const parsed = parseYaml(raw) as SpecKitExtensionManifest;
    // Throws on mismatch — green = template passes the same gate that runtime
    // installs would use.
    expect(() => validateExtensionYaml(parsed)).not.toThrow();
  });

  it("each command file's frontmatter `description` matches provides.commands[].description", () => {
    const raw = loadTemplate("speckit/extension.yml");
    const parsed = parseYaml(raw) as SpecKitExtensionManifest;
    for (const cmd of parsed.provides.commands) {
      const md = loadTemplate(`speckit/${cmd.file}`);
      const fmDesc = parseFrontmatterDescription(md);
      expect(fmDesc, `frontmatter description must exist in speckit/${cmd.file}`).not.toBeNull();
      expect(
        fmDesc,
        `frontmatter description in speckit/${cmd.file} must match the manifest's provides.commands entry`,
      ).toBe(cmd.description);
    }
  });
});
