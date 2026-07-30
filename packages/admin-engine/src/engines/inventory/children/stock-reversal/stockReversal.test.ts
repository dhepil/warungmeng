// packages/admin-engine/src/engines/inventory/children/stock-reversal/stockReversal.test.ts
//
// Protected behavior for returning a cancelled order's ingredients to stock.
//
// The load-bearing section is "the reversal restores exactly what was taken".
// SOURCE rebuilt each reversal from the consumed row's entered quantity and unit
// and re-ran the conversion against the ingredient's CURRENT definition, so an
// ingredient whose base unit changed between consuming and cancelling either
// restored 1000x or wedged the cancellation permanently.
//
// No React, no DOM, no renderer (LOGIC §6).

import { describe, expect, it } from "vitest";
import type {
  InventoryIngredient,
  InventoryMovement,
  InventoryStockBalance,
  Money,
  Order,
} from "@warungmeng/domain";
import { defineLogicChild } from "@warungmeng/module-system";
import type { AdminEngineSnapshot } from "../../../../adminEngineContracts";
import { createAdminEngine } from "../../../../createAdminEngine";
import type {
  InventoryStorePort,
  StockMovementCommit,
  StockReversal,
} from "../../inventoryContracts";
import {
  CONSUMPTION_ISSUE,
  INVENTORY_STORE_PORT,
  STOCK_REVERSAL,
  STOCK_REVERSAL_ID,
} from "../../inventoryContracts";
import inventoryEngine from "../../inventoryEngine";
import stockReversalChild, { planOrderReversal } from "./stockReversalChild";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const OUTLET = "wm-1";
const CREATED = "2026-03-01T10:00:00.000Z";
const CANCELLED = "2026-03-01T18:00:00.000Z";
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
    quantity: 1_000,
    updatedAt: CREATED,
    ...overrides,
  };
}

/** A consumption row as `stock-consumption` would have written it. */
function consumedRow(
  overrides: Partial<InventoryMovement> & Pick<InventoryMovement, "id" | "ingredientId">,
): InventoryMovement {
  return {
    outletId: OUTLET,
    type: "consumption",
    quantity: 100,
    unit: "g",
    baseQuantityDelta: -100,
    unitCost: null,
    referenceId: "o1",
    note: "POS WM-001",
    occurredAt: CREATED,
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
    status: "cancelled",
    customer: null,
    items: [],
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
    updatedAt: CANCELLED,
    events: [],
    ...overrides,
  };
}

function storeOver(seed: {
  movements?: readonly InventoryMovement[];
  ingredients?: readonly InventoryIngredient[];
  balances?: readonly InventoryStockBalance[];
  failBatch?: boolean;
}): InventoryStorePort & { readonly batches: StockMovementCommit[][] } {
  const batches: StockMovementCommit[][] = [];
  let sequence = 0;

  const unsupported = (): never => {
    throw new Error("not used by stock-reversal");
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
    listRecipes: async () => [],
    commitMovement: unsupported,
    commitMovements: async (batch) => {
      if (seed.failBatch === true) {
        throw new Error("batch rejected");
      }
      batches.push([...batch]);
    },
    newId: () => {
      sequence += 1;
      return `rv-${sequence}`;
    },
  };
}

/** Probe child, as in every sibling — the path order-cancellation will take. */
function runtimeWith(store?: InventoryStorePort): {
  readonly reversal: StockReversal | undefined;
  readonly snapshot: AdminEngineSnapshot;
  readonly dispose: () => void;
} {
  let captured: StockReversal | undefined;

  const probe = defineLogicChild({
    id: "admin.inventory.test-probe",
    parentId: inventoryEngine.id,
    requires: [STOCK_REVERSAL_ID],
    create(context) {
      const resolution = context.capabilities.resolve(STOCK_REVERSAL);
      if (resolution.status === "available") {
        captured = resolution.value;
      }
      return undefined;
    },
  });

  const engine = createAdminEngine({
    definitions: { engines: [inventoryEngine], children: [stockReversalChild, probe] },
    ports: {
      resolve: (token) =>
        token.id === INVENTORY_STORE_PORT.id && store !== undefined ? (store as never) : undefined,
    },
  });

  return { reversal: captured, snapshot: engine.getSnapshot(), dispose: engine.dispose };
}

let counter = 0;
const nextId = (): string => {
  counter += 1;
  return `rv-${counter}`;
};

// ─── The reversal restores exactly what was taken ────────────────────────────
//
// The load-bearing section.

