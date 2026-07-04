import { describe, expect, it } from "vitest";
import { MissingTemplateVarError, renderTemplate } from "../src/template.js";

// Unit tests for the renderTemplate SSOT (src/template.ts), extracted from
// src/integrate/templates.ts per issue #109 so both `integrate` (loadTemplate
// callers) and `init` (hooks Stop-hook template) share the same substitution
// engine. tests/integrate/templates.test.ts covers the re-export shim; this
// file covers the moved implementation directly.

describe("renderTemplate", () => {
  it("substitutes a {{name}} placeholder", () => {
    expect(renderTemplate("hello {{name}}", { name: "world" })).toBe("hello world");
  });

  it("accepts surrounding whitespace inside the braces", () => {
    expect(renderTemplate("a {{ name }} b", { name: "x" })).toBe("a x b");
  });

  it("throws MissingTemplateVarError for undefined keys", () => {
    expect(() => renderTemplate("hi {{name}}", {})).toThrow(MissingTemplateVarError);
  });

  it("exposes the missing variable name on err.varName", () => {
    try {
      renderTemplate("{{ARTGRAPH_EXEC}} check --gate --diff", {});
      expect.unreachable("renderTemplate should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MissingTemplateVarError);
      expect((e as MissingTemplateVarError).varName).toBe("ARTGRAPH_EXEC");
    }
  });

  it("substitutes the same key multiple times", () => {
    expect(renderTemplate("{{x}} and {{x}}", { x: "a" })).toBe("a and a");
  });

  it("substitutes multiple distinct keys in one template", () => {
    expect(
      renderTemplate("{{a}}-{{b}}-{{a}}", { a: "1", b: "2" }),
    ).toBe("1-2-1");
  });

  it("returns content unchanged when there are no placeholders", () => {
    expect(renderTemplate("plain text", {})).toBe("plain text");
  });

  it("passes through JSON content with only non-placeholder braces untouched", () => {
    const input = '{"hooks": {"Stop": []}}';
    expect(renderTemplate(input, {})).toBe(input);
  });
});
