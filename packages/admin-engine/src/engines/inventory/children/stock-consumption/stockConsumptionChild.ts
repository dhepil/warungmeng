// packages/admin-engine/src/engines/inventory/children/stock-consumption/stockConsumptionChild.ts
//
// Consuming an order's ingredients (capability `admin.inventory.stock-consumption`,
// required by `admin.pos.checkout` per LOGIC §8).
//
// Ported from SOURCE `packages/data/src/mocks/InMemoryInventoryRepository.ts`
// `consumeOrder`, plus the retry path in
// `apps/admin/src/features/pos/application/usePosCashier.ts`.
//
// The invariants are NOT here. Every row goes through `planStockMovement` in the
// area contracts, the same primitive the manual adjustment uses — which is the
// whole reason it lives at area level (see the comment on it, and tech-debt D10).
// This child owns three things SOURCE got wrong, and nothing else: what a recipe
// component costs in stock, whether an order has already been consumed, and the
// fact that the rows are one accounting event rather than N.

import type {
  InventoryIngredient,
  InventoryStockBalance,
  MenuRecipe,
  Order,
  RecipeComponent,
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
  StockConsumption,
  StockLedgerOutcome,
  StockMovementCommit,
} from "../../inventoryContracts";
import {
  CONSUMPTION_ISSUE,
  INVENTORY_STORE_PORT,
  planStockMovement,
  STOCK_CONSUMPTION,
  STOCK_CONSUMPTION_ID,
} from "../../inventoryContracts";

// ─── What a recipe component costs in stock ───────────────────────────────────

/**
 * SOURCE's arithmetic, unchanged:
 * `component.quantity * item.quantity * (1 + wastePercentage / 100)`.
 *
 * Waste is applied per unit ordered, in the component's own unit; the conversion
 * into the ingredient's base unit happens inside `planStockMovement`.
 */
export function consumptionQuantity(component: RecipeComponent, orderedQuantity: number): number {
  return component.quantity * orderedQuantity * (1 + component.wastePercentage / 100);
}

/** Balances are keyed by the pair, not by ingredient alone. */
function balanceKey(ingredientId: string, outletId: string): string {
  return `${ingredientId}:${outletId}`;
}

// ─── Planning the whole order ────────────────────────────────────────────────

/** What planning an order produced: every row to write, or the first refusal. */
export interface OrderConsumptionPlan {
  readonly commits: readonly StockMovementCommit[];
  readonly skippedMenuItemIds: readonly string[];
}

/**
 * Plans every row for an order, or refuses the whole order.
 *
 * Two things here are corrections to SOURCE rather than ports of it.
 *
 * **The plan validates exactly what the write validates.** SOURCE ran a "projected
 * balances" dry run first, so an order short on stock failed before anything was
 * written — but the projection only checked that each ingredient EXISTED, while
 * the real write additionally refused archived ingredients. A recipe naming an
 * archived ingredient therefore passed the dry run and threw partway through the
 * write loop, leaving some components consumed and the rest not. Here there is no
 * separate projection to disagree with: `planStockMovement` is the one judge, and
 * it runs over every row before any of them is committed.
 *
 * **The running balance carries forward.** Two components of one order can name the
 * same ingredient, and each has to see the balance the previous one left. SOURCE's
 * projection did accumulate correctly; the point is that this now happens in the
 * same pass that validates, so the accumulated figure and the committed figure
 * cannot drift apart.
 *
 * Refuses the entire order on the first component that cannot be satisfied,
 * matching SOURCE's all-or-nothing intent. A half-consumed order is a worse state
 * than a refused one.
 */
export function planOrderConsumption(
  order: Order,
  recipes: readonly MenuRecipe[],
  ingredients: readonly InventoryIngredient[],
  balances: readonly InventoryStockBalance[],
  newMovementId: () => string,
): OperationResult<OrderConsumptionPlan> {
  const recipeByMenuItemId = new Map(recipes.map((recipe) => [recipe.menuItemId, recipe]));
  const ingredientById = new Map(ingredients.map((ingredient) => [ingredient.id, ingredient]));

  const runningBalances = new Map(
    balances.map((balance) => [balanceKey(balance.ingredientId, balance.outletId), balance]),
  );

  const commits: StockMovementCommit[] = [];
  const skippedMenuItemIds: string[] = [];

  for (const item of order.items) {
    const recipe = recipeByMenuItemId.get(item.menuItemId);

    if (recipe === undefined || recipe.components.length === 0) {
      // SOURCE skipped this in silence, which is how an order of entirely
      // recipe-less items wrote zero rows — and then, because its guard keyed on
      // rows existing, never latched, so every retry re-ran the whole thing.
      // Named here so the caller can see it and the outcome can report it.
      skippedMenuItemIds.push(item.menuItemId);
      continue;
    }

    for (const component of recipe.components) {
      const key = balanceKey(component.ingredientId, order.outletId);

      const plan = planStockMovement(
        {
          ingredientId: component.ingredientId,
          outletId: order.outletId,
          type: "consumption",
          quantity: consumptionQuantity(component, item.quantity),
          // Recipe arithmetic, not a typed figure — so the form's rounding and
          // 0.01 floor do not apply. See `QuantitySource`.
          quantitySource: "derived",
          unit: component.unit,
          unitCost: null,
          referenceId: order.id,
          note: `POS ${order.orderNumber}`,
          occurredAt: order.createdAt,
        },
        ingredientById.get(component.ingredientId) ?? null,
        runningBalances.get(key) ?? null,
        newMovementId(),
      );

      if (plan.status === "failure") {
        return plan;
      }

      commits.push(plan.value);
      runningBalances.set(key, plan.value.balance);
    }
  }

  return operationSuccess({ commits, skippedMenuItemIds });
}

