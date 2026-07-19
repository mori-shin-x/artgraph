// Vitest globalSetup: runs once before any test file.
// Ensures the cytoscape vendor asset exists in templates/graph/vendor/ so tests
// that exercise `--serve` / `--output` paths don't fail on cold `pnpm install &&
// pnpm test`. The regular `pnpm build` prebuild hook covers the production case;
// this covers `test:unit` / `test:e2e` invoked directly.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const VENDOR = resolve(import.meta.dirname, "../templates/graph/vendor/cytoscape.min.js");
const VENDOR_LICENSE = resolve(import.meta.dirname, "../templates/graph/vendor/cytoscape.LICENSE");

export default function setup(): void {
  // Both the bundle and its MIT notice must exist — a checkout that predates
  // the license copy has the bundle only, so check each independently.
  if (existsSync(VENDOR) && existsSync(VENDOR_LICENSE)) return;
  // `pnpm run copy-vendor` reads package.json script, safe even if pnpm was invoked
  // from a subdir. `stdio: "inherit"` surfaces the copy log & any failure.
  execFileSync("pnpm", ["run", "copy-vendor"], { stdio: "inherit" });
}
