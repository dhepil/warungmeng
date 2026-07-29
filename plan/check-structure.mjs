// Structure checker — is every file where the plan says it should be?
// Reads plan/plan.json (the single source of truth). Prints a plain green/red
// result a non-developer can read. Exit code 0 = OK, 1 = drift.
//
// Rules:
//  1. Any product source file NOT covered by an active/done phase's allow-list
//     (and not a root-allowed config file) is DRIFT ("invented / wrong place").
//  2. Any file matching plan.forbiddenPaths is DRIFT ("copied source layout").
//  3. For each DONE phase, every 'exact' file must exist ("MISSING").
//
// Pending phases are not required to have files yet, so an empty repo is green.

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  loadPlan,
  listSourceFiles,
  matchesAny,
  repoRoot,
  green,
  red,
  bold,
} from "./lib/planUtils.mjs";

const plan = loadPlan();
const files = listSourceFiles();

const activeOrDone = plan.phases.filter(
  (p) => p.status === "active" || p.status === "in_progress" || p.status === "done" || p.status === "completed",
);

// Build the union of allow-lists (exact + allow) for active/done phases.
const allowedGlobs = [];
for (const phase of activeOrDone) {
  const entry = plan.allowedFiles[phase.id];
  if (!entry) continue;
  allowedGlobs.push(...(entry.exact ?? []), ...(entry.allow ?? []));
}

const problems = [];

// Rule 2 first (most important for this port): forbidden source-layout paths.
for (const file of files) {
  if (file.startsWith("plan/")) continue; // checker's own files
  if (matchesAny(file, plan.forbiddenPaths)) {
    problems.push({
      kind: "FORBIDDEN LAYOUT",
      file,
      hint: "this is the old AntD source layout — code must be reorganized into the new-target layout, not copied here",
    });
  }
}

// Rule 1: stray files not covered by any active/done phase.
for (const file of files) {
  if (file.startsWith("plan/")) continue;
  if (matchesAny(file, plan.rootAllow)) continue;
  if (matchesAny(file, plan.forbiddenPaths)) continue; // already reported above
  if (matchesAny(file, allowedGlobs)) continue;

  // Is it inside a package/app that belongs to a pending phase? Then it's
  // premature (phase not started). Otherwise it's simply unplanned.
  const pendingPhase = plan.phases.find(
    (p) => p.status === "pending" && file.startsWith(p.package.replace("/*", "")),
  );
  problems.push({
    kind: pendingPhase ? "PHASE NOT STARTED" : "NOT IN PLAN",
    file,
    hint: pendingPhase
      ? `belongs to phase ${pendingPhase.id} which is still 'pending' — activate that phase first`
      : "no active phase allows this file — an agent likely invented it or put it in the wrong place",
  });
}

// Rule 3: missing 'exact' files for done phases.
for (const phase of activeOrDone) {
  if (phase.status !== "done" && phase.status !== "completed") continue;
  const entry = plan.allowedFiles[phase.id];
  if (!entry) continue;
  for (const exact of entry.exact ?? []) {
    if (exact.includes("*")) continue; // globs aren't "must exist"
    if (!existsSync(join(repoRoot, exact))) {
      problems.push({
        kind: "MISSING",
        file: exact,
        hint: `phase ${phase.id} is marked done but this planned file does not exist`,
      });
    }
  }
}

const activeList = activeOrDone.map((p) => p.id).join(", ") || "(none — repo is at Phase 0)";
console.log(bold("Structure check"));
console.log(`  active/done phases: ${activeList}`);
console.log(`  product files scanned: ${files.filter((f) => !f.startsWith("plan/")).length}`);

if (problems.length === 0) {
  console.log(green(`\n✓ STRUCTURE OK — every file is where the plan says.`));
  process.exit(0);
}

console.log(red(`\n✗ STRUCTURE DRIFT — ${problems.length} problem(s):\n`));
for (const p of problems) {
  console.log(red(`  [${p.kind}] ${p.file}`));
  console.log(`      ${p.hint}`);
}
console.log(
  red(`\nNothing should be committed while structure is red. Fix or move these files.`),
);
process.exit(1);
