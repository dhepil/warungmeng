// Protected Dashboard reports behavior through the real four-area graph.

import type {
  FinanceTransaction,
  InventoryIngredient,
  InventoryMovement,
  Money,
  Order,
} from "@warungmeng/domain";
import {
  defineLogicChild,
  operationDegraded,
  operationFailure,
  operationIssue,
  operationSuccess,
  type OperationResult,
} from "@warungmeng/module-system";
import { describe, expect, it, vi } from "vitest";
import type { AdminEngineSnapshot } from "../../../../adminEngineContracts";
import { createAdminEngine } from "../../../../createAdminEngine";
import type { LedgerRead } from "../../../finance/financeContracts";
import { LEDGER_READ, LEDGER_READ_ID } from "../../../finance/financeContracts";
import financeEngine from "../../../finance/financeEngine";
import type { MovementListItem, StockMovements } from "../../../inventory/inventoryContracts";
import { STOCK_MOVEMENTS, STOCK_MOVEMENTS_ID } from "../../../inventory/inventoryContracts";
import inventoryEngine from "../../../inventory/inventoryEngine";
import type { OrderCollection, OrderRead } from "../../../orders/ordersContracts";
import { ORDER_READ, ORDER_READ_ID } from "../../../orders/ordersContracts";
import ordersEngine from "../../../orders/ordersEngine";
import type { DashboardDataSource, DashboardReports } from "../../dashboardContracts";
import { DASHBOARD_REPORTS, DASHBOARD_REPORTS_ID } from "../../dashboardContracts";
import dashboardEngine from "../../dashboardEngine";
import dashboardReportsChild from "./dashboardReportsChild";

const IDR = (amount: number): Money => ({ amount, currency: "IDR" });
const PERIOD = {
  startDate: "2026-08-01",
  endDate: "2026-08-01",
  timeZone: "Asia/Jakarta",
} as const;

function order(): Order {
  return {
    id: "order-1",
    orderNumber: "WM-001",
    outletId: "wm-1",
    outletName: "Warung Meng",
    channel: "pos",
    fulfillment: "dine-in",
    paymentStatus: "paid",
    paymentMethod: "cash",
    status: "completed",
    customer: null,
    items: [
      {
        id: "item-1",
        menuItemId: "menu-1",
        name: "Nasi",
        quantity: 1,
        unitPrice: IDR(20_000),
        variantSelections: [],
        note: "",
        lineTotal: IDR(20_000),
      },
    ],
    totals: {
      subtotal: IDR(20_000),
      discount: IDR(0),
      tax: IDR(0),
      serviceCharge: IDR(0),
      rounding: IDR(0),
      total: IDR(20_000),
    },
    customerNote: "",
    internalNote: "",
    createdAt: "2026-08-01T03:00:00.000Z",
    updatedAt: "2026-08-01T03:00:00.000Z",
    events: [],
  };
}

function sale(): FinanceTransaction {
  return {
    id: "sale-order-1",
    occurredAt: "2026-08-01T03:00:00.000Z",
    direction: "inflow",
    type: "sale",
    source: "automatic",
    status: "posted",
    categoryId: "sales",
    categoryLabel: "Penjualan",
    amount: IDR(20_000),
    paymentMethod: "cash",
    description: "Sale",
    referenceNumber: "WM-001",
    sourceReference: "order-1",
    attachment: null,
    createdAt: "2026-08-01T03:00:00.000Z",
    updatedAt: "2026-08-01T03:00:00.000Z",
  };
}

function ingredient(): InventoryIngredient {
  return {
    id: "ingredient-1",
    name: "Beras",
    baseUnit: "kg",
    supplierId: null,
    status: "active",
    minimumStock: 2,
    lastPurchaseUnitCost: IDR(14_000),
    averageUnitCost: IDR(14_000),
  };
}

function movement(
  overrides: Partial<InventoryMovement> & Pick<InventoryMovement, "id">,
): InventoryMovement {
  return {
    ingredientId: "ingredient-1",
    outletId: "wm-1",
    type: "consumption",
    quantity: 2,
    unit: "kg",
    baseQuantityDelta: -2,
    unitCost: IDR(14_000),
    referenceId: "order-1",
    note: "POS WM-001",
    occurredAt: "2026-08-01T03:00:00.000Z",
    ...overrides,
  };
}

