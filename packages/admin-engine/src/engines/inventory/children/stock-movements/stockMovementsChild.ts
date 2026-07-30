// packages/admin-engine/src/engines/inventory/children/stock-movements/stockMovementsChild.ts
//
// Inventory ledger reading (capability `admin.inventory.stock-movements`).
//
// The audit side of the Inventory area, and the capability LOGIC §8 shows
// `admin.dashboard.reports` depending on. It requires nothing itself.
//
// Ported from SOURCE:
//   - apps/admin/src/features/inventory/application/useInventoryMovements.ts
//     (the movement + ingredient load and the filter plumbing)
//   - packages/data/src/mocks/InMemoryInventoryRepository.ts (the three query
//     filters, honoured there, and the newest-first ordering that moved here)
//   - apps/admin/src/features/inventory/components/InventoryMovementsTable.tsx
//     (the ingredient-name lookup it did while rendering)
//
// This child only reads. Writing a movement is `stock-adjustment`, and the
// automated consumption and reversal paths are S5 — all three go through the
// port's `commitMovement`, never through here.

import type { InventoryIngredient, InventoryMovement } from "@warungmeng/domain";
import type { LogicChildContext, OperationResult } from "@warungmeng/module-system";
import {
  defineLogicChild,
  operationFailure,
  operationIssue,
  operationSuccess,
  severityForCode,
} from "@warungmeng/module-system";
import { INVENTORY_ENGINE_ID } from "../../inventoryEngine";
import type {
  InventoryStorePort,
  MovementListFilters,
  MovementListItem,
  MovementStoreQuery,
  StockMovements,
} from "../../inventoryContracts";
import {
  DEFAULT_MOVEMENT_LIST_FILTERS,
  INVENTORY_STORE_PORT,
  STOCK_MOVEMENTS,
  STOCK_MOVEMENTS_ID,
} from "../../inventoryContracts";

// ─── Ordering ────────────────────────────────────────────────────────────────

/**
 * Newest first, then by id.
 *
 * SOURCE compared `occurredAt` as an ISO string with no tie-break, inside its
 * in-memory repository. Two problems, both fixed here.
 *
 * The sort moved out of the store for the same reason it did in `materials-read`:
 * ordering is a promise the engine makes, and leaving it in the adapter meant a
 * different adapter would silently reorder the ledger.
 *
 * The id tie-break is not cosmetic. SOURCE's automated paths stamp EVERY row of
 * one order with an identical timestamp — consumption uses the order's
 * `createdAt` for all of its movements, reversal uses `updatedAt` — so a
 * multi-ingredient order produces a block of rows the comparison cannot
 * distinguish. Without a tie-break their order is left to the sort
 * implementation, which means an audit record could present the same history
 * differently on two machines. An id comparison is arbitrary but stable, and a
 * stable audit order is the point.
 *
 * Descending, so the comparison is reversed against `occurredAt` and the id
 * follows the same direction to keep the whole ordering a single total order.
 */
function byNewestThenId(left: InventoryMovement, right: InventoryMovement): number {
  return right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id);
}

export function sortMovements(
  movements: readonly InventoryMovement[],
): readonly InventoryMovement[] {
  return [...movements].sort(byNewestThenId);
}

// ─── Filters and joining ─────────────────────────────────────────────────────
//
// Exported for the test beside this file. Discovery reads the default export, so
// naming these does not make the file ambiguous.

/**
 * Translates the area's filter shape into the port's narrower query.
 *
 * A key is omitted rather than passed as undefined so an adapter that inspects
 * its argument sees only the dimensions actually being filtered.
 */
export function toStoreQuery(filters: MovementListFilters): MovementStoreQuery {
  return {
    ...(filters.ingredientId === null ? {} : { ingredientId: filters.ingredientId }),
    ...(filters.outletId === null ? {} : { outletId: filters.outletId }),
    ...(filters.type === "all" ? {} : { type: filters.type }),
  };
}

/**
 * Re-applies the filters the store was asked for.
 *
 * This is deliberate belt-and-braces, not redundancy. The port promises nothing
 * about honouring its query — SOURCE's in-memory adapter did, but a caller of
 * this capability is entitled to a list that matches what it asked for
 * regardless of which adapter is plugged in. The alternative is that a partially
 * implemented store silently returns extra rows and the ledger appears to contain
 * movements the filter excluded.
 */
