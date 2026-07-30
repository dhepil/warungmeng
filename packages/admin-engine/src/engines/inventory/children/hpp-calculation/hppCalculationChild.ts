// packages/admin-engine/src/engines/inventory/children/hpp-calculation/hppCalculationChild.ts
//
// Costing menus against their recipes (capability `admin.inventory.hpp-calculation`).
//
// The only inventory child that REQUIRES another area. LOGIC §8 gives it
// `admin.menu.catalog-read`, because a cost figure is meaningless without the
// menu's name and selling price — and that requirement is why the Menu area had
// to be built before this one.
//
// It is also the first child in the port to resolve a SIBLING AREA's capability
// rather than only an injected port. It does that the same way the Menu area's
// tests always did: by declaring the id in `requires` and resolving the token
// from its own context. It does not import anything from `engines/menu/`
// except the contract types — no child imports another child.
//
// Ported from SOURCE:
//   - apps/admin/src/features/inventory/application/useInventoryHpp.ts (the load,
//     the per-menu margin and recommended price, the no-recipe handling)
//   - packages/data/src/mocks/InMemoryInventoryRepository.ts `calculateHpp`
//   - apps/admin/src/features/inventory/application/ports/catalogReadPort.ts,
//     whose single `listMenus()` becomes the real capability requirement
//
// The arithmetic itself is the domain's (`calculateMenuHpp`,
// `calculateGrossMarginPercentage`, `calculateRecommendedSellingPrice`) and is not
// restated here.

import type { InventoryIngredient, MenuItem, MenuRecipe } from "@warungmeng/domain";
import {
  calculateGrossMarginPercentage,
  calculateMenuHpp,
  calculateRecommendedSellingPrice,
} from "@warungmeng/domain";
import type { LogicChildContext, OperationIssue, OperationResult } from "@warungmeng/module-system";
import {
  defineLogicChild,
  operationDegraded,
  operationFailure,
  operationIssue,
  operationSuccess,
  severityForCode,
} from "@warungmeng/module-system";
import { MENU_CATALOG_READ, MENU_CATALOG_READ_ID } from "../../../menu/menuContracts";
import type { CatalogRead } from "../../../menu/menuContracts";
import { INVENTORY_ENGINE_ID } from "../../inventoryEngine";
import type {
  HppCalculation,
  InventoryStorePort,
  MenuCostBreakdown,
  MenuCostCollection,
} from "../../inventoryContracts";
import {
  COSTING_ISSUE,
  HPP_CALCULATION,
  HPP_CALCULATION_ID,
  HPP_PRICE_ROUNDING_STEP,
  HPP_TARGET_MARGIN_PERCENTAGE,
  INVENTORY_STORE_PORT,
} from "../../inventoryContracts";

// ─── Costing one menu ────────────────────────────────────────────────────────

/**
 * Works out one menu's cost, never throwing.
 *
 * Three things here are corrections rather than ports.
 *
 * **A menu that cannot be costed does not take the others down.** The domain
 * throws for a missing ingredient, and `calculateRecommendedSellingPrice` throws
 * for a negative total — which is reachable, because packaging and additional
 * costs are unvalidated and merely added. SOURCE called both unguarded inside one
 * `Promise.all` wrapped in a single `catch`, so one bad recipe blanked the entire
 * table. Every throw is contained per menu here.
 *
 * **The pricing policy is named.** SOURCE relied on the domain's default
 * arguments, so "60% margin, round up to 500" was the product's pricing rule
 * expressed as library defaults at one call site. Passed explicitly now.
 *
 * **An archived ingredient is reported, not hidden.** SOURCE fed `calculateMenuHpp`
 * the unfiltered ingredient list, so an archived ingredient's cost silently
 * entered the total while being unselectable in the recipe editor — the displayed
 * figure could not be reconciled against anything the user could see. The cost is
 * still included, because excluding it would understate the total, but the reason
 * now travels with the row.
 */
