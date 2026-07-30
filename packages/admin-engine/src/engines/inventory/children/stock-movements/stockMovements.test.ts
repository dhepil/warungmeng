// packages/admin-engine/src/engines/inventory/children/stock-movements/stockMovements.test.ts
//
// Protected behavior for the Inventory area's ledger read side.
//
// Same two layers as the other children: the pure ordering, filter and join
// functions are called directly, and the child itself goes through a real Admin
// runtime with an injected store so the wiring is real.
//
// The ordering section is the load-bearing one. A ledger is an audit record, and
// SOURCE's sort could present the same history in different orders on different
// machines.
//
// No React, no DOM, no renderer (LOGIC §6).

import { describe, expect, it } from "vitest";
import type { InventoryIngredient, InventoryMovement, Money } from "@warungmeng/domain";
import { defineLogicChild } from "@warungmeng/module-system";
import type { AdminEngineSnapshot } from "../../../../adminEngineContracts";
import { createAdminEngine } from "../../../../createAdminEngine";
import type {
  InventoryStorePort,
  MovementListFilters,
  StockMovements,
} from "../../inventoryContracts";
import {
  DEFAULT_MOVEMENT_LIST_FILTERS,
  INVENTORY_STORE_PORT,
  STOCK_MOVEMENTS,
  STOCK_MOVEMENTS_ID,
} from "../../inventoryContracts";
import inventoryEngine from "../../inventoryEngine";
import stockMovementsChild, {
  filterMovements,
  joinMovements,
  sortMovements,
  toStoreQuery,
} from "./stockMovementsChild";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const OUTLET = "wm-1";
const IDR = (amount: number): Money => ({ amount, currency: "IDR" });

const filters = (overrides: Partial<MovementListFilters> = {}): MovementListFilters => ({
  ...DEFAULT_MOVEMENT_LIST_FILTERS,
  ...overrides,
});

function movement(
  overrides: Partial<InventoryMovement> & Pick<InventoryMovement, "id" | "occurredAt">,
): InventoryMovement {
  return {
    ingredientId: "i1",
    outletId: OUTLET,
    type: "purchase",
    quantity: 1,
    unit: "kg",
    baseQuantityDelta: 1000,
    unitCost: IDR(20_000),
    referenceId: null,
    note: "",
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
    minimumStock: 10,
    lastPurchaseUnitCost: IDR(100),
    averageUnitCost: IDR(100),
    ...overrides,
  };
}

/**
 * A store over in-memory arrays.
 *
 * `listMovements` deliberately IGNORES its query, so the tests prove the child
 * re-applies the filters itself rather than trusting the adapter.
 */
function storeOver(seed: {
  movements?: readonly InventoryMovement[];
  ingredients?: readonly InventoryIngredient[];
}): InventoryStorePort {
  const unsupported = (): never => {
    throw new Error("write path not used by stock-movements");
  };

  return {
    listIngredients: async () => seed.ingredients ?? [],
    getIngredientById: async (id) =>
      (seed.ingredients ?? []).find((entry) => entry.id === id) ?? null,
    createIngredient: unsupported,
    updateIngredient: unsupported,
    listSuppliers: async () => [],
    listStockBalances: async () => [],
    listMovements: async () => seed.movements ?? [],
    commitMovement: unsupported,
    newId: (kind) => `${kind}-test`,
  };
}

/**
 * Composes a real Admin runtime holding the Inventory area plus a probe child
 * that REQUIRES the ledger capability and captures it — the same path
 * `admin.dashboard.reports` will take. A direct `create()` call could not catch
 * the capability being published under the wrong id.
 */
function runtimeWith(store?: InventoryStorePort): {
  readonly ledger: StockMovements | undefined;
  readonly snapshot: AdminEngineSnapshot;
  readonly dispose: () => void;
} {
  let captured: StockMovements | undefined;

  const probe = defineLogicChild({
    id: "admin.inventory.test-probe",
    parentId: inventoryEngine.id,
    requires: [STOCK_MOVEMENTS_ID],
    create(context) {
      const resolution = context.capabilities.resolve(STOCK_MOVEMENTS);
      if (resolution.status === "available") {
        captured = resolution.value;
      }
      return undefined;
    },
  });

  const engine = createAdminEngine({
    definitions: { engines: [inventoryEngine], children: [stockMovementsChild, probe] },
    ports: {
      resolve: (token) =>
        token.id === INVENTORY_STORE_PORT.id && store !== undefined ? (store as never) : undefined,
    },
  });

  return { ledger: captured, snapshot: engine.getSnapshot(), dispose: engine.dispose };
}

// ─── Ordering ────────────────────────────────────────────────────────────────
//
// The load-bearing section. A ledger is an audit record.

