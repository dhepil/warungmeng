// packages/domain/src/finance.ts
//
// Ported from SOURCE packages/domain/src/finance/{types,validation,ledger,calculations}.ts
// plus the cost-of-goods (HPP) functions from SOURCE inventory/hpp.ts, consolidated per
// new-target LOGIC-TARGET-FILE-TREE.md §4 and the roadmap's S4 "money type, HPP/tax math".
// Pure TypeScript: finance transaction model, manual-transaction validation, order→ledger
// projection, reporting summaries, and HPP/margin/pricing math. No I/O.

import type { Money } from "./catalog";
import type { Order, OrderPaymentMethod } from "./orders";
import { convertInventoryQuantity } from "./inventory";
import type { InventoryIngredient, MenuHppBreakdown, MenuRecipe } from "./inventory";

// ─── Types ───────────────────────────────────────────────────────────────────

export const FINANCE_DIRECTIONS = ["inflow", "outflow"] as const;
export type FinanceDirection = (typeof FINANCE_DIRECTIONS)[number];

export const FINANCE_TRANSACTION_TYPES = [
  "sale",
  "manual-income",
  "expense",
  "refund",
  "cash-in",
  "cash-out",
  "adjustment",
] as const;
export type FinanceTransactionType = (typeof FINANCE_TRANSACTION_TYPES)[number];

export const FINANCE_SOURCES = ["automatic", "manual"] as const;
export type FinanceSource = (typeof FINANCE_SOURCES)[number];

export const FINANCE_STATUSES = ["pending", "posted", "voided"] as const;
export type FinanceStatus = (typeof FINANCE_STATUSES)[number];
export type ManualFinanceStatus = Exclude<FinanceStatus, "voided">;

export const FINANCE_PAYMENT_METHODS = ["cash", "qris", "card", "bank-transfer", "other"] as const;
export type FinancePaymentMethod = (typeof FINANCE_PAYMENT_METHODS)[number];

export interface FinanceCategory {
  readonly id: string;
  readonly label: string;
  readonly direction: FinanceDirection;
}

export const FINANCE_CATEGORIES: readonly FinanceCategory[] = [
  { id: "sales", label: "Penjualan", direction: "inflow" },
  { id: "other-income", label: "Pemasukan Lain", direction: "inflow" },
  { id: "capital-deposit", label: "Setoran Modal", direction: "inflow" },
  { id: "inflow-adjustment", label: "Penyesuaian Masuk", direction: "inflow" },
  { id: "ingredients", label: "Bahan Baku", direction: "outflow" },
  { id: "packaging", label: "Kemasan", direction: "outflow" },
  { id: "utilities", label: "Listrik dan Utilitas", direction: "outflow" },
  { id: "transportation", label: "Transportasi", direction: "outflow" },
  { id: "salary", label: "Gaji", direction: "outflow" },
  { id: "maintenance", label: "Perawatan", direction: "outflow" },
  { id: "refund", label: "Refund", direction: "outflow" },
  { id: "other-expense", label: "Pengeluaran Lain", direction: "outflow" },
  { id: "outflow-adjustment", label: "Penyesuaian Keluar", direction: "outflow" },
] as const;

export interface FinanceAttachmentMetadata {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
}

