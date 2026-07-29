// packages/domain/src/reporting.ts
//
// Ported from SOURCE packages/domain/src/reporting/{types,dashboard,reports}.ts,
// consolidated per new-target LOGIC-TARGET-FILE-TREE.md §4. Pure TypeScript: read-only
// reporting aggregations over a ReportingSnapshot — dashboard summary, sales trend,
// payment/channel breakdowns, menu/category performance, peak hours, inventory usage.
// No I/O, no mutation of inputs.

import type { Money, MenuCategory, MenuItem } from "./catalog";
import type { FinancePaymentMethod, FinanceTransaction } from "./finance";
import type {
  InventoryIngredient,
  InventoryMovement,
  InventoryStockBalance,
  InventoryUnit,
  MenuHppBreakdown,
} from "./inventory";
import type { Order, OrderChannel } from "./orders";

// ─── Types ───────────────────────────────────────────────────────────────────

export const DEFAULT_REPORTING_TIME_ZONE = "Asia/Jakarta";

export interface ReportingPeriod {
  readonly startDate: string;
  readonly endDate: string;
  readonly timeZone: string;
}

export interface ReportingSnapshot {
  readonly period: ReportingPeriod;
  readonly orders: readonly Order[];
  readonly financeTransactions: readonly FinanceTransaction[];
  readonly menuItems: readonly MenuItem[];
  readonly categories: readonly MenuCategory[];
  readonly menuHpp: readonly MenuHppBreakdown[];
  readonly ingredients: readonly InventoryIngredient[];
  readonly stockBalances: readonly InventoryStockBalance[];
  readonly inventoryMovements: readonly InventoryMovement[];
}

export interface DashboardSummary {
  readonly grossSales: Money;
  readonly refunds: Money;
  readonly netRevenue: Money;
  readonly expenses: Money;
  readonly netCashflow: Money;
  readonly paidOrderCount: number;
  readonly averageOrderValue: Money;
  readonly cancellationRate: number;
  readonly estimatedCogs: Money;
  readonly estimatedGrossProfit: Money;
  readonly estimatedGrossMarginPercentage: number;
  readonly missingCostItemCount: number;
  readonly lowStockIngredientCount: number;
}

export interface DailySalesTrendPoint {
  readonly date: string;
  readonly grossSales: Money;
  readonly refunds: Money;
  readonly netRevenue: Money;
  readonly paidOrderCount: number;
}

export interface PaymentMethodBreakdownItem {
  readonly paymentMethod: FinancePaymentMethod;
  readonly totalInflow: Money;
  readonly totalOutflow: Money;
  readonly netCashflow: Money;
  readonly transactionCount: number;
}

export interface OrderChannelBreakdownItem {
  readonly channel: OrderChannel;
  readonly paidOrderCount: number;
  readonly grossSales: Money;
  readonly refunds: Money;
  readonly netRevenue: Money;
}

export interface LowStockIngredientItem {
  readonly ingredientId: string;
  readonly ingredientName: string;
  readonly unit: InventoryUnit;
  readonly currentStock: number;
  readonly minimumStock: number;
}

export interface MenuPerformanceRow {
  readonly menuItemId: string;
  readonly menuName: string;
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  readonly quantitySold: number;
  readonly netSales: Money;
  readonly estimatedCogs: Money;
  readonly estimatedGrossProfit: Money;
  readonly estimatedGrossMarginPercentage: number;
  readonly missingCost: boolean;
}

export interface CategoryPerformanceRow {
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  readonly quantitySold: number;
  readonly netSales: Money;
  readonly estimatedCogs: Money;
  readonly estimatedGrossProfit: Money;
  readonly estimatedGrossMarginPercentage: number;
  readonly missingCostItemCount: number;
}

export interface PeakSalesHourRow {
  readonly hour: number;
  readonly paidOrderCount: number;
  readonly grossSales: Money;
}

