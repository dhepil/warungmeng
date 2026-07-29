// packages/domain/src/inventory.ts
//
// Ported from SOURCE packages/domain/src/inventory/{types,units,stock}.ts, consolidated
// per new-target LOGIC-TARGET-FILE-TREE.md §4. Pure TypeScript: inventory + recipe types,
// unit conversion, and stock-movement math. No I/O.
//
// NOTE on HPP: the SOURCE kept cost-of-goods (HPP) math under inventory/hpp.ts. Per the
// roadmap, the HPP *calculation functions* are ported into finance.ts (slice S4). The
// recipe/HPP *types* below (MenuRecipe, RecipeComponent, MenuHppBreakdown,
// RecipeIngredientCost) stay here because they describe inventory recipes; finance.ts
// imports them plus convertInventoryQuantity from this module.

import type { Money } from "./catalog";

// ─── Types ───────────────────────────────────────────────────────────────────

export type InventoryUnit = "g" | "kg" | "ml" | "l" | "piece" | "portion";
export type InventoryIngredientStatus = "active" | "archived";
export type InventoryMovementType =
  | "purchase"
  | "consumption"
  | "adjustment-in"
  | "adjustment-out"
  | "waste";

export interface InventorySupplier {
  readonly id: string;
  readonly name: string;
  readonly phone: string;
}

export interface InventoryIngredient {
  readonly id: string;
  readonly name: string;
  readonly baseUnit: InventoryUnit;
  readonly supplierId: string | null;
  readonly status: InventoryIngredientStatus;
  readonly minimumStock: number;
  readonly lastPurchaseUnitCost: Money;
  readonly averageUnitCost: Money;
}

export interface InventoryStockBalance {
  readonly ingredientId: string;
  readonly outletId: string;
  readonly quantity: number;
  readonly updatedAt: string;
}

export interface InventoryMovement {
  readonly id: string;
  readonly ingredientId: string;
  readonly outletId: string;
  readonly type: InventoryMovementType;
  readonly quantity: number;
  readonly unit: InventoryUnit;
  readonly baseQuantityDelta: number;
  readonly unitCost: Money | null;
  readonly referenceId: string | null;
  readonly note: string;
  readonly occurredAt: string;
}

export interface RecipeComponent {
  readonly id: string;
  readonly ingredientId: string;
  readonly quantity: number;
  readonly unit: InventoryUnit;
  readonly wastePercentage: number;
}

export interface MenuRecipe {
  readonly menuItemId: string;
  readonly components: readonly RecipeComponent[];
  readonly packagingCost: Money;
  readonly additionalCost: Money;
  readonly updatedAt: string;
}

export interface RecipeIngredientCost {
  readonly ingredientId: string;
  readonly baseQuantity: number;
  readonly cost: Money;
}

export interface MenuHppBreakdown {
  readonly menuItemId: string;
  readonly ingredientCosts: readonly RecipeIngredientCost[];
  readonly ingredientTotal: Money;
  readonly packagingCost: Money;
  readonly additionalCost: Money;
  readonly total: Money;
}

// ─── Unit conversion ─────────────────────────────────────────────────────────

type UnitDimension = "mass" | "volume" | "count";

const UNIT_DEFINITIONS: Record<
  InventoryUnit,
  { readonly dimension: UnitDimension; readonly canonicalFactor: number }
> = {
  g: { dimension: "mass", canonicalFactor: 1 },
  kg: { dimension: "mass", canonicalFactor: 1000 },
  ml: { dimension: "volume", canonicalFactor: 1 },
  l: { dimension: "volume", canonicalFactor: 1000 },
  piece: { dimension: "count", canonicalFactor: 1 },
  portion: { dimension: "count", canonicalFactor: 1 },
};

export const INVENTORY_UNITS = Object.freeze(Object.keys(UNIT_DEFINITIONS) as InventoryUnit[]);

export function areInventoryUnitsCompatible(source: InventoryUnit, target: InventoryUnit): boolean {
  return UNIT_DEFINITIONS[source].dimension === UNIT_DEFINITIONS[target].dimension;
}

export function convertInventoryQuantity(
  quantity: number,
  source: InventoryUnit,
  target: InventoryUnit,
): number {
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new RangeError("Inventory quantity must be a finite non-negative number");
  }
  if (!areInventoryUnitsCompatible(source, target)) {
    throw new RangeError(`Cannot convert inventory unit ${source} to ${target}`);
  }

  return (
    (quantity * UNIT_DEFINITIONS[source].canonicalFactor) / UNIT_DEFINITIONS[target].canonicalFactor
  );
}

// ─── Stock movements ─────────────────────────────────────────────────────────

export interface StockMovementDraft {
  readonly type: InventoryMovementType;
  readonly quantity: number;
  readonly unit: InventoryUnit;
}

const OUTBOUND_TYPES: readonly InventoryMovementType[] = ["consumption", "adjustment-out", "waste"];

export function calculateMovementBaseDelta(
  ingredient: InventoryIngredient,
  movement: StockMovementDraft,
): number {
  const baseQuantity = convertInventoryQuantity(
    movement.quantity,
    movement.unit,
    ingredient.baseUnit,
  );
  return OUTBOUND_TYPES.includes(movement.type) ? -baseQuantity : baseQuantity;
}

export function applyStockDelta(
  balance: InventoryStockBalance,
  baseQuantityDelta: number,
  allowNegativeStock = false,
): InventoryStockBalance {
  if (!Number.isFinite(baseQuantityDelta)) {
    throw new RangeError("Stock delta must be finite");
  }

  const quantity = balance.quantity + baseQuantityDelta;
  if (!allowNegativeStock && quantity < 0) {
    throw new RangeError("Stock movement would create a negative balance");
  }

  return { ...balance, quantity };
}

export function isLowStock(
  ingredient: InventoryIngredient,
  balance: InventoryStockBalance,
): boolean {
  return balance.quantity <= ingredient.minimumStock;
}