describe("planning a reversal", () => {
  it("negates the stored delta rather than re-deriving from the entered unit", () => {
    const plan = planOrderReversal(
      order(),
      [consumedRow({ id: "mv-1", ingredientId: "i1", quantity: 100, unit: "g", baseQuantityDelta: -100 })],
      [ingredient({ id: "i1", name: "Rice", baseUnit: "g" })],
      [balance({ ingredientId: "i1", quantity: 900 })],
      nextId,
    );

    expect(plan.status).toBe("success");
    if (plan.status === "success") {
      expect(plan.value[0]?.movement.baseQuantityDelta).toBe(100);
      expect(plan.value[0]?.balance.quantity).toBe(1_000);
    }
  });

  it("restores the right amount after the ingredient's base unit CHANGED", () => {
    // The defect this design removes. 100 g was consumed; someone then edited the
    // ingredient to be measured in kg. SOURCE re-ran the conversion from the
    // consumed row's entered quantity (100) and unit (g) against the NEW base
    // unit, restoring 0.1 kg — but the balance is now kept in kg, and the stored
    // delta says 100 base units were taken. Negating the delta is immune.
    const plan = planOrderReversal(
      order(),
      [consumedRow({ id: "mv-1", ingredientId: "i1", quantity: 100, unit: "g", baseQuantityDelta: -100 })],
      [ingredient({ id: "i1", name: "Rice", baseUnit: "kg" })],
      [balance({ ingredientId: "i1", quantity: 0 })],
      nextId,
    );

    expect(plan.status).toBe("success");
    if (plan.status === "success") {
      expect(plan.value[0]?.movement.baseQuantityDelta).toBe(100);
      expect(plan.value[0]?.balance.quantity).toBe(100);
    }
  });

  it("still reverses when the consumed unit would no longer convert at all", () => {
    // g -> ml is a dimension mismatch, which SOURCE's re-derivation threw on.
    // Through order cancellation's rollback that made the order permanently
    // un-cancellable. Expressing the reversal in the ingredient's own base unit
    // means there is no conversion left to fail.
    const plan = planOrderReversal(
      order(),
      [consumedRow({ id: "mv-1", ingredientId: "i1", quantity: 100, unit: "g", baseQuantityDelta: -100 })],
      [ingredient({ id: "i1", name: "Syrup", baseUnit: "ml" })],
      [balance({ ingredientId: "i1", quantity: 0 })],
      nextId,
    );

    expect(plan.status).toBe("success");
    if (plan.status === "success") {
      expect(plan.value[0]?.movement.baseQuantityDelta).toBe(100);
    }
  });

  it("round-trips a converted consumption exactly", () => {
    // 2 kg entered against a gram-based ingredient consumed 2000 base units.
    const plan = planOrderReversal(
      order(),
      [consumedRow({ id: "mv-1", ingredientId: "i1", quantity: 2, unit: "kg", baseQuantityDelta: -2_000 })],
      [ingredient({ id: "i1", name: "Rice", baseUnit: "g" })],
      [balance({ ingredientId: "i1", quantity: 0 })],
      nextId,
    );

    if (plan.status === "success") {
      expect(plan.value[0]?.movement.baseQuantityDelta).toBe(2_000);
    }
  });

  it("writes one inbound row per consumed row, accumulating a shared ingredient", () => {
    const plan = planOrderReversal(
      order(),
      [
        consumedRow({ id: "mv-1", ingredientId: "i1", baseQuantityDelta: -60 }),
        consumedRow({ id: "mv-2", ingredientId: "i1", baseQuantityDelta: -30 }),
      ],
      [ingredient({ id: "i1", name: "Rice" })],
      [balance({ ingredientId: "i1", quantity: 10 })],
      nextId,
    );

    expect(plan.status).toBe("success");
    if (plan.status === "success") {
      expect(plan.value).toHaveLength(2);
      expect(plan.value[0]?.balance.quantity).toBe(70);
      expect(plan.value[1]?.balance.quantity).toBe(100);
    }
  });

  it("skips a consumed row that did not actually reduce stock", () => {
    const plan = planOrderReversal(
      order(),
      [consumedRow({ id: "mv-1", ingredientId: "i1", baseQuantityDelta: 0 })],
      [ingredient({ id: "i1", name: "Rice" })],
      [balance({ ingredientId: "i1" })],
      nextId,
    );

    if (plan.status === "success") {
      expect(plan.value).toHaveLength(0);
    }
  });

  it("stamps the cancellation time and note, not the original order time", () => {
    const plan = planOrderReversal(
      order(),
      [consumedRow({ id: "mv-1", ingredientId: "i1" })],
      [ingredient({ id: "i1", name: "Rice" })],
      [balance({ ingredientId: "i1" })],
      nextId,
    );

    if (plan.status === "success") {
      const row = plan.value[0]?.movement;
      expect(row?.type).toBe("adjustment-in");
      expect(row?.occurredAt).toBe(CANCELLED);
      expect(row?.note).toBe("Pembatalan WM-001");
      expect(row?.referenceId).toBe("o1");
    }
  });

  it("refuses when the ingredient is archived, rather than half-reversing", () => {
    // SOURCE hit the same refusal but from inside a write loop, so cancellation
    // rolled back and reported a retryable failure that would never succeed.
    // Here it is a plain refusal before anything is written.
    const plan = planOrderReversal(
      order(),
      [consumedRow({ id: "mv-1", ingredientId: "i1" })],
      [ingredient({ id: "i1", name: "Old Spice", status: "archived" })],
      [balance({ ingredientId: "i1" })],
      nextId,
    );

    expect(plan.status).toBe("failure");
  });
});

