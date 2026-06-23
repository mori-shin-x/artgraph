import { describe, expect, it } from "vitest";
import {
  MissingTemplateVarError,
  loadTemplate,
  renderTemplate,
} from "../../src/integrate/templates.js";

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

  it("substitutes the same key multiple times", () => {
    expect(renderTemplate("{{x}} and {{x}}", { x: "a" })).toBe("a and a");
  });

  it("returns content unchanged when there are no placeholders", () => {
    expect(renderTemplate("plain text", {})).toBe("plain text");
  });
});

describe("loadTemplate", () => {
  it("throws when the template path does not exist", () => {
    expect(() => loadTemplate("nonexistent/missing.md")).toThrow();
  });
});
