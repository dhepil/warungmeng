// packages/admin-engine/src/engines/inventory/inventoryOperations.ts
//
// Shared Inventory behavior used by sibling children. Operations may import the
// area's contracts; contracts never import operations.

import type { InventoryIngredient, InventoryStockBalance, Money } from "@warungmeng/domain";
import {
  applyStockDelta,
  areInventoryUnitsCompatible,
  calculateMovementBaseDelta,
  convertInventoryQuantity,
} from "@warungmeng/domain";
import type { OperationResult } from "@warungmeng/module-system";
import {
  operationFailure,
  operationIssue,
  operationSuccess,
} from "@warungmeng/module-system";
import type { StockMovementCommit, StockMovementDraftInput } from "./inventoryContracts";
import {
  INVENTORY_DECIMAL_PLACES,
  MOVEMENT_ISSUE,
  MOVEMENT_QUANTITY_MINIMUM,
  UNIT_COST_FLOOR,
} from "./inventoryContracts";

/**
 * Rounds an entered value to the area's decimal precision.
 *
 * SOURCE enforced this as `precision={2}` on the input widget, so it applied only
 * to values typed into that one dialog and nothing else — a movement submitted
 * any other way kept full float precision. Rounding here makes it a rule.
 *
 * Applies to what a caller ENTERS. A quantity the area derives (750 ml expressed
 * in litres is 0.75) is not re-rounded, and neither is money the area computes.
 */
