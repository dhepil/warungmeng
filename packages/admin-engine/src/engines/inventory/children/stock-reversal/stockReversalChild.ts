// packages/admin-engine/src/engines/inventory/children/stock-reversal/stockReversalChild.ts
//
// Returning a cancelled order's ingredients to stock (capability
// `admin.inventory.stock-reversal`, required by `admin.orders.order-cancellation`
// per LOGIC §8).
//
// Ported from SOURCE `packages/data/src/mocks/InMemoryInventoryRepository.ts`
// `revertOrderConsumption`, plus the wrapping in
// `apps/admin/src/features/orders/application/commands/cancelOrderCommand.ts`.
//
// Like consumption, every row goes through `planStockMovement`, so a reversal
// cannot disagree with any other write about what a legal stock change is.

import type {
  InventoryIngredient,
  InventoryMovement,
  InventoryStockBalance,
  Order,
} from "@warungmeng/domain";
import type { LogicChildContext, OperationResult } from "@warungmeng/module-system";
import {
  defineLogicChild,
  operationDegraded,
  operationFailure,
  operationIssue,
  operationSuccess,
  severityForCode,
} from "@warungmeng/module-system";
import { INVENTORY_ENGINE_ID } from "../../inventoryEngine";
import type {
  InventoryStorePort,
  StockLedgerOutcome,
  StockMovementCommit,
  StockReversal,
} from "../../inventoryContracts";
import {
  CONSUMPTION_ISSUE,
  INVENTORY_STORE_PORT,
  planStockMovement,
  STOCK_REVERSAL,
  STOCK_REVERSAL_ID,
} from "../../inventoryContracts";

/**
 * The movement type a reversal writes.
 *
 * `adjustment-in` is SOURCE's choice and it stays, because `InventoryMovementType`
 * lives in `packages/domain` — a closed phase — and inventing a `reversal` member
 * would mean editing a finished package to suit this child.
 *
 * The consequence SOURCE carried is that the type is generic and user-facing, so
 * its idempotency guard — `referenceId === order.id && type === "adjustment-in"` —
 * could be tripped by a *manual* adjustment tagged with an order id, permanently
 * suppressing that order's real reversal. In SOURCE the only thing preventing it
 * was the movement dialog hardcoding `referenceId: null`: protection by accident.
 *
 * In this runtime it cannot happen by construction. `RecordMovementInput` (the
 * manual path's input) has no `referenceId` field at all, and `stock-adjustment`
 * passes `null` unconditionally, so nothing reachable through the admin engine can
 * write an `adjustment-in` carrying an order's id. Externally seeded data still
 * could — recorded in `plan/tech-debt.md`.
 */
const REVERSAL_TYPE = "adjustment-in" as const;

// ─── Planning the reversal ───────────────────────────────────────────────────

/**
 * Plans one inbound row per consumed row, restoring exactly what was taken.
 *
 * **The correction that matters.** SOURCE rebuilt each reversal from the consumed
 * row's *entered* `quantity` and `unit` and let the conversion run again against
 * the ingredient's CURRENT definition — it never looked at the stored
 * `baseQuantityDelta`. Because `baseUnit` is patchable, changing an ingredient
 * from `g` to `kg` between consuming and cancelling restored a thousand times what
 * was deducted, and changing `g` to `ml` made the conversion throw, which
 * (through order cancellation's rollback) left the order permanently
 * un-cancellable.
 *
 * Here the reversal is expressed in the ingredient's own base unit with the
 * magnitude of the stored delta, so `planStockMovement`'s conversion is the
 * identity and the row is the exact arithmetic negation of the consumption. A
 * balance is a number in base units: we subtracted N, so we add back N, and the
 * round trip is exact no matter what the unit is now called or whether the two
 * units would still convert.
 *
 * A consumed row with a non-negative delta is skipped rather than trusted — a
 * consumption that did not reduce stock is not something to invert.
 */
export function planOrderReversal(
  order: Order,
  consumed: readonly InventoryMovement[],
  ingredients: readonly InventoryIngredient[],
  balances: readonly InventoryStockBalance[],
  newMovementId: () => string,
): OperationResult<readonly StockMovementCommit[]> {
  const ingredientById = new Map(ingredients.map((ingredient) => [ingredient.id, ingredient]));
  const runningBalances = new Map(
    balances.map((balance) => [`${balance.ingredientId}:${balance.outletId}`, balance]),
  );

  const commits: StockMovementCommit[] = [];

  for (const row of consumed) {
    if (row.baseQuantityDelta >= 0) {
      continue;
    }

    const ingredient = ingredientById.get(row.ingredientId) ?? null;
    const key = `${row.ingredientId}:${row.outletId}`;

    const plan = planStockMovement(
      {
        ingredientId: row.ingredientId,
        outletId: row.outletId,
        type: REVERSAL_TYPE,
        // The magnitude of what was actually deducted, stated in the unit the
        // balance is kept in, so the conversion cannot change it.
        quantity: Math.abs(row.baseQuantityDelta),
        unit: ingredient?.baseUnit ?? row.unit,
        quantitySource: "derived",
        unitCost: null,
        referenceId: order.id,
        note: `Pembatalan ${order.orderNumber}`,
        occurredAt: order.updatedAt,
      },
      ingredient,
      runningBalances.get(key) ?? null,
      newMovementId(),
    );

    if (plan.status === "failure") {
      return plan;
    }

    commits.push(plan.value);
    runningBalances.set(key, plan.value.balance);
  }

  return operationSuccess(commits);
}

