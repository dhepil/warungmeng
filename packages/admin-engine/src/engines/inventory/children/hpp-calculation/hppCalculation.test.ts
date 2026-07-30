// packages/admin-engine/src/engines/inventory/children/hpp-calculation/hppCalculation.test.ts
//
// Protected behavior for costing menus against their recipes.
//
// This is the first test in the port that composes TWO areas. `hpp-calculation`
// declares `admin.menu.catalog-read` in `requires`, so the runtime must hold the
// Menu area as well — which makes this the first real end-to-end check that the
// cross-area capability wiring LOGIC §8 describes actually works, rather than
// being merely declared.
//
// Two load-bearing sections: "one bad recipe does not take the others down" (the
// policy SOURCE had two contradictory versions of), and "the child is not created
// at all without its required capability".
//
// No React, no DOM, no renderer (LOGIC §6).

import { describe, expect, it } from "vitest";
import type {
  InventoryIngredient,
  MenuCategory,
  MenuItem,
  MenuRecipe,
  MenuVariantGroup,
  Money,
  RecipeComponent,
} from "@warungmeng/domain";
import { defineLogicChild } from "@warungmeng/module-system";
import type { AdminEngineSnapshot } from "../../../../adminEngineContracts";
import { createAdminEngine } from "../../../../createAdminEngine";
import type { MenuCatalogPort } from "../../../menu/menuContracts";
import { MENU_CATALOG_PORT } from "../../../menu/menuContracts";
import menuEngine from "../../../menu/menuEngine";
import catalogReadChild from "../../../menu/children/catalog-read/catalogReadChild";
import type { HppCalculation, InventoryStorePort } from "../../inventoryContracts";
import {
  COSTING_ISSUE,
  HPP_CALCULATION,
  HPP_CALCULATION_ID,
  INVENTORY_STORE_PORT,
} from "../../inventoryContracts";
import inventoryEngine from "../../inventoryEngine";
import hppCalculationChild, { costMenu } from "./hppCalculationChild";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const IDR = (amount: number): Money => ({ amount, currency: "IDR" });

function menu(overrides: Partial<MenuItem> & Pick<MenuItem, "id" | "name">): MenuItem {
  return {
    slug: overrides.id,
    categoryId: "cat-food",
    description: "",
    image: null,
    price: IDR(20_000),
    compareAtPrice: null,
    availability: { status: "available" },
    inventory: { mode: "untracked" },
    visibility: "visible",
    salesSchedule: { mode: "always" },
    variantGroupIds: [],
    sortOrder: 0,
    ...overrides,
  };
}

function ingredient(
  overrides: Partial<InventoryIngredient> & Pick<InventoryIngredient, "id" | "name">,
): InventoryIngredient {
  return {
    baseUnit: "g",
    supplierId: null,
    status: "active",
    minimumStock: 0,
    lastPurchaseUnitCost: IDR(10),
    averageUnitCost: IDR(10),
    ...overrides,
  };
}

function component(
  overrides: Partial<RecipeComponent> & Pick<RecipeComponent, "ingredientId">,
): RecipeComponent {
  return {
    id: `rc-${overrides.ingredientId}`,
    quantity: 100,
    unit: "g",
    wastePercentage: 0,
    ...overrides,
  };
}

