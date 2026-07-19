import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const src = join(root, "node_modules/cytoscape/dist/cytoscape.min.js");
// MIT requires the copyright + permission notice to travel with redistributed
// copies, so the upstream LICENSE ships next to the bundle it covers — both in
// the npm tarball (templates/ is in `files`) and in `scan --output` exports.
const licenseSrc = join(root, "node_modules/cytoscape/LICENSE");
const destDir = join(root, "templates/graph/vendor");
const dest = join(destDir, "cytoscape.min.js");
const licenseDest = join(destDir, "cytoscape.LICENSE");

if (!existsSync(src)) {
  console.error(`copy-vendor: source missing: ${src}\nRun \`pnpm install\` to fetch cytoscape.`);
  process.exit(1);
}
if (!existsSync(licenseSrc)) {
  console.error(
    `copy-vendor: license missing: ${licenseSrc}\n` +
      "Redistributing cytoscape.min.js without its MIT notice violates the license — " +
      "check whether the cytoscape package renamed its LICENSE file.",
  );
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
copyFileSync(licenseSrc, licenseDest);

const sizeKb = Math.round(statSync(dest).size / 1024);
console.log(`copy-vendor: templates/graph/vendor/cytoscape.min.js (${sizeKb} KB)`);
console.log("copy-vendor: templates/graph/vendor/cytoscape.LICENSE");
