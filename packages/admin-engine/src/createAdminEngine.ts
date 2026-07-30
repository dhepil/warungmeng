// packages/admin-engine/src/createAdminEngine.ts
//
// The Admin composition root (LOGIC §7 activation sequence).
//
// This file owns the order of startup and nothing else. Every decision it makes is
// delegated: what is a valid definition is discovery's answer, what may safely run
// and in what order is the dependency graph's answer, and creating children is the
// registry's answer. What remains — and what genuinely belongs to Admin — is three
// things the generic runtime cannot do:
//
//   1. Merge diagnostics from all three stages. The registry deliberately does not
//      de-duplicate, because within it every report site is distinct. Across
//      stages that stops being true, so the fan-in dedupe lives here.
//   2. Republish the injected atomic port as the capability LOGIC §8 says two
//      children require.
//   3. Hand back a runtime that cannot be registered into after startup.
//
// A half-composed Admin is a degraded Admin, never a crashed one (LOGIC §7 rules
// 4-6). There is no throw anywhere in this file: a missing port, an empty
// discovery, a child that fails — each is reported and survived.

import type {
  Diagnostic,
  LogicChildDefinition,
  OutboundPortRegistry,
  ParentEngineDefinition,
} from "@warungmeng/module-system";
import {
  createDiagnosticCollector,
  createEngineRegistry,
  defineLogicChild,
  defineParentEngine,
  resolveDependencyGraph,
  severityForCode,
} from "@warungmeng/module-system";
import type {
  AdminEngineRuntime,
  AdminLogicDefinitions,
  CreateAdminEngineOptions,
} from "./adminEngineContracts";
import { projectAdminSnapshot } from "./adminEngineSnapshot";
import { discoverAdminLogic } from "./discoverAdminLogic";
import {
  ADMIN_ATOMIC_OPERATION,
  ADMIN_ATOMIC_OPERATION_ID,
  ATOMIC_OPERATION_PORT,
} from "./shared/atomicOperationPort";

const NO_PORTS: OutboundPortRegistry = { resolve: () => undefined };

/**
 * The parent engine the atomic bridge below belongs to.
 *
 * Three segments, not two, and that is load-bearing: `areaFromEngineId` only
 * recognizes `admin.<area>`, so this engine is invisible to the area projection
 * and cannot be mistaken for an eighth operational area. It is still fully
 * present in the generic runtime snapshot, so nothing is hidden — it simply is
 * not an area, because it is composition scaffolding rather than a part of the
 * business (LOGIC §4 lists seven areas and this is not one of them).
 */
const ADMIN_SHARED_ENGINE = defineParentEngine({
  id: "admin.runtime.shared",
  childNamespace: "admin.runtime.shared",
});

/**
 * Bridges the injected atomic port into the capability graph.
 *
 * The registry has no door for "publish this capability directly" — capabilities
 * are published by children, through the staged scope that makes rollback
 * trustworthy. Rather than widen that door (which would let a host publish behind
 * the registry's back and break staged rollback), the port enters the same way
 * every other capability does: as a child that provides it.
 *
 * Built only when the port actually resolved. That is the whole mechanism behind
 * "no port means those two children stand down": with no provider, the dependency
 * graph finds nothing publishing `admin.atomic-operation` and excludes exactly the
 * children that require it, leaving their independent siblings running (LOGIC §7
 * rules 4 and 6). Nothing anywhere has to special-case the atomic case.
 */
function atomicBridgeChild(ports: OutboundPortRegistry): LogicChildDefinition | undefined {
  const port = ports.resolve(ATOMIC_OPERATION_PORT);
  if (port === undefined) {
    return undefined;
  }

  return defineLogicChild({
    id: `${ADMIN_SHARED_ENGINE.id}.atomic-operation`,
    parentId: ADMIN_SHARED_ENGINE.id,
    provides: [ADMIN_ATOMIC_OPERATION_ID],
    create(context) {
      // Publishing the port unchanged is the point: this runtime promises a
      // boundary exists, and never promises to be the one implementing it
      // (LOGIC §10 leaves the mechanism open on purpose).
      context.capabilities.provide(ADMIN_ATOMIC_OPERATION, port);
      return port;
    },
  });
}

/** True when at least one discovered child declared the atomic boundary in `requires`. */
function requiresAtomicOperation(children: readonly LogicChildDefinition[]): boolean {
  return children.some((child) =>
    child.requires.some((id) => id === ADMIN_ATOMIC_OPERATION_ID),
  );
}

function unavailableAtomicOperation(): Diagnostic {
  return {
    code: "missing-capability",
    severity: severityForCode("missing-capability"),
    message:
      `No implementation was supplied for the "${ADMIN_ATOMIC_OPERATION_ID}" port, ` +
      "so children requiring an atomic boundary are unavailable. This is a composition " +
      "choice, not a fault: running a multi-owner write without a boundary would be worse.",
    source: "createAdminEngine",
  };
}

/**
 * Composes the Admin runtime.
 *
 * Always returns a runtime. There is no failure mode that produces nothing — an
 * Admin that discovered no areas at all still starts and reports all seven as
 * missing, because a runtime that can explain why it is empty is more useful than
 * a constructor that threw.
 */
export function createAdminEngine(options: CreateAdminEngineOptions = {}): AdminEngineRuntime {
  const ports = options.ports ?? NO_PORTS;

  // De-duplicating on purpose, unlike the registry: these entries come from
  // different stages that legitimately notice the same problem.
  const startup = createDiagnosticCollector({
    forwardTo: options.diagnostics,
    deduplicate: true,
  });

  // Discover — or accept injected definitions. The override exists so a test never
  // depends on what happens to be on disk, which also makes this file testable
  // before any area has been ported.
  const discovered: AdminLogicDefinitions = options.definitions ?? discoverAdminLogic();
  for (const entry of discovered.diagnostics ?? []) {
    startup.report(entry);
  }

  // Only complain about a missing atomic port when something actually wants one.
  // Reporting it unconditionally would put an error in the snapshot of a perfectly
  // healthy runtime that has no multi-owner workflow — and a diagnostic that cries
  // wolf trains its reader to stop looking.
  const bridge = atomicBridgeChild(ports);
  if (bridge === undefined && requiresAtomicOperation(discovered.children)) {
    startup.report(unavailableAtomicOperation());
  }

  const engines: readonly ParentEngineDefinition[] = bridge
    ? [...discovered.engines, ADMIN_SHARED_ENGINE]
    : discovered.engines;
  const children: readonly LogicChildDefinition[] = bridge
    ? [...discovered.children, bridge]
    : discovered.children;

  // Resolve the graph: duplicates, orphans, contested capabilities, unmet
  // requirements, and cycles are all decided here, before anything is created.
  const graph = resolveDependencyGraph(engines, children);
  for (const entry of graph.diagnostics) {
    startup.report(entry);
  }

  const registry = createEngineRegistry({
    diagnostics: options.diagnostics,
    ports,
  });

  for (const engine of engines) {
    registry.registerEngine(engine);
  }

  // Every child is registered, including the ones the graph excluded. They are not
  // initialized (the order it computed leaves them out), but registering them keeps
  // them visible in the snapshot as unavailable — an excluded child that vanished
  // from the report would be indistinguishable from one that was never written.
  for (const child of children) {
    registry.registerChild(child);
  }

  registry.initialize(graph.order);

  return {
    getSnapshot: () => projectAdminSnapshot(registry.getSnapshot(), startup.list()),
    subscribe: (listener) => registry.subscribe(listener),
    dispose: () => {
      registry.dispose();
    },
  };
}