export function costMenu(
  menu: MenuItem,
  recipe: MenuRecipe | null,
  ingredients: readonly InventoryIngredient[],
): MenuCostBreakdown {
  const base = {
    menuItemId: menu.id,
    menuName: menu.name,
    sellingPrice: menu.price,
  };

  if (recipe === null) {
    // Not a failure. SOURCE showed a dash, and so should any caller.
    return { ...base, hpp: null, marginPercentage: null, recommendedPrice: null, issues: [] };
  }

  const issues: OperationIssue[] = [];

  if (recipe.components.length === 0) {
    issues.push(
      operationIssue(
        COSTING_ISSUE.emptyRecipe,
        "This recipe has no ingredients, so its cost is packaging and extras only.",
        menu.id,
      ),
    );
  }

  const archived = recipe.components
    .map((component) => ingredients.find((entry) => entry.id === component.ingredientId))
    .filter(
      (ingredient): ingredient is InventoryIngredient =>
        ingredient !== undefined && ingredient.status === "archived",
    );

  for (const ingredient of archived) {
    issues.push(
      operationIssue(
        COSTING_ISSUE.archivedIngredient,
        `${ingredient.name} is archived but still priced into this recipe.`,
        ingredient.id,
      ),
    );
  }

  let hpp;
  try {
    hpp = calculateMenuHpp(recipe, ingredients);
  } catch (error) {
    return {
      ...base,
      hpp: null,
      marginPercentage: null,
      recommendedPrice: null,
      issues: [
        ...issues,
        operationIssue(
          COSTING_ISSUE.missingIngredient,
          error instanceof Error ? error.message : "This recipe could not be costed.",
          menu.id,
        ),
      ],
    };
  }

  const marginPercentage = calculateGrossMarginPercentage(menu.price.amount, hpp.total.amount);

  // Reachable: packaging and additional costs are unvalidated and simply added,
  // so a recipe can total below zero. SOURCE let this throw and lost every row.
  if (hpp.total.amount < 0) {
    return {
      ...base,
      hpp,
      marginPercentage,
      recommendedPrice: null,
      issues: [
        ...issues,
        operationIssue(
          COSTING_ISSUE.negativeTotal,
          "This recipe costs less than nothing, so no selling price can be recommended.",
          menu.id,
          { total: hpp.total.amount },
        ),
      ],
    };
  }

  return {
    ...base,
    hpp,
    marginPercentage,
    recommendedPrice: {
      amount: calculateRecommendedSellingPrice(
        hpp.total.amount,
        HPP_TARGET_MARGIN_PERCENTAGE,
        HPP_PRICE_ROUNDING_STEP,
      ),
      currency: hpp.total.currency,
    },
    issues,
  };
}

// ─── Store and catalog access ────────────────────────────────────────────────

const NO_STORE = "no-inventory-store";
const STORE_FAILED = "inventory-store-failed";

