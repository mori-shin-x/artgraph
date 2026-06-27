import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const yml = readFileSync(
  join(root, "templates/integrate/speckit/extension.yml"),
  "utf8",
);
const match = yml.match(/^\s*version:\s*["']?([\d.]+)/m);
if (!match) {
  console.error("Could not find extension.version in extension.yml");
  process.exit(1);
}
if (match[1] !== pkg.version) {
  console.error(
    `Version drift: package.json=${pkg.version} extension.yml=${match[1]}`,
  );
  console.error(
    `Update templates/integrate/speckit/extension.yml#version to match.`,
  );
  process.exit(1);
}
console.log(`Version sync OK: ${pkg.version}`);
