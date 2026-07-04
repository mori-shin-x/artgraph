import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export { MissingTemplateVarError, renderTemplate } from "../template.js";

const TEMPLATES_ROOT = resolve(import.meta.dirname, "../../templates/integrate");

/**
 * Read a template file from `templates/integrate/<relPath>`.
 * Throws if the file does not exist (likely a packaging bug).
 */
export function loadTemplate(relPath: string): string {
  const abs = resolve(TEMPLATES_ROOT, relPath);
  return readFileSync(abs, "utf-8");
}