function movementRows(): readonly MovementListItem[] {
  const rice = ingredient();
  return [
    {
      movement: movement({
        id: "opening",
        type: "purchase",
        quantity: 10,
        baseQuantityDelta: 10,
        referenceId: "purchase-1",
        occurredAt: "2026-07-31T03:00:00.000Z",
      }),
      ingredient: rice,
    },
    { movement: movement({ id: "consumption-1" }), ingredient: rice },
  ];
}

function ordersOver(result: OperationResult<OrderCollection>): OrderRead {
  return {
    listOrders: async () => result,
    getOrderById: async () => operationFailure("not-found", []),
  };
}

function movementsOver(
  result: OperationResult<readonly MovementListItem[]>,
  queryMovements = vi.fn(async () => result),
): StockMovements & { readonly queryMovements: typeof queryMovements } {
  return {
    listMovements: async () => operationSuccess([]),
    queryMovements,
  };
}

function ledgerOver(result: OperationResult<readonly FinanceTransaction[]>): LedgerRead {
  return {
    listTransactions: async () => result,
    queryLedger: async () => operationFailure("failed", []),
    resolveDatePreset: () => ({ dateFrom: PERIOD.startDate, dateTo: PERIOD.endDate }),
    identifyDateRange: () => "custom",
  };
}

interface RuntimeOptions {
  readonly missing?: DashboardDataSource;
  readonly orders?: OrderRead;
  readonly movements?: StockMovements;
  readonly ledger?: LedgerRead;
}

function runtimeWith(options: RuntimeOptions = {}): {
  readonly reports: DashboardReports | undefined;
  readonly snapshot: AdminEngineSnapshot;
  readonly dispose: () => void;
} {
  let captured: DashboardReports | undefined;
  const orderCapability =
    options.orders ?? ordersOver(operationSuccess({ orders: [order()], totalCount: 1 }));
  const movementCapability = options.movements ?? movementsOver(operationSuccess(movementRows()));
  const ledgerCapability = options.ledger ?? ledgerOver(operationSuccess([sale()]));

  const orderProvider = defineLogicChild({
    id: "admin.orders.dashboard-reports-provider",
    parentId: ordersEngine.id,
    provides: [ORDER_READ_ID],
    create(context) {
      context.capabilities.provide(ORDER_READ, orderCapability);
    },
  });
  const inventoryProvider = defineLogicChild({
    id: "admin.inventory.dashboard-reports-provider",
    parentId: inventoryEngine.id,
    provides: [STOCK_MOVEMENTS_ID],
    create(context) {
      context.capabilities.provide(STOCK_MOVEMENTS, movementCapability);
    },
  });
  const financeProvider = defineLogicChild({
    id: "admin.finance.dashboard-reports-provider",
    parentId: financeEngine.id,
    provides: [LEDGER_READ_ID],
    create(context) {
      context.capabilities.provide(LEDGER_READ, ledgerCapability);
    },
  });
  const probe = defineLogicChild({
    id: "admin.dashboard.reports-probe",
    parentId: dashboardEngine.id,
    requires: [DASHBOARD_REPORTS_ID],
    create(context) {
      const resolution = context.capabilities.resolve(DASHBOARD_REPORTS);
      if (resolution.status === "available") captured = resolution.value;
    },
  });

  const engines = [dashboardEngine];
  const children = [dashboardReportsChild, probe];
  if (options.missing !== "orders") {
    engines.push(ordersEngine);
    children.push(orderProvider);
  }
  if (options.missing !== "inventory") {
    engines.push(inventoryEngine);
    children.push(inventoryProvider);
  }
  if (options.missing !== "finance") {
    engines.push(financeEngine);
    children.push(financeProvider);
  }

  const runtime = createAdminEngine({ definitions: { engines, children } });
  return { reports: captured, snapshot: runtime.getSnapshot(), dispose: runtime.dispose };
}

describe("Dashboard reports graph", () => {
  it("publishes the LOGIC section 8 id with all three requirements verbatim", () => {
    expect(dashboardReportsChild.provides).toEqual([DASHBOARD_REPORTS_ID]);
    expect(dashboardReportsChild.requires).toEqual([
      ORDER_READ_ID,
      STOCK_MOVEMENTS_ID,
      LEDGER_READ_ID,
    ]);

    const runtime = runtimeWith();
    expect(runtime.reports).toBeDefined();
    runtime.dispose();
  });

  it.each(["orders", "inventory", "finance"] as const)(
    "is excluded when the %s area is absent",
    (missing) => {
      const runtime = runtimeWith({ missing });

      expect(runtime.reports).toBeUndefined();
      expect(
        runtime.snapshot.areas.find((area) => area.engineId === dashboardEngine.id)
          ?.unavailableChildIds,
      ).toContain(DASHBOARD_REPORTS_ID);
      runtime.dispose();
    },
  );
});