// ─── Store access ────────────────────────────────────────────────────────────

const NO_STORE = "no-inventory-store";
const STORE_FAILED = "inventory-store-failed";

function noStore<TValue>(operation: string): OperationResult<TValue> {
  return operationFailure("unsatisfied-dependency", [
    operationIssue(
      NO_STORE,
      "No inventory store is connected, so order stock cannot be consumed.",
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

function stockConsumptionOverStore(store: InventoryStorePort): StockConsumption {
  return {
    async consumeOrder(order: Order): Promise<OperationResult<StockLedgerOutcome>> {
      let plan: ReturnType<typeof planOrderConsumption>;

      try {
        // The idempotency check is now a query, not a scan of every movement ever
        // recorded (tech-debt D14, closed in S5a).
        const already = await store.listMovements({
          referenceId: order.id,
          type: "consumption",
        });

        if (already.length > 0) {
          // SOURCE returned these rows and said nothing, so a caller could not
          // tell a replay from a fresh write — which is how its retry reported
          // success for an order it had not finished.
          return operationDegraded(
            { movements: already, replayed: true, skippedMenuItemIds: [] },
            [
              operationIssue(
                CONSUMPTION_ISSUE.alreadyConsumed,
                `Order ${order.orderNumber} has already been consumed; nothing was written.`,
                order.id,
                { movementCount: already.length },
              ),
            ],
          );
        }

        const [recipes, ingredients, balances] = await Promise.all([
          store.listRecipes(),
          store.listIngredients(),
          store.listStockBalances(order.outletId),
        ]);

        plan = planOrderConsumption(order, recipes, ingredients, balances, () =>
          store.newId("movement"),
        );
      } catch (error) {
        return storeFailed("consumeOrder", error);
      }

      if (plan.status === "failure") {
        return plan;
      }

      const { commits, skippedMenuItemIds } = plan.value;

      if (commits.length === 0) {
        // Nothing to write. Reported as a failure rather than an empty success:
        // in SOURCE this returned [] and left no trace, so the guard never
        // latched and every retry re-ran it. A caller has to know that this
        // order consumes nothing, or it will keep asking.
        return operationFailure("invalid-input", [
          operationIssue(
            CONSUMPTION_ISSUE.nothingToConsume,
            `No item in order ${order.orderNumber} has a recipe, so no stock was consumed.`,
            order.id,
            { skippedMenuItemCount: skippedMenuItemIds.length },
          ),
        ]);
      }

      try {
        // One call, so the caller's atomic boundary (LOGIC §10, owned by POS
        // checkout) has a single thing to wrap. SOURCE wrote these one at a time.
        await store.commitMovements(commits);
      } catch (error) {
        return storeFailed("commitMovements", error);
      }

      const outcome: StockLedgerOutcome = {
        movements: commits.map((commit) => commit.movement),
        replayed: false,
        skippedMenuItemIds,
      };

      // Degrades when some items had no recipe: the stock that moved is correct,
      // but the order was not fully costed and someone should know which items.
      return operationDegraded(
        outcome,
        skippedMenuItemIds.map((menuItemId) =>
          operationIssue(
            CONSUMPTION_ISSUE.noRecipe,
            "This menu item has no recipe, so it consumed no stock.",
            menuItemId,
          ),
        ),
      );
    },
  };
}

/**
 * The capability published when no store is connected — same reasoning as every
 * other child in this area: it declared no requirements, so it loads and
 * publishes, and the caller gets an honest "no store" answer.
 */
function stockConsumptionWithoutStore(): StockConsumption {
  return {
    consumeOrder: async () => noStore("consumeOrder"),
  };
}

export function createStockConsumption(context: LogicChildContext): StockConsumption {
  const store = context.ports.resolve(INVENTORY_STORE_PORT);

  if (store === undefined) {
    context.diagnostics.report({
      code: "missing-dependency",
      severity: severityForCode("missing-dependency"),
      message:
        "No inventory store was supplied to the Inventory area, so order consumption returns " +
        "a normalized failure. The capability is published and callers stay working.",
      childId: context.childId,
      engineId: context.parentId,
      source: "stockConsumptionChild",
    });
  }

  const capability =
    store === undefined ? stockConsumptionWithoutStore() : stockConsumptionOverStore(store);

  context.capabilities.provide(STOCK_CONSUMPTION, capability);

  return capability;
}

export default defineLogicChild<StockConsumption>({
  id: STOCK_CONSUMPTION_ID,
  parentId: INVENTORY_ENGINE_ID,
  provides: [STOCK_CONSUMPTION_ID],
  requires: [],
  create: createStockConsumption,
});
