// The ONE command: `npm run check`.
// Runs structure + boundaries now; adds typecheck + tests automatically once
// those tools are installed and product code exists. Prints a single summary a
// non-developer can act on: GREEN = safe to continue / commit, RED = stop.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, green, red, bold } from "./lib/planUtils.mjs";

function run(label, cmd, args) {
  const res = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  const ok = res.status === 0;
  return { label, ok };
}

const results = [];

console.log(bold("\n=== Warung Meng plan check ===\n"));

results.push(run("structure", "node", ["plan/check-structure.mjs"]));
console.log("");
results.push(run("boundaries", "node", ["plan/check-boundaries.mjs"]));

// Typecheck + tests only if tooling is present (post first `npm install`).
const hasNodeModules = existsSync(join(repoRoot, "node_modules"));
const hasTsc = existsSync(join(repoRoot, "node_modules", ".bin", "tsc"));
const hasVitest = existsSync(join(repoRoot, "node_modules", ".bin", "vitest"));

if (hasNodeModules && hasTsc) {
  console.log("");
  results.push(run("typecheck", "npm", ["run", "typecheck", "--if-present"]));
}
if (hasNodeModules && hasVitest) {
  console.log("");
  results.push(run("tests", "npx", ["vitest", "run"]));
}

console.log(bold("\n=== Summary ===\n"));
for (const r of results) {
  console.log(`  ${r.ok ? green("✓") : red("✗")} ${r.label}`);
}

const allOk = results.every((r) => r.ok);
if (allOk) {
  console.log(green(`\n✓ ALL CHECKS PASSED — safe to commit / continue.\n`));
  process.exit(0);
}
console.log(
  red(`\n✗ CHECKS FAILED — do NOT commit. Read the red lines above; each names the file and why.\n`),
);
process.exit(1);
