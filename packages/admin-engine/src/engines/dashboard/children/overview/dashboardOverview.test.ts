// Protected Dashboard overview behavior through the real four-area graph.

import type {
  FinanceTransaction,
  InventoryIngredient,
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
import type {
  MaterialCollection,
  MaterialsRead,
} from "../../../inventory/inventoryContracts";
import {
  MATERIALS_READ,
  MATERIALS_READ_ID,
} from "../../../inventory/inventoryContracts";
import inventoryEngine from "../../../inventory/inventoryEngine";
import type { OrderCollection, OrderRead } from "../../../orders/ordersContracts";
import { ORDER_READ, ORDER_READ_ID } from "../../../orders/ordersContracts";
import ordersEngine from "../../../orders/ordersEngine";
import type {
  DashboardDataSource,
  DashboardOverview,
} from "../../dashboardContracts";
import {
  DASHBOARD_OVERVIEW,
  DASHBOARD_OVERVIEW_ID,
} from "../../dashboardContracts";
import dashboardEngine from "../../dashboardEngine";
import dashboardOverviewChild from "./dashboardOverviewChild";

const IDR = (amount: number): Money => ({ amount, currency: "IDR" });
const PERIOD = {
  startDate: "2026-08-01",
  endDate: "2026-08-01",
  timeZone: "Asia/Jakarta",
} as const;

function order(overrides: Partial<Order> = {}): Order {
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
    ...overrides,
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
    lastPurchaseUnitCost: IDR(15_000),
    averageUnitCost: IDR(14_000),
  };
}

function materialCollection(quantity = 1, hasBalanceRecord = true): MaterialCollection {
  const material = ingredient();
  return {
    materials: [
      {
        ingredient: material,
        outletId: "wm-1",
        quantity,
        hasBalanceRecord,
        isLowStock: quantity <= material.minimumStock,
        supplier: null,
      },
    ],
    totalCount: 1,
    lowStockCount: 1,
  };
}

function ordersOver(result: OperationResult<OrderCollection>): OrderRead {
  return {
    listOrders: async () => result,
    getOrderById: async () => operationFailure("not-found", []),
  };
}

