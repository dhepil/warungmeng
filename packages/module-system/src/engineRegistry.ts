// packages/module-system/src/engineRegistry.ts
//
// Register, resolve, list, initialize, and dispose (LOGIC §5).
//
// The engine host. Ported from the SOURCE's `registry/{createModuleRegistry,
// registerModule}.ts`, reshaped to the target's parent/child model: SOURCE
// registered async "extensions" that called back into a scope, the target creates
// children synchronously from an injected context (LOGIC §3).
//
// The SOURCE behaviors that matter are carried over intact:
//   - a child that fails leaves nothing published behind (staged rollback);
//   - what a child declares in `provides` must match what it actually publishes;
//   - disposal runs in reverse initialization order;
//   - one child failing must not take independent siblings down (LOGIC §7 rule 5);
//   - `initialize()` and `dispose()` are idempotent (LOGIC §7 rule 7).
//
// Duplicate-id detection happens here because it is a registration-time concern.
// Orphan children, missing dependencies, cycles, and initialization ORDER belong to
// dependencyGraph.ts; this file accepts an injected order so it never has to know
// how that order was computed.

import type {
  ApplicationEngineSnapshot,
  CapabilityId,
  CapabilityRegistration,
  CapabilityToken,
  Diagnostic,
  DiagnosticSink,
  EngineId,
  EngineRuntimeStatus,
  LogicChildDefinition,
  LogicChildId,
  LogicChildSnapshot,
  LogicChildState,
  OutboundPortRegistry,
  ParentEngineDefinition,
  ParentEngineSnapshot,
} from "./engineContracts";
import { createCapabilityRegistry } from "./capabilityRegistry";
import type { OperationResult } from "./operationResult";
import { operationFailure, operationIssue, operationSuccess } from "./operationResult";

export interface EngineRegistryOptions {
  readonly diagnostics?: DiagnosticSink;
  readonly ports?: OutboundPortRegistry;
}

/** One registered child and everything needed to tear it back down. */
interface ActiveChild {
  readonly definition: LogicChildDefinition;
  readonly capabilities: readonly CapabilityRegistration[];
  readonly value: unknown;
}

export interface EngineRegistry {
  registerEngine(definition: ParentEngineDefinition): OperationResult<EngineId>;
  registerChild(definition: LogicChildDefinition): OperationResult<LogicChildId>;
  resolveEngine(id: EngineId): ParentEngineDefinition | undefined;
  listEngines(): readonly ParentEngineDefinition[];
  listChildren(): readonly LogicChildDefinition[];
  /**
   * Creates every registered child in `order`, skipping any whose requirements are
   * unmet. Idempotent: a second call initializes only what is not yet active.
   */
  initialize(order?: readonly LogicChildId[]): OperationResult<readonly LogicChildId[]>;
  resolve<TContract>(token: CapabilityToken<TContract>): TContract | undefined;
  getSnapshot(): ApplicationEngineSnapshot;
  subscribe(listener: () => void): () => void;
  disposeChild(id: LogicChildId): void;
  dispose(): void;
}

const NO_PORTS: OutboundPortRegistry = { resolve: () => undefined };

