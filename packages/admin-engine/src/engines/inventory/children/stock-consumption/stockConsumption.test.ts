// packages/admin-engine/src/engines/inventory/children/stock-consumption/stockConsumption.test.ts
//
// Protected behavior for consuming an order's ingredients.
//
// The load-bearing sections are "the plan judges what the write judges" (SOURCE's
// dry run checked less than its write, so an archived ingredient produced a
// half-consumed order) and "a replay is distinguishable from a fresh write"
// (SOURCE's retry reported success for an order it had not finished).
//
// No React, no DOM, no renderer (LOGIC §6).

import { describe, expect, it } from "vitest";
import type {
  InventoryIngredient,
  InventoryMovement,
  InventoryStockBalance,
  MenuRecipe,
  Money,
  Order,
  OrderItem,
  RecipeComponent,
} from "@warungmeng/domain";
import { defineLogicChild } from "@warungmeng/module-system";
import type { AdminEngineSnapshot } from "../../../../adminEngineContracts";
import { createAdminEngine } from "../../../../createAdminEngine";
import type {
  InventoryStorePort,
  StockConsumption,
  StockMovementCommit,
} from "../../inventoryContracts";
import {
  CONSUMPTION_ISSUE,
  INVENTORY_STORE_PORT,
  MOVEMENT_ISSUE,
  STOCK_CONSUMPTION,
  STOCK_CONSUMPTION_ID,
} from "../../inventoryContracts";
import inventoryEngine from "../../inventoryEngine";
import { consumptionQuantity } from "../../inventoryOperations";
import stockConsumptionChild, {
  consumptionUnitCost,
  planOrderConsumption,
} from "./stockConsumptionChild";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const OUTLET = "wm-1";
const CREATED = "2026-03-01T10:00:00.000Z";
const IDR = (amount: number): Money => ({ amount, currency: "IDR" });

function ingredient(
  overrides: Partial<InventoryIngredient> & Pick<InventoryIngredient, "id" | "name">,
): InventoryIngredient {
  return {
    baseUnit: "g",
    supplierId: null,
    status: "active",
    minimumStock: 0,
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
    quantity: 10_000,
    updatedAt: "2026-01-01T00:00:00.000Z",
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
    updatedAt: CREATED,
    ...overrides,
  };
}

function orderItem(overrides: Partial<OrderItem> & Pick<OrderItem, "menuItemId">): OrderItem {
  return {
    id: `oi-${overrides.menuItemId}`,
    name: overrides.menuItemId,
    quantity: 1,
    unitPrice: IDR(10_000),
    variantSelections: [],
    note: "",
    lineTotal: IDR(10_000),
    ...overrides,
  };
}

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: "o1",
    orderNumber: "WM-001",
    outletId: OUTLET,
    outletName: "Warung Meng",
    channel: "pos",
    fulfillment: "dine-in",
    paymentStatus: "paid",
    paymentMethod: "cash",
    status: "new",
    customer: null,
    items: [orderItem({ menuItemId: "m1" })],
    totals: {
      subtotal: IDR(10_000),
      discount: IDR(0),
      tax: IDR(0),
      serviceCharge: IDR(0),
      rounding: IDR(0),
      total: IDR(10_000),
    },
    customerNote: "",
    internalNote: "",
    createdAt: CREATED,
    updatedAt: CREATED,
    events: [],
    ...overrides,
  };
}

