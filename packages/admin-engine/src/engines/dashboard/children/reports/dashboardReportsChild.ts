// packages/admin-engine/src/engines/dashboard/children/reports/dashboardReportsChild.ts
//
// Read-only detailed reporting across Orders, Inventory movements, and Finance.
// The child composes three published capabilities and delegates the metric
// calculations to packages/domain/reporting.ts.

import type { LedgerRead } from "../../../finance/financeContracts";
import { LEDGER_READ, LEDGER_READ_ID } from "../../../finance/financeContracts";
import type { MovementListItem, StockMovements } from "../../../inventory/inventoryContracts";
import { STOCK_MOVEMENTS, STOCK_MOVEMENTS_ID } from "../../../inventory/inventoryContracts";
import type { OrderRead } from "../../../orders/ordersContracts";
import {
  DEFAULT_ORDER_LIST_FILTERS,
  ORDER_READ,
  ORDER_READ_ID,
} from "../../../orders/ordersContracts";
import {
  buildCategoryPerformance,
  buildDailySalesTrend,
  buildInventoryUsage,
  buildMenuPerformance,
  buildOrderChannelBreakdown,
  buildPaymentMethodBreakdown,
  buildPeakSalesHours,
  isTimestampInReportingPeriod,
  validateReportingPeriod,
  type InventoryIngredient,
  type InventoryMovement,
  type InventoryStockBalance,
  type ReportingSnapshot,
} from "@warungmeng/domain";
import type { LogicChildContext, OperationIssue, OperationResult } from "@warungmeng/module-system";
import {
  defineLogicChild,
  operationDegraded,
  operationFailure,
  operationIssue,
  operationSuccess,
} from "@warungmeng/module-system";
import type {
  DashboardDataSource,
  DashboardLoadInput,
  DashboardReports,
  DashboardReportsSnapshot,
} from "../../dashboardContracts";
import {
  DASHBOARD_DATA_SOURCES,
  DASHBOARD_ISSUE,
  DASHBOARD_REPORTS,
  DASHBOARD_REPORTS_ID,
  DEFAULT_DASHBOARD_OUTLET_ID,
} from "../../dashboardContracts";
import { DASHBOARD_ENGINE_ID } from "../../dashboardEngine";

interface SourceLoad<TValue> {
  readonly source: DashboardDataSource;
  readonly value: TValue | undefined;
  readonly issues: readonly OperationIssue[];
}

interface InventoryReportSource {
  readonly movements: readonly InventoryMovement[];
  readonly ingredients: readonly InventoryIngredient[];
  readonly stockBalances: readonly InventoryStockBalance[];
}

const SOURCE_ISSUE = {
  orders: DASHBOARD_ISSUE.ordersUnavailable,
  finance: DASHBOARD_ISSUE.financeUnavailable,
  inventory: DASHBOARD_ISSUE.inventoryUnavailable,
} as const;

function sourceFailure(
  source: DashboardDataSource,
  message: string,
  issues: readonly OperationIssue[] = [],
): SourceLoad<never> {
  return {
    source,
    value: undefined,
    issues: [operationIssue(SOURCE_ISSUE[source], message, source), ...issues],
  };
}

async function loadSource<TValue>(
  source: DashboardDataSource,
  read: () => Promise<OperationResult<TValue>>,
): Promise<SourceLoad<TValue>> {
  try {
    const result = await read();
    if (result.status === "failure") {
      return sourceFailure(source, `Dashboard ${source} data is unavailable.`, result.issues);
    }
    return {
      source,
      value: result.value,
      issues: result.status === "degraded" ? result.issues : [],
    };
  } catch (error) {
    return sourceFailure(
      source,
      error instanceof Error ? error.message : `Dashboard ${source} data is unavailable.`,
    );
  }
}