function noStore<TValue>(operation: string): OperationResult<TValue> {
  return operationFailure("unsatisfied-dependency", [
    operationIssue(
      NO_STORE,
      "No inventory store is connected, so menu costs cannot be worked out.",
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

function hppCalculationOverStore(
  store: InventoryStorePort,
  catalog: CatalogRead,
): HppCalculation {
  /** Everything costing needs, in one round trip rather than SOURCE's N+1. */
  async function load(): Promise<
    OperationResult<{
      menus: readonly MenuItem[];
      recipes: readonly MenuRecipe[];
      ingredients: readonly InventoryIngredient[];
    }>
  > {
    const menus = await catalog.listMenus();

    if (menus.status === "failure") {
      // The catalog is a required capability, so an unresolvable one is a real
      // dependency failure — but it is still reported rather than thrown, and the
      // menu area's own issues are carried through rather than flattened.
      return operationFailure("unsatisfied-dependency", [
        operationIssue(
          COSTING_ISSUE.noCatalog,
          "The menu catalog could not be read, so there are no menus to cost.",
          "queryMenuCosts",
        ),
        ...menus.issues,
      ]);
    }

    try {
      const [recipes, ingredients] = await Promise.all([
        store.listRecipes(),
        // Unfiltered on purpose: an archived ingredient's cost still belongs in
        // the total, and `costMenu` reports it rather than dropping it.
        store.listIngredients(),
      ]);

      return operationSuccess({ menus: menus.value, recipes, ingredients });
    } catch (error) {
      return storeFailed("load", error);
    }
  }

  return {
    async calculateMenuCost(menuItemId: string): Promise<OperationResult<MenuCostBreakdown>> {
      const loaded = await load();
      if (loaded.status === "failure") {
        return loaded;
      }

      const menu = loaded.value.menus.find((entry) => entry.id === menuItemId);
      if (menu === undefined) {
        return operationFailure("not-found", [
          operationIssue("menu-not-found", `Menu ${menuItemId} was not found.`, menuItemId),
        ]);
      }

      const recipe =
        loaded.value.recipes.find((entry) => entry.menuItemId === menuItemId) ?? null;
      const cost = costMenu(menu, recipe, loaded.value.ingredients);

      return operationDegraded(cost, cost.issues);
    },

    async queryMenuCosts(): Promise<OperationResult<MenuCostCollection>> {
      const loaded = await load();
      if (loaded.status === "failure") {
        return loaded;
      }

      const recipeByMenuItemId = new Map(
        loaded.value.recipes.map((recipe) => [recipe.menuItemId, recipe]),
      );

      const items: MenuCostBreakdown[] = [];
      const failedMenuItemIds: string[] = [];
      const issues: OperationIssue[] = [];

      for (const menu of loaded.value.menus) {
        const cost = costMenu(menu, recipeByMenuItemId.get(menu.id) ?? null, loaded.value.ingredients);
        items.push(cost);
        issues.push(...cost.issues);

        // A menu with a recipe that produced no cost figure could not be costed.
        // One with no recipe at all is simply uncosted, which is normal.
        if (cost.hpp === null && recipeByMenuItemId.has(menu.id)) {
          failedMenuItemIds.push(menu.id);
        }
      }

      // Degrades rather than failing: the rows that costed are still useful, and
      // the caller learns exactly which ones did not. SOURCE blanked the whole
      // table when any single menu threw.
      return operationDegraded({ items, failedMenuItemIds }, issues);
    },
  };
}

/**
 * The capability published when the store is missing.
 *
 * Note the asymmetry with the catalog: the catalog is a REQUIRED capability, so if
 * it is unavailable the dependency graph never creates this child at all and there
 * is nothing to publish. A missing store is different — it is an injected port, and
 * absent is a legal state — so the capability is still published and answers
 * honestly, exactly as every sibling does.
 */
function hppCalculationWithoutStore(): HppCalculation {
  return {
    calculateMenuCost: async () => noStore("calculateMenuCost"),
    queryMenuCosts: async () => noStore("queryMenuCosts"),
  };
}

export function createHppCalculation(context: LogicChildContext): HppCalculation {
  const store = context.ports.resolve(INVENTORY_STORE_PORT);
  const catalog = context.capabilities.resolve(MENU_CATALOG_READ);

  if (store === undefined) {
    context.diagnostics.report({
      code: "missing-dependency",
      severity: severityForCode("missing-dependency"),
      message:
        "No inventory store was supplied to the Inventory area, so menu costing returns a " +
        "normalized failure. The capability is published and callers stay working.",
      childId: context.childId,
      engineId: context.parentId,
      source: "hppCalculationChild",
    });
  }

  // `requires` means the runtime will not create this child unless the catalog was
  // published, so an unavailable resolution here is a contradiction rather than a
  // state to design for — reported, not silently tolerated.
  const capability =
    store === undefined || catalog.status !== "available"
      ? hppCalculationWithoutStore()
      : hppCalculationOverStore(store, catalog.value);

  context.capabilities.provide(HPP_CALCULATION, capability);

  return capability;
}

export default defineLogicChild<HppCalculation>({
  id: HPP_CALCULATION_ID,
  parentId: INVENTORY_ENGINE_ID,
  provides: [HPP_CALCULATION_ID],
  requires: [MENU_CATALOG_READ_ID],
  create: createHppCalculation,
});
