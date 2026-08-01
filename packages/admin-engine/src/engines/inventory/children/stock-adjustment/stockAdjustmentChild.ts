// packages/admin-engine/src/engines/inventory/children/stock-adjustment/stockAdjustmentChild.ts
//
// Manual stock writing (capability `admin.inventory.stock-adjustment`).
//
// LOGIC §8 names no capability for this child, so it takes its own id. Nothing
// requires it: it is the entry point a person uses, not one another child calls.
//
// Ported from SOURCE:
//   - packages/data/src/mocks/InMemoryInventoryRepository.ts (`recordMovement`,
//     `createIngredient`, `updateIngredient`, `archiveIngredient`)
//   - apps/admin/src/features/inventory/application/useInventoryMaterials.ts and
//     useInventoryMovements.ts (the save/archive/record call paths)
//   - apps/admin/src/features/inventory/components/InventoryMovementDialog.tsx
//     and InventoryMaterialEditorDialog.tsx — where most of this area's actual
//     RULES were living, as AntD form props. See `inventoryContracts.ts`.
//
// The decision-making is NOT here. `planStockMovement` in the area operations
// validates and computes every movement, because S5's consumption and reversal
// go through the same primitive and LOGIC §8 shows neither of them requiring a
// capability from a sibling — so the invariants cannot live in this child. This
// file is the manual entry point over that primitive: read what the plan needs,
// plan, commit, report.

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
  CreateIngredientInput,
  IngredientValues,
  InventoryStorePort,
  RecordMovementInput,
  StockAdjustment,
} from "../../inventoryContracts";
import {
  INVENTORY_STORE_PORT,
  MINIMUM_STOCK_FLOOR,
  STOCK_ADJUSTMENT,
  STOCK_ADJUSTMENT_ID,
  UNIT_COST_FLOOR,
} from "../../inventoryContracts";
import { planStockMovement, roundEntered } from "../../inventoryOperations";

// ─── Ingredient validation ───────────────────────────────────────────────────
//
// Exported for the test beside this file. Every rule here was an AntD form prop
// in SOURCE, which meant a caller not going through that one dialog skipped it —
// and the store itself validated nothing at all on any ingredient write.

const NAME_REQUIRED = "ingredient-name-required";
const MINIMUM_STOCK_NEGATIVE = "minimum-stock-negative";
const MINIMUM_STOCK_NOT_FINITE = "minimum-stock-not-finite";
const UNIT_COST_NEGATIVE = "unit-cost-negative";

/**
 * Checks an ingredient's editable values.
 *
 * The name is trimmed before being checked and stored, as SOURCE's submit handler
 * did — but SOURCE relied on a `whitespace: true` rule to reject a blank one, so
 * only that form enforced it.
 *
 * `minimumStock` is rounded to the area's precision rather than rejected for
 * having too many decimals: SOURCE's `precision={2}` rounded silently, so
 * rejecting would be stricter than the behavior being ported.
 *
 * No length cap on the name. Unlike the Menu area, SOURCE's inventory forms
 * carried no `maxLength` at all, so inventing one would add a rule rather than
 * move one.
 */
export function validateIngredientValues(
  values: IngredientValues,
): OperationResult<IngredientValues> {
  const name = values.name.trim();

  if (name.length === 0) {
    return operationFailure("invalid-input", [
      operationIssue(NAME_REQUIRED, "An ingredient needs a name."),
    ]);
  }

  if (!Number.isFinite(values.minimumStock)) {
    return operationFailure("invalid-input", [
      operationIssue(MINIMUM_STOCK_NOT_FINITE, "The minimum stock must be a finite number."),
    ]);
  }

  const minimumStock = roundEntered(values.minimumStock);

  if (minimumStock < MINIMUM_STOCK_FLOOR) {
    return operationFailure("invalid-input", [
      operationIssue(MINIMUM_STOCK_NEGATIVE, "The minimum stock cannot be negative."),
    ]);
  }

  return operationSuccess({ ...values, name, minimumStock });
}

// ─── Store access ────────────────────────────────────────────────────────────

const NO_STORE = "no-inventory-store";
const STORE_FAILED = "inventory-store-failed";
const NOT_FOUND = "ingredient-not-found";
const ALREADY_ARCHIVED = "ingredient-already-archived";