export function roundEntered(value: number): number {
  const factor = 10 ** INVENTORY_DECIMAL_PLACES;
  // The `Number.EPSILON` nudge matches the domain's own `roundMoney`. Without it
  // a value like 1.005 — which is really 1.00499… in binary floating point —
  // rounds DOWN, so two places in one runtime would round the same input
  // differently. One rounding convention, as with diagnostic severity.
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * Recomputes an ingredient's weighted-average unit cost after a purchase.
 *
 * Ported from SOURCE `InMemoryInventoryRepository.recordMovement`, keeping the
 * arithmetic exactly: the pre-movement quantity weights the old average, the
 * purchased quantity weights the new unit cost, and a purchase into empty stock
 * takes the new cost outright. `Math.max(0, previousQuantity)` is SOURCE's too —
 * a negative starting balance is treated as empty rather than allowed to invert
 * the weighting.
 *
 * `previousQuantity` must be the balance BEFORE the delta is applied. SOURCE
 * depended on the same thing implicitly, by reading a variable it had already
 * overwritten in the array; here it is a parameter, so the requirement is visible.
 *
 * Deliberately NOT rounded, matching SOURCE. See `plan/tech-debt.md` — the value
 * feeds HPP and therefore prices, and rounding it would change every cost figure
 * the owner currently sees. That is a decision for the owner, not a port.
 */
export function recomputeAverageUnitCost(
  ingredient: InventoryIngredient,
  previousQuantity: number,
  purchasedBaseQuantity: number,
  baseUnitCost: number,
): { readonly lastPurchaseUnitCost: Money; readonly averageUnitCost: Money } {
  const held = Math.max(0, previousQuantity);
  const total = held + purchasedBaseQuantity;
  const average =
    total === 0
      ? baseUnitCost
      : (held * ingredient.averageUnitCost.amount + purchasedBaseQuantity * baseUnitCost) / total;

  return {
    lastPurchaseUnitCost: { amount: baseUnitCost, currency: ingredient.averageUnitCost.currency },
    averageUnitCost: { amount: average, currency: ingredient.averageUnitCost.currency },
  };
}

/**
 * Decides one stock movement in full, or explains why it cannot happen.
 *
 * This is the shared write primitive. It validates, computes, and assembles —
 * and touches nothing. The caller persists the returned commit through
 * `InventoryStorePort.commitMovement`, which is the only step that can leave a
 * trace, so a rejected movement changes nothing at all.
 *
 * That ordering is the fix for SOURCE's central defect. There, `recordMovement`
 * pushed a zero-quantity balance row for a new (ingredient, outlet) pair, THEN
 * applied the delta — so a movement rejected for negative stock left behind a
 * balance row that had not existed before, which in turn changed how that
 * ingredient answered the low-stock filter. A failed write silently altered query
 * results. Here the new zero row is only ever part of a plan; if validation fails,
 * the plan is discarded.
 *
 * Rules enforced, and where SOURCE kept each one:
 *
 *   - the ingredient must exist and be active — SOURCE: the store, kept
 *   - quantity finite and at least `MOVEMENT_QUANTITY_MINIMUM` — SOURCE: an AntD
 *     `min` rule, so logic accepted a zero-quantity movement that wrote a ledger
 *     row changing nothing
 *   - the entered quantity is rounded to 2 decimals — SOURCE: `precision={2}`
 *     on the widget only
 *   - the unit must share a dimension with the ingredient's base unit — SOURCE:
 *     the dropdown was pre-filtered, so the domain's check was unreachable and a
 *     non-UI caller bypassed it entirely
 *   - a purchase requires a unit cost — SOURCE: a conditionally rendered field,
 *     and the payload coerced a missing cost to zero, which would silently drag
 *     the weighted average toward zero
 *   - a unit cost may not be negative — SOURCE: `min={0}` on the widget
 *   - the resulting balance may not go negative — SOURCE: the domain, kept
 *
 * `allowNegativeStock` is not exposed. The domain parameter exists and defaults to
 * false; no SOURCE caller ever set it, not even a test. Threading a flag no
 * caller uses would be inventing a feature.
 */
export function planStockMovement(
  input: StockMovementDraftInput,
  ingredient: InventoryIngredient | null,
  balance: InventoryStockBalance | null,
  movementId: string,
): OperationResult<StockMovementCommit> {
  if (ingredient === null) {
    return operationFailure("not-found", [
      operationIssue(
        "ingredient-not-found",
        `Ingredient ${input.ingredientId} was not found.`,
        input.ingredientId,
      ),
    ]);
  }

  if (ingredient.status !== "active") {
    return operationFailure("conflict", [
      operationIssue(
        MOVEMENT_ISSUE.archivedIngredient,
        `${ingredient.name} is archived, so its stock cannot move.`,
        ingredient.id,
      ),
    ]);
  }

  if (!Number.isFinite(input.quantity)) {
    return operationFailure("invalid-input", [
      operationIssue(
        MOVEMENT_ISSUE.quantityNotFinite,
        "A movement quantity must be a finite number.",
        ingredient.id,
      ),
    ]);
  }

  // See `QuantitySource`: the rounding and the floor are rules about what a
  // person may type, not about what recipe arithmetic may produce.
  const entered = input.quantitySource === "entered";
  const quantity = entered ? roundEntered(input.quantity) : input.quantity;
  const minimum = entered ? MOVEMENT_QUANTITY_MINIMUM : 0;

  if (quantity < minimum || quantity === 0) {
    return operationFailure("invalid-input", [
      operationIssue(
        MOVEMENT_ISSUE.quantityTooSmall,
        entered
          ? `A movement must move at least ${MOVEMENT_QUANTITY_MINIMUM} ${input.unit}.`
          : "A movement must move a quantity greater than zero.",
        ingredient.id,
        { quantity, minimum },
      ),
    ]);
  }

  if (!areInventoryUnitsCompatible(input.unit, ingredient.baseUnit)) {
    return operationFailure("invalid-input", [
      operationIssue(
        MOVEMENT_ISSUE.incompatibleUnit,
        `${input.unit} cannot be converted to ${ingredient.baseUnit}.`,
        ingredient.id,
        { from: input.unit, to: ingredient.baseUnit },
      ),
    ]);
  }

  if (input.type === "purchase" && input.unitCost === null) {
    return operationFailure("invalid-input", [
      operationIssue(
        MOVEMENT_ISSUE.missingUnitCost,
        "A purchase must carry a unit cost, because it sets the ingredient's average cost.",
        ingredient.id,
      ),
    ]);
  }

  if (input.unitCost !== null && input.unitCost.amount < UNIT_COST_FLOOR) {
    return operationFailure("invalid-input", [
      operationIssue(
        MOVEMENT_ISSUE.negativeUnitCost,
        "A unit cost cannot be negative.",
        ingredient.id,
      ),
    ]);
  }

  const draft = { type: input.type, quantity, unit: input.unit };
  const baseQuantityDelta = calculateMovementBaseDelta(ingredient, draft);

  // The row a first-ever movement would create. It exists only inside this plan
  // until the caller commits, which is what stops a rejected movement from
  // leaving one behind.
  const current: InventoryStockBalance = balance ?? {
    ingredientId: input.ingredientId,
    outletId: input.outletId,
    quantity: 0,
    updatedAt: input.occurredAt,
  };

  let nextBalance: InventoryStockBalance;
  try {
    nextBalance = applyStockDelta(current, baseQuantityDelta);
  } catch {
    // The domain's own rejection, restated as a typed issue naming the numbers.
    // SOURCE let the RangeError reach a catch-all that showed one generic toast,
    // so "not enough stock" and "the backend is down" looked identical.
    return operationFailure("conflict", [
      operationIssue(
        MOVEMENT_ISSUE.negativeStock,
        `${ingredient.name} has ${current.quantity} ${ingredient.baseUnit}, which is not ` +
          `enough for this movement.`,
        ingredient.id,
        { available: current.quantity, delta: baseQuantityDelta },
      ),
    ]);
  }

  const costed =
    input.type === "purchase" && input.unitCost !== null
      ? recomputeAverageUnitCost(
          ingredient,
          current.quantity,
          Math.abs(baseQuantityDelta),
          input.unitCost.amount / convertInventoryQuantity(1, input.unit, ingredient.baseUnit),
        )
      : null;

  return operationSuccess({
    movement: {
      id: movementId,
      ingredientId: input.ingredientId,
      outletId: input.outletId,
      type: input.type,
      quantity,
      unit: input.unit,
      baseQuantityDelta,
      unitCost: input.unitCost,
      referenceId: input.referenceId,
      note: input.note,
      occurredAt: input.occurredAt,
    },
    balance: { ...nextBalance, updatedAt: input.occurredAt },
    ingredient: costed === null ? null : { ...ingredient, ...costed },
  });
}
