// packages/admin-engine/src/engines/dashboard/children/overview/dashboardOverviewChild.ts
//
// Read-only overview aggregation. This is the first child in the port to compose
// three sibling areas at once. It consumes their published capabilities only;
// no repository/store shape is restated in Dashboard (tech-debt D15).

import type { MaterialCollection, MaterialsRead } from "../../../inventory/inventoryContracts";
import {
  DEFAULT_MATERIAL_LIST_FILTERS,
  MATERIALS_READ,
  MATERIALS_READ_ID,
} from "../../../inventory/inventoryContracts";
import type { LedgerRead } from "../../../finance/financeContracts";
import { LEDGER_READ, LEDGER_READ_ID } from "../../../finance/financeContracts";
import type { OrderRead } from "../../../orders/ordersContracts";
import {
  DEFAULT_ORDER_LIST_FILTERS,
  ORDER_READ,
  ORDER_READ_ID,
} from "../../../orders/ordersContracts";
import {
  buildDailySalesTrend,
  buildOrderChannelBreakdown,
  buildPaymentMethodBreakdown,
  calculateDashboardSummary,
  selectLowStockIngredients,
  validateReportingPeriod,
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
  DashboardOverview,
  DashboardOverviewSnapshot,
} from "../../dashboardContracts";
import {
  DASHBOARD_DATA_SOURCES,
  DASHBOARD_ISSUE,
  DASHBOARD_OVERVIEW,
  DASHBOARD_OVERVIEW_ID,
  DEFAULT_DASHBOARD_OUTLET_ID,
} from "../../dashboardContracts";
import { DASHBOARD_ENGINE_ID } from "../../dashboardEngine";

interface SourceLoad<TValue> {
  readonly source: DashboardDataSource;
  readonly value: TValue | undefined;
  readonly issues: readonly OperationIssue[];
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
 * Expresses materials-read's consolidated missing-balance rule through the
 * reporting snapshot: every active material gets a projected balance, including
 * a zero row when Inventory says it has never been counted. The timestamp is not
 * consumed by any reporting selector; it is deterministic projection metadata.
 */
function snapshotFromMaterials(
  period: DashboardLoadInput["period"],
  collection: MaterialCollection,
): Pick<ReportingSnapshot, "ingredients" | "stockBalances"> {
  return {
    ingredients: collection.materials.map((item) => item.ingredient),
    stockBalances: collection.materials.map((item) => ({
      ingredientId: item.ingredient.id,
      outletId: item.outletId,
      quantity: item.quantity,
      updatedAt: `${period.endDate}T00:00:00.000Z`,
    })),
  };
}

function createOverview(
  snapshot: ReportingSnapshot,
  outletId: string,
  failedSources: readonly DashboardDataSource[],
): DashboardOverviewSnapshot {
  const summary = calculateDashboardSummary(snapshot);
  const dailySalesTrend = buildDailySalesTrend(snapshot);
  const paymentMethods = buildPaymentMethodBreakdown(snapshot);
  const orderChannels = buildOrderChannelBreakdown(snapshot);
  const lowStockIngredients = selectLowStockIngredients(snapshot);
  const hasActivity =
    summary.grossSales.amount !== 0 ||
    summary.refunds.amount !== 0 ||
    summary.expenses.amount !== 0 ||
    summary.paidOrderCount !== 0 ||
    dailySalesTrend.some(
      (point) =>
        point.grossSales.amount !== 0 || point.refunds.amount !== 0 || point.paidOrderCount !== 0,
    ) ||
    paymentMethods.length > 0 ||
    orderChannels.length > 0 ||
    lowStockIngredients.length > 0;

  return {
    period: { ...snapshot.period },
    outletId,
    failedSources,
    summary,
    dailySalesTrend,
    paymentMethods,
    orderChannels,
    lowStockIngredients,
    isEmpty: !hasActivity,
  };
}

function overviewOverCapabilities(
  orders: OrderRead,
  materials: MaterialsRead,
  ledger: LedgerRead,
): DashboardOverview {
  return {
    async loadOverview(
      input: DashboardLoadInput,
    ): Promise<OperationResult<DashboardOverviewSnapshot>> {
      const validated = validateInput(input);
      if (validated.status === "failure") return validated;
      const outletId = validated.value;

      const [orderSource, financeSource, inventorySource] = await Promise.all([
        loadSource("orders", () => orders.listOrders({ ...DEFAULT_ORDER_LIST_FILTERS, outletId })),
        loadSource("finance", () => ledger.listTransactions(outletId)),
        loadSource("inventory", () =>
          materials.queryMaterials({
            ...DEFAULT_MATERIAL_LIST_FILTERS,
            outletId,
            status: "active",
            lowStockOnly: false,
          }),
        ),
      ]);
      const sources = [orderSource, financeSource, inventorySource] as const;
      const availableCount = sources.filter((source) => source.value !== undefined).length;
      const issues = sources.flatMap((source) => source.issues);

      if (availableCount === 0) {
        return operationFailure("failed", [
          operationIssue(
            DASHBOARD_ISSUE.allSourcesUnavailable,
            "No dashboard overview source produced usable data.",
            DASHBOARD_OVERVIEW_ID,
          ),
          ...issues,
        ]);
      }

      const failedSources = DASHBOARD_DATA_SOURCES.filter((source) =>
        sources.some((result) => result.source === source && result.issues.length > 0),
      );
      const inventory =
        inventorySource.value === undefined
          ? { ingredients: [], stockBalances: [] }
          : snapshotFromMaterials(input.period, inventorySource.value);
      const snapshot: ReportingSnapshot = {
        period: { ...input.period },
        orders: orderSource.value?.orders ?? [],
        financeTransactions: financeSource.value ?? [],
        menuItems: [],
        categories: [],
        menuHpp: [],
        ingredients: inventory.ingredients,
        stockBalances: inventory.stockBalances,
        inventoryMovements: [],
      };

      return operationDegraded(createOverview(snapshot, outletId, failedSources), issues);
    },
  };
}

function unavailableOverview(): DashboardOverview {
  return {
    loadOverview: async () =>
      operationFailure("unsatisfied-dependency", [
        operationIssue(
          DASHBOARD_ISSUE.dependencyUnavailable,
          "A required Dashboard overview capability was unavailable during creation.",
          DASHBOARD_OVERVIEW_ID,
        ),
      ]),
  };
}

export function createDashboardOverview(context: LogicChildContext): DashboardOverview {
  const orders = context.capabilities.resolve(ORDER_READ);
  const materials = context.capabilities.resolve(MATERIALS_READ);
  const ledger = context.capabilities.resolve(LEDGER_READ);
  const capability =
    orders.status === "available" &&
    materials.status === "available" &&
    ledger.status === "available"
      ? overviewOverCapabilities(orders.value, materials.value, ledger.value)
      : unavailableOverview();

  context.capabilities.provide(DASHBOARD_OVERVIEW, capability);
  return capability;
}

export default defineLogicChild<DashboardOverview>({
  id: DASHBOARD_OVERVIEW_ID,
  parentId: DASHBOARD_ENGINE_ID,
  provides: [DASHBOARD_OVERVIEW_ID],
  requires: [ORDER_READ_ID, MATERIALS_READ_ID, LEDGER_READ_ID],
  create: createDashboardOverview,
});
