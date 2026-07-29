// Import-boundary checker — does any file import something the plan forbids?
// Reads plan/plan.json boundaries (transcribed from new-target import contracts).
//
// Extraction is regex-based on purpose: Phase 0 must run with ZERO dependencies
// (the empty repo has no node_modules yet). Once `typescript` is installed as a
// dev dependency, this can be upgraded to the AST approach used by the source repo
// (apps/admin/src/tests/adminImportBoundary.test.ts) for full precision. Regex is
// sufficient to catch forbidden import specifiers.
//
// Includes a NEGATIVE-PROOF self-test (--self-test) so we can demonstrate the
// checker actually catches a violation, mirroring the source's proven pattern.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadPlan,
  listSourceFiles,
  matchesAny,
  globToRegExp,
  repoRoot,
  green,
  red,
  bold,
} from "./lib/planUtils.mjs";

const BROWSER_RUNTIME =
  /\b(?:localStorage|sessionStorage|window|document|fetch|XMLHttpRequest|WebSocket)\b/;

/** Extract every module specifier (string in import/export/require/dynamic-import). */
export function extractSpecifiers(source) {
  const specs = [];
  const patterns = [
    /import\s+[^'"]*?from\s*['"]([^'"]+)['"]/g, // import x from "s"
    /import\s*['"]([^'"]+)['"]/g, // import "s"
    /export\s+[^'"]*?from\s*['"]([^'"]+)['"]/g, // export ... from "s"
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // require("s")
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // import("s")
    /import\s+\w+\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // import x = require("s")
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source)) !== null) specs.push(m[1]);
  }
  return specs;
}

/** Does a specifier violate a "cannotImport" token? Substring match, plus ".css" suffix. */
function specifierHitsToken(specifier, token) {
  if (token === ".css") return specifier.endsWith(".css");
  return specifier.includes(token);
}

/** Check one file's source against the applicable boundary rules. Returns violations. */
export function violationsFor(relPath, source, boundaries) {
  const out = [];
  const applicable = boundaries.filter((b) => globToRegExp(b.from).test(relPath));
  if (applicable.length === 0) return out;

  const specs = extractSpecifiers(source);
  for (const b of applicable) {
    for (const spec of specs) {
      for (const token of b.cannotImport) {
        if (specifierHitsToken(spec, token)) {
          out.push({ file: relPath, spec, token, rule: b.source ?? b.from });
        }
      }
    }
    if (b.forbidBrowserRuntime && BROWSER_RUNTIME.test(source)) {
      out.push({
        file: relPath,
        spec: "(browser runtime API)",
        token: "window/document/fetch/localStorage/…",
        rule: b.source ?? b.from,
      });
    }
  }
  return out;
}

function runSelfTest(boundaries) {
  // A synthetic domain file that breaks the rules must be caught.
  const fake = 'import React from "react";\nimport { x } from "@warungmeng/admin-engine";\n';
  const hits = violationsFor("packages/domain/src/__selftest__.ts", fake, boundaries);
  const caughtReact = hits.some((h) => h.spec === "react");
  const caughtEngine = hits.some((h) => h.spec.includes("admin-engine"));
  console.log(bold("Boundary checker self-test (negative proof)"));
  if (caughtReact && caughtEngine) {
    console.log(green("  ✓ checker correctly flags a forbidden React + engine import"));
    process.exit(0);
  }
  console.log(red("  ✗ SELF-TEST FAILED — checker did not catch a known violation"));
  process.exit(1);
}

const plan = loadPlan();

if (process.argv.includes("--self-test")) {
  runSelfTest(plan.boundaries);
}

const files = listSourceFiles().filter(
  (f) => !f.startsWith("plan/") && /\.(?:tsx?|jsx?|mjs|cjs)$/.test(f),
);

const violations = [];
for (const file of files) {
  const source = readFileSync(join(repoRoot, file), "utf8");
  violations.push(...violationsFor(file, source, plan.boundaries));
}

console.log(bold("Import-boundary check"));
console.log(`  files scanned: ${files.length}`);

if (violations.length === 0) {
  console.log(green(`\n✓ BOUNDARIES OK — no forbidden imports.`));
  process.exit(0);
}

console.log(red(`\n✗ BOUNDARY VIOLATIONS — ${violations.length}:\n`));
for (const v of violations) {
  console.log(red(`  ${v.file}`));
  console.log(`      imports "${v.spec}"  →  forbidden (${v.token})`);
  console.log(`      rule: ${v.rule}`);
}
process.exit(1);