describe("Dashboard reports loading", () => {
  it("composes sales, menu, and inventory reports through the domain selectors", async () => {
    const queryMovements = vi.fn(async () => operationSuccess(movementRows()));
    const movements = movementsOver(operationSuccess(movementRows()), queryMovements);
    const runtime = runtimeWith({ movements });

    const result = await runtime.reports?.loadReports({ period: PERIOD });

    expect(result).toMatchObject({
      status: "success",
      value: {
        failedSources: [],
        dailyNetRevenueTotal: 20_000,
        menuPerformance: [
          { menuItemId: "menu-1", menuName: "Nasi", quantitySold: 1, missingCost: true },
        ],
        inventoryUsage: [
          {
            ingredientId: "ingredient-1",
            quantityUsed: 2,
            estimatedUsageValue: { amount: 28_000 },
            currentStock: 8,
            lowStock: false,
          },
        ],
        isSalesEmpty: false,
        isMenuEmpty: false,
        isInventoryEmpty: false,
      },
    });
    expect(queryMovements).toHaveBeenCalledWith({
      ingredientId: null,
      outletId: "wm-1",
      type: "all",
    });
    runtime.dispose();
  });

  it("degrades per source while keeping healthy sales and inventory", async () => {
    const runtime = runtimeWith({
      orders: ordersOver(
        operationFailure("failed", [operationIssue("orders-offline", "Orders offline")]),
      ),
    });

    const result = await runtime.reports?.loadReports({ period: PERIOD });

    expect(result?.status).toBe("degraded");
    if (result?.status === "degraded") {
      expect(result.value.failedSources).toEqual(["orders"]);
      expect(result.value.dailyNetRevenueTotal).toBe(20_000);
      expect(result.value.inventoryUsage).toHaveLength(1);
      expect(result.issues.some((issue) => issue.code === "orders-offline")).toBe(true);
    }
    runtime.dispose();
  });

  it("keeps a usable upstream degradation and names its source", async () => {
    const runtime = runtimeWith({
      ledger: ledgerOver(
        operationDegraded([sale()], [operationIssue("manual-rows-missing", "Manual rows absent")]),
      ),
    });

    const result = await runtime.reports?.loadReports({ period: PERIOD });

    expect(result).toMatchObject({
      status: "degraded",
      value: { failedSources: ["finance"], dailyNetRevenueTotal: 20_000 },
    });
    runtime.dispose();
  });

  it("surfaces legacy cost gaps and dangling movement ingredients without dropping rows", async () => {
    const dangling = movement({ id: "legacy", unitCost: null });
    const runtime = runtimeWith({
      movements: movementsOver(operationSuccess([{ movement: dangling, ingredient: null }])),
    });

    const result = await runtime.reports?.loadReports({ period: PERIOD });

    expect(result?.status).toBe("degraded");
    if (result?.status === "degraded") {
      expect(result.value.failedSources).toEqual(["inventory"]);
      expect(result.value.inventoryUsage).toEqual([]);
      expect(result.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining([
          "dashboard-movement-ingredient-missing",
          "dashboard-consumption-cost-missing",
        ]),
      );
    }
    runtime.dispose();
  });

  it("fails rather than fabricating reports when every source fails", async () => {
    const failed = operationFailure("failed", [operationIssue("offline", "Offline")]);
    const runtime = runtimeWith({
      orders: ordersOver(failed),
      movements: movementsOver(failed),
      ledger: ledgerOver(failed),
    });

    const result = await runtime.reports?.loadReports({ period: PERIOD });

    expect(result?.status).toBe("failure");
    if (result?.status === "failure") {
      expect(result.reason).toBe("failed");
      expect(result.issues[0]?.code).toBe("dashboard-all-sources-unavailable");
    }
    runtime.dispose();
  });

  it("rejects invalid periods before reading any source", async () => {
    const listOrders = vi.fn(async () => operationSuccess({ orders: [], totalCount: 0 }));
    const runtime = runtimeWith({
      orders: { listOrders, getOrderById: async () => operationFailure("not-found", []) },
    });

    const result = await runtime.reports?.loadReports({
      period: { ...PERIOD, startDate: "2026-08-02" },
    });

    expect(result).toMatchObject({
      status: "failure",
      reason: "invalid-input",
      issues: [{ code: "invalid-dashboard-period" }],
    });
    expect(listOrders).not.toHaveBeenCalled();
    runtime.dispose();
  });
});