describe("ledger ordering", () => {
  it("returns newest first", () => {
    const sorted = sortMovements([
      movement({ id: "m1", occurredAt: "2026-01-01T00:00:00.000Z" }),
      movement({ id: "m3", occurredAt: "2026-03-01T00:00:00.000Z" }),
      movement({ id: "m2", occurredAt: "2026-02-01T00:00:00.000Z" }),
    ]);

    expect(sorted.map((entry) => entry.id)).toEqual(["m3", "m2", "m1"]);
  });

  it("breaks a timestamp tie by id, so an identical instant is still a total order", () => {
    // This is not hypothetical. SOURCE's automated paths stamp EVERY row of one
    // order with the same timestamp — consumption uses the order's createdAt for
    // all of its movements — so a multi-ingredient order produces exactly this
    // block of indistinguishable rows.
    const sameInstant = "2026-01-01T00:00:00.000Z";
    const sorted = sortMovements([
      movement({ id: "m-b", occurredAt: sameInstant }),
      movement({ id: "m-c", occurredAt: sameInstant }),
      movement({ id: "m-a", occurredAt: sameInstant }),
    ]);

    expect(sorted.map((entry) => entry.id)).toEqual(["m-c", "m-b", "m-a"]);
  });

  it("orders a tie the same way no matter what order it arrives in", () => {
    // The property that matters: same rows in, same rows out. Without a
    // tie-break this depends on the sort implementation.
    const sameInstant = "2026-01-01T00:00:00.000Z";
    const rows = [
      movement({ id: "m-a", occurredAt: sameInstant }),
      movement({ id: "m-b", occurredAt: sameInstant }),
      movement({ id: "m-c", occurredAt: sameInstant }),
    ];

    const forward = sortMovements(rows).map((entry) => entry.id);
    const reversed = sortMovements([...rows].reverse()).map((entry) => entry.id);

    expect(forward).toEqual(reversed);
  });

  it("does not mutate the array it was given", () => {
    const rows = [
      movement({ id: "m1", occurredAt: "2026-01-01T00:00:00.000Z" }),
      movement({ id: "m2", occurredAt: "2026-02-01T00:00:00.000Z" }),
    ];

    sortMovements(rows);

    expect(rows.map((entry) => entry.id)).toEqual(["m1", "m2"]);
  });
});

// ─── Filtering ───────────────────────────────────────────────────────────────

describe("ledger filtering", () => {
  const rows = [
    movement({ id: "m1", occurredAt: "2026-01-01T00:00:00.000Z", ingredientId: "i1" }),
    movement({
      id: "m2",
      occurredAt: "2026-01-02T00:00:00.000Z",
      ingredientId: "i2",
      type: "waste",
    }),
    movement({
      id: "m3",
      occurredAt: "2026-01-03T00:00:00.000Z",
      ingredientId: "i1",
      outletId: "wm-2",
    }),
  ];

  it("filters by ingredient, outlet and type, and treats all/null as unfiltered", () => {
    expect(
      filterMovements(rows, filters({ ingredientId: "i1" })).map((entry) => entry.id),
    ).toEqual(["m1", "m3"]);
    expect(filterMovements(rows, filters({ outletId: "wm-2" })).map((entry) => entry.id)).toEqual([
      "m3",
    ]);
    expect(filterMovements(rows, filters({ type: "waste" })).map((entry) => entry.id)).toEqual([
      "m2",
    ]);
    expect(filterMovements(rows, filters())).toHaveLength(3);
  });

  it("combines the filters as AND", () => {
    expect(
      filterMovements(rows, filters({ ingredientId: "i1", outletId: OUTLET })).map(
        (entry) => entry.id,
      ),
    ).toEqual(["m1"]);
  });

  it("omits unset dimensions from the store query instead of passing undefined", () => {
    expect(toStoreQuery(filters())).toEqual({});
    expect(toStoreQuery(filters({ ingredientId: "i1", type: "waste" }))).toEqual({
      ingredientId: "i1",
      type: "waste",
    });
  });
});

// ─── Joining ─────────────────────────────────────────────────────────────────

describe("joining a row to its ingredient", () => {
  it("resolves the ingredient", () => {
    const joined = joinMovements(
      [movement({ id: "m1", occurredAt: "2026-01-01T00:00:00.000Z", ingredientId: "i1" })],
      [ingredient({ id: "i1", name: "Flour" })],
    );

    expect(joined[0]?.ingredient?.name).toBe("Flour");
  });

  it("reports an unresolvable ingredient as null rather than as a blank name", () => {
    // SOURCE looked names up against ACTIVE ingredients only while rendering, so
    // a movement whose ingredient had been archived showed an empty cell with no
    // explanation. An audit row that cannot be explained is information.
    const joined = joinMovements(
      [movement({ id: "m1", occurredAt: "2026-01-01T00:00:00.000Z", ingredientId: "gone" })],
      [ingredient({ id: "i1", name: "Flour" })],
    );

    expect(joined).toHaveLength(1);
    expect(joined[0]?.ingredient).toBeNull();
  });
});

