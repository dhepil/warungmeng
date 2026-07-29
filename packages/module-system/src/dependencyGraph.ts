// packages/module-system/src/dependencyGraph.ts
//
// Duplicate, orphan, missing dependency, cycle, and order (LOGIC §5).
//
// Ported from SOURCE `registry/{validateModuleGraph,resolveModuleOrder}.ts`.
// SOURCE derived order from module-to-module `dependsOn` edges plus capability
// requirements; the target has no `dependsOn` — a child's only dependencies are the
// capabilities it requires (LOGIC §9), so edges come from `requires` → whoever
// declares that id in `provides`.
//
// Two checks are new here because the target's parent/child model needs them:
// a child whose parent engine was never registered is an ORPHAN, and two children
// declaring the same capability id is caught before either one runs.
//
// Order is deterministic: ties break on id, so the same input always yields the
// same startup sequence. Nothing here mutates or instantiates anything — this file
// answers questions about definitions only.

import type {
  CapabilityId,
  Diagnostic,
  EngineId,
  LogicChildDefinition,
  LogicChildId,
  ParentEngineDefinition,
} from "./engineContracts";

/** What the graph concluded. `order` only includes children that may safely run. */
export interface DependencyGraphResult {
  /** Startup sequence: every child appears after the children it depends on. */
  readonly order: readonly LogicChildId[];
  /** Children that must not run, mapped to why. */
  readonly excluded: readonly ExcludedChild[];
  readonly diagnostics: readonly Diagnostic[];
}

export type ExclusionReason =
  | "duplicate-child-id"
  | "orphan-child"
  | "duplicate-capability"
  | "missing-dependency"
  | "dependency-cycle";

export interface ExcludedChild {
  readonly childId: LogicChildId;
  readonly reason: ExclusionReason;
  readonly details?: readonly string[];
}

function byId(left: string, right: string): number {
  return left.localeCompare(right);
}

function diagnostic(
  code: Diagnostic["code"],
  message: string,
  childId: LogicChildId,
  engineId?: EngineId,
  details?: Diagnostic["details"],
): Diagnostic {
  return { code, severity: "error", message, childId, engineId, details };
}

/**
 * Resolves the startup order for a set of definitions, excluding any child that
 * cannot safely run. Pure: same input, same output, no side effects.
 */