export interface InventoryUsageRow {
  readonly ingredientId: string;
  readonly ingredientName: string;
  readonly unit: InventoryUnit;
  readonly quantityUsed: number;
  readonly estimatedUsageValue: Money;
  readonly currentStock: number;
  readonly minimumStock: number;
  readonly lowStock: boolean;
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function money(amount: number): Money {
  return { amount, currency: "IDR" };
}

function roundPercentage(value: number): number {
  return Math.round(value * 100) / 100;
}

function marginPercentage(netSales: number, grossProfit: number): number {
  return netSales > 0 ? Math.round((grossProfit / netSales) * 10_000) / 100 : 0;
}

function assertDateKey(value: string): void {
  if (!DATE_KEY_PATTERN.test(value)) throw new RangeError(`Invalid reporting date: ${value}`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new RangeError(`Invalid reporting date: ${value}`);
  }
}

export function validateReportingPeriod(period: ReportingPeriod): void {
  assertDateKey(period.startDate);
  assertDateKey(period.endDate);
  if (period.startDate > period.endDate) {
    throw new RangeError("Reporting startDate must not be after endDate");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: period.timeZone }).format(0);
  } catch {
    throw new RangeError(`Invalid reporting time zone: ${period.timeZone}`);
  }
}

export function getReportingDateKey(timestamp: string, timeZone: string): string | null {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(parsed);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : null;
}

export function getReportingHour(timestamp: string, timeZone: string): number | null {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return null;
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(parsed)
    .find((part) => part.type === "hour")?.value;
  return hour === undefined ? null : Number(hour);
}

export function isTimestampInReportingPeriod(timestamp: string, period: ReportingPeriod): boolean {
  validateReportingPeriod(period);
  const key = getReportingDateKey(timestamp, period.timeZone);
  return key !== null && key >= period.startDate && key <= period.endDate;
}

function enumerateDateKeys(period: ReportingPeriod): readonly string[] {
  validateReportingPeriod(period);
  const cursor = new Date(`${period.startDate}T00:00:00.000Z`);
  const last = new Date(`${period.endDate}T00:00:00.000Z`);
  const keys: string[] = [];
  while (cursor <= last) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
}

function selectPeriodTransactions(snapshot: ReportingSnapshot): readonly FinanceTransaction[] {
  return snapshot.financeTransactions.filter((transaction) =>
    isTimestampInReportingPeriod(transaction.occurredAt, snapshot.period),
  );
}

function selectPeriodOrders(snapshot: ReportingSnapshot): readonly Order[] {
  return snapshot.orders.filter((order) =>
    isTimestampInReportingPeriod(order.createdAt, snapshot.period),
  );
}

