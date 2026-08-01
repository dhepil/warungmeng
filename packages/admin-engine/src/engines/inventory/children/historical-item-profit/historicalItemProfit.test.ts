// packages/admin-engine/src/engines/inventory/children/historical-item-profit/historicalItemProfit.test.ts
//
// Permanent DS-C witnesses. Every capability assertion reaches the child through
// a probe that requires its published id; no test calls `create()` directly.
//
// The three load-bearing behaviors are recipe-proportional reconstruction,
// Jakarta/refiltered selection with deterministic ties, and pre-S11 null cost
// remaining UNKNOWN rather than becoming a plausible zero.

import { describe, expect, it } from "vitest";
import type {
  InventoryMovement,
  MenuRecipe,
  Money,
  Order,
  RecipeComponent,
} from "@warungmeng/domain";
import {
  defineLogicChild,
  operationFailure,
  operationIssue,
  operationSuccess,
} from "@warungmeng/module-system";
import type { AdminEngineSnapshot } from "../../../../adminEngineContracts";
import { createAdminEngine } from "../../../../createAdminEngine";
import type { OrderRead } from "../../../orders/ordersContracts";
import { ORDER_READ, ORDER_READ_ID } from "../../../orders/ordersContracts";
import ordersEngine from "../../../orders/ordersEngine";
import type {
  HistoricalItemProfit,
  HistoricalItemProfitQuery,
  InventoryStorePort,
} from "../../inventoryContracts";
import {
  HISTORICAL_ITEM_PROFIT,
  HISTORICAL_ITEM_PROFIT_ATTRIBUTION,
  HISTORICAL_ITEM_PROFIT_ID,
  HISTORICAL_ITEM_PROFIT_ISSUE,
  HISTORICAL_ITEM_PROFIT_RECIPE_ASSUMPTION,
  INVENTORY_STORE_PORT,
} from "../../inventoryContracts";
import inventoryEngine from "../../inventoryEngine";
import historicalItemProfitChild from "./historicalItemProfitChild";

const IDR = (amount: number): Money => ({ amount, currency: "IDR" });

const AUGUST_FIRST: HistoricalItemProfitQuery = {
  outletId: "wm-1",
  dateFrom: "2026-08-01",
  dateTo: "2026-08-01",
  menuItemId: null,
};

type OrderItem = Order["items"][number];

function item(
  overrides: Partial<OrderItem> & Pick<OrderItem, "id" | "menuItemId" | "name">,
): OrderItem {
  return {
    quantity: 1,
    unitPrice: IDR(1_000),
    variantSelections: [],
    note: "",
    lineTotal: IDR(1_000),
    ...overrides,
  };
}

function order(overrides: Partial<Order> & Pick<Order, "id" | "createdAt" | "items">): Order {
  const subtotal = overrides.items.reduce((total, entry) => total + entry.lineTotal.amount, 0);
  const total = IDR(subtotal);
  return {
    orderNumber: `WM-${overrides.id}`,
    outletId: "wm-1",
    outletName: "Warung Meng",
    channel: "pos",
    fulfillment: "dine-in",
    paymentStatus: "paid",
    paymentMethod: "cash",
    status: "completed",
    customer: null,
    totals: {
      subtotal: total,
      discount: IDR(0),
      tax: IDR(0),
      serviceCharge: IDR(0),
      rounding: IDR(0),
      total,
    },
    customerNote: "",
    internalNote: "",
    updatedAt: overrides.createdAt,
    events: [],
    ...overrides,
  };
}

function component(
  overrides: Partial<RecipeComponent> & Pick<RecipeComponent, "id" | "ingredientId">,
): RecipeComponent {
  return {
    quantity: 1,
    unit: "g",
    wastePercentage: 0,
    ...overrides,
  };
}

