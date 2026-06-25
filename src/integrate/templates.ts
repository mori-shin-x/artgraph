import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Thrown by {@link renderTemplate} when the template references a variable
 * that isn't supplied. Surfaced as an error (not silently rendered "") to
 * make missing-variable bugs loud.
 */
export class MissingTemplateVarError extends Error {
  readonly varName: string;
  constructor(varName: string) {
    super(`Missing template variable: ${varName}`);
    this.name = "MissingTemplateVarError";
    this.varName = varName;
  }
}

const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;

/**
 * Substitute `{{ varName }}` placeholders in `template` with values from
 * `vars`. Whitespace inside braces is tolerated. Throws
 * {@link MissingTemplateVarError} if a referenced variable is absent.
 *
 * No loops / conditionals / nesting are supported — keep templates flat
 * (contracts/agent-guidance.md §テンプレート変数仕様).
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) {
      throw new MissingTemplateVarError(name);
    }
    return vars[name]!;
  });
}

const TEMPLATES_ROOT = resolve(import.meta.dirname, "../../templates/integrate");

/**
 * Read a template file from `templates/integrate/<relPath>`.
 * Throws if the file does not exist (likely a packaging bug).
 */
export function loadTemplate(relPath: string): string {
  const abs = resolve(TEMPLATES_ROOT, relPath);
  return readFileSync(abs, "utf-8");
}