function validateInput(input: DashboardLoadInput): OperationResult<string> {
  try {
    validateReportingPeriod(input.period);
  } catch (error) {
    return operationFailure("invalid-input", [
      operationIssue(
        DASHBOARD_ISSUE.invalidPeriod,
        error instanceof Error ? error.message : "The dashboard period is invalid.",
        "period",
      ),
    ]);
  }

  const outletId = input.outletId ?? DEFAULT_DASHBOARD_OUTLET_ID;
  if (outletId.trim().length === 0) {
    return operationFailure("invalid-input", [
      operationIssue(DASHBOARD_ISSUE.invalidOutlet, "Dashboard outlet id is required.", "outletId"),
    ]);
  }
  return operationSuccess(outletId);
}

/**
 * The stock-movements capability owns the ledger and its ingredient join. The
 * detailed report reconstructs the current balance from the full outlet ledger,
 * avoiding any direct reach into Inventory's store. Movement writers commit the
 * balance and ledger together, so both projections describe the same event set.
 */
function inventorySourceFromRows(
  rows: readonly MovementListItem[],
  period: DashboardLoadInput["period"],
): OperationResult<InventoryReportSource> {
  const ingredientById = new Map<string, InventoryIngredient>();
  const balances = new Map<string, InventoryStockBalance>();
  const issues: OperationIssue[] = [];
  const missingIngredientIds = new Set<string>();
  const missingCostMovementIds: string[] = [];

  for (const row of rows) {
    const movement = row.movement;
    if (row.ingredient === null) missingIngredientIds.add(movement.ingredientId);
    else ingredientById.set(row.ingredient.id, row.ingredient);

    const current = balances.get(movement.ingredientId);
    balances.set(movement.ingredientId, {
      ingredientId: movement.ingredientId,
      outletId: movement.outletId,
      quantity: (current?.quantity ?? 0) + movement.baseQuantityDelta,
      updatedAt:
        current === undefined || movement.occurredAt > current.updatedAt
          ? movement.occurredAt
          : current.updatedAt,
    });

    if (
      movement.type === "consumption" &&
      movement.unitCost === null &&
      isTimestampInReportingPeriod(movement.occurredAt, period)
    ) {
      missingCostMovementIds.push(movement.id);
    }
  }

  for (const ingredientId of missingIngredientIds) {
    issues.push(
      operationIssue(
        DASHBOARD_ISSUE.missingMovementIngredient,
        `Inventory movement data references missing ingredient ${ingredientId}.`,
        ingredientId,
      ),
    );
  }
  if (missingCostMovementIds.length > 0) {
    issues.push(
      operationIssue(
        DASHBOARD_ISSUE.missingConsumptionCost,
        `${missingCostMovementIds.length} consumption movement(s) predate sale-time cost snapshots.`,
        "inventory",
        { count: missingCostMovementIds.length },
      ),
    );
  }

  return operationDegraded(
    {
      movements: rows.map((row) => row.movement),
      ingredients: [...ingredientById.values()],
      stockBalances: [...balances.values()],
    },
    issues,
  );
}

function createReports(
  snapshot: ReportingSnapshot,
  outletId: string,
  failedSources: readonly DashboardDataSource[],
): DashboardReportsSnapshot {
  const dailySalesTrend = buildDailySalesTrend(snapshot);
  const paymentMethods = buildPaymentMethodBreakdown(snapshot);
  const orderChannels = buildOrderChannelBreakdown(snapshot);
  const peakSalesHours = buildPeakSalesHours(snapshot);
  const menuPerformance = buildMenuPerformance(snapshot);
  const categoryPerformance = buildCategoryPerformance(snapshot);
  const inventoryUsage = buildInventoryUsage(snapshot);

  return {
    period: { ...snapshot.period },
    outletId,
    failedSources,
    dailySalesTrend,
    paymentMethods,
    orderChannels,
    peakSalesHours,
    menuPerformance,
    categoryPerformance,
    inventoryUsage,
    dailyNetRevenueTotal: dailySalesTrend.reduce(
      (total, point) => total + point.netRevenue.amount,
      0,
    ),
    isSalesEmpty:
      dailySalesTrend.every(
        (point) =>
          point.grossSales.amount === 0 && point.refunds.amount === 0 && point.paidOrderCount === 0,
      ) &&
      paymentMethods.length === 0 &&
      orderChannels.length === 0 &&
      peakSalesHours.length === 0,
    isMenuEmpty: menuPerformance.length === 0 && categoryPerformance.length === 0,
    isInventoryEmpty: inventoryUsage.length === 0,
  };
}

