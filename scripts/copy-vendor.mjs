import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const src = join(root, "node_modules/cytoscape/dist/cytoscape.min.js");
const destDir = join(root, "templates/graph/vendor");
const dest = join(destDir, "cytoscape.min.js");

if (!existsSync(src)) {
  console.error(`copy-vendor: source missing: ${src}\nRun \`pnpm install\` to fetch cytoscape.`);
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);

const sizeKb = Math.round(statSync(dest).size / 1024);
console.log(`copy-vendor: templates/graph/vendor/cytoscape.min.js (${sizeKb} KB)`);