/** A recording store. `listMovements` honours only the filters these tests need. */
function storeOver(seed: {
  recipes?: readonly MenuRecipe[];
  ingredients?: readonly InventoryIngredient[];
  balances?: readonly InventoryStockBalance[];
  movements?: readonly InventoryMovement[];
  failBatch?: boolean;
}): InventoryStorePort & { readonly batches: StockMovementCommit[][] } {
  const batches: StockMovementCommit[][] = [];
  let sequence = 0;

  const unsupported = (): never => {
    throw new Error("not used by stock-consumption");
  };

  return {
    batches,
    listIngredients: async () => seed.ingredients ?? [],
    getIngredientById: async (id) =>
      (seed.ingredients ?? []).find((entry) => entry.id === id) ?? null,
    createIngredient: unsupported,
    updateIngredient: unsupported,
    listSuppliers: async () => [],
    listStockBalances: async (outletId) =>
      (seed.balances ?? []).filter(
        (entry) => outletId === undefined || entry.outletId === outletId,
      ),
    listMovements: async (query) =>
      (seed.movements ?? []).filter(
        (entry) =>
          (query?.referenceId === undefined || entry.referenceId === query.referenceId) &&
          (query?.type === undefined || entry.type === query.type),
      ),
    listRecipes: async () => seed.recipes ?? [],
    commitMovement: unsupported,
    commitMovements: async (batch) => {
      if (seed.failBatch === true) {
        throw new Error("batch rejected");
      }
      batches.push([...batch]);
    },
    newId: () => {
      sequence += 1;
      return `mv-${sequence}`;
    },
  };
}

/**
 * Composes a real Admin runtime with a probe child that REQUIRES the consumption
 * capability — the same path POS checkout will take, so a capability published
 * under the wrong id fails the suite.
 */
function runtimeWith(store?: InventoryStorePort): {
  readonly consumption: StockConsumption | undefined;
  readonly snapshot: AdminEngineSnapshot;
  readonly dispose: () => void;
} {
  let captured: StockConsumption | undefined;

  const probe = defineLogicChild({
    id: "admin.inventory.test-probe",
    parentId: inventoryEngine.id,
    requires: [STOCK_CONSUMPTION_ID],
    create(context) {
      const resolution = context.capabilities.resolve(STOCK_CONSUMPTION);
      if (resolution.status === "available") {
        captured = resolution.value;
      }
      return undefined;
    },
  });

  const engine = createAdminEngine({
    definitions: { engines: [inventoryEngine], children: [stockConsumptionChild, probe] },
    ports: {
      resolve: (token) =>
        token.id === INVENTORY_STORE_PORT.id && store !== undefined ? (store as never) : undefined,
    },
  });

  return { consumption: captured, snapshot: engine.getSnapshot(), dispose: engine.dispose };
}

let movementCounter = 0;
const nextId = (): string => {
  movementCounter += 1;
  return `mv-${movementCounter}`;
};

// ─── The recipe arithmetic ───────────────────────────────────────────────────

describe("what a recipe component costs in stock", () => {
  it("multiplies component quantity by ordered quantity", () => {
    expect(consumptionQuantity(component({ ingredientId: "i1", quantity: 100 }), 3)).toBe(300);
  });

  it("applies waste per unit ordered, as SOURCE did", () => {
    // 100 × 2 × 1.1 is 220.00000000000003 in binary floating point, and that is
    // SOURCE's exact expression, carried over unchanged. Asserting a clean 220
    // would mean rounding a derived quantity — the very thing `QuantitySource`
    // exists to prevent. The imprecision is real but harmless: it is far below
    // any unit's meaningful resolution, and the ledger records what was computed
    // rather than a tidied version of it.
    expect(
      consumptionQuantity(component({ ingredientId: "i1", quantity: 100, wastePercentage: 10 }), 2),
    ).toBeCloseTo(220, 10);
  });

  it("keeps full precision — a derived quantity is not rounded to two decimals", () => {
    // The 0.01 floor and the two-decimal rounding are rules about what a PERSON
    // may type. Applying them to recipe arithmetic would refuse orders SOURCE
    // accepted and silently round the maths. See `QuantitySource`.
    const tiny = component({ ingredientId: "i1", quantity: 0.001, wastePercentage: 0 });
    expect(consumptionQuantity(tiny, 1)).toBe(0.001);

    const plan = planOrderConsumption(
      order(),
      [recipe({ menuItemId: "m1", components: [tiny] })],
      [ingredient({ id: "i1", name: "Saffron" })],
      [balance({ ingredientId: "i1" })],
      nextId,
    );

    expect(plan.status).toBe("success");
    if (plan.status === "success") {
      expect(plan.value.commits[0]?.movement.quantity).toBe(0.001);
    }
  });
});

// ─── The plan judges exactly what the write judges ───────────────────────────

