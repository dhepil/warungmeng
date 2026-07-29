// packages/module-system/src/discovery.ts
//
// Validasi unknown candidate (LOGIC §5).
//
// Discovery is how the runtime finds parents and children without a central
// hardcoded list (LOGIC §7 rule 1): the engine hands over whatever a glob turned
// up, and this file decides what is actually a valid definition. Everything
// arriving here is `unknown` — it may be a broken module, a half-written file, or
// not a definition at all.
//
// Ported from SOURCE `discovery/discoverModuleCandidates.ts` + the shape checks in
// `registry/validateModuleGraph.ts`. Two departures, consistent with S1:
//   - SOURCE validated UI fields (labelKey, iconId, route path, componentId); the
//     target keeps UI out of logic contracts, so those checks are gone.
//   - SOURCE checked each manifest against a surface ("is this an admin module?");
//     the generic runtime no longer knows about surfaces.
//
// This file is synchronous. SOURCE's loader was async because it awaited
// `candidate.load()`; the target discovers through eager globs (LOGIC §7), so
// candidates arrive already loaded and there is nothing to await.

import type {
  Diagnostic,
  LogicChildDefinition,
  ParentEngineDefinition,
} from "./engineContracts";
import { isNamespacedId } from "./engineContracts";

/** An unvalidated thing found by discovery, with where it came from. */
export interface DiscoveryCandidate {
  readonly source: string;
  readonly value: unknown;
}

export interface RejectedCandidate {
  readonly source: string;
  readonly diagnostics: readonly Diagnostic[];
}

export interface DiscoveryResult {
  readonly engines: readonly ParentEngineDefinition[];
  readonly children: readonly LogicChildDefinition[];
  readonly rejected: readonly RejectedCandidate[];
  readonly diagnostics: readonly Diagnostic[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIdArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isNamespacedId);
}

function malformed(source: string, message: string): Diagnostic {
  return { code: "definition-malformed", severity: "error", message, source };
}

/** A parent engine: namespaced id, supported version, non-empty namespace. */
function isParentEngine(value: unknown): value is ParentEngineDefinition {
  return (
    isRecord(value) &&
    isNamespacedId(value.id) &&
    typeof value.childNamespace === "string" &&
    value.childNamespace.length > 0 &&
    !("create" in value)
  );
}

/** A logic child: the parent link and a `create` function are what distinguish it. */
function isLogicChild(value: unknown): value is LogicChildDefinition {
  return (
    isRecord(value) &&
    isNamespacedId(value.id) &&
    isNamespacedId(value.parentId) &&
    typeof value.create === "function" &&
    isIdArray(value.provides) &&
    isIdArray(value.requires)
  );
}

/**
 * Sorts candidates into valid parents, valid children, and rejects. A rejected
 * candidate never reaches the registry — discovery is the quarantine boundary.
 */
export function discoverDefinitions(
  candidates: readonly DiscoveryCandidate[],
): DiscoveryResult {
  const engines: ParentEngineDefinition[] = [];
  const children: LogicChildDefinition[] = [];
  const rejected: RejectedCandidate[] = [];
  const diagnostics: Diagnostic[] = [];

  function reject(source: string, message: string): void {
    const issue = malformed(source, message);
    diagnostics.push(issue);
    rejected.push({ source, diagnostics: [issue] });
  }

  for (const candidate of candidates) {
    const { source, value } = candidate;

    if (value === null || value === undefined) {
      reject(source, "Discovery candidate is empty.");
      continue;
    }

    if (isLogicChild(value)) {
      if (value.version !== 1) {
        const issue: Diagnostic = {
          code: "unsupported-version",
          severity: "error",
          message: "Logic child version is not supported.",
          childId: value.id,
          engineId: value.parentId,
          source,
        };
        diagnostics.push(issue);
        rejected.push({ source, diagnostics: [issue] });
        continue;
      }
      children.push(value);
      continue;
    }

    if (isParentEngine(value)) {
      if (value.version !== 1) {
        const issue: Diagnostic = {
          code: "unsupported-version",
          severity: "error",
          message: "Parent engine version is not supported.",
          engineId: value.id,
          source,
        };
        diagnostics.push(issue);
        rejected.push({ source, diagnostics: [issue] });
        continue;
      }
      engines.push(value);
      continue;
    }

    reject(source, "Discovery candidate is neither a parent engine nor a logic child.");
  }

  return { engines, children, rejected, diagnostics };
}

/**
 * Adapts an eager glob result (`{ "./path.ts": module }`) into candidates, taking
 * each module's default or single named export. Matches the LOGIC §7 discovery
 * call shape without importing any bundler types.
 */
export function candidatesFromModules(
  modules: Readonly<Record<string, unknown>>,
): readonly DiscoveryCandidate[] {
  return Object.keys(modules)
    .sort((left, right) => left.localeCompare(right))
    .map((source) => {
      const loaded = modules[source];
      if (!isRecord(loaded)) {
        return { source, value: loaded };
      }
      if ("default" in loaded) {
        return { source, value: loaded.default };
      }
      const exported = Object.values(loaded);
      // A definition file exports exactly one definition; anything else is
      // ambiguous and left to fail validation with its own source attached.
      return { source, value: exported.length === 1 ? exported[0] : loaded };
    });
}
