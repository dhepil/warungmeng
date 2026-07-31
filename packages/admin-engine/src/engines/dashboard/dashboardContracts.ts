// packages/admin-engine/src/engines/dashboard/dashboardContracts.ts
//
// Stable contracts for the read-only Dashboard area. Dashboard owns no store:
// both children aggregate capabilities published by Orders, Inventory, and
// Finance, then delegate every business calculation to the reporting domain.

import type {
  CategoryPerformanceRow,
  DailySalesTrendPoint,
  DashboardSummary,
  InventoryUsageRow,
  LowStockIngredientItem,
  MenuPerformanceRow,
  OrderChannelBreakdownItem,
  PaymentMethodBreakdownItem,
  PeakSalesHourRow,
  ReportingPeriod,
} from "@warungmeng/domain";
import type { OperationResult } from "@warungmeng/module-system";
import { createCapabilityToken } from "@warungmeng/module-system";

/** SOURCE's single-outlet dashboard scope, made overrideable at the capability edge. */
export const DEFAULT_DASHBOARD_OUTLET_ID = "wm-1";

export const DASHBOARD_DATA_SOURCES = ["orders", "finance", "inventory"] as const;
export type DashboardDataSource = (typeof DASHBOARD_DATA_SOURCES)[number];

export const DASHBOARD_ISSUE = {
  invalidPeriod: "invalid-dashboard-period",
  invalidOutlet: "invalid-dashboard-outlet",
  dependencyUnavailable: "dashboard-dependency-unavailable",
  allSourcesUnavailable: "dashboard-all-sources-unavailable",
  ordersUnavailable: "dashboard-orders-unavailable",
  financeUnavailable: "dashboard-finance-unavailable",
  inventoryUnavailable: "dashboard-inventory-unavailable",
  missingMovementIngredient: "dashboard-movement-ingredient-missing",
  missingConsumptionCost: "dashboard-consumption-cost-missing",
} as const;

export interface DashboardLoadInput {
  readonly period: ReportingPeriod;
  readonly outletId?: string;
}

interface DashboardLoadState {
  readonly period: ReportingPeriod;
  readonly outletId: string;
  /** Stable source order; includes a usable-but-degraded upstream source. */
  readonly failedSources: readonly DashboardDataSource[];
}

export interface DashboardOverviewSnapshot extends DashboardLoadState {
  readonly summary: DashboardSummary;
  readonly dailySalesTrend: readonly DailySalesTrendPoint[];
  readonly paymentMethods: readonly PaymentMethodBreakdownItem[];
  readonly orderChannels: readonly OrderChannelBreakdownItem[];
  readonly lowStockIngredients: readonly LowStockIngredientItem[];
  readonly isEmpty: boolean;
}

export interface DashboardOverview {
  loadOverview(input: DashboardLoadInput): Promise<OperationResult<DashboardOverviewSnapshot>>;
}

export const DASHBOARD_OVERVIEW_ID = "admin.dashboard.overview";
export const DASHBOARD_OVERVIEW = createCapabilityToken<DashboardOverview>(DASHBOARD_OVERVIEW_ID);

export interface DashboardReportsSnapshot extends DashboardLoadState {
  readonly dailySalesTrend: readonly DailySalesTrendPoint[];
  readonly paymentMethods: readonly PaymentMethodBreakdownItem[];
  readonly orderChannels: readonly OrderChannelBreakdownItem[];
  readonly peakSalesHours: readonly PeakSalesHourRow[];
  readonly menuPerformance: readonly MenuPerformanceRow[];
  readonly categoryPerformance: readonly CategoryPerformanceRow[];
  readonly inventoryUsage: readonly InventoryUsageRow[];
  readonly dailyNetRevenueTotal: number;
  readonly isSalesEmpty: boolean;
  readonly isMenuEmpty: boolean;
  readonly isInventoryEmpty: boolean;
}

export interface DashboardReports {
  loadReports(input: DashboardLoadInput): Promise<OperationResult<DashboardReportsSnapshot>>;
}

export const DASHBOARD_REPORTS_ID = "admin.dashboard.reports";
export const DASHBOARD_REPORTS = createCapabilityToken<DashboardReports>(DASHBOARD_REPORTS_ID);