describe("planning an order", () => {
  it("writes one row per recipe component, signed outbound", () => {
    const plan = planOrderConsumption(
      order(),
      [
        recipe({
          menuItemId: "m1",
          components: [
            component({ ingredientId: "i1", quantity: 100 }),
            component({ ingredientId: "i2", quantity: 50 }),
          ],
        }),
      ],
      [ingredient({ id: "i1", name: "Rice" }), ingredient({ id: "i2", name: "Egg" })],
      [balance({ ingredientId: "i1" }), balance({ ingredientId: "i2" })],
      nextId,
    );

    expect(plan.status).toBe("success");
    if (plan.status === "success") {
      expect(plan.value.commits).toHaveLength(2);
      expect(plan.value.commits[0]?.movement.baseQuantityDelta).toBe(-100);
      expect(plan.value.commits[1]?.movement.baseQuantityDelta).toBe(-50);
    }
  });

  it("carries the running balance forward when two components share an ingredient", () => {
    // Each component has to see what the previous one left, or the second row is
    // validated against stock the first already spent.
    const plan = planOrderConsumption(
      order(),
      [
        recipe({
          menuItemId: "m1",
          components: [
            component({ ingredientId: "i1", id: "a", quantity: 60 }),
            component({ ingredientId: "i1", id: "b", quantity: 30 }),
          ],
        }),
      ],
      [ingredient({ id: "i1", name: "Rice" })],
      [balance({ ingredientId: "i1", quantity: 100 })],
      nextId,
    );

    expect(plan.status).toBe("success");
    if (plan.status === "success") {
      expect(plan.value.commits[0]?.balance.quantity).toBe(40);
      expect(plan.value.commits[1]?.balance.quantity).toBe(10);
    }
  });

  it("refuses the whole order when the accumulated total exceeds stock", () => {
    // Neither component alone is too big; together they are. This is the case a
    // per-row check against the stored balance would miss.
    const plan = planOrderConsumption(
      order(),
      [
        recipe({
          menuItemId: "m1",
          components: [
            component({ ingredientId: "i1", id: "a", quantity: 60 }),
            component({ ingredientId: "i1", id: "b", quantity: 60 }),
          ],
        }),
      ],
      [ingredient({ id: "i1", name: "Rice" })],
      [balance({ ingredientId: "i1", quantity: 100 })],
      nextId,
    );

    expect(plan.status).toBe("failure");
    if (plan.status === "failure") {
      expect(plan.issues[0]?.code).toBe(MOVEMENT_ISSUE.negativeStock);
    }
  });

  it("refuses an order naming an ARCHIVED ingredient, before writing anything", () => {
    // The defect this design removes. SOURCE's dry run checked only that the
    // ingredient existed, while its real write also refused archived ones — so
    // this order passed the projection and then threw partway through the write
    // loop, leaving earlier components consumed and the rest not.
    const plan = planOrderConsumption(
      order(),
      [
        recipe({
          menuItemId: "m1",
          components: [
            component({ ingredientId: "i1", id: "a" }),
            component({ ingredientId: "i2", id: "b" }),
          ],
        }),
      ],
      [
        ingredient({ id: "i1", name: "Rice" }),
        ingredient({ id: "i2", name: "Old Spice", status: "archived" }),
      ],
      [balance({ ingredientId: "i1" }), balance({ ingredientId: "i2" })],
      nextId,
    );

    expect(plan.status).toBe("failure");
    if (plan.status === "failure") {
      expect(plan.issues[0]?.code).toBe(MOVEMENT_ISSUE.archivedIngredient);
    }
  });

  it("refuses an order naming an ingredient that does not exist", () => {
    const plan = planOrderConsumption(
      order(),
      [recipe({ menuItemId: "m1", components: [component({ ingredientId: "gone" })] })],
      [],
      [],
      nextId,
    );

    expect(plan.status).toBe("failure");
    if (plan.status === "failure") {
      expect(plan.reason).toBe("not-found");
    }
  });

  it("stamps every row with its sale-time cost, order reference, note and creation time", () => {
    const plan = planOrderConsumption(
      order(),
      [recipe({ menuItemId: "m1" })],
      [ingredient({ id: "i1", name: "Rice" })],
      [balance({ ingredientId: "i1" })],
      nextId,
    );

    if (plan.status === "success") {
      const row = plan.value.commits[0]?.movement;
      expect(row?.referenceId).toBe("o1");
      expect(row?.note).toBe("POS WM-001");
      expect(row?.occurredAt).toBe(CREATED);
      expect(row?.unitCost).toEqual(IDR(100));
    }
  });

  it("stores cost in the movement unit without rounding the average", () => {
    const rice = ingredient({ id: "i1", name: "Rice", averageUnitCost: IDR(12.345) });

    expect(consumptionUnitCost(component({ ingredientId: "i1", unit: "kg" }), rice)).toEqual(
      IDR(12_345),
    );
  });

  it("names menu items that have no recipe instead of skipping them silently", () => {
    const plan = planOrderConsumption(
      order({ items: [orderItem({ menuItemId: "m1" }), orderItem({ menuItemId: "m2" })] }),
      [recipe({ menuItemId: "m1" })],
      [ingredient({ id: "i1", name: "Rice" })],
      [balance({ ingredientId: "i1" })],
      nextId,
    );

    expect(plan.status).toBe("success");
    if (plan.status === "success") {
      expect(plan.value.commits).toHaveLength(1);
      expect(plan.value.skippedMenuItemIds).toEqual(["m2"]);
    }
  });

  it("treats a recipe with no components as no recipe at all", () => {
    const plan = planOrderConsumption(
      order(),
      [recipe({ menuItemId: "m1", components: [] })],
      [],
      [],
      nextId,
    );

    if (plan.status === "success") {
      expect(plan.value.commits).toHaveLength(0);
      expect(plan.value.skippedMenuItemIds).toEqual(["m1"]);
    }
  });
});