function recipe(overrides: Partial<MenuRecipe> & Pick<MenuRecipe, "menuItemId">): MenuRecipe {
  return {
    components: [component({ ingredientId: "i1" })],
    packagingCost: IDR(0),
    additionalCost: IDR(0),
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function inventoryStoreOver(seed: {
  recipes?: readonly MenuRecipe[];
  ingredients?: readonly InventoryIngredient[];
  failRecipes?: boolean;
}): InventoryStorePort {
  const unsupported = (): never => {
    throw new Error("not used by hpp-calculation");
  };

  return {
    listIngredients: async () => seed.ingredients ?? [],
    getIngredientById: async (id) =>
      (seed.ingredients ?? []).find((entry) => entry.id === id) ?? null,
    createIngredient: unsupported,
    updateIngredient: unsupported,
    listSuppliers: async () => [],
    listStockBalances: async () => [],
    listMovements: async () => [],
    listRecipes: async () => {
      if (seed.failRecipes === true) {
        throw new Error("recipes unavailable");
      }
      return seed.recipes ?? [];
    },
    commitMovement: unsupported,
    commitMovements: unsupported,
    newId: (kind) => `${kind}-test`,
  };
}

function menuStoreOver(menus: readonly MenuItem[], fail = false): MenuCatalogPort {
  const unsupported = (): never => {
    throw new Error("not used by hpp-calculation");
  };

  return {
    listMenus: async () => {
      if (fail) {
        throw new Error("catalog unavailable");
      }
      return menus;
    },
    getMenuById: async (id) => menus.find((entry) => entry.id === id) ?? null,
    createMenu: unsupported,
    updateMenu: unsupported,
    deleteMenu: unsupported,
    listCategories: async (): Promise<readonly MenuCategory[]> => [],
    getCategoryById: async () => null,
    createCategory: unsupported,
    updateCategory: unsupported,
    deleteCategory: unsupported,
    listVariantGroups: async (): Promise<readonly MenuVariantGroup[]> => [],
    getVariantGroupById: async () => null,
    createVariantGroup: unsupported,
    updateVariantGroup: unsupported,
    deleteVariantGroup: unsupported,
    newId: (kind) => `${kind}-test`,
  };
}

/**
 * Composes a runtime holding BOTH areas, so the cross-area requirement is real.
 *
 * `withMenuArea: false` deliberately leaves the Menu area out, which is how the
 * "not created without its requirement" case is exercised — the dependency graph
 * should exclude this child rather than let it publish a broken capability.
 */
function runtimeWith(options: {
  inventoryStore?: InventoryStorePort;
  menuStore?: MenuCatalogPort;
  withMenuArea?: boolean;
}): {
  readonly costing: HppCalculation | undefined;
  readonly snapshot: AdminEngineSnapshot;
  readonly dispose: () => void;
} {
  const withMenuArea = options.withMenuArea !== false;
  let captured: HppCalculation | undefined;

  const probe = defineLogicChild({
    id: "admin.inventory.test-probe",
    parentId: inventoryEngine.id,
    requires: [HPP_CALCULATION_ID],
    create(context) {
      const resolution = context.capabilities.resolve(HPP_CALCULATION);
      if (resolution.status === "available") {
        captured = resolution.value;
      }
      return undefined;
    },
  });

  const engine = createAdminEngine({
    definitions: {
      engines: withMenuArea ? [inventoryEngine, menuEngine] : [inventoryEngine],
      children: withMenuArea
        ? [hppCalculationChild, catalogReadChild, probe]
        : [hppCalculationChild, probe],
    },
    ports: {
      resolve: (token) => {
        if (token.id === INVENTORY_STORE_PORT.id) {
          return (options.inventoryStore as never) ?? undefined;
        }
        if (token.id === MENU_CATALOG_PORT.id) {
          return (options.menuStore as never) ?? undefined;
        }
        return undefined;
      },
    },
  });

  return { costing: captured, snapshot: engine.getSnapshot(), dispose: engine.dispose };
}

// ─── Costing one menu ────────────────────────────────────────────────────────

describe("costing one menu", () => {
  const rice = ingredient({ id: "i1", name: "Rice", averageUnitCost: IDR(10) });

  it("costs a recipe from its components and the ingredient's average cost", () => {
    // 100 g at 10/g = 1000.
    const cost = costMenu(menu({ id: "m1", name: "Nasi" }), recipe({ menuItemId: "m1" }), [rice]);

    expect(cost.hpp?.total.amount).toBe(1_000);
    expect(cost.issues).toEqual([]);
  });

  it("treats a menu with no recipe as uncosted, not as a failure", () => {
    // SOURCE showed a dash. Nulls, no issues, and it must not appear as failed.
    const cost = costMenu(menu({ id: "m1", name: "Nasi" }), null, [rice]);

    expect(cost.hpp).toBeNull();
    expect(cost.marginPercentage).toBeNull();
    expect(cost.recommendedPrice).toBeNull();
    expect(cost.issues).toEqual([]);
  });

  it("computes the margin against the selling price", () => {
    // Price 20000, cost 1000 → 95%.
    const cost = costMenu(
      menu({ id: "m1", name: "Nasi", price: IDR(20_000) }),
      recipe({ menuItemId: "m1" }),
      [rice],
    );

    expect(cost.marginPercentage).toBe(95);
  });

  it("recommends a price at the named target margin, not a library default", () => {
    // 1000 at a 60% target = 2500, already on the 500 step.
    const cost = costMenu(menu({ id: "m1", name: "Nasi" }), recipe({ menuItemId: "m1" }), [rice]);

    expect(cost.recommendedPrice?.amount).toBe(2_500);
  });

  it("reports a missing ingredient per menu instead of throwing", () => {
    // The domain throws here. SOURCE called it unguarded inside one Promise.all
    // wrapped in a single catch, so this one recipe blanked the entire table.
    const cost = costMenu(
      menu({ id: "m1", name: "Nasi" }),
      recipe({ menuItemId: "m1", components: [component({ ingredientId: "gone" })] }),
      [rice],
    );

    expect(cost.hpp).toBeNull();
    expect(cost.issues[0]?.code).toBe(COSTING_ISSUE.missingIngredient);
  });

  it("recommends no price when the recipe totals below zero, instead of throwing", () => {
    // Reachable: packaging and additional costs are unvalidated and merely added.
    // calculateRecommendedSellingPrice throws on a negative hpp, and SOURCE let
    // it, losing every row.
    const cost = costMenu(
      menu({ id: "m1", name: "Nasi" }),
      recipe({ menuItemId: "m1", additionalCost: IDR(-5_000) }),
      [rice],
    );

    expect(cost.hpp?.total.amount).toBeLessThan(0);
    expect(cost.recommendedPrice).toBeNull();
    expect(cost.issues.some((issue) => issue.code === COSTING_ISSUE.negativeTotal)).toBe(true);
  });

  it("prices an archived ingredient in, but says that it did", () => {
    // SOURCE included the cost silently while the recipe editor could not show
    // the ingredient, so the figure could not be reconciled with anything visible.
    const cost = costMenu(
      menu({ id: "m1", name: "Nasi" }),
      recipe({ menuItemId: "m1" }),
      [ingredient({ id: "i1", name: "Old Rice", status: "archived", averageUnitCost: IDR(10) })],
    );

    expect(cost.hpp?.total.amount).toBe(1_000);
    expect(cost.issues[0]?.code).toBe(COSTING_ISSUE.archivedIngredient);
  });

  it("flags a recipe with no components, whose total is packaging only", () => {
    const cost = costMenu(
      menu({ id: "m1", name: "Nasi" }),
      recipe({ menuItemId: "m1", components: [], packagingCost: IDR(500) }),
      [rice],
    );

    expect(cost.hpp?.total.amount).toBe(500);
    expect(cost.issues[0]?.code).toBe(COSTING_ISSUE.emptyRecipe);
  });

  it("yields a null margin when the selling price is zero", () => {
    const cost = costMenu(
      menu({ id: "m1", name: "Nasi", price: IDR(0) }),
      recipe({ menuItemId: "m1" }),
      [rice],
    );

    expect(cost.marginPercentage).toBeNull();
  });

  it("applies the recipe's waste percentage to the cost", () => {
    // 100 g at 10/g with 10% waste = 1100.
    const cost = costMenu(
      menu({ id: "m1", name: "Nasi" }),
      recipe({
        menuItemId: "m1",
        components: [component({ ingredientId: "i1", wastePercentage: 10 })],
      }),
      [rice],
    );

    expect(cost.hpp?.total.amount).toBe(1_100);
  });
});

// ─── Two areas composed together ─────────────────────────────────────────────
//
// The first end-to-end check that the cross-area requirement in LOGIC §8 works.

describe("the child across two areas", () => {
  const rice = ingredient({ id: "i1", name: "Rice", averageUnitCost: IDR(10) });

  it("resolves the Menu area's capability and publishes its own", () => {
    const { costing, dispose } = runtimeWith({
      inventoryStore: inventoryStoreOver({}),
      menuStore: menuStoreOver([]),
    });

    expect(costing).toBeDefined();
    dispose();
  });

  it("is NOT created when the Menu area is absent", () => {
    // `requires` is the whole point: without the catalog there is nothing to cost,
    // so the dependency graph must exclude this child rather than let it publish a
    // capability that cannot work. The probe therefore captures nothing.
    const { costing, snapshot, dispose } = runtimeWith({
      inventoryStore: inventoryStoreOver({}),
      withMenuArea: false,
    });

    expect(costing).toBeUndefined();

    const area = snapshot.areas.find((entry) => entry.engineId === inventoryEngine.id);
    expect(area?.unavailableChildIds).toContain(HPP_CALCULATION_ID);
    dispose();
  });

  it("costs every menu in one pass, joining menus to recipes", async () => {
    const { costing, dispose } = runtimeWith({
      inventoryStore: inventoryStoreOver({
        recipes: [recipe({ menuItemId: "m1" })],
        ingredients: [rice],
      }),
      menuStore: menuStoreOver([
        menu({ id: "m1", name: "Nasi" }),
        menu({ id: "m2", name: "Es Teh" }),
      ]),
    });

    const result = await costing?.queryMenuCosts();

    expect(result?.status).toBe("success");
    if (result?.status === "success") {
      // Looked up by id, not by position: the rows arrive in the Menu area's own
      // order (sortOrder, then name), which is its promise to keep, not this
      // child's to assume.
      const byId = new Map(result.value.items.map((item) => [item.menuItemId, item]));
      expect(result.value.items).toHaveLength(2);
      expect(byId.get("m1")?.hpp?.total.amount).toBe(1_000);
      expect(byId.get("m2")?.hpp).toBeNull();
      expect(result.value.failedMenuItemIds).toEqual([]);
    }
    dispose();
  });

  it("keeps costing the other menus when one recipe is broken", async () => {
    // SOURCE had two contradictory policies over this same data: the HPP screen
    // blanked every row when any menu threw, while the dashboard degraded per
    // item. The degrading one is right, so it is the only one here.
    const { costing, dispose } = runtimeWith({
      inventoryStore: inventoryStoreOver({
        recipes: [
          recipe({ menuItemId: "m1" }),
          recipe({ menuItemId: "m2", components: [component({ ingredientId: "gone" })] }),
        ],
        ingredients: [rice],
      }),
      menuStore: menuStoreOver([
        menu({ id: "m1", name: "Nasi" }),
        menu({ id: "m2", name: "Ayam" }),
      ]),
    });

    const result = await costing?.queryMenuCosts();

    expect(result?.status).toBe("degraded");
    if (result?.status === "degraded") {
      const byId = new Map(result.value.items.map((item) => [item.menuItemId, item]));
      expect(byId.get("m1")?.hpp?.total.amount).toBe(1_000);
      expect(byId.get("m2")?.hpp).toBeNull();
      expect(result.value.failedMenuItemIds).toEqual(["m2"]);
    }
    dispose();
  });

  it("does not count a menu without a recipe as failed", async () => {
    const { costing, dispose } = runtimeWith({
      inventoryStore: inventoryStoreOver({ ingredients: [rice] }),
      menuStore: menuStoreOver([menu({ id: "m1", name: "Nasi" })]),
    });

    const result = await costing?.queryMenuCosts();

    if (result?.status === "success" || result?.status === "degraded") {
      expect(result.value.failedMenuItemIds).toEqual([]);
    }
    dispose();
  });

  it("costs a single menu by id, and reports one that does not exist", async () => {
    const { costing, dispose } = runtimeWith({
      inventoryStore: inventoryStoreOver({
        recipes: [recipe({ menuItemId: "m1" })],
        ingredients: [rice],
      }),
      menuStore: menuStoreOver([menu({ id: "m1", name: "Nasi" })]),
    });

    const found = await costing?.calculateMenuCost("m1");
    expect(found?.status).toBe("success");
    if (found?.status === "success") {
      expect(found.value.hpp?.total.amount).toBe(1_000);
    }

    const missing = await costing?.calculateMenuCost("nope");
    expect(missing?.status).toBe("failure");
    if (missing?.status === "failure") {
      expect(missing.reason).toBe("not-found");
    }
    dispose();
  });

  it("reports an unreadable catalog as a dependency failure, carrying its reason", async () => {
    const { costing, dispose } = runtimeWith({
      inventoryStore: inventoryStoreOver({}),
      menuStore: menuStoreOver([], true),
    });

    const result = await costing?.queryMenuCosts();

    expect(result?.status).toBe("failure");
    if (result?.status === "failure") {
      expect(result.reason).toBe("unsatisfied-dependency");
      expect(result.issues[0]?.code).toBe(COSTING_ISSUE.noCatalog);
      // The menu area's own message survives rather than being flattened.
      expect(result.issues.some((issue) => issue.message.includes("catalog unavailable"))).toBe(
        true,
      );
    }
    dispose();
  });

  it("reports a failing recipe store as a store failure", async () => {
    const { costing, dispose } = runtimeWith({
      inventoryStore: inventoryStoreOver({ failRecipes: true }),
      menuStore: menuStoreOver([menu({ id: "m1", name: "Nasi" })]),
    });

    const result = await costing?.queryMenuCosts();

    expect(result?.status).toBe("failure");
    if (result?.status === "failure") {
      expect(result.reason).toBe("failed");
      expect(result.issues[0]?.message).toBe("recipes unavailable");
    }
    dispose();
  });

  it("still publishes with no inventory store, answering with a normalized failure", async () => {
    const { costing, snapshot, dispose } = runtimeWith({ menuStore: menuStoreOver([]) });

    expect(costing).toBeDefined();
    const area = snapshot.areas.find((entry) => entry.engineId === inventoryEngine.id);
    expect(area?.failedChildIds).not.toContain(HPP_CALCULATION_ID);

    const result = await costing?.queryMenuCosts();
    expect(result?.status).toBe("failure");
    if (result?.status === "failure") {
      expect(result.issues[0]?.code).toBe("no-inventory-store");
    }
    dispose();
  });

  it("reports the missing store once, at creation, not per call", async () => {
    const { costing, snapshot, dispose } = runtimeWith({ menuStore: menuStoreOver([]) });

    await costing?.queryMenuCosts();
    await costing?.calculateMenuCost("m1");

    const reported = snapshot.diagnostics.filter(
      (entry) => entry.source === "hppCalculationChild" && entry.code === "missing-dependency",
    );
    expect(reported).toHaveLength(1);
    dispose();
  });
});