// ─── Through a composed runtime ──────────────────────────────────────────────

describe("the child in a real runtime", () => {
  it("publishes the capability under the id LOGIC §8 names", () => {
    const { ledger, dispose } = runtimeWith(storeOver({}));
    expect(ledger).toBeDefined();
    dispose();
  });

  it("re-applies the filters even when the store ignores its query", async () => {
    // The fixture store returns everything regardless of what it was asked. A
    // caller of this capability is entitled to a list matching its request no
    // matter which adapter is plugged in.
    const { ledger, dispose } = runtimeWith(
      storeOver({
        movements: [
          movement({ id: "m1", occurredAt: "2026-01-01T00:00:00.000Z", ingredientId: "i1" }),
          movement({ id: "m2", occurredAt: "2026-01-02T00:00:00.000Z", ingredientId: "i2" }),
        ],
      }),
    );

    const result = await ledger?.listMovements(filters({ ingredientId: "i1" }));

    expect(result?.status).toBe("success");
    if (result?.status === "success") {
      expect(result.value.map((entry) => entry.id)).toEqual(["m1"]);
    }
    dispose();
  });

  it("orders and joins in one call", async () => {
    const { ledger, dispose } = runtimeWith(
      storeOver({
        movements: [
          movement({ id: "m1", occurredAt: "2026-01-01T00:00:00.000Z", ingredientId: "i1" }),
          movement({ id: "m2", occurredAt: "2026-02-01T00:00:00.000Z", ingredientId: "i1" }),
        ],
        ingredients: [ingredient({ id: "i1", name: "Flour" })],
      }),
    );

    const result = await ledger?.queryMovements();

    expect(result?.status).toBe("success");
    if (result?.status === "success") {
      expect(result.value.map((item) => item.movement.id)).toEqual(["m2", "m1"]);
      expect(result.value[0]?.ingredient?.name).toBe("Flour");
    }
    dispose();
  });

  it("defaults to the unfiltered ledger when called with no filters", async () => {
    const { ledger, dispose } = runtimeWith(
      storeOver({
        movements: [
          movement({ id: "m1", occurredAt: "2026-01-01T00:00:00.000Z" }),
          movement({ id: "m2", occurredAt: "2026-02-01T00:00:00.000Z", type: "waste" }),
        ],
      }),
    );

    const result = await ledger?.listMovements();

    expect(result?.status).toBe("success");
    if (result?.status === "success") {
      expect(result.value).toHaveLength(2);
    }
    dispose();
  });

  it("carries the store's own message instead of an opaque flag", async () => {
    const failing: InventoryStorePort = {
      ...storeOver({}),
      listMovements: async () => {
        throw new Error("ledger unavailable");
      },
    };

    const { ledger, dispose } = runtimeWith(failing);
    const result = await ledger?.listMovements();

    expect(result?.status).toBe("failure");
    if (result?.status === "failure") {
      expect(result.reason).toBe("failed");
      expect(result.issues[0]?.message).toBe("ledger unavailable");
    }
    dispose();
  });

  it("still publishes with no store, answering with a normalized failure", async () => {
    const { ledger, snapshot, dispose } = runtimeWith(undefined);

    expect(ledger).toBeDefined();
    const area = snapshot.areas.find((entry) => entry.engineId === inventoryEngine.id);
    expect(area?.unavailableChildIds).not.toContain(STOCK_MOVEMENTS_ID);
    expect(area?.failedChildIds).not.toContain(STOCK_MOVEMENTS_ID);

    const result = await ledger?.queryMovements();
    expect(result?.status).toBe("failure");
    if (result?.status === "failure") {
      expect(result.reason).toBe("unsatisfied-dependency");
      expect(result.issues[0]?.code).toBe("no-inventory-store");
    }
    dispose();
  });

  it("reports the missing store once, at creation, not per call", async () => {
    const { ledger, snapshot, dispose } = runtimeWith(undefined);

    await ledger?.listMovements();
    await ledger?.queryMovements();

    const reported = snapshot.diagnostics.filter(
      (entry) => entry.source === "stockMovementsChild" && entry.code === "missing-dependency",
    );
    expect(reported).toHaveLength(1);
    dispose();
  });
});
