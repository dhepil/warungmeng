// packages/admin-engine/src/engines/inventory/children/materials-read/materialsRead.test.ts
//
// Protected behavior for the Inventory area's materials read side.
//
// Two layers, split as in the Menu area's tests. The pure projections are called
// directly, because that is where the ported rules live and a direct call names
// the rule under test. The child itself goes through a real Admin runtime with an
// injected store, because "does it load, publish, and survive a broken store" is
// only true if the wiring is real.
//
// The low-stock section is the important one: it pins down the case SOURCE's four
// implementations disagreed about.
//
// No React, no DOM, no renderer (LOGIC §6).

import { describe, expect, it } from "vitest";
import type {
  InventoryIngredient,
  InventoryStockBalance,
  InventorySupplier,
  Money,
} from "@warungmeng/domain";
import { defineLogicChild } from "@warungmeng/module-system";
import type { AdminEngineSnapshot } from "../../../../adminEngineContracts";
import { createAdminEngine } from "../../../../createAdminEngine";
import type { MaterialListFilters, MaterialsRead, InventoryStorePort } from "../../inventoryContracts";
import {
  DEFAULT_MATERIAL_LIST_FILTERS,
  INVENTORY_STORE_PORT,
  MATERIALS_READ,
  MATERIALS_READ_ID,
} from "../../inventoryContracts";
import inventoryEngine from "../../inventoryEngine";
import materialsReadChild, {
  filterMaterials,
  isLowStockLevel,
  joinMaterials,
  projectMaterialCollection,
} from "./materialsReadChild";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const OUTLET = "wm-1";
const IDR = (amount: number): Money => ({ amount, currency: "IDR" });

const filters = (overrides: Partial<MaterialListFilters> = {}): MaterialListFilters => ({
  ...DEFAULT_MATERIAL_LIST_FILTERS,
  outletId: OUTLET,
  ...overrides,
});

function ingredient(
  overrides: Partial<InventoryIngredient> & Pick<InventoryIngredient, "id" | "name">,
): InventoryIngredient {
  return {
    baseUnit: "g",
    supplierId: null,
    status: "active",
    minimumStock: 10,
    lastPurchaseUnitCost: IDR(100),
    averageUnitCost: IDR(100),
    ...overrides,
  };
}