export function resolveDependencyGraph(
  engines: readonly ParentEngineDefinition[],
  children: readonly LogicChildDefinition[],
): DependencyGraphResult {
  const diagnostics: Diagnostic[] = [];
  const excluded: ExcludedChild[] = [];
  const engineIds = new Set<string>(engines.map(({ id }) => id));

  function exclude(
    definition: LogicChildDefinition,
    reason: ExclusionReason,
    message: string,
    details?: readonly string[],
  ): void {
    excluded.push({ childId: definition.id, reason, details });
    diagnostics.push(
      diagnostic(reason, message, definition.id, definition.parentId, {
        ...(details && details.length > 0 ? { details: details.join(", ") } : {}),
      }),
    );
  }

  // Pass 1 — identity. A duplicate id or a missing parent disqualifies a child
  // before its capabilities are considered at all.
  const eligible = new Map<LogicChildId, LogicChildDefinition>();
  for (const definition of [...children].sort((left, right) => byId(left.id, right.id))) {
    if (eligible.has(definition.id)) {
      exclude(definition, "duplicate-child-id", "Logic child id is declared more than once.");
      continue;
    }
    if (!engineIds.has(definition.parentId)) {
      exclude(definition, "orphan-child", "Logic child has no registered parent engine.", [
        definition.parentId,
      ]);
      continue;
    }
    eligible.set(definition.id, definition);
  }

  // Pass 2 — capability ownership. Two children claiming the same id is ambiguous,
  // so BOTH are excluded rather than letting registration order decide a winner.
  const providers = new Map<CapabilityId, LogicChildId>();
  const contested = new Set<CapabilityId>();
  for (const definition of eligible.values()) {
    for (const capabilityId of definition.provides) {
      const existing = providers.get(capabilityId);
      if (existing !== undefined && existing !== definition.id) {
        contested.add(capabilityId);
        continue;
      }
      providers.set(capabilityId, definition.id);
    }
  }

  for (const capabilityId of [...contested].sort(byId)) {
    providers.delete(capabilityId);
    const claimants = [...eligible.values()].filter((definition) =>
      definition.provides.includes(capabilityId),
    );
    for (const definition of claimants) {
      eligible.delete(definition.id);
      exclude(definition, "duplicate-capability", "Capability is declared by more than one child.", [
        capabilityId,
      ]);
    }
  }

  // Pass 3 — reachability. A child whose requirement nothing provides cannot run,
  // and neither can anything that transitively depends on it. Iterates to a fixed
  // point so the exclusion propagates only along real edges (LOGIC §7 rule 6).
  let settled = false;
  while (!settled) {
    settled = true;
    for (const definition of [...eligible.values()].sort((left, right) => byId(left.id, right.id))) {
      const unmet = definition.requires.filter((id) => !providers.has(id));
      if (unmet.length === 0) {
        continue;
      }
      eligible.delete(definition.id);
      for (const capabilityId of definition.provides) {
        providers.delete(capabilityId);
      }
      exclude(
        definition,
        "missing-dependency",
        "Required capability has no provider.",
        [...unmet].sort(byId),
      );
      settled = false;
    }
  }

  // Pass 4 — topological order via depth-first search, ported from SOURCE's
  // temporary/permanent marking. A node still in `visiting` when reached again is a
  // cycle; SOURCE recorded the cycle root and continued, and so do we.
  const visiting = new Set<LogicChildId>();
  const visited = new Set<LogicChildId>();
  const cycleMembers = new Set<LogicChildId>();
  const order: LogicChildId[] = [];

  function dependenciesOf(definition: LogicChildDefinition): readonly LogicChildId[] {
    const edges = definition.requires
      .map((capabilityId) => providers.get(capabilityId))
      .filter(
        (providerId): providerId is LogicChildId =>
          providerId !== undefined && providerId !== definition.id,
      );
    return [...new Set(edges)].sort(byId);
  }

  function visit(childId: LogicChildId): void {
    if (visited.has(childId)) {
      return;
    }
    if (visiting.has(childId)) {
      cycleMembers.add(childId);
      return;
    }

    const definition = eligible.get(childId);
    if (!definition) {
      return;
    }

    visiting.add(childId);
    for (const dependencyId of dependenciesOf(definition)) {
      visit(dependencyId);
    }
    visiting.delete(childId);
    visited.add(childId);
    order.push(childId);
  }

  for (const childId of [...eligible.keys()].sort(byId)) {
    visit(childId);
  }

  // A child in a cycle can never have its requirement satisfied, so it is excluded
  // along with everything downstream of it.
  if (cycleMembers.size > 0) {
    const cyclic = new Set<LogicChildId>();
    let growing = true;
    while (growing) {
      growing = false;
      for (const childId of [...eligible.keys()].sort(byId)) {
        if (cyclic.has(childId)) {
          continue;
        }
        const definition = eligible.get(childId);
        if (!definition) {
          continue;
        }
        const touchesCycle =
          cycleMembers.has(childId) ||
          dependenciesOf(definition).some((dependencyId) => cyclic.has(dependencyId));
        if (touchesCycle) {
          cyclic.add(childId);
          growing = true;
        }
      }
    }

    for (const childId of [...cyclic].sort(byId)) {
      const definition = eligible.get(childId);
      if (definition) {
        exclude(definition, "dependency-cycle", "Capability dependency graph contains a cycle.");
      }
    }

    return {
      order: order.filter((childId) => !cyclic.has(childId)),
      excluded,
      diagnostics,
    };
  }

  return { order, excluded, diagnostics };
}