function reportsOverCapabilities(
  orders: OrderRead,
  movements: StockMovements,
  ledger: LedgerRead,
): DashboardReports {
  return {
    async loadReports(
      input: DashboardLoadInput,
    ): Promise<OperationResult<DashboardReportsSnapshot>> {
      const validated = validateInput(input);
      if (validated.status === "failure") return validated;
      const outletId = validated.value;

      const [orderSource, financeSource, inventorySource] = await Promise.all([
        loadSource("orders", () => orders.listOrders({ ...DEFAULT_ORDER_LIST_FILTERS, outletId })),
        loadSource("finance", () => ledger.listTransactions(outletId)),
        loadSource("inventory", async () => {
          const rows = await movements.queryMovements({
            ingredientId: null,
            outletId,
            type: "all",
          });
          if (rows.status === "failure") return rows;
          const source = inventorySourceFromRows(rows.value, input.period);
          if (source.status === "failure") return source;
          const issues = [
            ...(rows.status === "degraded" ? rows.issues : []),
            ...(source.status === "degraded" ? source.issues : []),
          ];
          return operationDegraded(source.value, issues);
        }),
      ]);
      const sources = [orderSource, financeSource, inventorySource] as const;
      const availableCount = sources.filter((source) => source.value !== undefined).length;
      const issues = sources.flatMap((source) => source.issues);

      if (availableCount === 0) {
        return operationFailure("failed", [
          operationIssue(
            DASHBOARD_ISSUE.allSourcesUnavailable,
            "No dashboard report source produced usable data.",
            DASHBOARD_REPORTS_ID,
          ),
          ...issues,
        ]);
      }

      const failedSources = DASHBOARD_DATA_SOURCES.filter((source) =>
        sources.some((result) => result.source === source && result.issues.length > 0),
      );
      const snapshot: ReportingSnapshot = {
        period: { ...input.period },
        orders: orderSource.value?.orders ?? [],
        financeTransactions: financeSource.value ?? [],
        menuItems: [],
        categories: [],
        menuHpp: [],
        ingredients: inventorySource.value?.ingredients ?? [],
        stockBalances: inventorySource.value?.stockBalances ?? [],
        inventoryMovements: inventorySource.value?.movements ?? [],
      };

      return operationDegraded(createReports(snapshot, outletId, failedSources), issues);
    },
  };
}

function unavailableReports(): DashboardReports {
  return {
    loadReports: async () =>
      operationFailure("unsatisfied-dependency", [
        operationIssue(
          DASHBOARD_ISSUE.dependencyUnavailable,
          "A required Dashboard reports capability was unavailable during creation.",
          DASHBOARD_REPORTS_ID,
        ),
      ]),
  };
}

export function createDashboardReports(context: LogicChildContext): DashboardReports {
  const orders = context.capabilities.resolve(ORDER_READ);
  const movements = context.capabilities.resolve(STOCK_MOVEMENTS);
  const ledger = context.capabilities.resolve(LEDGER_READ);
  const capability =
    orders.status === "available" &&
    movements.status === "available" &&
    ledger.status === "available"
      ? reportsOverCapabilities(orders.value, movements.value, ledger.value)
      : unavailableReports();

  context.capabilities.provide(DASHBOARD_REPORTS, capability);
  return capability;
}

export default defineLogicChild<DashboardReports>({
  id: DASHBOARD_REPORTS_ID,
  parentId: DASHBOARD_ENGINE_ID,
  provides: [DASHBOARD_REPORTS_ID],
  requires: [ORDER_READ_ID, STOCK_MOVEMENTS_ID, LEDGER_READ_ID],
  create: createDashboardReports,
});
