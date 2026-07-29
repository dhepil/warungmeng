// Shared helpers for the plan checkers. Pure Node, no dependencies.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Load and parse plan/plan.json. */
export function loadPlan() {
  const raw = readFileSync(join(repoRoot, "plan", "plan.json"), "utf8");
  return JSON.parse(raw);
}

/** Convert a glob (supporting ** , * and literal segments) to a RegExp anchored full-match. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // ** matches any number of path segments (including none)
        re += "[^]*";
        i += 1;
        // swallow a following slash so "a/**/b" also matches "a/b"
        if (glob[i + 1] === "/") i += 1;
      } else {
        // * matches within a single segment
        re += "[^/]*";
      }
    } else if (".+^${}()|[]\\".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** True if path matches any glob in the list. */
export function matchesAny(path, globs) {
  return globs.some((g) => globToRegExp(g).test(path));
}

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".claude",
]);

/**
 * List every tracked-style source file under the repo (relative, forward-slash),
 * skipping ignored directories. Includes .ts/.tsx/.js/.jsx/.mjs/.cjs/.php/.css.
 */
export function listSourceFiles(root = repoRoot) {
  const exts = /\.(?:tsx?|jsx?|mjs|cjs|php|css)$/;
  const out = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name));
      } else if (exts.test(entry.name)) {
        out.push(relative(root, join(dir, entry.name)).replaceAll("\\", "/"));
      }
    }
  }
  walk(root);
  return out;
}

// ANSI colors (kept minimal; degrade gracefully if not a TTY).
const useColor = process.stdout.isTTY;
export const green = (s) => (useColor ? `\x1b[32m${s}\x1b[0m` : s);
export const red = (s) => (useColor ? `\x1b[31m${s}\x1b[0m` : s);
export const bold = (s) => (useColor ? `\x1b[1m${s}\x1b[0m` : s);