export function filterMovements(
  movements: readonly InventoryMovement[],
  filters: MovementListFilters,
): readonly InventoryMovement[] {
  return movements.filter((movement) => {
    const matchesIngredient =
      filters.ingredientId === null || movement.ingredientId === filters.ingredientId;
    const matchesOutlet = filters.outletId === null || movement.outletId === filters.outletId;
    const matchesType = filters.type === "all" || movement.type === filters.type;

    return matchesIngredient && matchesOutlet && matchesType;
  });
}

/**
 * Joins each row to its ingredient, or to null when the ingredient is gone.
 *
 * SOURCE looked the name up while rendering, against a list of ACTIVE
 * ingredients only, so a movement whose ingredient had since been archived
 * rendered with an empty name and no explanation. The join here uses whatever the
 * store returns and reports an unresolved reference as null rather than as a
 * blank, because an audit row that cannot be explained is information.
 */
export function joinMovements(
  movements: readonly InventoryMovement[],
  ingredients: readonly InventoryIngredient[],
): readonly MovementListItem[] {
  const ingredientById = new Map(ingredients.map((ingredient) => [ingredient.id, ingredient]));

  return movements.map((movement) => ({
    movement,
    ingredient: ingredientById.get(movement.ingredientId) ?? null,
  }));
}

// ─── Store access ────────────────────────────────────────────────────────────

const NO_STORE = "no-inventory-store";
const STORE_FAILED = "inventory-store-failed";

function noStore<TValue>(operation: string): OperationResult<TValue> {
  return operationFailure("unsatisfied-dependency", [
    operationIssue(
      NO_STORE,
      "No inventory store is connected, so the stock ledger cannot be read.",
      operation,
    ),
  ]);
}

async function fromStore<TValue>(
  operation: string,
  read: () => Promise<TValue>,
): Promise<OperationResult<TValue>> {
  try {
    return operationSuccess(await read());
  } catch (error) {
    return operationFailure("failed", [
      operationIssue(
        STORE_FAILED,
        error instanceof Error ? error.message : "The inventory store failed.",
        operation,
      ),
    ]);
  }
}

function stockMovementsOverStore(store: InventoryStorePort): StockMovements {
  async function rows(filters: MovementListFilters): Promise<readonly InventoryMovement[]> {
    const stored = await store.listMovements(toStoreQuery(filters));
    return sortMovements(filterMovements(stored, filters));
  }

  return {
    listMovements: async (
      filters: MovementListFilters = DEFAULT_MOVEMENT_LIST_FILTERS,
    ): Promise<OperationResult<readonly InventoryMovement[]>> =>
      fromStore("listMovements", async () => rows(filters)),

    queryMovements: async (
      filters: MovementListFilters = DEFAULT_MOVEMENT_LIST_FILTERS,
    ): Promise<OperationResult<readonly MovementListItem[]>> =>
      fromStore("queryMovements", async () => {
        const [movements, ingredients] = await Promise.all([
          rows(filters),
          store.listIngredients(),
        ]);

        return joinMovements(movements, ingredients);
      }),
  };
}

/**
 * The capability published when no store is connected — same reasoning as in
 * `materials-read`: the child declared no requirements, so it loads and
 * publishes, and a consumer gets an honest "no store" answer instead of an
 * unexplained absence.
 */
function stockMovementsWithoutStore(): StockMovements {
  return {
    listMovements: async () => noStore("listMovements"),
    queryMovements: async () => noStore("queryMovements"),
  };
}

export function createStockMovements(context: LogicChildContext): StockMovements {
  const store = context.ports.resolve(INVENTORY_STORE_PORT);

  if (store === undefined) {
    // Reported once, at creation, rather than on every call.
    context.diagnostics.report({
      code: "missing-dependency",
      severity: severityForCode("missing-dependency"),
      message:
        "No inventory store was supplied to the Inventory area, so ledger reads return a " +
        "normalized failure. The capability is published and callers stay working.",
      childId: context.childId,
      engineId: context.parentId,
      source: "stockMovementsChild",
    });
  }

  const capability =
    store === undefined ? stockMovementsWithoutStore() : stockMovementsOverStore(store);

  context.capabilities.provide(STOCK_MOVEMENTS, capability);

  return capability;
}

export default defineLogicChild<StockMovements>({
  id: STOCK_MOVEMENTS_ID,
  parentId: INVENTORY_ENGINE_ID,
  provides: [STOCK_MOVEMENTS_ID],
  requires: [],
  create: createStockMovements,
});