export interface FinanceTransaction {
  readonly id: string;
  readonly occurredAt: string;
  readonly direction: FinanceDirection;
  readonly type: FinanceTransactionType;
  readonly source: FinanceSource;
  readonly status: FinanceStatus;
  readonly categoryId: string;
  readonly categoryLabel: string;
  readonly amount: Money;
  readonly paymentMethod: FinancePaymentMethod;
  readonly description: string;
  readonly referenceNumber: string;
  readonly sourceReference: string | null;
  readonly attachment: FinanceAttachmentMetadata | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ManualFinanceTransactionType = Exclude<FinanceTransactionType, "sale" | "refund">;

export interface ManualFinanceTransactionInput {
  readonly occurredAt: string;
  readonly direction: FinanceDirection;
  readonly type: ManualFinanceTransactionType;
  readonly status: ManualFinanceStatus;
  readonly categoryId: string;
  readonly categoryLabel: string;
  readonly amount: Money;
  readonly paymentMethod: FinancePaymentMethod;
  readonly description: string;
  readonly referenceNumber: string;
  readonly attachment: FinanceAttachmentMetadata | null;
}

export interface FinanceTransactionQuery {
  readonly search?: string;
  readonly dateFrom?: string;
  readonly dateTo?: string;
  readonly direction?: FinanceDirection;
  readonly type?: FinanceTransactionType;
  readonly categoryId?: string;
  readonly paymentMethod?: FinancePaymentMethod;
  readonly source?: FinanceSource;
  readonly status?: FinanceStatus;
}

export interface FinanceSummary {
  readonly totalInflow: Money;
  readonly totalOutflow: Money;
  readonly netCashflow: Money;
  readonly cashBalance: Money;
  readonly postedCount: number;
  readonly pendingCount: number;
  readonly voidedCount: number;
}

export interface FinancePaymentMethodSummary {
  readonly paymentMethod: FinancePaymentMethod;
  readonly totalInflow: Money;
  readonly totalOutflow: Money;
  readonly netCashflow: Money;
  readonly transactionCount: number;
}

export interface FinanceCategorySummary {
  readonly categoryId: string;
  readonly categoryLabel: string;
  readonly total: Money;
  readonly transactionCount: number;
}

export function getFinanceCategories(direction: FinanceDirection): readonly FinanceCategory[] {
  return FINANCE_CATEGORIES.filter((category) => category.direction === direction);
}

// ─── Manual transaction validation ───────────────────────────────────────────

export const MAX_FINANCE_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export interface ManualFinanceTransactionErrors {
  readonly occurredAt?: string;
  readonly type?: string;
  readonly categoryId?: string;
  readonly categoryLabel?: string;
  readonly amount?: string;
  readonly description?: string;
  readonly attachment?: string;
}

const INFLOW_TYPES: readonly ManualFinanceTransactionType[] = [
  "manual-income",
  "cash-in",
  "adjustment",
];
const OUTFLOW_TYPES: readonly ManualFinanceTransactionType[] = [
  "expense",
  "cash-out",
  "adjustment",
];

function isValidIsoDatetime(value: string): boolean {
  return value.trim() !== "" && Number.isFinite(Date.parse(value));
}

function isAcceptedAttachment(attachment: FinanceAttachmentMetadata): boolean {
  return attachment.mimeType.startsWith("image/") || attachment.mimeType === "application/pdf";
}

function isTypeValidForDirection(
  type: ManualFinanceTransactionType,
  direction: FinanceDirection,
): boolean {
  return (direction === "inflow" ? INFLOW_TYPES : OUTFLOW_TYPES).includes(type);
}

export function validateManualFinanceTransaction(
  input: ManualFinanceTransactionInput,
): ManualFinanceTransactionErrors {
  const errors: Record<string, string> = {};
  const category = FINANCE_CATEGORIES.find((candidate) => candidate.id === input.categoryId);

  if (!isValidIsoDatetime(input.occurredAt)) {
    errors.occurredAt = "Transaction date and time must be valid.";
  }
  if (!isTypeValidForDirection(input.type, input.direction)) {
    errors.type = "Transaction type does not match its direction.";
  }
  if (input.categoryId.trim() === "") {
    errors.categoryId = "Transaction category is required.";
  } else if (category && category.direction !== input.direction) {
    errors.categoryId = "Transaction category does not match its direction.";
  }
  if (input.categoryLabel.trim() === "") {
    errors.categoryLabel = "Transaction category label is required.";
  }
  if (
    input.amount.currency !== "IDR" ||
    !Number.isSafeInteger(input.amount.amount) ||
    input.amount.amount < 0
  ) {
    errors.amount = "Amount must be a non-negative whole number in IDR.";
  }
  if (input.description.trim() === "") {
    errors.description = "Transaction description is required.";
  }
  if (input.attachment) {
    if (
      input.attachment.id.trim() === "" ||
      input.attachment.name.trim() === "" ||
      !Number.isSafeInteger(input.attachment.size) ||
      input.attachment.size < 0 ||
      input.attachment.size > MAX_FINANCE_ATTACHMENT_BYTES ||
      !isAcceptedAttachment(input.attachment)
    ) {
      errors.attachment = "Attachment must be an image or PDF no larger than 5 MB.";
    }
  }

  return errors;
}

export function isManualFinanceTransactionValid(input: ManualFinanceTransactionInput): boolean {
  return Object.keys(validateManualFinanceTransaction(input)).length === 0;
}

// ─── Order → finance ledger projection ───────────────────────────────────────

function mapPaymentMethod(method: OrderPaymentMethod): FinancePaymentMethod {
  return method === "unknown" ? "other" : method;
}

// Deep clone of a finance transaction. FinanceTransaction is JSON-safe (strings, numbers,
// null, nested Money/attachment — no Dates or functions), so a JSON round-trip is a
// faithful deep clone and keeps the domain free of Node/DOM globals (structuredClone).
function cloneFinanceTransaction(transaction: FinanceTransaction): FinanceTransaction {
  return JSON.parse(JSON.stringify(transaction)) as FinanceTransaction;
}

function buildAutomaticTransaction(
  order: Order,
  type: Extract<FinanceTransactionType, "sale" | "refund">,
): FinanceTransaction {
  const isRefund = type === "refund";
  const occurredAt = isRefund ? order.updatedAt : order.createdAt;

  return {
    id: `finance-order-${order.id}-${type}`,
    occurredAt,
    direction: isRefund ? "outflow" : "inflow",
    type,
    source: "automatic",
    status: "posted",
    categoryId: isRefund ? "refund" : "sales",
    categoryLabel: isRefund ? "Refund" : "Penjualan",
    amount: { ...order.totals.total },
    paymentMethod: mapPaymentMethod(order.paymentMethod),
    description: `${isRefund ? "Refund" : "Penjualan"} ${order.orderNumber}`,
    referenceNumber: order.orderNumber,
    sourceReference: order.id,
    attachment: null,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
}

export function projectOrderToFinanceTransactions(order: Order): readonly FinanceTransaction[] {
  if (order.paymentStatus === "unpaid") return [];

  const sale = buildAutomaticTransaction(order, "sale");
  if (order.paymentStatus === "paid") return [sale];

  return [sale, buildAutomaticTransaction(order, "refund")];
}

export function projectOrdersToFinanceTransactions(
  orders: readonly Order[],
): readonly FinanceTransaction[] {
  const projectedById = new Map<string, FinanceTransaction>();

  orders.forEach((order) => {
    projectOrderToFinanceTransactions(order).forEach((transaction) => {
      projectedById.set(transaction.id, transaction);
    });
  });

  return Array.from(projectedById.values());
}

export function buildFinanceLedger(
  orders: readonly Order[],
  manualTransactions: readonly FinanceTransaction[],
): readonly FinanceTransaction[] {
  const transactionById = new Map<string, FinanceTransaction>();

  manualTransactions.forEach((transaction) => {
    transactionById.set(transaction.id, cloneFinanceTransaction(transaction));
  });
  projectOrdersToFinanceTransactions(orders).forEach((transaction) => {
    transactionById.set(transaction.id, transaction);
  });

  return Array.from(transactionById.values());
}

// ─── Ledger queries and summaries ────────────────────────────────────────────

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function money(amount: number) {
  return { amount, currency: "IDR" as const };
}

function parseBoundary(value: string, boundary: "start" | "end"): number {
  const normalized = DATE_ONLY_PATTERN.test(value)
    ? `${value}T${boundary === "start" ? "00:00:00.000" : "23:59:59.999"}Z`
    : value;
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) throw new RangeError(`Invalid finance date boundary: ${value}`);
  return timestamp;
}

function includesSearch(transaction: FinanceTransaction, search: string): boolean {
  const normalizedSearch = search.trim().toLocaleLowerCase();
  if (!normalizedSearch) return true;

  return [
    transaction.description,
    transaction.referenceNumber,
    transaction.categoryLabel,
    transaction.sourceReference ?? "",
  ].some((value) => value.toLocaleLowerCase().includes(normalizedSearch));
}

export function sortFinanceTransactionsNewestFirst(
  transactions: readonly FinanceTransaction[],
): readonly FinanceTransaction[] {
  return [...transactions].sort(
    (left, right) =>
      right.occurredAt.localeCompare(left.occurredAt) || left.id.localeCompare(right.id),
  );
}

export function filterFinanceTransactions(
  transactions: readonly FinanceTransaction[],
  query: FinanceTransactionQuery = {},
): readonly FinanceTransaction[] {
  const dateFrom = query.dateFrom ? parseBoundary(query.dateFrom, "start") : null;
  const dateTo = query.dateTo ? parseBoundary(query.dateTo, "end") : null;
  if (dateFrom !== null && dateTo !== null && dateFrom > dateTo) {
    throw new RangeError("Finance dateFrom must not be after dateTo");
  }

  return sortFinanceTransactionsNewestFirst(
    transactions.filter((transaction) => {
      const occurredAt = Date.parse(transaction.occurredAt);
      return (
        Number.isFinite(occurredAt) &&
        (dateFrom === null || occurredAt >= dateFrom) &&
        (dateTo === null || occurredAt <= dateTo) &&
        (!query.search || includesSearch(transaction, query.search)) &&
        (!query.direction || transaction.direction === query.direction) &&
        (!query.type || transaction.type === query.type) &&
        (!query.categoryId || transaction.categoryId === query.categoryId) &&
        (!query.paymentMethod || transaction.paymentMethod === query.paymentMethod) &&
        (!query.source || transaction.source === query.source) &&
        (!query.status || transaction.status === query.status)
      );
    }),
  );
}

export function summarizeFinanceTransactions(
  transactions: readonly FinanceTransaction[],
): FinanceSummary {
  let inflow = 0;
  let outflow = 0;
  let cashInflow = 0;
  let cashOutflow = 0;
  let postedCount = 0;
  let pendingCount = 0;
  let voidedCount = 0;

  transactions.forEach((transaction) => {
    if (transaction.status === "pending") {
      pendingCount += 1;
      return;
    }
    if (transaction.status === "voided") {
      voidedCount += 1;
      return;
    }

    postedCount += 1;
    if (transaction.direction === "inflow") {
      inflow += transaction.amount.amount;
      if (transaction.paymentMethod === "cash") cashInflow += transaction.amount.amount;
    } else {
      outflow += transaction.amount.amount;
      if (transaction.paymentMethod === "cash") cashOutflow += transaction.amount.amount;
    }
  });

  return {
    totalInflow: money(inflow),
    totalOutflow: money(outflow),
    netCashflow: money(inflow - outflow),
    cashBalance: money(cashInflow - cashOutflow),
    postedCount,
    pendingCount,
    voidedCount,
  };
}

export function groupFinanceTransactionsByPaymentMethod(
  transactions: readonly FinanceTransaction[],
): readonly FinancePaymentMethodSummary[] {
  const groups = new Map<
    FinancePaymentMethod,
    { inflow: number; outflow: number; count: number }
  >();

  transactions.forEach((transaction) => {
    if (transaction.status !== "posted") return;
    const current = groups.get(transaction.paymentMethod) ?? { inflow: 0, outflow: 0, count: 0 };
    if (transaction.direction === "inflow") current.inflow += transaction.amount.amount;
    else current.outflow += transaction.amount.amount;
    current.count += 1;
    groups.set(transaction.paymentMethod, current);
  });

  return Array.from(groups, ([paymentMethod, group]) => ({
    paymentMethod,
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

export function groupFinanceOutflowsByCategory(
  transactions: readonly FinanceTransaction[],
): readonly FinanceCategorySummary[] {
  const groups = new Map<string, { label: string; total: number; count: number }>();

  transactions.forEach((transaction) => {
    if (transaction.status !== "posted" || transaction.direction !== "outflow") return;
    const current = groups.get(transaction.categoryId) ?? {
      label: transaction.categoryLabel,
      total: 0,
      count: 0,
    };
    current.total += transaction.amount.amount;
    current.count += 1;
    groups.set(transaction.categoryId, current);
  });

  return Array.from(groups, ([categoryId, group]) => ({
    categoryId,
    categoryLabel: group.label,
    total: money(group.total),
    transactionCount: group.count,
  })).sort(
    (left, right) =>
      right.total.amount - left.total.amount ||
      left.categoryLabel.localeCompare(right.categoryLabel),
  );
}

// ─── HPP (cost of goods) and pricing math ────────────────────────────────────
// Ported from SOURCE inventory/hpp.ts. Uses inventory recipe types + unit conversion.

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function calculateMenuHpp(
  recipe: MenuRecipe,
  ingredients: readonly InventoryIngredient[],
): MenuHppBreakdown {
  const ingredientById = new Map(ingredients.map((ingredient) => [ingredient.id, ingredient]));
  const ingredientCosts = recipe.components.map((component) => {
    const ingredient = ingredientById.get(component.ingredientId);
    if (!ingredient) {
      throw new RangeError(`Recipe ingredient ${component.ingredientId} was not found`);
    }
    if (component.wastePercentage < 0 || component.wastePercentage > 100) {
      throw new RangeError("Waste percentage must be between 0 and 100");
    }

    const baseQuantity = convertInventoryQuantity(
      component.quantity,
      component.unit,
      ingredient.baseUnit,
    );
    const cost = roundMoney(
      baseQuantity * ingredient.averageUnitCost.amount * (1 + component.wastePercentage / 100),
    );
    return {
      ingredientId: component.ingredientId,
      baseQuantity,
      cost: { amount: cost, currency: "IDR" as const },
    };
  });
  const ingredientTotal = roundMoney(
    ingredientCosts.reduce((total, item) => total + item.cost.amount, 0),
  );
  const total = roundMoney(
    ingredientTotal + recipe.packagingCost.amount + recipe.additionalCost.amount,
  );

  return {
    menuItemId: recipe.menuItemId,
    ingredientCosts,
    ingredientTotal: { amount: ingredientTotal, currency: "IDR" },
    packagingCost: { ...recipe.packagingCost },
    additionalCost: { ...recipe.additionalCost },
    total: { amount: total, currency: "IDR" },
  };
}

export function calculateGrossMarginPercentage(sellingPrice: number, hpp: number): number | null {
  if (sellingPrice <= 0) return null;
  return Math.round(((sellingPrice - hpp) / sellingPrice) * 10_000) / 100;
}

export function calculateRecommendedSellingPrice(
  hpp: number,
  targetMarginPercentage = 60,
  roundingStep = 500,
): number {
  if (hpp < 0 || targetMarginPercentage < 0 || targetMarginPercentage >= 100 || roundingStep <= 0) {
    throw new RangeError("Invalid recommended price parameters");
  }
  return Math.ceil(hpp / (1 - targetMarginPercentage / 100) / roundingStep) * roundingStep;
}