function materialsOver(
  result: OperationResult<MaterialCollection>,
  queryMaterials = vi.fn(async () => result),
): MaterialsRead & { readonly queryMaterials: typeof queryMaterials } {
  return {
    listIngredients: async () => operationSuccess([]),
    listSuppliers: async () => operationSuccess([]),
    listStockBalances: async () => operationSuccess([]),
    queryMaterials,
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
  readonly materials?: MaterialsRead;
  readonly ledger?: LedgerRead;
}

function runtimeWith(options: RuntimeOptions = {}): {
  readonly overview: DashboardOverview | undefined;
  readonly snapshot: AdminEngineSnapshot;
  readonly dispose: () => void;
} {
  let captured: DashboardOverview | undefined;
  const orderCapability =
    options.orders ?? ordersOver(operationSuccess({ orders: [order()], totalCount: 1 }));
  const materialCapability =
    options.materials ?? materialsOver(operationSuccess(materialCollection()));
  const ledgerCapability = options.ledger ?? ledgerOver(operationSuccess([sale()]));

  const orderProvider = defineLogicChild({
    id: "admin.orders.dashboard-overview-provider",
    parentId: ordersEngine.id,
    provides: [ORDER_READ_ID],
    create(context) {
      context.capabilities.provide(ORDER_READ, orderCapability);
    },
  });
  const inventoryProvider = defineLogicChild({
    id: "admin.inventory.dashboard-overview-provider",
    parentId: inventoryEngine.id,
    provides: [MATERIALS_READ_ID],
    create(context) {
      context.capabilities.provide(MATERIALS_READ, materialCapability);
    },
  });
  const financeProvider = defineLogicChild({
    id: "admin.finance.dashboard-overview-provider",
    parentId: financeEngine.id,
    provides: [LEDGER_READ_ID],
    create(context) {
      context.capabilities.provide(LEDGER_READ, ledgerCapability);
    },
  });
  const probe = defineLogicChild({
    id: "admin.dashboard.overview-probe",
    parentId: dashboardEngine.id,
    requires: [DASHBOARD_OVERVIEW_ID],
    create(context) {
      const resolution = context.capabilities.resolve(DASHBOARD_OVERVIEW);
      if (resolution.status === "available") captured = resolution.value;
    },
  });

  const engines = [dashboardEngine];
  const children = [dashboardOverviewChild, probe];
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
  return { overview: captured, snapshot: runtime.getSnapshot(), dispose: runtime.dispose };
}

describe("Dashboard overview graph", () => {
  it("publishes the LOGIC section 8 id with all three requirements verbatim", () => {
    expect(dashboardOverviewChild.provides).toEqual([DASHBOARD_OVERVIEW_ID]);
    expect(dashboardOverviewChild.requires).toEqual([
      ORDER_READ_ID,
      MATERIALS_READ_ID,
      LEDGER_READ_ID,
    ]);

    const runtime = runtimeWith();
    expect(runtime.overview).toBeDefined();
    runtime.dispose();
  });

  it.each(["orders", "inventory", "finance"] as const)(
    "is excluded when the %s area is absent",
    (missing) => {
      const runtime = runtimeWith({ missing });

      expect(runtime.overview).toBeUndefined();
      expect(
        runtime.snapshot.areas.find((area) => area.engineId === dashboardEngine.id)
          ?.unavailableChildIds,
      ).toContain(DASHBOARD_OVERVIEW_ID);
      runtime.dispose();
    },
  );
});

describe("Dashboard overview loading", () => {
  it("composes four areas and delegates the report projections to the domain", async () => {
    const queryMaterials = vi.fn(async () => operationSuccess(materialCollection()));
    const materials = materialsOver(operationSuccess(materialCollection()), queryMaterials);
    const runtime = runtimeWith({ materials });

    const result = await runtime.overview?.loadOverview({ period: PERIOD });

    expect(result).toMatchObject({
      status: "success",
      value: {
        outletId: "wm-1",
        failedSources: [],
        summary: {
          grossSales: { amount: 20_000 },
          paidOrderCount: 1,
          missingCostItemCount: 1,
          lowStockIngredientCount: 1,
        },
        lowStockIngredients: [{ ingredientId: "ingredient-1", currentStock: 1 }],
        isEmpty: false,
      },
    });
    expect(queryMaterials).toHaveBeenCalledWith({
      search: "",
      status: "active",
      outletId: "wm-1",
      lowStockOnly: false,
    });
    runtime.dispose();
  });

  it("keeps Inventory's missing-balance-as-zero rule in the domain projection", async () => {
    const runtime = runtimeWith({
      materials: materialsOver(operationSuccess(materialCollection(0, false))),
    });

    const result = await runtime.overview?.loadOverview({ period: PERIOD });

    expect(result?.status).toBe("success");
    if (result?.status === "success") {
      expect(result.value.lowStockIngredients).toMatchObject([
        { ingredientId: "ingredient-1", currentStock: 0 },
      ]);
      expect(result.value.summary.lowStockIngredientCount).toBe(1);
    }
    runtime.dispose();
  });

  it("degrades per source and keeps every healthy source", async () => {
    const runtime = runtimeWith({
      ledger: ledgerOver(
        operationFailure("failed", [operationIssue("finance-offline", "Finance offline")]),
      ),
    });

    const result = await runtime.overview?.loadOverview({ period: PERIOD });

    expect(result?.status).toBe("degraded");
    if (result?.status === "degraded") {
      expect(result.value.failedSources).toEqual(["finance"]);
      expect(result.value.summary.lowStockIngredientCount).toBe(1);
      expect(result.value.summary.paidOrderCount).toBe(0);
      expect(result.issues.some((issue) => issue.code === "finance-offline")).toBe(true);
    }
    runtime.dispose();
  });

  it("propagates a usable upstream degradation without discarding its value", async () => {
    const runtime = runtimeWith({
      ledger: ledgerOver(
        operationDegraded([sale()], [operationIssue("manual-finance-missing", "Manual rows absent")]),
      ),
    });

    const result = await runtime.overview?.loadOverview({ period: PERIOD });

    expect(result).toMatchObject({
      status: "degraded",
      value: { failedSources: ["finance"], summary: { grossSales: { amount: 20_000 } } },
    });
    runtime.dispose();
  });

  it("fails instead of fabricating an empty dashboard when every source fails", async () => {
    const failed = operationFailure("failed", [operationIssue("offline", "Offline")]);
    const runtime = runtimeWith({
      orders: ordersOver(failed),
      materials: materialsOver(failed),
      ledger: ledgerOver(failed),
    });

    const result = await runtime.overview?.loadOverview({ period: PERIOD });

    expect(result?.status).toBe("failure");
    if (result?.status === "failure") {
      expect(result.reason).toBe("failed");
      expect(result.issues[0]?.code).toBe("dashboard-all-sources-unavailable");
      expect(result.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining([
          "dashboard-orders-unavailable",
          "dashboard-finance-unavailable",
          "dashboard-inventory-unavailable",
        ]),
      );
    }
    runtime.dispose();
  });

  it("rejects an invalid period before reading any source", async () => {
    const listOrders = vi.fn(async () => operationSuccess({ orders: [], totalCount: 0 }));
    const orders: OrderRead = {
      listOrders,
      getOrderById: async () => operationFailure("not-found", []),
    };
    const runtime = runtimeWith({ orders });

    const result = await runtime.overview?.loadOverview({
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