// ─── Store access ────────────────────────────────────────────────────────────

const NO_STORE = "no-inventory-store";
const STORE_FAILED = "inventory-store-failed";

function noStore<TValue>(operation: string): OperationResult<TValue> {
  return operationFailure("unsatisfied-dependency", [
    operationIssue(
      NO_STORE,
      "No inventory store is connected, so order stock cannot be returned.",
      operation,
    ),
  ]);
}

function storeFailed<TValue>(operation: string, error: unknown): OperationResult<TValue> {
  return operationFailure("failed", [
    operationIssue(
      STORE_FAILED,
      error instanceof Error ? error.message : "The inventory store failed.",
      operation,
    ),
  ]);
}

function stockReversalOverStore(store: InventoryStorePort): StockReversal {
  return {
    async revertOrderConsumption(order: Order): Promise<OperationResult<StockLedgerOutcome>> {
      let plan: ReturnType<typeof planOrderReversal>;

      try {
        // Both guards are queries now rather than scans of the whole ledger
        // (tech-debt D14, closed in S5a).
        const [consumed, reversed] = await Promise.all([
          store.listMovements({ referenceId: order.id, type: "consumption" }),
          store.listMovements({ referenceId: order.id, type: REVERSAL_TYPE }),
        ]);

        if (consumed.length === 0) {
          // Nothing was ever taken, so there is nothing to give back. SOURCE
          // returned an empty array here, which a caller could not tell apart
          // from a reversal that returned nothing because it had nothing to do.
          return operationFailure("not-found", [
            operationIssue(
              CONSUMPTION_ISSUE.neverConsumed,
              `Order ${order.orderNumber} never consumed stock, so there is nothing to return.`,
              order.id,
            ),
          ]);
        }

        if (reversed.length > 0) {
          return operationDegraded(
            { movements: reversed, replayed: true, skippedMenuItemIds: [] },
            [
              operationIssue(
                CONSUMPTION_ISSUE.alreadyReversed,
                `Order ${order.orderNumber} has already been reversed; nothing was written.`,
                order.id,
                { movementCount: reversed.length },
              ),
            ],
          );
        }

        const [ingredients, balances] = await Promise.all([
          store.listIngredients(),
          store.listStockBalances(order.outletId),
        ]);

        plan = planOrderReversal(order, consumed, ingredients, balances, () =>
          store.newId("movement"),
        );
      } catch (error) {
        return storeFailed("revertOrderConsumption", error);
      }

      if (plan.status === "failure") {
        return plan;
      }

      if (plan.value.length === 0) {
        // Consumed rows exist but none of them actually reduced stock. Not an
        // error and not a success: there is nothing to undo, and a caller telling
        // a customer their stock came back should not be told this was fine.
        return operationFailure("conflict", [
          operationIssue(
            CONSUMPTION_ISSUE.neverConsumed,
            `Order ${order.orderNumber} has consumption rows but none reduced stock.`,
            order.id,
          ),
        ]);
      }

      try {
        // One batch, so order cancellation's atomic boundary wraps a single call.
        await store.commitMovements(plan.value);
      } catch (error) {
        return storeFailed("commitMovements", error);
      }

      return operationSuccess({
        movements: plan.value.map((commit) => commit.movement),
        replayed: false,
        skippedMenuItemIds: [],
      });
    },
  };
}

/** Published even with no store, for the reasons given in every sibling child. */
function stockReversalWithoutStore(): StockReversal {
  return {
    revertOrderConsumption: async () => noStore("revertOrderConsumption"),
  };
}

export function createStockReversal(context: LogicChildContext): StockReversal {
  const store = context.ports.resolve(INVENTORY_STORE_PORT);

  if (store === undefined) {
    context.diagnostics.report({
      code: "missing-dependency",
      severity: severityForCode("missing-dependency"),
      message:
        "No inventory store was supplied to the Inventory area, so stock reversal returns a " +
        "normalized failure. The capability is published and callers stay working.",
      childId: context.childId,
      engineId: context.parentId,
      source: "stockReversalChild",
    });
  }

  const capability =
    store === undefined ? stockReversalWithoutStore() : stockReversalOverStore(store);

  context.capabilities.provide(STOCK_REVERSAL, capability);

  return capability;
}

export default defineLogicChild<StockReversal>({
  id: STOCK_REVERSAL_ID,
  parentId: INVENTORY_ENGINE_ID,
  provides: [STOCK_REVERSAL_ID],
  requires: [],
  create: createStockReversal,
});