function balance(
  overrides: Partial<InventoryStockBalance> & Pick<InventoryStockBalance, "ingredientId">,
): InventoryStockBalance {
  return {
    outletId: OUTLET,
    quantity: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function supplier(
  overrides: Partial<InventorySupplier> & Pick<InventorySupplier, "id" | "name">,
): InventorySupplier {
  return { phone: "0800", ...overrides };
}

/** A store over in-memory arrays. Only the read half is exercised here. */
function storeOver(seed: {
  ingredients?: readonly InventoryIngredient[];
  balances?: readonly InventoryStockBalance[];
  suppliers?: readonly InventorySupplier[];
}): InventoryStorePort {
  const unsupported = (): never => {
    throw new Error("write path not used by materials-read");
  };

  return {
    listIngredients: async () => seed.ingredients ?? [],
    getIngredientById: async (id) =>
      (seed.ingredients ?? []).find((entry) => entry.id === id) ?? null,
    createIngredient: unsupported,
    updateIngredient: unsupported,
    listSuppliers: async () => seed.suppliers ?? [],
    listStockBalances: async (outletId) =>
      (seed.balances ?? []).filter((entry) => outletId === undefined || entry.outletId === outletId),
    listMovements: async () => [],
    listRecipes: async () => [],
    commitMovement: unsupported,
    commitMovements: unsupported,
    newId: (kind) => `${kind}-test`,
  };
}

/**
 * Composes a real Admin runtime holding the Inventory area plus a probe child
 * that REQUIRES the read capability and captures it.
 *
 * The probe is how a test reaches a capability, and it is not a workaround: an
 * Admin runtime deliberately cannot resolve capabilities from outside. A consumer
 * declares the capability in `requires` and resolves it from its injected
 * context, so the probe takes exactly the path the dashboard will. It also means
 * these tests fail if the capability is published under the wrong id — which a
 * direct `create()` call could not catch.
 *
 * Definitions are injected rather than discovered so the test never depends on
 * which other areas happen to exist on disk yet.
 */
function runtimeWith(store?: InventoryStorePort): {
  readonly materials: MaterialsRead | undefined;
  readonly snapshot: AdminEngineSnapshot;
  readonly dispose: () => void;
} {
  let captured: MaterialsRead | undefined;

  const probe = defineLogicChild({
    id: "admin.inventory.test-probe",
    parentId: inventoryEngine.id,
    requires: [MATERIALS_READ_ID],
    create(context) {
      const resolution = context.capabilities.resolve(MATERIALS_READ);
      if (resolution.status === "available") {
        captured = resolution.value;
      }
      return undefined;
    },
  });

  const engine = createAdminEngine({
    definitions: { engines: [inventoryEngine], children: [materialsReadChild, probe] },
    ports: {
      resolve: (token) =>
        token.id === INVENTORY_STORE_PORT.id && store !== undefined ? (store as never) : undefined,
    },
  });

  return { materials: captured, snapshot: engine.getSnapshot(), dispose: engine.dispose };
}

// ─── The low-stock rule ──────────────────────────────────────────────────────
//
// The behavior SOURCE got wrong in four different ways. These tests exist to
// make the badge and the filter agree forever.

describe("the low-stock rule", () => {
  it("is low at or below the minimum, and not above it", () => {
    const flour = ingredient({ id: "i1", name: "Flour", minimumStock: 10 });
    expect(isLowStockLevel(flour, 9)).toBe(true);
    expect(isLowStockLevel(flour, 10)).toBe(true);
    expect(isLowStockLevel(flour, 11)).toBe(false);
  });

  it("treats an ingredient with NO balance row as low, not as absent", () => {
    // SOURCE's table badged this row as low while SOURCE's filter hid it. The
    // badge wins: an ingredient nobody has stocked is what a low-stock list is
    // for. `hasBalanceRecord` keeps "never counted" distinguishable from "empty".
    const joined = joinMaterials([ingredient({ id: "i1", name: "Flour" })], [], [], OUTLET);

    expect(joined[0]?.quantity).toBe(0);
    expect(joined[0]?.hasBalanceRecord).toBe(false);
    expect(joined[0]?.isLowStock).toBe(true);
  });

  it("keeps an ingredient with no balance row when the low-stock filter is on", () => {
    // The headline defect: in SOURCE, ticking "low stock only" REMOVED rows the
    // same list had just badged low, because the filter walked balance rows and
    // this ingredient has none.
    const joined = joinMaterials([ingredient({ id: "i1", name: "Flour" })], [], [], OUTLET);
    const shown = filterMaterials(joined, filters({ lowStockOnly: true }));

    expect(shown.map((item) => item.ingredient.id)).toEqual(["i1"]);
  });

  it("agrees with itself: every badged row survives the filter", () => {
    const joined = joinMaterials(
      [
        ingredient({ id: "i1", name: "Flour", minimumStock: 10 }),
        ingredient({ id: "i2", name: "Sugar", minimumStock: 10 }),
        ingredient({ id: "i3", name: "Salt", minimumStock: 10 }),
      ],
      [balance({ ingredientId: "i2", quantity: 5 }), balance({ ingredientId: "i3", quantity: 50 })],
      [],
      OUTLET,
    );

    const badged = joined.filter((item) => item.isLowStock).map((item) => item.ingredient.id);
    const filtered = filterMaterials(joined, filters({ lowStockOnly: true })).map(
      (item) => item.ingredient.id,
    );

    expect(filtered).toEqual(badged);
    expect(badged).toEqual(["i1", "i2"]);
  });

  it("judges low stock per outlet", () => {
    const joined = joinMaterials(
      [ingredient({ id: "i1", name: "Flour", minimumStock: 10 })],
      [
        balance({ ingredientId: "i1", outletId: "wm-1", quantity: 5 }),
        balance({ ingredientId: "i1", outletId: "wm-2", quantity: 50 }),
      ],
      [],
      "wm-2",
    );

    expect(joined[0]?.quantity).toBe(50);
    expect(joined[0]?.isLowStock).toBe(false);
  });
});

// ─── Joining ─────────────────────────────────────────────────────────────────

describe("joining ingredients to balances and suppliers", () => {
  it("ignores a balance belonging to another outlet", () => {
    // Narrowing here rather than trusting the store means an adapter that
    // ignores its outletId argument cannot leak another outlet's quantity.
    const joined = joinMaterials(
      [ingredient({ id: "i1", name: "Flour" })],
      [balance({ ingredientId: "i1", outletId: "wm-2", quantity: 99 })],
      [],
      OUTLET,
    );

    expect(joined[0]?.quantity).toBe(0);
    expect(joined[0]?.hasBalanceRecord).toBe(false);
  });

  it("resolves the supplier, and yields null for an unset or missing one", () => {
    const joined = joinMaterials(
      [
        ingredient({ id: "i1", name: "Flour", supplierId: "s1" }),
        ingredient({ id: "i2", name: "Sugar", supplierId: null }),
        ingredient({ id: "i3", name: "Salt", supplierId: "gone" }),
      ],
      [],
      [supplier({ id: "s1", name: "Pasar Pagi" })],
      OUTLET,
    );

    expect(joined[0]?.supplier?.name).toBe("Pasar Pagi");
    expect(joined[1]?.supplier).toBeNull();
    expect(joined[2]?.supplier).toBeNull();
  });

  it("orders by name, then by id so duplicate names are deterministic", () => {
    // SOURCE sorted by name alone, inside the store. Nothing forbids two
    // ingredients sharing a name, so the tie-break is what makes this stable.
    const joined = joinMaterials(
      [
        ingredient({ id: "i9", name: "Sugar" }),
        ingredient({ id: "i2", name: "Flour" }),
        ingredient({ id: "i1", name: "Sugar" }),
      ],
      [],
      [],
      OUTLET,
    );

    expect(joined.map((item) => item.ingredient.id)).toEqual(["i2", "i1", "i9"]);
  });
});

// ─── Filtering and counts ────────────────────────────────────────────────────

describe("filtering materials", () => {
  const joined = joinMaterials(
    [
      ingredient({ id: "i1", name: "Flour", minimumStock: 10 }),
      ingredient({ id: "i2", name: "Sugar", minimumStock: 10 }),
      ingredient({ id: "i3", name: "Old Spice", status: "archived", minimumStock: 10 }),
    ],
    [
      balance({ ingredientId: "i1", quantity: 5 }),
      balance({ ingredientId: "i2", quantity: 50 }),
      balance({ ingredientId: "i3", quantity: 1 }),
    ],
    [],
    OUTLET,
  );

  it("matches search against the name, ignoring case and surrounding space", () => {
    expect(
      filterMaterials(joined, filters({ search: "  FLO " })).map((item) => item.ingredient.id),
    ).toEqual(["i1"]);
  });

  it("treats an empty search as matching everything within the status", () => {
    expect(filterMaterials(joined, filters({ status: "all" }))).toHaveLength(3);
  });

  it("defaults to active only, and 'archived' selects the archived ones", () => {
    expect(filterMaterials(joined, filters()).map((item) => item.ingredient.id)).toEqual([
      "i1",
      "i2",
    ]);
    expect(
      filterMaterials(joined, filters({ status: "archived" })).map((item) => item.ingredient.id),
    ).toEqual(["i3"]);
  });

  it("combines the filters as AND", () => {
    // "Sugar" matches the search but is not low; nothing satisfies both.
    expect(
      filterMaterials(joined, filters({ search: "sugar", lowStockOnly: true })).map(
        (item) => item.ingredient.id,
      ),
    ).toEqual([]);
  });
});

describe("material counts", () => {
  const joined = joinMaterials(
    [
      ingredient({ id: "i1", name: "Flour", minimumStock: 10 }),
      ingredient({ id: "i2", name: "Sugar", minimumStock: 10 }),
      ingredient({ id: "i3", name: "Salt", minimumStock: 10 }),
    ],
    [
      balance({ ingredientId: "i1", quantity: 5 }),
      balance({ ingredientId: "i2", quantity: 5 }),
      balance({ ingredientId: "i3", quantity: 50 }),
    ],
    [],
    OUTLET,
  );

  it("keeps the low-stock count intact while the low-stock filter is on", () => {
    // The count relaxes its own dimension, as the Menu area's counts do. If it
    // did not, ticking the filter would make the number describe the filtered
    // list rather than the reason to tick it.
    const off = projectMaterialCollection(joined, filters({ lowStockOnly: false }));
    const on = projectMaterialCollection(joined, filters({ lowStockOnly: true }));

    expect(off.lowStockCount).toBe(2);
    expect(on.lowStockCount).toBe(2);
    expect(on.materials).toHaveLength(2);
  });

  it("keeps the total intact while the low-stock filter is on", () => {
    // Both counts relax the low-stock dimension, not just `lowStockCount`. If
    // `totalCount` tracked the filtered list it would collapse to the low-stock
    // count the moment the filter went on, and "2 of 3 are low" would read as
    // "2 of 2" — the comparison the number exists to make.
    const off = projectMaterialCollection(joined, filters({ lowStockOnly: false }));
    const on = projectMaterialCollection(joined, filters({ lowStockOnly: true }));

    expect(off.totalCount).toBe(3);
    expect(on.totalCount).toBe(3);
  });

  it("counts totals within the other filters, not across the whole store", () => {
    // "Sugar" and "Salt" match; only Sugar is low.
    const collection = projectMaterialCollection(joined, filters({ search: "s" }));

    expect(collection.totalCount).toBe(2);
    expect(collection.lowStockCount).toBe(1);
  });
});

// ─── Through a composed runtime ──────────────────────────────────────────────

describe("the child in a real runtime", () => {
  it("publishes the capability under the id LOGIC §8 names", () => {
    const { materials, dispose } = runtimeWith(storeOver({}));
    expect(materials).toBeDefined();
    dispose();
  });

  it("reads through the store and joins in one call", async () => {
    const { materials, dispose } = runtimeWith(
      storeOver({
        ingredients: [ingredient({ id: "i1", name: "Flour", supplierId: "s1", minimumStock: 10 })],
        balances: [balance({ ingredientId: "i1", quantity: 5 })],
        suppliers: [supplier({ id: "s1", name: "Pasar Pagi" })],
      }),
    );

    const result = await materials?.queryMaterials(filters());

    expect(result?.status).toBe("success");
    if (result?.status === "success") {
      expect(result.value.materials).toHaveLength(1);
      expect(result.value.materials[0]?.isLowStock).toBe(true);
      expect(result.value.materials[0]?.supplier?.name).toBe("Pasar Pagi");
    }
    dispose();
  });

  it("sorts the plain list the dashboard consumes", async () => {
    const { materials, dispose } = runtimeWith(
      storeOver({
        ingredients: [
          ingredient({ id: "i9", name: "Sugar" }),
          ingredient({ id: "i2", name: "Flour" }),
        ],
      }),
    );

    const result = await materials?.listIngredients();

    expect(result?.status).toBe("success");
    if (result?.status === "success") {
      expect(result.value.map((entry) => entry.id)).toEqual(["i2", "i9"]);
    }
    dispose();
  });

  it("narrows balances to the requested outlet", async () => {
    const { materials, dispose } = runtimeWith(
      storeOver({
        balances: [
          balance({ ingredientId: "i1", outletId: "wm-1" }),
          balance({ ingredientId: "i1", outletId: "wm-2" }),
        ],
      }),
    );

    const result = await materials?.listStockBalances("wm-2");

    expect(result?.status).toBe("success");
    if (result?.status === "success") {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.outletId).toBe("wm-2");
    }
    dispose();
  });

  it("carries the store's own message instead of an opaque flag", async () => {
    // SOURCE caught every rejection into one boolean, so a dead backend and a
    // rejected write were indistinguishable to the caller.
    const failing: InventoryStorePort = {
      ...storeOver({}),
      listIngredients: async () => {
        throw new Error("connection refused");
      },
    };

    const { materials, dispose } = runtimeWith(failing);
    const result = await materials?.listIngredients();

    expect(result?.status).toBe("failure");
    if (result?.status === "failure") {
      expect(result.reason).toBe("failed");
      expect(result.issues[0]?.message).toBe("connection refused");
    }
    dispose();
  });

  it("still publishes with no store, answering with a normalized failure", async () => {
    // `unavailable` means a required capability was never published. This one
    // was; it simply has nothing to read. A child that vanished because its
    // adapter was absent would be indistinguishable from one never written.
    const { materials, snapshot, dispose } = runtimeWith(undefined);

    expect(materials).toBeDefined();

    const area = snapshot.areas.find((entry) => entry.engineId === inventoryEngine.id);
    expect(area?.unavailableChildIds).not.toContain(MATERIALS_READ_ID);
    expect(area?.failedChildIds).not.toContain(MATERIALS_READ_ID);

    const result = await materials?.queryMaterials(filters());
    expect(result?.status).toBe("failure");
    if (result?.status === "failure") {
      expect(result.reason).toBe("unsatisfied-dependency");
      expect(result.issues[0]?.code).toBe("no-inventory-store");
    }
    dispose();
  });

  it("reports the missing store once, at creation, not per call", async () => {
    const { materials, snapshot, dispose } = runtimeWith(undefined);

    await materials?.listIngredients();
    await materials?.listSuppliers();

    const reported = snapshot.diagnostics.filter(
      (entry) => entry.source === "materialsReadChild" && entry.code === "missing-dependency",
    );
    expect(reported).toHaveLength(1);
    dispose();
  });
});