export function createEngineRegistry(options: EngineRegistryOptions = {}): EngineRegistry {
  const engines = new Map<EngineId, ParentEngineDefinition>();
  const children = new Map<LogicChildId, LogicChildDefinition>();
  const active = new Map<LogicChildId, ActiveChild>();
  const states = new Map<LogicChildId, LogicChildState>();
  const unmet = new Map<LogicChildId, readonly CapabilityId[]>();
  const initializationOrder: LogicChildId[] = [];
  const collected: Diagnostic[] = [];
  const listeners = new Set<() => void>();

  const capabilities = createCapabilityRegistry();
  const ports = options.ports ?? NO_PORTS;
  let disposed = false;

  /** Records a diagnostic locally and forwards it to the host's sink. */
  function report(diagnostic: Diagnostic): void {
    collected.push(diagnostic);
    options.diagnostics?.report(diagnostic);
  }

  const diagnostics: DiagnosticSink = { report };

  function notify(): void {
    for (const listener of [...listeners]) {
      listener();
    }
  }

  function registerEngine(definition: ParentEngineDefinition): OperationResult<EngineId> {
    const existing = engines.get(definition.id);
    if (existing) {
      const issue = operationIssue(
        "duplicate-engine-id",
        "A parent engine with this id is already registered.",
        definition.id,
      );
      report({
        code: "duplicate-engine-id",
        severity: "error",
        message: issue.message,
        engineId: definition.id,
      });
      return operationFailure("conflict", [issue]);
    }

    engines.set(definition.id, definition);
    return operationSuccess(definition.id);
  }

  function registerChild(definition: LogicChildDefinition): OperationResult<LogicChildId> {
    const existing = children.get(definition.id);
    if (existing) {
      const issue = operationIssue(
        "duplicate-child-id",
        "A logic child with this id is already registered.",
        definition.id,
      );
      report({
        code: "duplicate-child-id",
        severity: "error",
        message: issue.message,
        engineId: definition.parentId,
        childId: definition.id,
      });
      return operationFailure("conflict", [issue]);
    }

    children.set(definition.id, definition);
    states.set(definition.id, "unavailable");
    return operationSuccess(definition.id);
  }

  /** Requirements this child declared that nothing has published yet. */
  function missingRequirements(
    definition: LogicChildDefinition,
  ): readonly CapabilityId[] {
    return definition.requires.filter(
      (id) => capabilities.resolve({ id, version: 1 }).status === "missing",
    );
  }

  /**
   * Creates one child. Everything it publishes is staged, so a throw, a duplicate,
   * or a provides/publishes mismatch leaves the registry exactly as it was.
   */
  function initializeChild(definition: LogicChildDefinition): boolean {
    const unmetRequirements = missingRequirements(definition);
    if (unmetRequirements.length > 0) {
      unmet.set(definition.id, unmetRequirements);
      states.set(definition.id, "unavailable");
      for (const capabilityId of unmetRequirements) {
        report({
          code: "missing-dependency",
          severity: "warning",
          message: "Child is unavailable because a required capability is not active.",
          engineId: definition.parentId,
          childId: definition.id,
          details: { capabilityId },
        });
      }
      return false;
    }

    const scope = capabilities.createStagedScope(definition.id);
    let value: unknown;
    try {
      value = definition.create({
        childId: definition.id,
        parentId: definition.parentId,
        capabilities: scope.registry,
        diagnostics,
        ports,
      });
    } catch {
      scope.rollback();
      unmet.set(definition.id, []);
      states.set(definition.id, "failed");
      report({
        code: "initialization-failed",
        severity: "error",
        message: "Child threw while being created.",
        engineId: definition.parentId,
        childId: definition.id,
      });
      return false;
    }

    const conflicts = scope.conflicts();
    if (conflicts.length > 0) {
      scope.rollback();
      unmet.set(definition.id, []);
      states.set(definition.id, "failed");
      for (const conflict of conflicts) {
        report({
          code: "duplicate-capability",
          severity: "error",
          message: conflict.message,
          engineId: definition.parentId,
          childId: definition.id,
          details: { capabilityId: conflict.subject ?? null },
        });
      }
      return false;
    }

    // A child must publish exactly what it declared — no more, no less. Ported
    // from SOURCE registerModule's undeclared/missing capability checks; without
    // it the dependency graph would be a lie.
    const staged = new Set<string>(scope.staged());
    const declared = new Set<string>(definition.provides);
    const undeclared = [...staged].find((id) => !declared.has(id));
    const unpublished = [...declared].find((id) => !staged.has(id));
    if (undeclared !== undefined || unpublished !== undefined) {
      scope.rollback();
      unmet.set(definition.id, []);
      states.set(definition.id, "failed");
      report({
        code: "initialization-failed",
        severity: "error",
        message:
          undeclared !== undefined
            ? "Child published an undeclared capability."
            : "Child did not publish a declared capability.",
        engineId: definition.parentId,
        childId: definition.id,
        details: { capabilityId: undeclared ?? unpublished ?? null },
      });
      return false;
    }

    const commit = scope.commit();
    if (commit.status === "failure") {
      unmet.set(definition.id, []);
      states.set(definition.id, "failed");
      for (const issue of commit.issues) {
        report({
          code: "duplicate-capability",
          severity: "error",
          message: issue.message,
          engineId: definition.parentId,
          childId: definition.id,
          details: { capabilityId: issue.subject ?? null },
        });
      }
      return false;
    }

    active.set(definition.id, {
      definition,
      capabilities: commit.status === "success" ? commit.value : [],
      value,
    });
    initializationOrder.push(definition.id);
    unmet.set(definition.id, []);
    states.set(definition.id, "active");
    return true;
  }

  /**
   * Idempotent (LOGIC §7 rule 7): already-active children are skipped, so a repeat
   * call is a no-op. A child that cannot start is recorded and skipped — its
   * independent siblings still initialize (LOGIC §7 rule 5).
   */
  function initialize(order?: readonly LogicChildId[]): OperationResult<readonly LogicChildId[]> {
    if (disposed) {
      return operationFailure("conflict", [
        operationIssue("disposed", "This runtime has been disposed."),
      ]);
    }

    const sequence = order ?? [...children.keys()];
    const started: LogicChildId[] = [];
    for (const id of sequence) {
      const definition = children.get(id);
      if (!definition || active.has(id)) {
        continue;
      }
      if (initializeChild(definition)) {
        started.push(id);
      }
    }

    notify();

    const blocked = [...children.keys()].filter((id) => !active.has(id));
    if (blocked.length === 0) {
      return operationSuccess(started);
    }

    // Degraded, not failed: the runtime is usable, just missing these children.
    return {
      status: "degraded",
      value: started,
      issues: blocked.map((id) =>
        operationIssue(
          states.get(id) === "failed" ? "initialization-failed" : "missing-dependency",
          states.get(id) === "failed"
            ? "Child failed to initialize."
            : "Child is unavailable because a required capability is not active.",
          id,
        ),
      ),
    };
  }

  /** Tears one child down, releasing its capabilities. Safe to call twice. */
  function disposeChildInternal(id: LogicChildId): boolean {
    const entry = active.get(id);
    if (!entry) {
      return false;
    }

    for (const registration of [...entry.capabilities].reverse()) {
      try {
        void registration.dispose();
      } catch {
        report({
          code: "disposal-failed",
          severity: "error",
          message: "Capability disposal failed.",
          engineId: entry.definition.parentId,
          childId: id,
        });
      }
    }

    active.delete(id);
    const index = initializationOrder.indexOf(id);
    if (index >= 0) {
      initializationOrder.splice(index, 1);
    }
    states.set(id, "disposed");
    return true;
  }

  /** Reverse initialization order, so providers outlive their consumers. */
  function dispose(): void {
    if (disposed) {
      return;
    }
    for (const id of [...initializationOrder].reverse()) {
      disposeChildInternal(id);
    }
    disposed = true;
    notify();
    listeners.clear();
  }

  function childSnapshot(definition: LogicChildDefinition): LogicChildSnapshot {
    return {
      childId: definition.id,
      parentId: definition.parentId,
      state: states.get(definition.id) ?? "unavailable",
      provides: definition.provides,
      requires: definition.requires,
      unmetRequirements: unmet.get(definition.id) ?? [],
    };
  }

  function engineSnapshot(definition: ParentEngineDefinition): ParentEngineSnapshot {
    return {
      engineId: definition.id,
      childNamespace: definition.childNamespace,
      children: [...children.values()]
        .filter((child) => child.parentId === definition.id)
        .map(childSnapshot),
    };
  }

  function runtimeStatus(): EngineRuntimeStatus {
    if (disposed) {
      return "disposed";
    }
    if (initializationOrder.length === 0) {
      return children.size === 0 ? "idle" : "degraded";
    }
    return active.size === children.size ? "ready" : "degraded";
  }

  /** Read-only by construction: every array is a fresh copy (LOGIC §3). */
  function getSnapshot(): ApplicationEngineSnapshot {
    return {
      status: runtimeStatus(),
      engines: [...engines.values()].map(engineSnapshot),
      capabilities: capabilities.list(),
      diagnostics: [...collected],
      initializationOrder: [...initializationOrder],
    };
  }

  return {
    registerEngine,
    registerChild,
    resolveEngine: (id) => engines.get(id),
    listEngines: () => [...engines.values()],
    listChildren: () => [...children.values()],
    initialize,
    resolve<TContract>(token: CapabilityToken<TContract>) {
      const resolution = capabilities.resolve(token);
      return resolution.status === "available" ? resolution.value : undefined;
    },
    getSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    disposeChild(id) {
      if (disposeChildInternal(id)) {
        notify();
      }
    },
    dispose,
  };
}