function recipe(overrides: Partial<MenuRecipe> & Pick<MenuRecipe, "menuItemId">): MenuRecipe {
  return {
    components: [component({ id: `rc-${overrides.menuItemId}`, ingredientId: "rice" })],
    packagingCost: IDR(0),
    additionalCost: IDR(0),
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function movement(
  overrides: Partial<InventoryMovement> &
    Pick<InventoryMovement, "id" | "referenceId" | "occurredAt">,
): InventoryMovement {
  const quantity = overrides.quantity ?? 1;
  return {
    ingredientId: "rice",
    outletId: "wm-1",
    type: "consumption",
    quantity,
    unit: "g",
    baseQuantityDelta: -quantity,
    unitCost: IDR(1),
    note: "",
    ...overrides,
  };
}

interface StoreSeed {
  readonly movements?: readonly InventoryMovement[];
  readonly recipes?: readonly MenuRecipe[];
  readonly failMovements?: boolean;
  readonly failRecipes?: boolean;
}

/** Both list methods deliberately ignore their query; DS-C must refilter. */
function inventoryStoreOver(seed: StoreSeed): InventoryStorePort {
  const unsupported = (): never => {
    throw new Error("write path not used by historical-item-profit");
  };

  return {
    listIngredients: async () => [],
    getIngredientById: async () => null,
    createIngredient: unsupported,
    updateIngredient: unsupported,
    listSuppliers: async () => [],
    listStockBalances: async () => [],
    listMovements: async () => {
      if (seed.failMovements === true) throw new Error("movements unavailable");
      return seed.movements ?? [];
    },
    listRecipes: async () => {
      if (seed.failRecipes === true) throw new Error("recipes unavailable");
      return seed.recipes ?? [];
    },
    commitMovement: unsupported,
    commitMovements: unsupported,
    newId: (kind) => `${kind}-test`,
  };
}

interface RuntimeOptions {
  readonly orders?: readonly Order[];
  readonly inventoryStore?: InventoryStorePort;
  readonly failOrders?: boolean;
  readonly throwOrders?: boolean;
  readonly withOrdersArea?: boolean;
}

function runtimeWith(options: RuntimeOptions): {
  readonly profit: HistoricalItemProfit | undefined;
  readonly snapshot: AdminEngineSnapshot;
  readonly dispose: () => void;
} {
  const withOrdersArea = options.withOrdersArea !== false;
  let captured: HistoricalItemProfit | undefined;

  const orderCapability: OrderRead = {
    // Ignores filters intentionally. DS-C owns the final outlet/date selection.
    listOrders: async () => {
      if (options.throwOrders === true) throw new Error("orders threw");
      if (options.failOrders === true) {
        return operationFailure("failed", [
          operationIssue("test-orders-failed", "orders unavailable", "orders"),
        ]);
      }
      const orders = options.orders ?? [];
      return operationSuccess({ orders, totalCount: orders.length });
    },
    getOrderById: async () =>
      operationFailure("not-found", [operationIssue("test-not-found", "not used", "getOrderById")]),
  };

  const orderProvider = defineLogicChild({
    id: "admin.orders.historical-profit-test-provider",
    parentId: ordersEngine.id,
    provides: [ORDER_READ_ID],
    requires: [],
    create(context) {
      context.capabilities.provide(ORDER_READ, orderCapability);
      return orderCapability;
    },
  });

  const probe = defineLogicChild({
    id: "admin.inventory.historical-profit-test-probe",
    parentId: inventoryEngine.id,
    requires: [HISTORICAL_ITEM_PROFIT_ID],
    create(context) {
      const resolution = context.capabilities.resolve(HISTORICAL_ITEM_PROFIT);
      if (resolution.status === "available") captured = resolution.value;
      return undefined;
    },
  });

  const runtime = createAdminEngine({
    definitions: {
      engines: withOrdersArea ? [inventoryEngine, ordersEngine] : [inventoryEngine],
      children: withOrdersArea
        ? [historicalItemProfitChild, orderProvider, probe]
        : [historicalItemProfitChild, probe],
    },
    ports: {
      resolve: (token) =>
        token.id === INVENTORY_STORE_PORT.id && options.inventoryStore !== undefined
          ? (options.inventoryStore as never)
          : undefined,
    },
  });

  return {
    profit: captured,
    snapshot: runtime.getSnapshot(),
    dispose: runtime.dispose,
  };
}

function oneLineFixture(
  options: {
    readonly unitCost?: Money | null;
    readonly menuItemId?: string;
    readonly menuName?: string;
  } = {},
): {
  readonly orders: readonly Order[];
  readonly store: InventoryStorePort;
} {
  const soldAt = "2026-08-01T10:00:00.000Z";
  const menuItemId = options.menuItemId ?? "menu-rice";
  return {
    orders: [
      order({
        id: "order-1",
        createdAt: soldAt,
        items: [
          item({
            id: "line-1",
            menuItemId,
            name: options.menuName ?? "Nasi",
          }),
        ],
      }),
    ],
    store: inventoryStoreOver({
      movements: [
        movement({
          id: "movement-1",
          referenceId: "order-1",
          occurredAt: soldAt,
          unitCost: options.unitCost === undefined ? IDR(1) : options.unitCost,
        }),
      ],
      recipes: [recipe({ menuItemId })],
    }),
  };
}

describe("historical item profit capability", () => {
  it("publishes through a probe and declares the required Orders read edge", () => {
    const fixture = oneLineFixture();
    const runtime = runtimeWith({ orders: fixture.orders, inventoryStore: fixture.store });

    expect(runtime.profit).toBeDefined();
    const child = runtime.snapshot.runtime.engines
      .flatMap((engine) => engine.children)
      .find((entry) => entry.childId === HISTORICAL_ITEM_PROFIT_ID);
    expect(child?.requires).toEqual([ORDER_READ_ID]);
    expect(child?.provides).toEqual([HISTORICAL_ITEM_PROFIT_ID]);
    runtime.dispose();
  });

  it("splits shared ingredient cost by recipe proportion without rounding", async () => {
    const soldAt = "2026-08-01T10:00:00.000Z";
    const sold = order({
      id: "order-shared",
      createdAt: soldAt,
      items: [
        item({
          id: "line-large",
          menuItemId: "menu-large",
          name: "Porsi Besar",
          quantity: 2,
          lineTotal: IDR(1_000),
        }),
        item({
          id: "line-small",
          menuItemId: "menu-small",
          name: "Porsi Kecil",
          lineTotal: IDR(500),
        }),
      ],
    });
    const store = inventoryStoreOver({
      // Same timestamp, reversed ids/input. The fractional unit rate is kept.
      movements: [
        movement({
          id: "movement-small",
          referenceId: sold.id,
          occurredAt: soldAt,
          quantity: 100,
          unitCost: IDR(0.12345),
        }),
        movement({
          id: "movement-large",
          referenceId: sold.id,
          occurredAt: soldAt,
          quantity: 200,
          unitCost: IDR(0.12345),
        }),
      ],
      recipes: [
        recipe({
          menuItemId: "menu-large",
          components: [component({ id: "rc-large", ingredientId: "rice", quantity: 100 })],
          packagingCost: IDR(0.25),
        }),
        recipe({
          menuItemId: "menu-small",
          components: [component({ id: "rc-small", ingredientId: "rice", quantity: 100 })],
          packagingCost: IDR(0.5),
        }),
      ],
    });
    const runtime = runtimeWith({ orders: [sold], inventoryStore: store });

    const result = await runtime.profit?.queryHistoricalItemProfits(AUGUST_FIRST);

    expect(result?.status).toBe("success");
    if (result?.status === "success") {
      const byId = new Map(result.value.items.map((entry) => [entry.menuItemId, entry]));
      // 200/300 of recorded 37.035 + 2 × 0.25 packaging. No new rounding.
      expect(byId.get("menu-large")?.reconstructedCost?.amount).toBeCloseTo(25.19, 10);
      expect(byId.get("menu-large")?.reconstructedProfit?.amount).toBeCloseTo(974.81, 10);
      // 100/300 of recorded 37.035 + 1 × 0.5 packaging keeps three decimals.
      expect(byId.get("menu-small")?.reconstructedCost?.amount).toBeCloseTo(12.845, 10);
      expect(byId.get("menu-small")?.reconstructedProfit?.amount).toBeCloseTo(487.155, 10);
      expect(result.value.attribution).toBe(HISTORICAL_ITEM_PROFIT_ATTRIBUTION);
      expect(result.value.recipeAssumption).toBe(HISTORICAL_ITEM_PROFIT_RECIPE_ASSUMPTION);
    }
    runtime.dispose();
  });

  it("marks pre-S11 null cost as unknown instead of zero", async () => {
    const fixture = oneLineFixture({ unitCost: null });
    const runtime = runtimeWith({ orders: fixture.orders, inventoryStore: fixture.store });

    const result = await runtime.profit?.queryHistoricalItemProfits(AUGUST_FIRST);

    expect(result?.status).toBe("degraded");
    if (result?.status === "degraded") {
      const row = result.value.items[0];
      expect(row?.costStatus).toBe("unknown");
      expect(row?.reconstructedCost).toBeNull();
      expect(row?.reconstructedProfit).toBeNull();
      expect(row?.unknownOrderItemCount).toBe(1);
      expect(row?.issues.map((issue) => issue.code)).toContain(
        HISTORICAL_ITEM_PROFIT_ISSUE.missingConsumptionCost,
      );
    }
    runtime.dispose();
  });

  it("never presents a known subtotal when one historical line is unknown", async () => {
    const known = oneLineFixture();
    const oldOrder = order({
      id: "order-legacy",
      createdAt: "2026-08-01T09:00:00.000Z",
      items: [item({ id: "line-legacy", menuItemId: "menu-rice", name: "Nasi" })],
    });
    const store = inventoryStoreOver({
      movements: [
        movement({
          id: "movement-known",
          referenceId: "order-1",
          occurredAt: "2026-08-01T10:00:00.000Z",
        }),
        movement({
          id: "movement-legacy",
          referenceId: oldOrder.id,
          occurredAt: oldOrder.createdAt,
          unitCost: null,
        }),
      ],
      recipes: [recipe({ menuItemId: "menu-rice" })],
    });
    const runtime = runtimeWith({
      orders: [...known.orders, oldOrder],
      inventoryStore: store,
    });

    const result = await runtime.profit?.queryHistoricalItemProfits(AUGUST_FIRST);

    expect(result?.status).toBe("degraded");
    if (result?.status === "degraded") {
      expect(result.value.items[0]).toMatchObject({
        revenue: IDR(2_000),
        orderItemCount: 2,
        unknownOrderItemCount: 1,
        costStatus: "unknown",
        reconstructedCost: null,
        reconstructedProfit: null,
      });
    }
    runtime.dispose();
  });

  it("sorts duplicate menu names by menu id and ignores source order", async () => {
    const soldAt = "2026-08-01T10:00:00.000Z";
    const sold = order({
      id: "order-tie",
      createdAt: soldAt,
      items: [
        item({ id: "line-a", menuItemId: "menu-a", name: "Nasi" }),
        item({ id: "line-b", menuItemId: "menu-b", name: "Nasi" }),
      ],
    });
    const store = inventoryStoreOver({
      movements: [
        movement({ id: "movement-a", referenceId: sold.id, occurredAt: soldAt }),
        movement({ id: "movement-b", referenceId: sold.id, occurredAt: soldAt }),
      ].reverse(),
      recipes: [recipe({ menuItemId: "menu-b" }), recipe({ menuItemId: "menu-a" })],
    });
    const runtime = runtimeWith({ orders: [sold], inventoryStore: store });

    const result = await runtime.profit?.queryHistoricalItemProfits(AUGUST_FIRST);

    expect(result?.status).toBe("success");
    if (result?.status === "success") {
      expect(result.value.items.map((entry) => entry.menuItemId)).toEqual(["menu-a", "menu-b"]);
    }
    runtime.dispose();
  });

  it("re-filters outlet and Jakarta dates even when both sources ignore queries", async () => {
    // 18:30Z is 01:30 on August 2 in Jakarta.
    const includedAt = "2026-08-01T18:30:00.000Z";
    const excludedAt = "2026-08-01T16:30:00.000Z";
    const included = order({
      id: "order-included",
      createdAt: includedAt,
      items: [item({ id: "line-included", menuItemId: "menu-included", name: "A" })],
    });
    const tooEarly = order({
      id: "order-early",
      createdAt: excludedAt,
      items: [item({ id: "line-early", menuItemId: "menu-early", name: "B" })],
    });
    const otherOutlet = order({
      id: "order-other",
      createdAt: includedAt,
      outletId: "wm-2",
      items: [item({ id: "line-other", menuItemId: "menu-other", name: "C" })],
    });
    const store = inventoryStoreOver({
      movements: [
        movement({
          id: "movement-included",
          referenceId: included.id,
          occurredAt: includedAt,
        }),
        movement({ id: "movement-early", referenceId: tooEarly.id, occurredAt: excludedAt }),
        movement({
          id: "movement-other",
          referenceId: otherOutlet.id,
          occurredAt: includedAt,
          outletId: "wm-2",
        }),
      ],
      recipes: [
        recipe({ menuItemId: "menu-included" }),
        recipe({ menuItemId: "menu-early" }),
        recipe({ menuItemId: "menu-other" }),
      ],
    });
    const runtime = runtimeWith({
      orders: [tooEarly, otherOutlet, included],
      inventoryStore: store,
    });

    const result = await runtime.profit?.queryHistoricalItemProfits({
      outletId: "wm-1",
      dateFrom: "2026-08-02",
      dateTo: "2026-08-02",
    });

    expect(result?.status).toBe("success");
    if (result?.status === "success") {
      expect(result.value.items.map((entry) => entry.menuItemId)).toEqual(["menu-included"]);
    }
    runtime.dispose();
  });

  it("allocates against every dish before applying a menu filter", async () => {
    const soldAt = "2026-08-01T10:00:00.000Z";
    const sold = order({
      id: "order-filter",
      createdAt: soldAt,
      items: [
        item({ id: "line-a", menuItemId: "menu-a", name: "A" }),
        item({ id: "line-b", menuItemId: "menu-b", name: "B" }),
      ],
    });
    const store = inventoryStoreOver({
      movements: [
        movement({
          id: "movement-filter",
          referenceId: sold.id,
          occurredAt: soldAt,
          quantity: 2,
          unitCost: IDR(10),
        }),
      ],
      recipes: [recipe({ menuItemId: "menu-a" }), recipe({ menuItemId: "menu-b" })],
    });
    const runtime = runtimeWith({ orders: [sold], inventoryStore: store });

    const result = await runtime.profit?.queryHistoricalItemProfits({
      ...AUGUST_FIRST,
      menuItemId: "menu-a",
    });

    expect(result?.status).toBe("success");
    if (result?.status === "success") {
      expect(result.value.items).toHaveLength(1);
      expect(result.value.items[0]?.reconstructedCost?.amount).toBe(10);
    }
    runtime.dispose();
  });

  it("degrades when recorded consumption no longer matches the current recipe", async () => {
    const fixture = oneLineFixture();
    const mismatchedStore = inventoryStoreOver({
      movements: [
        movement({
          id: "movement-1",
          referenceId: "order-1",
          occurredAt: "2026-08-01T10:00:00.000Z",
          quantity: 1,
        }),
      ],
      recipes: [
        recipe({
          menuItemId: "menu-rice",
          components: [component({ id: "rc-rice", ingredientId: "rice", quantity: 2 })],
        }),
      ],
    });
    const runtime = runtimeWith({
      orders: fixture.orders,
      inventoryStore: mismatchedStore,
    });

    const result = await runtime.profit?.queryHistoricalItemProfits(AUGUST_FIRST);

    expect(result?.status).toBe("degraded");
    if (result?.status === "degraded") {
      expect(result.value.items[0]?.costStatus).toBe("unknown");
      expect(result.value.items[0]?.issues.map((issue) => issue.code)).toContain(
        HISTORICAL_ITEM_PROFIT_ISSUE.consumptionQuantityMismatch,
      );
      expect(result.value.recipeAssumption).toBe(HISTORICAL_ITEM_PROFIT_RECIPE_ASSUMPTION);
    }
    runtime.dispose();
  });

  it.each([
    { source: "movements" as const, seed: { failMovements: true } },
    { source: "recipes" as const, seed: { failRecipes: true } },
  ])("keeps Orders usable and degrades when $source fails", async ({ source, seed }) => {
    const fixture = oneLineFixture();
    const store = inventoryStoreOver({
      movements: [
        movement({
          id: "movement-1",
          referenceId: "order-1",
          occurredAt: "2026-08-01T10:00:00.000Z",
        }),
      ],
      recipes: [recipe({ menuItemId: "menu-rice" })],
      ...seed,
    });
    const runtime = runtimeWith({ orders: fixture.orders, inventoryStore: store });

    const result = await runtime.profit?.queryHistoricalItemProfits(AUGUST_FIRST);

    expect(result?.status).toBe("degraded");
    if (result?.status === "degraded") {
      expect(result.value.failedSources).toEqual([source]);
      expect(result.value.items[0]?.costStatus).toBe("unknown");
      expect(result.value.items[0]?.reconstructedCost).toBeNull();
    }
    runtime.dispose();
  });

  it("fails instead of fabricating an empty collection when every source fails", async () => {
    const runtime = runtimeWith({
      failOrders: true,
      inventoryStore: inventoryStoreOver({ failMovements: true, failRecipes: true }),
    });

    const result = await runtime.profit?.queryHistoricalItemProfits(AUGUST_FIRST);

    expect(result?.status).toBe("failure");
    if (result?.status === "failure") {
      expect(result.issues[0]?.code).toBe(HISTORICAL_ITEM_PROFIT_ISSUE.allSourcesUnavailable);
    }
    runtime.dispose();
  });

  it("fails when Orders is unavailable even if inventory sources answered", async () => {
    const runtime = runtimeWith({
      failOrders: true,
      inventoryStore: inventoryStoreOver({}),
    });

    const result = await runtime.profit?.queryHistoricalItemProfits(AUGUST_FIRST);

    expect(result?.status).toBe("failure");
    if (result?.status === "failure") {
      expect(result.issues.some((issue) => issue.code === "test-orders-failed")).toBe(true);
    }
    runtime.dispose();
  });

  it("rejects invalid outlet, menu id, and reporting period", async () => {
    const fixture = oneLineFixture();
    const runtime = runtimeWith({ orders: fixture.orders, inventoryStore: fixture.store });

    const outlet = await runtime.profit?.queryHistoricalItemProfits({
      ...AUGUST_FIRST,
      outletId: " ",
    });
    const menu = await runtime.profit?.queryHistoricalItemProfits({
      ...AUGUST_FIRST,
      menuItemId: " ",
    });
    const period = await runtime.profit?.queryHistoricalItemProfits({
      ...AUGUST_FIRST,
      dateFrom: "2026-08-02",
      dateTo: "2026-08-01",
    });

    expect(outlet?.status).toBe("failure");
    expect(menu?.status).toBe("failure");
    expect(period?.status).toBe("failure");
    runtime.dispose();
  });

  it("stays active without a store, publishes, and reports one creation diagnostic", async () => {
    const fixture = oneLineFixture();
    const runtime = runtimeWith({ orders: fixture.orders });

    expect(runtime.profit).toBeDefined();
    const area = runtime.snapshot.areas.find((entry) => entry.engineId === inventoryEngine.id);
    expect(area?.failedChildIds).not.toContain(HISTORICAL_ITEM_PROFIT_ID);
    const child = runtime.snapshot.runtime.engines
      .flatMap((engine) => engine.children)
      .find((entry) => entry.childId === HISTORICAL_ITEM_PROFIT_ID);
    expect(child?.state).toBe("active");
    expect(runtime.snapshot.runtime.capabilities).toContain(HISTORICAL_ITEM_PROFIT_ID);

    const first = await runtime.profit?.queryHistoricalItemProfits(AUGUST_FIRST);
    const second = await runtime.profit?.queryHistoricalItemProfits(AUGUST_FIRST);
    expect(first?.status).toBe("failure");
    expect(second?.status).toBe("failure");
    if (first?.status === "failure") {
      expect(first.reason).toBe("unsatisfied-dependency");
      expect(first.issues[0]?.code).toBe("no-inventory-store");
    }
    expect(
      runtime.snapshot.diagnostics.filter(
        (entry) =>
          entry.source === "historicalItemProfitChild" && entry.code === "missing-dependency",
      ),
    ).toHaveLength(1);
    runtime.dispose();
  });

  it("is excluded when its required Orders capability is absent", () => {
    const runtime = runtimeWith({
      inventoryStore: inventoryStoreOver({}),
      withOrdersArea: false,
    });

    expect(runtime.profit).toBeUndefined();
    const area = runtime.snapshot.areas.find((entry) => entry.engineId === inventoryEngine.id);
    expect(area?.unavailableChildIds).toContain(HISTORICAL_ITEM_PROFIT_ID);
    runtime.dispose();
  });
});