// ─── Through a composed runtime ──────────────────────────────────────────────

describe("the child in a real runtime", () => {
  it("publishes the capability under the id LOGIC §8 names", () => {
    const { consumption, dispose } = runtimeWith(storeOver({}));
    expect(consumption).toBeDefined();
    dispose();
  });

  it("writes the whole order as ONE batch, not one call per row", async () => {
    // The rows are one accounting event. SOURCE wrote them in a loop of single
    // writes, so a failure partway left stock decremented with no way to finish.
    // One call is also what the caller's atomic boundary wraps.
    const store = storeOver({
      recipes: [
        recipe({
          menuItemId: "m1",
          components: [
            component({ ingredientId: "i1", id: "a" }),
            component({ ingredientId: "i2", id: "b" }),
          ],
        }),
      ],
      ingredients: [ingredient({ id: "i1", name: "Rice" }), ingredient({ id: "i2", name: "Egg" })],
      balances: [balance({ ingredientId: "i1" }), balance({ ingredientId: "i2" })],
    });
    const { consumption, dispose } = runtimeWith(store);

    const result = await consumption?.consumeOrder(order());

    expect(result?.status).toBe("success");
    expect(store.batches).toHaveLength(1);
    expect(store.batches[0]).toHaveLength(2);
    dispose();
  });

  it("reports a replay as a replay, not as a fresh write", async () => {
    // SOURCE returned the existing rows and said nothing, so its retry path
    // cleared the pending-sync flag and reported success for an order it had
    // never finished consuming.
    const existing: InventoryMovement = {
      id: "mv-old",
      ingredientId: "i1",
      outletId: OUTLET,
      type: "consumption",
      quantity: 100,
      unit: "g",
      baseQuantityDelta: -100,
      unitCost: null,
      referenceId: "o1",
      note: "POS WM-001",
      occurredAt: CREATED,
    };

    const store = storeOver({
      movements: [existing],
      recipes: [recipe({ menuItemId: "m1" })],
      ingredients: [ingredient({ id: "i1", name: "Rice" })],
      balances: [balance({ ingredientId: "i1" })],
    });
    const { consumption, dispose } = runtimeWith(store);

    const result = await consumption?.consumeOrder(order());

    expect(result?.status).toBe("degraded");
    if (result?.status === "degraded") {
      expect(result.value.replayed).toBe(true);
      expect(result.value.movements).toHaveLength(1);
      expect(result.issues[0]?.code).toBe(CONSUMPTION_ISSUE.alreadyConsumed);
    }
    expect(store.batches).toHaveLength(0);
    dispose();
  });

  it("fails an order where NOTHING has a recipe, rather than silently doing nothing", async () => {
    // SOURCE returned [] and wrote no rows, so its guard — which keys on rows
    // existing — never latched, and every retry re-ran the whole thing.
    const store = storeOver({ recipes: [] });
    const { consumption, dispose } = runtimeWith(store);

    const result = await consumption?.consumeOrder(order());

    expect(result?.status).toBe("failure");
    if (result?.status === "failure") {
      expect(result.issues[0]?.code).toBe(CONSUMPTION_ISSUE.nothingToConsume);
    }
    expect(store.batches).toHaveLength(0);
    dispose();
  });

  it("degrades, naming the items that consumed nothing", async () => {
    const store = storeOver({
      recipes: [recipe({ menuItemId: "m1" })],
      ingredients: [ingredient({ id: "i1", name: "Rice" })],
      balances: [balance({ ingredientId: "i1" })],
    });
    const { consumption, dispose } = runtimeWith(store);

    const result = await consumption?.consumeOrder(
      order({ items: [orderItem({ menuItemId: "m1" }), orderItem({ menuItemId: "m2" })] }),
    );

    expect(result?.status).toBe("degraded");
    if (result?.status === "degraded") {
      expect(result.value.skippedMenuItemIds).toEqual(["m2"]);
      expect(result.issues[0]?.code).toBe(CONSUMPTION_ISSUE.noRecipe);
      expect(result.issues[0]?.subject).toBe("m2");
    }
    dispose();
  });

  it("writes nothing when the order cannot be satisfied", async () => {
    const store = storeOver({
      recipes: [
        recipe({
          menuItemId: "m1",
          components: [component({ ingredientId: "i1", quantity: 500 })],
        }),
      ],
      ingredients: [ingredient({ id: "i1", name: "Rice" })],
      balances: [balance({ ingredientId: "i1", quantity: 100 })],
    });
    const { consumption, dispose } = runtimeWith(store);

    const result = await consumption?.consumeOrder(order());

    expect(result?.status).toBe("failure");
    expect(store.batches).toHaveLength(0);
    dispose();
  });

  it("reports a rejected batch as a store failure", async () => {
    const store = storeOver({
      recipes: [recipe({ menuItemId: "m1" })],
      ingredients: [ingredient({ id: "i1", name: "Rice" })],
      balances: [balance({ ingredientId: "i1" })],
      failBatch: true,
    });
    const { consumption, dispose } = runtimeWith(store);

    const result = await consumption?.consumeOrder(order());

    expect(result?.status).toBe("failure");
    if (result?.status === "failure") {
      expect(result.reason).toBe("failed");
      expect(result.issues[0]?.message).toBe("batch rejected");
    }
    dispose();
  });

  it("still publishes with no store, answering with a normalized failure", async () => {
    const { consumption, snapshot, dispose } = runtimeWith(undefined);

    expect(consumption).toBeDefined();
    const area = snapshot.areas.find((entry) => entry.engineId === inventoryEngine.id);
    expect(area?.unavailableChildIds).not.toContain(STOCK_CONSUMPTION_ID);
    expect(area?.failedChildIds).not.toContain(STOCK_CONSUMPTION_ID);

    const result = await consumption?.consumeOrder(order());
    expect(result?.status).toBe("failure");
    if (result?.status === "failure") {
      expect(result.reason).toBe("unsatisfied-dependency");
      expect(result.issues[0]?.code).toBe("no-inventory-store");
    }
    dispose();
  });

  it("reports the missing store once, at creation, not per call", async () => {
    const { consumption, snapshot, dispose } = runtimeWith(undefined);

    await consumption?.consumeOrder(order());
    await consumption?.consumeOrder(order());

    const reported = snapshot.diagnostics.filter(
      (entry) => entry.source === "stockConsumptionChild" && entry.code === "missing-dependency",
    );
    expect(reported).toHaveLength(1);
    dispose();
  });
});