function noStore<TValue>(operation: string): OperationResult<TValue> {
  return operationFailure("unsatisfied-dependency", [
    operationIssue(
      NO_STORE,
      "No inventory store is connected, so stock cannot be written.",
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

function notFound<TValue>(ingredientId: string): OperationResult<TValue> {
  return operationFailure("not-found", [
    operationIssue(NOT_FOUND, `Ingredient ${ingredientId} was not found.`, ingredientId),
  ]);
}

function stockAdjustmentOverStore(store: InventoryStorePort): StockAdjustment {
  return {
    /**
     * Records one movement.
     *
     * The order is read → plan → commit, and it matters. Everything that can be
     * rejected is rejected before the store is touched, so a refused movement
     * leaves nothing behind. SOURCE's equivalent pushed a zero-quantity balance
     * row for a new (ingredient, outlet) pair BEFORE applying the delta, so a
     * movement refused for insufficient stock permanently created a balance row
     * that had not existed — which then changed how that ingredient answered the
     * low-stock filter. A failed write altered query results.
     */
    async recordMovement(input: RecordMovementInput): Promise<OperationResult<InventoryMovement>> {
      let plan: ReturnType<typeof planStockMovement>;

      try {
        const [ingredient, balances] = await Promise.all([
          store.getIngredientById(input.ingredientId),
          store.listStockBalances(input.outletId),
        ]);

        plan = planStockMovement(
          // A person typed this quantity, so the form's rounding and 0.01 floor
          // apply. Consumption passes "derived" instead — see `QuantitySource`.
          { ...input, quantitySource: "entered", referenceId: null },
          ingredient,
          balances.find(
            (balance) =>
              balance.ingredientId === input.ingredientId && balance.outletId === input.outletId,
          ) ?? null,
          store.newId("movement"),
        );
      } catch (error) {
        return storeFailed("recordMovement", error);
      }

      if (plan.status === "failure") {
        return plan;
      }

      try {
        await store.commitMovement(plan.value);
      } catch (error) {
        return storeFailed("commitMovement", error);
      }

      return operationSuccess(plan.value.movement);
    },

    /**
     * Creates an ingredient with its opening cost.
     *
     * This is the only place a cost is written directly; every later change comes
     * from a purchase movement. Both cost fields start at the opening value, as
     * SOURCE did.
     */
    async createIngredient(
      input: CreateIngredientInput,
    ): Promise<OperationResult<InventoryIngredient>> {
      const checked = validateIngredientValues(input.values);
      if (checked.status === "failure") {
        return checked;
      }

      if (!Number.isFinite(input.initialUnitCost.amount)) {
        return operationFailure("invalid-input", [
          operationIssue(UNIT_COST_NEGATIVE, "The opening cost must be a finite number."),
        ]);
      }

      if (input.initialUnitCost.amount < UNIT_COST_FLOOR) {
        return operationFailure("invalid-input", [
          operationIssue(UNIT_COST_NEGATIVE, "The opening cost cannot be negative."),
        ]);
      }

      const cost = {
        amount: roundEntered(input.initialUnitCost.amount),
        currency: input.initialUnitCost.currency,
      };

      try {
        return operationSuccess(
          await store.createIngredient({
            ...checked.value,
            status: "active",
            lastPurchaseUnitCost: cost,
            averageUnitCost: cost,
          }),
        );
      } catch (error) {
        return storeFailed("createIngredient", error);
      }
    },

    /**
     * Edits an ingredient's non-cost fields.
     *
     * The patch type excludes both cost fields, so "cost cannot be edited after
     * creation" is structural rather than advisory. SOURCE expressed that intent
     * three ways — a `disabled` input, the hook omitting the keys, and an `Omit`
     * on its update type — and only the last had force.
     *
     * A `null` from the store means the row is gone. SOURCE's hook ignored that
     * null and showed a success toast, so editing a deleted ingredient looked
     * like it worked.
     */
    async updateIngredient(
      ingredientId: string,
      values: IngredientValues,
    ): Promise<OperationResult<InventoryIngredient>> {
      const checked = validateIngredientValues(values);
      if (checked.status === "failure") {
        return checked;
      }

      try {
        const updated = await store.updateIngredient(ingredientId, checked.value);
        return updated === null ? notFound(ingredientId) : operationSuccess(updated);
      } catch (error) {
        return storeFailed("updateIngredient", error);
      }
    },

    /**
     * Archives an ingredient, refusing one that is already archived.
     *
     * In SOURCE the only thing preventing a second archive was a conditionally
     * rendered button; the store set `status: "archived"` unconditionally and
     * reported success. Any non-UI caller could re-archive, and the response was
     * indistinguishable from a real archive.
     */
    async archiveIngredient(
      ingredientId: string,
    ): Promise<OperationResult<InventoryIngredient>> {
      try {
        const ingredient = await store.getIngredientById(ingredientId);

        if (ingredient === null) {
          return notFound(ingredientId);
        }

        if (ingredient.status === "archived") {
          return operationFailure("conflict", [
            operationIssue(
              ALREADY_ARCHIVED,
              `${ingredient.name} is already archived.`,
              ingredientId,
            ),
          ]);
        }

        const updated = await store.updateIngredient(ingredientId, { status: "archived" });
        return updated === null ? notFound(ingredientId) : operationSuccess(updated);
      } catch (error) {
        return storeFailed("archiveIngredient", error);
      }
    },
  };
}

/**
 * The capability published when no store is connected — same reasoning as the
 * area's read children: the child declared no requirements, so it loads and
 * publishes, and a caller gets an honest "no store" answer.
 */
function stockAdjustmentWithoutStore(): StockAdjustment {
  return {
    recordMovement: async () => noStore("recordMovement"),
    createIngredient: async () => noStore("createIngredient"),
    updateIngredient: async () => noStore("updateIngredient"),
    archiveIngredient: async () => noStore("archiveIngredient"),
  };
}

export function createStockAdjustment(context: LogicChildContext): StockAdjustment {
  const store = context.ports.resolve(INVENTORY_STORE_PORT);

  if (store === undefined) {
    // Reported once, at creation, rather than on every call.
    context.diagnostics.report({
      code: "missing-dependency",
      severity: severityForCode("missing-dependency"),
      message:
        "No inventory store was supplied to the Inventory area, so stock writes return a " +
        "normalized failure. The capability is published and callers stay working.",
      childId: context.childId,
      engineId: context.parentId,
      source: "stockAdjustmentChild",
    });
  }

  const capability =
    store === undefined ? stockAdjustmentWithoutStore() : stockAdjustmentOverStore(store);

  context.capabilities.provide(STOCK_ADJUSTMENT, capability);

  return capability;
}

export default defineLogicChild<StockAdjustment>({
  id: STOCK_ADJUSTMENT_ID,
  parentId: INVENTORY_ENGINE_ID,
  provides: [STOCK_ADJUSTMENT_ID],
  requires: [],
  create: createStockAdjustment,
});
