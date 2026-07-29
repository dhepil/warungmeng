// packages/module-system/src/capabilityRegistry.ts
//
// Register and resolve public capability (LOGIC §5).
//
// Consolidated from the SOURCE's four `capabilities/*` files. Capabilities are the
// ONLY way one child may reach another (LOGIC §9), so this registry is the runtime's
// single seam: a child provides an implementation under a declared id, and any child
// that declared a matching requirement resolves it — without importing it.
//
// Staging is carried over from SOURCE: while a child is being created its
// capabilities are held pending, so that if creation fails nothing it published
// stays visible to its siblings.

import type {
  CapabilityId,
  CapabilityRegistration,
  CapabilityRegistry,
  CapabilityResolution,
  CapabilityToken,
  LogicChildId,
} from "./engineContracts";
import type {
  OperationFailure,
  OperationIssue,
  OperationResult,
  OperationSuccess,
} from "./operationResult";
import { operationFailure, operationIssue, operationSuccess } from "./operationResult";

interface CapabilityRecord {
  readonly ownerId: LogicChildId;
  readonly value: unknown;
}

/**
 * A capability scope held open while one child is created. `registry` is what the
 * child sees; `commit` publishes, `rollback` discards.
 */
export interface StagedCapabilityScope {
  readonly registry: CapabilityRegistry;
  readonly ownerId: LogicChildId;
  /** Capability ids staged so far, in the order they were provided. */
  staged(): readonly CapabilityId[];
  /** Duplicate-capability conflicts seen while staging. */
  conflicts(): readonly OperationIssue[];
  /** Publishes staged capabilities so siblings can resolve them. */
  commit(): OperationResult<readonly CapabilityRegistration[]>;
  /** Discards staged capabilities and disposes anything already committed. */
  rollback(): void;
}

export interface CapabilityRegistryController {
  /** A plain scope for an owner whose capabilities need no staging. */
  createScope(
    ownerId: LogicChildId,
    onRegistered?: (registration: CapabilityRegistration) => void,
  ): CapabilityRegistry;
  /** A scope whose provided capabilities stay pending until committed. */
  createStagedScope(ownerId: LogicChildId): StagedCapabilityScope;
  resolve<TContract>(token: CapabilityToken<TContract>): CapabilityResolution<TContract>;
  /** Every currently published capability id, in publication order. */
  list(): readonly CapabilityId[];
}

function resolveFrom<TContract>(
  records: ReadonlyMap<string, CapabilityRecord>,
  token: CapabilityToken<TContract>,
): CapabilityResolution<TContract> {
  const record = records.get(token.id);
  if (!record) {
    return { status: "missing", capabilityId: token.id };
  }

  return { status: "available", ownerId: record.ownerId, value: record.value as TContract };
}

function duplicateIssue(id: CapabilityId, existingOwnerId: LogicChildId): OperationIssue {
  return operationIssue(
    "duplicate-capability",
    "Capability provider is already registered.",
    id,
    { existingOwnerId },
  );
}

export function createCapabilityRegistry(): CapabilityRegistryController {
  const records = new Map<string, CapabilityRecord>();
  const publicationOrder: CapabilityId[] = [];

  /**
   * Publishes one capability. Returns a disposer that only removes the record it
   * created, so a late dispose can never delete a successor's registration.
   */
  function publish(
    ownerId: LogicChildId,
    id: CapabilityId,
    implementation: unknown,
  ): OperationSuccess<CapabilityRegistration> | OperationFailure {
    const existing = records.get(id);
    if (existing) {
      return operationFailure("conflict", [duplicateIssue(id, existing.ownerId)]);
    }

    const record: CapabilityRecord = { ownerId, value: implementation };
    records.set(id, record);
    publicationOrder.push(id);
    let active = true;

    return operationSuccess({
      capabilityId: id,
      dispose() {
        if (active && records.get(id) === record) {
          records.delete(id);
          const index = publicationOrder.indexOf(id);
          if (index >= 0) {
            publicationOrder.splice(index, 1);
          }
        }
        active = false;
      },
    });
  }

  function createScope(
    ownerId: LogicChildId,
    onRegistered?: (registration: CapabilityRegistration) => void,
  ): CapabilityRegistry {
    return {
      resolve: (token) => resolveFrom(records, token),
      provide(token, implementation) {
        const result = publish(ownerId, token.id, implementation);
        if (result.status === "success") {
          onRegistered?.(result.value);
        }
        return result;
      },
    };
  }

  function createStagedScope(ownerId: LogicChildId): StagedCapabilityScope {
    /**
     * A staged capability keeps a link to its published registration, so the handle
     * the child received during creation stays valid after commit. Without this a
     * child could never dispose its own capability (ported from SOURCE
     * registerModule, whose staged disposer awaited `record.committed?.dispose()`).
     */
    interface StagedCapability {
      readonly implementation: unknown;
      committed?: CapabilityRegistration;
    }

    const pending = new Map<CapabilityId, StagedCapability>();
    /**
     * The handles handed to the child, in provide order. `commit` returns THESE
     * rather than the internal published ones, so teardown always runs through the
     * handle the child holds — a child may wrap or decorate it.
     */
    const handles = new Map<CapabilityId, CapabilityRegistration>();
    const conflicts: OperationIssue[] = [];
    let committed: CapabilityRegistration[] = [];

    const registry: CapabilityRegistry = {
      /**
       * A child can read back its own pending capability — useful when one child
       * provides several that build on each other — before falling through to
       * what its siblings already published.
       */
      resolve<TContract>(token: CapabilityToken<TContract>) {
        const staged = pending.get(token.id);
        if (staged) {
          return {
            status: "available" as const,
            ownerId,
            value: staged.implementation as TContract,
          };
        }
        return resolveFrom(records, token);
      },
      provide(token, implementation) {
        const existing = records.get(token.id);
        const conflictOwnerId = existing ? existing.ownerId : pending.has(token.id) ? ownerId : null;
        if (conflictOwnerId !== null) {
          const issue = duplicateIssue(token.id, conflictOwnerId);
          conflicts.push(issue);
          return operationFailure("conflict", [issue]);
        }

        const staged: StagedCapability = { implementation };
        pending.set(token.id, staged);
        const handle: CapabilityRegistration = {
          capabilityId: token.id,
          dispose() {
            pending.delete(token.id);
            handles.delete(token.id);
            staged.committed?.dispose();
          },
        };
        handles.set(token.id, handle);
        return operationSuccess(handle);
      },
    };

    function rollback(): void {
      pending.clear();
      for (const registration of [...committed].reverse()) {
        registration.dispose();
      }
      committed = [];
      handles.clear();
    }

    return {
      registry,
      ownerId,
      staged: () => [...pending.keys()],
      conflicts: () => [...conflicts],
      /**
       * All-or-nothing: a conflict at commit time (a sibling published the same id
       * in between) rolls back everything this scope had already published.
       */
      commit() {
        for (const [id, staged] of pending) {
          const result = publish(ownerId, id, staged.implementation);
          if (result.status !== "success") {
            rollback();
            return result;
          }
          staged.committed = result.value;
          committed.push(result.value);
        }
        // The child-facing handles, not the internal ones: disposing a handle
        // cascades to its committed registration, while the reverse is not true.
        return operationSuccess([...handles.values()]);
      },
      rollback,
    };
  }

  return {
    createScope,
    createStagedScope,
    resolve: (token) => resolveFrom(records, token),
    list: () => [...publicationOrder],
  };
}
