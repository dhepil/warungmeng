// packages/admin-engine/src/discoverAdminLogic.ts
//
// How the Admin runtime finds its own parents and children (LOGIC §7).
//
// There is no central list of areas here. The two glob patterns below ARE the
// registry: dropping a new `*Engine.ts` or `*Child.ts` into `engines/` makes it
// discoverable on the next build, and deleting one removes its capability without
// editing anything (LOGIC §7 rules 1-3). A hardcoded list would work today and
// then quietly disagree with the folder tree the first time someone forgot it.
//
// Validation is NOT re-implemented here. Whether an unknown thing is a valid
// parent or child is the module system's question, and it already answers it
// (`discoverDefinitions`). This file's whole job is the part the module system
// cannot do: point at the right folders, and refuse anything that is not Admin's.

import type { Diagnostic, DiscoveryCandidate } from "@warungmeng/module-system";
import {
  candidatesFromModules,
  discoverDefinitions,
  severityForCode,
} from "@warungmeng/module-system";
import type { AdminLogicDefinitions } from "./adminEngineContracts";
import { ADMIN_NAMESPACE } from "./adminEngineContracts";

/**
 * `import.meta.glob` is a bundler feature, not a TypeScript one, so `tsc` does not
 * know it exists. This narrow augmentation declares exactly the one overload used
 * below and nothing more.
 *
 * It has to be an augmentation rather than a cast at the call site, and the call
 * has to be written out literally: the bundler replaces the expression
 * `import.meta.glob(...)` during transformation by matching it as text. Assign it
 * to a variable first and it type-checks fine, then throws at runtime — verified,
 * not assumed. Both spellings below are therefore literal on purpose.
 */
declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { readonly eager: true },
    ): Readonly<Record<string, unknown>>;
  }
}

/**
 * The two patterns from LOGIC §7, verbatim.
 *
 * Both are scoped to this package's own `engines/` folder, which is what makes
 * rule 9 — "Admin discovery never scans Storefront" — structurally true rather
 * than merely intended: a relative glob cannot reach into another package.
 */
function discoverParentModules(): Readonly<Record<string, unknown>> {
  return import.meta.glob("./engines/*/*Engine.ts", { eager: true });
}

function discoverChildModules(): Readonly<Record<string, unknown>> {
  return import.meta.glob("./engines/*/children/**/*Child.ts", { eager: true });
}

/** `admin.orders` and `admin.orders.order-cancellation` pass; `storefront.cart` does not. */
function isAdminId(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(`${ADMIN_NAMESPACE}.`);
}

/**
 * Reads the id a candidate claims, before it is known to be a valid definition.
 * Anything without a readable id is left alone — deciding it is malformed is the
 * module system's job, and duplicating that judgement here would mean two files
 * could disagree about what counts as valid.
 */
function claimedId(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const id = (value as { readonly id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

function foreignRuntime(source: string, id: string): Diagnostic {
  return {
    code: "definition-malformed",
    severity: severityForCode("definition-malformed"),
    message:
      `Definition "${id}" is not part of the Admin runtime and was ignored. ` +
      `Admin only loads ids under "${ADMIN_NAMESPACE}.".`,
    source,
  };
}

/**
 * Drops candidates belonging to another runtime, reporting each one.
 *
 * This should be unreachable — the globs are relative, so a Storefront file has
 * no way into this list. It is kept because the cost is one string comparison and
 * the failure it prevents is the worst kind: Admin silently running another
 * runtime's logic, with both runtimes appearing to work. A rejection is reported
 * rather than skipped quietly, because a file that exists and does nothing is
 * indistinguishable from a bug otherwise.
 */
function rejectForeignCandidates(candidates: readonly DiscoveryCandidate[]): {
  readonly kept: readonly DiscoveryCandidate[];
  readonly diagnostics: readonly Diagnostic[];
} {
  const kept: DiscoveryCandidate[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const candidate of candidates) {
    const id = claimedId(candidate.value);
    if (id !== undefined && !isAdminId(id)) {
      diagnostics.push(foreignRuntime(candidate.source, id));
      continue;
    }
    kept.push(candidate);
  }

  return { kept, diagnostics };
}

/**
 * Sorts already-loaded modules into Admin definitions. Separate from the disk scan
 * so it can be exercised with explicit input — the glob only resolves against real
 * files, and a test that has to create files on disk to check a filter is testing
 * the wrong thing.
 */
export function adminDefinitionsFromModules(
  parentModules: Readonly<Record<string, unknown>>,
  childModules: Readonly<Record<string, unknown>>,
): AdminLogicDefinitions {
  const candidates = [
    ...candidatesFromModules(parentModules),
    ...candidatesFromModules(childModules),
  ];

  const { kept, diagnostics: foreign } = rejectForeignCandidates(candidates);
  const discovered = discoverDefinitions(kept);

  return {
    engines: discovered.engines,
    children: discovered.children,
    diagnostics: [...foreign, ...discovered.diagnostics],
  };
}

/**
 * Discovers the Admin parents and children present in this build.
 *
 * An empty result is legal, not an error: while areas are still being ported the
 * globs match nothing and return `{}` (verified). The runtime then starts, reports
 * every expected area as missing, and stays honest about being empty — which is
 * far more useful than refusing to start.
 */
export function discoverAdminLogic(): AdminLogicDefinitions {
  return adminDefinitionsFromModules(discoverParentModules(), discoverChildModules());
}