// ─── Through a composed runtime ──────────────────────────────────────────────

describe("the child in a real runtime", () => {
  it("publishes the capability under the id LOGIC §8 names", () => {
    const { reversal, dispose } = runtimeWith(storeOver({}));
    expect(reversal).toBeDefined();
    dispose();
  });

  it("returns the stock in one batch", async () => {
    const store = storeOver({
      movements: [
        consumedRow({ id: "mv-1", ingredientId: "i1" }),
        consumedRow({ id: "mv-2", ingredientId: "i2" }),
      ],
      ingredients: [ingredient({ id: "i1", name: "Rice" }), ingredient({ id: "i2", name: "Egg" })],
      balances: [balance({ ingredientId: "i1" }), balance({ ingredientId: "i2" })],
    });
    const { reversal, dispose } = runtimeWith(store);

    const result = await reversal?.revertOrderConsumption(order());

    expect(result?.status).toBe("success");
    expect(store.batches).toHaveLength(1);
    expect(store.batches[0]).toHaveLength(2);
    if (result?.status === "success") {
      expect(result.value.replayed).toBe(false);
    }
    dispose();
  });

  it("refuses an order that never consumed anything", async () => {
    const store = storeOver({ movements: [] });
    const { reversal, dispose } = runtimeWith(store);

    const result = await reversal?.revertOrderConsumption(order());

    expect(result?.status).toBe("failure");
    if (result?.status === "failure") {
      expect(result.reason).toBe("not-found");
      expect(result.issues[0]?.code).toBe(CONSUMPTION_ISSUE.neverConsumed);
    }
    expect(store.batches).toHaveLength(0);
    dispose();
  });

  it("reports an already-reversed order as a replay, writing nothing", async () => {
    const store = storeOver({
      movements: [
        consumedRow({ id: "mv-1", ingredientId: "i1" }),
        consumedRow({ id: "rv-old", ingredientId: "i1", type: "adjustment-in", baseQuantityDelta: 100 }),
      ],
      ingredients: [ingredient({ id: "i1", name: "Rice" })],
      balances: [balance({ ingredientId: "i1" })],
    });
    const { reversal, dispose } = runtimeWith(store);

    const result = await reversal?.revertOrderConsumption(order());

    expect(result?.status).toBe("degraded");
    if (result?.status === "degraded") {
      expect(result.value.replayed).toBe(true);
      expect(result.issues[0]?.code).toBe(CONSUMPTION_ISSUE.alreadyReversed);
    }
    expect(store.batches).toHaveLength(0);
    dispose();
  });

  it("reports a rejected batch as a store failure", async () => {
    const store = storeOver({
      movements: [consumedRow({ id: "mv-1", ingredientId: "i1" })],
      ingredients: [ingredient({ id: "i1", name: "Rice" })],
      balances: [balance({ ingredientId: "i1" })],
      failBatch: true,
    });
    const { reversal, dispose } = runtimeWith(store);

    const result = await reversal?.revertOrderConsumption(order());

    expect(result?.status).toBe("failure");
    if (result?.status === "failure") {
      expect(result.reason).toBe("failed");
      expect(result.issues[0]?.message).toBe("batch rejected");
    }
    dispose();
  });

  it("still publishes with no store, answering with a normalized failure", async () => {
    const { reversal, snapshot, dispose } = runtimeWith(undefined);

    expect(reversal).toBeDefined();
    const area = snapshot.areas.find((entry) => entry.engineId === inventoryEngine.id);
    expect(area?.unavailableChildIds).not.toContain(STOCK_REVERSAL_ID);
    expect(area?.failedChildIds).not.toContain(STOCK_REVERSAL_ID);

    const result = await reversal?.revertOrderConsumption(order());
    expect(result?.status).toBe("failure");
    if (result?.status === "failure") {
      expect(result.reason).toBe("unsatisfied-dependency");
      expect(result.issues[0]?.code).toBe("no-inventory-store");
    }
    dispose();
  });

  it("reports the missing store once, at creation, not per call", async () => {
    const { reversal, snapshot, dispose } = runtimeWith(undefined);

    await reversal?.revertOrderConsumption(order());
    await reversal?.revertOrderConsumption(order());

    const reported = snapshot.diagnostics.filter(
      (entry) => entry.source === "stockReversalChild" && entry.code === "missing-dependency",
    );
    expect(reported).toHaveLength(1);
    dispose();
  });
});