function uniqueSaleReferences(transactions: readonly FinanceTransaction[]): readonly string[] {
  return Array.from(
    new Set(
      transactions
        .filter((transaction) => transaction.status === "posted" && transaction.type === "sale")
        .map((transaction) => transaction.sourceReference)
        .filter((reference): reference is string => reference !== null),
    ),
  );
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

export function selectLowStockIngredients(
  snapshot: ReportingSnapshot,
): readonly LowStockIngredientItem[] {
  const stockByIngredient = new Map<string, number>();
  snapshot.stockBalances.forEach((balance) => {
    stockByIngredient.set(
      balance.ingredientId,
      (stockByIngredient.get(balance.ingredientId) ?? 0) + balance.quantity,
    );
  });

  return snapshot.ingredients
    .filter((ingredient) => ingredient.status === "active")
    .flatMap((ingredient) => {
      const currentStock = stockByIngredient.get(ingredient.id);
      if (currentStock === undefined || currentStock > ingredient.minimumStock) return [];
      return [
        {
          ingredientId: ingredient.id,
          ingredientName: ingredient.name,
          unit: ingredient.baseUnit,
          currentStock,
          minimumStock: ingredient.minimumStock,
        },
      ];
    })
    .sort(
      (left, right) =>
        left.currentStock - right.currentStock ||
        left.ingredientName.localeCompare(right.ingredientName) ||
        left.ingredientId.localeCompare(right.ingredientId),
    );
}

export function calculateDashboardSummary(snapshot: ReportingSnapshot): DashboardSummary {
  const transactions = selectPeriodTransactions(snapshot);
  const posted = transactions.filter((transaction) => transaction.status === "posted");
  const grossSales = posted
    .filter((transaction) => transaction.type === "sale" && transaction.direction === "inflow")
    .reduce((total, transaction) => total + transaction.amount.amount, 0);
  const refunds = posted
    .filter((transaction) => transaction.type === "refund" && transaction.direction === "outflow")
    .reduce((total, transaction) => total + transaction.amount.amount, 0);
  const expenses = posted
    .filter((transaction) => transaction.type === "expense" && transaction.direction === "outflow")
    .reduce((total, transaction) => total + transaction.amount.amount, 0);
  const totalInflow = posted
    .filter((transaction) => transaction.direction === "inflow")
    .reduce((total, transaction) => total + transaction.amount.amount, 0);
  const totalOutflow = posted
    .filter((transaction) => transaction.direction === "outflow")
    .reduce((total, transaction) => total + transaction.amount.amount, 0);
  const saleReferences = uniqueSaleReferences(transactions);
  const paidOrderCount = saleReferences.length;
  const netRevenue = grossSales - refunds;
  const periodOrders = selectPeriodOrders(snapshot);
  const cancellationRate = periodOrders.length
    ? roundPercentage(
        (periodOrders.filter((order) => order.status === "cancelled").length /
          periodOrders.length) *
          100,
      )
    : 0;

  const orderById = new Map(snapshot.orders.map((order) => [order.id, order]));
  const hppByMenuId = new Map(snapshot.menuHpp.map((item) => [item.menuItemId, item.total.amount]));
  let estimatedCogs = 0;
  let missingCostItemCount = 0;
  saleReferences.forEach((reference) => {
    orderById.get(reference)?.items.forEach((item) => {
      const hpp = hppByMenuId.get(item.menuItemId);
      if (hpp === undefined) missingCostItemCount += 1;
      else estimatedCogs += hpp * item.quantity;
    });
  });
  const estimatedGrossProfit = netRevenue - estimatedCogs;
  const estimatedGrossMarginPercentage =
    netRevenue > 0 ? roundPercentage((estimatedGrossProfit / netRevenue) * 100) : 0;

  return {
    grossSales: money(grossSales),
    refunds: money(refunds),
    netRevenue: money(netRevenue),
    expenses: money(expenses),
    netCashflow: money(totalInflow - totalOutflow),
    paidOrderCount,
    averageOrderValue: money(paidOrderCount ? Math.round(netRevenue / paidOrderCount) : 0),
    cancellationRate,
    estimatedCogs: money(estimatedCogs),
    estimatedGrossProfit: money(estimatedGrossProfit),
    estimatedGrossMarginPercentage,
    missingCostItemCount,
    lowStockIngredientCount: selectLowStockIngredients(snapshot).length,
  };
}

export function buildDailySalesTrend(snapshot: ReportingSnapshot): readonly DailySalesTrendPoint[] {
  const buckets = new Map(
    enumerateDateKeys(snapshot.period).map((date) => [
      date,
      { grossSales: 0, refunds: 0, saleReferences: new Set<string>() },
    ]),
  );
  selectPeriodTransactions(snapshot).forEach((transaction) => {
    if (transaction.status !== "posted") return;
    const date = getReportingDateKey(transaction.occurredAt, snapshot.period.timeZone);
    const bucket = date ? buckets.get(date) : undefined;
    if (!bucket) return;
    if (transaction.type === "sale" && transaction.direction === "inflow") {
      bucket.grossSales += transaction.amount.amount;
      bucket.saleReferences.add(transaction.sourceReference ?? transaction.id);
    } else if (transaction.type === "refund" && transaction.direction === "outflow") {
      bucket.refunds += transaction.amount.amount;
    }
  });

  return Array.from(buckets, ([date, bucket]) => ({
    date,
    grossSales: money(bucket.grossSales),
    refunds: money(bucket.refunds),
    netRevenue: money(bucket.grossSales - bucket.refunds),
    paidOrderCount: bucket.saleReferences.size,
  }));
}

export function buildPaymentMethodBreakdown(
  snapshot: ReportingSnapshot,
): readonly PaymentMethodBreakdownItem[] {
  const groups = new Map<string, { inflow: number; outflow: number; count: number }>();
  selectPeriodTransactions(snapshot).forEach((transaction) => {
    if (transaction.status !== "posted") return;
    const current = groups.get(transaction.paymentMethod) ?? { inflow: 0, outflow: 0, count: 0 };
    if (transaction.direction === "inflow") current.inflow += transaction.amount.amount;
    else current.outflow += transaction.amount.amount;
    current.count += 1;
    groups.set(transaction.paymentMethod, current);
  });
  return Array.from(groups, ([paymentMethod, group]) => ({
    paymentMethod: paymentMethod as PaymentMethodBreakdownItem["paymentMethod"],
    totalInflow: money(group.inflow),
    totalOutflow: money(group.outflow),
    netCashflow: money(group.inflow - group.outflow),
    transactionCount: group.count,
  })).sort(
    (left, right) =>
      right.netCashflow.amount - left.netCashflow.amount ||
      left.paymentMethod.localeCompare(right.paymentMethod),
  );
}

export function buildOrderChannelBreakdown(
  snapshot: ReportingSnapshot,
): readonly OrderChannelBreakdownItem[] {
  const orderById = new Map(snapshot.orders.map((order) => [order.id, order]));
  const groups = new Map<
    OrderChannelBreakdownItem["channel"],
    { sales: number; refunds: number; orderIds: Set<string> }
  >();
  selectPeriodTransactions(snapshot).forEach((transaction) => {
    if (transaction.status !== "posted" || transaction.sourceReference === null) return;
    const order = orderById.get(transaction.sourceReference);
    if (!order || (transaction.type !== "sale" && transaction.type !== "refund")) return;
    const current = groups.get(order.channel) ?? { sales: 0, refunds: 0, orderIds: new Set() };
    if (transaction.type === "sale" && transaction.direction === "inflow") {
      current.sales += transaction.amount.amount;
      current.orderIds.add(order.id);
    } else if (transaction.type === "refund" && transaction.direction === "outflow") {
      current.refunds += transaction.amount.amount;
    }
    groups.set(order.channel, current);
  });

  return Array.from(groups, ([channel, group]) => ({
    channel,
    paidOrderCount: group.orderIds.size,
    grossSales: money(group.sales),
    refunds: money(group.refunds),
    netRevenue: money(group.sales - group.refunds),
  })).sort(
    (left, right) =>
      right.netRevenue.amount - left.netRevenue.amount || left.channel.localeCompare(right.channel),
  );
}

// ─── Reports ─────────────────────────────────────────────────────────────────

function periodOrderTransactions(snapshot: ReportingSnapshot): readonly FinanceTransaction[] {
  return snapshot.financeTransactions.filter(
    (transaction) =>
      transaction.status === "posted" &&
      transaction.sourceReference !== null &&
      (transaction.type === "sale" || transaction.type === "refund") &&
      isTimestampInReportingPeriod(transaction.occurredAt, snapshot.period),
  );
}

export function buildMenuPerformance(snapshot: ReportingSnapshot): readonly MenuPerformanceRow[] {
  const orderById = new Map(snapshot.orders.map((order) => [order.id, order]));
  const menuById = new Map(snapshot.menuItems.map((menu) => [menu.id, menu]));
  const categoryById = new Map(snapshot.categories.map((category) => [category.id, category]));
  const hppByMenuId = new Map(snapshot.menuHpp.map((item) => [item.menuItemId, item.total.amount]));
  const groups = new Map<
    string,
    {
      name: string;
      categoryId: string | null;
      categoryName: string | null;
      quantity: number;
      netSales: number;
      cogs: number;
      missingCost: boolean;
    }
  >();

  periodOrderTransactions(snapshot).forEach((transaction) => {
    const order = orderById.get(transaction.sourceReference ?? "");
    if (!order) return;
    const factor = transaction.type === "refund" ? -1 : 1;
    order.items.forEach((item) => {
      const menu = menuById.get(item.menuItemId);
      const category = menu ? categoryById.get(menu.categoryId) : undefined;
      const current = groups.get(item.menuItemId) ?? {
        name: menu?.name ?? item.name,
        categoryId: category?.id ?? null,
        categoryName: category?.name ?? null,
        quantity: 0,
        netSales: 0,
        cogs: 0,
        missingCost: false,
      };
      current.quantity += item.quantity * factor;
      current.netSales += item.lineTotal.amount * factor;
      const hpp = hppByMenuId.get(item.menuItemId);
      if (hpp === undefined) current.missingCost = true;
      else current.cogs += hpp * item.quantity * factor;
      groups.set(item.menuItemId, current);
    });
  });

  return Array.from(groups, ([menuItemId, group]) => {
    const grossProfit = group.netSales - group.cogs;
    return {
      menuItemId,
      menuName: group.name,
      categoryId: group.categoryId,
      categoryName: group.categoryName,
      quantitySold: group.quantity,
      netSales: money(group.netSales),
      estimatedCogs: money(group.cogs),
      estimatedGrossProfit: money(grossProfit),
      estimatedGrossMarginPercentage: marginPercentage(group.netSales, grossProfit),
      missingCost: group.missingCost,
    };
  }).sort(
    (left, right) =>
      right.quantitySold - left.quantitySold ||
      right.netSales.amount - left.netSales.amount ||
      left.menuName.localeCompare(right.menuName) ||
      left.menuItemId.localeCompare(right.menuItemId),
  );
}

export function buildCategoryPerformance(
  snapshot: ReportingSnapshot,
): readonly CategoryPerformanceRow[] {
  const groups = new Map<
    string,
    {
      categoryId: string | null;
      name: string | null;
      quantity: number;
      netSales: number;
      cogs: number;
      missingCostCount: number;
    }
  >();
  buildMenuPerformance(snapshot).forEach((menu) => {
    const key = menu.categoryId ?? "__unknown__";
    const current = groups.get(key) ?? {
      categoryId: menu.categoryId,
      name: menu.categoryName,
      quantity: 0,
      netSales: 0,
      cogs: 0,
      missingCostCount: 0,
    };
    current.quantity += menu.quantitySold;
    current.netSales += menu.netSales.amount;
    current.cogs += menu.estimatedCogs.amount;
    if (menu.missingCost) current.missingCostCount += 1;
    groups.set(key, current);
  });

  return Array.from(groups.values(), (group) => {
    const grossProfit = group.netSales - group.cogs;
    return {
      categoryId: group.categoryId,
      categoryName: group.name,
      quantitySold: group.quantity,
      netSales: money(group.netSales),
      estimatedCogs: money(group.cogs),
      estimatedGrossProfit: money(grossProfit),
      estimatedGrossMarginPercentage: marginPercentage(group.netSales, grossProfit),
      missingCostItemCount: group.missingCostCount,
    };
  }).sort(
    (left, right) =>
      right.netSales.amount - left.netSales.amount ||
      (left.categoryName ?? "").localeCompare(right.categoryName ?? "") ||
      (left.categoryId ?? "").localeCompare(right.categoryId ?? ""),
  );
}

export function buildPeakSalesHours(snapshot: ReportingSnapshot): readonly PeakSalesHourRow[] {
  const groups = new Map<number, { total: number; orderIds: Set<string> }>();
  periodOrderTransactions(snapshot).forEach((transaction) => {
    if (transaction.type !== "sale" || transaction.direction !== "inflow") return;
    const hour = getReportingHour(transaction.occurredAt, snapshot.period.timeZone);
    if (hour === null) return;
    const current = groups.get(hour) ?? { total: 0, orderIds: new Set() };
    current.total += transaction.amount.amount;
    current.orderIds.add(transaction.sourceReference ?? transaction.id);
    groups.set(hour, current);
  });

  return Array.from(groups, ([hour, group]) => ({
    hour,
    paidOrderCount: group.orderIds.size,
    grossSales: money(group.total),
  })).sort(
    (left, right) =>
      right.paidOrderCount - left.paidOrderCount ||
      right.grossSales.amount - left.grossSales.amount ||
      left.hour - right.hour,
  );
}

export function buildInventoryUsage(snapshot: ReportingSnapshot): readonly InventoryUsageRow[] {
  const ingredientById = new Map(
    snapshot.ingredients.map((ingredient) => [ingredient.id, ingredient]),
  );
  const currentStock = new Map<string, number>();
  snapshot.stockBalances.forEach((balance) => {
    currentStock.set(
      balance.ingredientId,
      (currentStock.get(balance.ingredientId) ?? 0) + balance.quantity,
    );
  });
  const usage = new Map<string, number>();
  snapshot.inventoryMovements.forEach((movement) => {
    if (
      movement.type !== "consumption" ||
      !isTimestampInReportingPeriod(movement.occurredAt, snapshot.period)
    ) {
      return;
    }
    usage.set(
      movement.ingredientId,
      (usage.get(movement.ingredientId) ?? 0) + Math.abs(movement.baseQuantityDelta),
    );
  });

  return Array.from(usage, ([ingredientId, quantityUsed]) => {
    const ingredient = ingredientById.get(ingredientId);
    if (!ingredient) return null;
    const stock = currentStock.get(ingredientId) ?? 0;
    return {
      ingredientId,
      ingredientName: ingredient.name,
      unit: ingredient.baseUnit,
      quantityUsed,
      estimatedUsageValue: money(quantityUsed * ingredient.averageUnitCost.amount),
      currentStock: stock,
      minimumStock: ingredient.minimumStock,
      lowStock: ingredient.status === "active" && stock <= ingredient.minimumStock,
    };
  })
    .filter((row): row is InventoryUsageRow => row !== null)
    .sort(
      (left, right) =>
        right.quantityUsed - left.quantityUsed ||
        left.ingredientName.localeCompare(right.ingredientName) ||
        left.ingredientId.localeCompare(right.ingredientId),
    );
}
