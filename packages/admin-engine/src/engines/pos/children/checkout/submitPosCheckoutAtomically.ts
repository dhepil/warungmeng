// packages/admin-engine/src/engines/pos/children/checkout/submitPosCheckoutAtomically.ts
//
// POS checkout's multi-owner sequence (LOGIC §10). Caller opens atomic boundary;
// this file decides which endings return without rollback and which must throw.

import type {
  MenuItem,
  MenuVariantGroup,
  Money,
  Order,
  OrderItem,
  OrderTotals,
} from "@warungmeng/domain";
import {
  DEFAULT_REPORTING_TIME_ZONE,
  isMenuAvailable,
  projectOrderToFinanceTransactions,
  validateVariantSelectionRule,
} from "@warungmeng/domain";
import type { OperationIssue, OperationResult } from "@warungmeng/module-system";
import {
  isOperationUsable,
  operationDegraded,
  operationFailure,
  operationIssue,
  operationSuccess,
} from "@warungmeng/module-system";
import type { TransactionRecording } from "../../../finance/financeContracts";
import type { StockConsumption } from "../../../inventory/inventoryContracts";
import type { CatalogRead } from "../../../menu/menuContracts";
import type { OrderSubmission } from "../../../orders/ordersContracts";
import type {
  PosCart,
  PosCartItem,
  PosCartSnapshot,
  PosCheckoutOutcome,
  PosPricingOptions,
  PosReceipt,
  PosSession,
  PosSessionSnapshot,
  SubmitPosCheckoutInput,
} from "../../posContracts";
import { POS_ISSUE, posCartFingerprint } from "../../posContracts";

const IDR = (amount: number): Money => ({ amount, currency: "IDR" });

/** Thrown after first write so atomic port rolls every owner back. */
export class PosCheckoutRollback extends Error {
  readonly issues: readonly OperationIssue[];

  constructor(issues: readonly OperationIssue[], cause?: unknown) {
    super(issues[0]?.message ?? "POS checkout was rolled back");
    this.name = "PosCheckoutRollback";
    this.issues = issues;
    if (cause !== undefined) this.cause = cause;
  }
}

export interface PosCheckoutOwners {
  readonly session: PosSession;
  readonly cart: PosCart;
  readonly catalog: CatalogRead;
  readonly inventory: StockConsumption;
  readonly orders: OrderSubmission;
  /**
   * Declared by LOGIC §8, deliberately not called. SOURCE derives automatic sales
   * from committed orders; calling this manual writer would duplicate one fact.
   * Keeping resolution here makes structural dependency explicit without a fake write.
   */
  readonly finance: TransactionRecording;
}

interface PosCheckoutPlan {
  readonly idempotencyKey: string;
  readonly expectedCheckoutKey: string;
  readonly session: Extract<PosSessionSnapshot["session"], { readonly status: "open" }>;
  readonly cart: PosCartSnapshot;
  readonly order: Omit<Order, "id">;
  readonly cashReceived: number;
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function isWholeNonNegative(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

export function calculatePosTotals(
  items: readonly PosCartItem[],
  options: PosPricingOptions,
): OrderTotals {
  const subtotal = items.reduce(
    (total, item) =>
      total +
      (item.unitPrice.amount +
        item.variantSelections.reduce(
          (variantTotal, selection) => variantTotal + selection.priceAdjustment.amount,
          0,
        )) *
        item.quantity,
    0,
  );
  const discount = Math.min(options.discountAmount, subtotal);
  const taxableAmount = subtotal - discount + options.serviceChargeAmount;
  const tax = Math.round(taxableAmount * options.taxRate);
  const beforeRounding = taxableAmount + tax;
  const total =
    options.roundingStep > 1
      ? Math.round(beforeRounding / options.roundingStep) * options.roundingStep
      : beforeRounding;

  return {
    subtotal: IDR(subtotal),
    discount: IDR(discount),
    tax: IDR(tax),
    serviceCharge: IDR(options.serviceChargeAmount),
    rounding: IDR(total - beforeRounding),
    total: IDR(total),
  };
}

export function createPosOrderNumber(occurredAt: string, sequence: number): string {
  if (!validTimestamp(occurredAt) || !Number.isInteger(sequence) || sequence < 1) {
    throw new RangeError("POS order number needs a valid timestamp and positive sequence");
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DEFAULT_REPORTING_TIME_ZONE,
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(Date.parse(occurredAt));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  const date = `${part("year")}${part("month")}${part("day")}`;
  const time = `${part("hour")}${part("minute")}${part("second")}`;
  return `WM-POS-${date}-${time}-${String(sequence).padStart(3, "0")}`;
}

function optionAvailable(option: MenuVariantGroup["options"][number], now: Date): boolean {
  if (
    option.inventory.mode === "tracked" &&
    option.inventory.quantity <= 0
  ) {
    return false;
  }
  if (option.availability.status === "available") return true;
  if (option.availability.unavailableUntil === null) return false;
  const unavailableUntil = Date.parse(option.availability.unavailableUntil);
  return Number.isFinite(unavailableUntil) && unavailableUntil <= now.getTime();
}

function revalidateItem(
  item: PosCartItem,
  menu: MenuItem,
  groups: ReadonlyMap<string, MenuVariantGroup>,
  now: Date,
): readonly OperationIssue[] {
  const issues: OperationIssue[] = [];
  if (menu.visibility !== "visible" || !isMenuAvailable(menu, now)) {
    issues.push(
      operationIssue(
        POS_ISSUE.menuUnavailable,
        `${menu.name} is no longer available for checkout.`,
        item.menuItemId,
      ),
    );
  }
  if (menu.price.amount !== item.unitPrice.amount || menu.price.currency !== item.unitPrice.currency) {
    issues.push(
      operationIssue(
        POS_ISSUE.cartChanged,
        `${menu.name}'s price changed after it was added; reload the cart before checkout.`,
        item.menuItemId,
      ),
    );
  }

  const selectedByGroup = new Map<string, typeof item.variantSelections>();
  for (const selection of item.variantSelections) {
    selectedByGroup.set(selection.groupId, [
      ...(selectedByGroup.get(selection.groupId) ?? []),
      selection,
    ]);
  }

  for (const groupId of menu.variantGroupIds) {
    const group = groups.get(groupId);
    if (group === undefined) {
      issues.push(
        operationIssue(
          POS_ISSUE.cartChanged,
          `Variant group ${groupId} is no longer available.`,
          item.menuItemId,
        ),
      );
      continue;
    }
    const selected = selectedByGroup.get(groupId) ?? [];
    const available = group.options.filter((option) => optionAvailable(option, now));
    const rule = validateVariantSelectionRule(
      group.selection,
      group.options.length,
      available.length,
    );
    const maximum = group.selection.maxSelections ?? Number.POSITIVE_INFINITY;
    if (
      group.visibility !== "visible" ||
      !rule.valid ||
      selected.length < group.selection.minSelections ||
      selected.length > maximum
    ) {
      issues.push(
        operationIssue(
          POS_ISSUE.cartChanged,
          `${group.name}'s selection is no longer valid.`,
          item.id,
        ),
      );
    }

    for (const selection of selected) {
      const option = group.options.find((candidate) => candidate.id === selection.optionId);
      if (
        option === undefined ||
        !optionAvailable(option, now) ||
        option.name !== selection.optionName ||
        option.priceAdjustment.amount !== selection.priceAdjustment.amount ||
        option.priceAdjustment.currency !== selection.priceAdjustment.currency
      ) {
        issues.push(
          operationIssue(
            POS_ISSUE.cartChanged,
            `A selected option for ${group.name} changed after it was added.`,
            selection.optionId,
          ),
        );
      }
    }
  }

  for (const groupId of selectedByGroup.keys()) {
    if (!menu.variantGroupIds.includes(groupId)) {
      issues.push(
        operationIssue(
          POS_ISSUE.cartChanged,
          `Variant group ${groupId} is no longer attached to ${menu.name}.`,
          item.id,
        ),
      );
    }
  }

  return issues;
}

function validateCheckoutInput(input: SubmitPosCheckoutInput): readonly OperationIssue[] {
  const issues: OperationIssue[] = [];
  if (!validTimestamp(input.occurredAt)) {
    issues.push(
      operationIssue(
        POS_ISSUE.invalidCheckout,
        "Checkout needs a valid timestamp.",
        "occurredAt",
      ),
    );
  }
  if (!(["dine-in", "takeaway"] as const).includes(input.fulfillment)) {
    issues.push(operationIssue(POS_ISSUE.invalidCheckout, "Invalid POS fulfillment.", "fulfillment"));
  }
  if (!(["cash", "qris", "card"] as const).includes(input.paymentMethod)) {
    issues.push(operationIssue(POS_ISSUE.invalidCheckout, "Invalid POS payment method.", "paymentMethod"));
  }
  if (
    !isWholeNonNegative(input.cashReceived) ||
    !isWholeNonNegative(input.pricing.discountAmount) ||
    !isWholeNonNegative(input.pricing.serviceChargeAmount) ||
    !Number.isFinite(input.pricing.taxRate) ||
    input.pricing.taxRate < 0 ||
    input.pricing.taxRate > 1 ||
    !Number.isInteger(input.pricing.roundingStep) ||
    input.pricing.roundingStep < 1
  ) {
    issues.push(
      operationIssue(
        POS_ISSUE.invalidCheckout,
        "Checkout money must be whole non-negative IDR; tax is 0..1 and rounding is a positive whole step.",
        "pricing",
      ),
    );
  }
  return issues;
}

async function planCheckout(
  owners: PosCheckoutOwners,
  input: SubmitPosCheckoutInput,
): Promise<OperationResult<PosCheckoutPlan>> {
  const inputIssues = validateCheckoutInput(input);
  if (inputIssues.length > 0) return operationFailure("invalid-input", inputIssues);

  const identityResult = await owners.session.beginCheckout();
  if (!isOperationUsable(identityResult)) return identityResult;

  const [sessionResult, cartResult, menusResult, groupsResult] = await Promise.all([
    owners.session.getSession(),
    owners.cart.getCart(),
    owners.catalog.listMenus(),
    owners.catalog.listVariantGroups(),
  ]);
  const reads = [sessionResult, cartResult, menusResult, groupsResult] as const;
  const failed = reads.filter((result) => result.status === "failure");
  if (failed.length > 0) {
    return operationFailure("failed", [
      operationIssue(
        POS_ISSUE.catalogFailed,
        "Session, cart, or catalog could not be revalidated before checkout.",
        "checkout",
      ),
      ...failed.flatMap((result) => result.issues),
    ]);
  }

  if (!isOperationUsable(sessionResult) || !isOperationUsable(cartResult)) {
    return operationFailure("failed", []);
  }
  if (sessionResult.value.session.status !== "open") {
    return operationFailure("conflict", [
      operationIssue(POS_ISSUE.sessionClosed, "Open a POS session before checkout.", "session"),
    ]);
  }
  if (cartResult.value.items.length === 0) {
    return operationFailure("invalid-input", [
      operationIssue(POS_ISSUE.emptyCart, "POS cart is empty.", "cart"),
    ]);
  }

  const now = new Date(input.occurredAt);
  const menus = isOperationUsable(menusResult) ? menusResult.value : [];
  const groups = isOperationUsable(groupsResult) ? groupsResult.value : [];
  const menuById = new Map(menus.map((menu) => [menu.id, menu]));
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const cartIssues: OperationIssue[] = [];
  for (const item of cartResult.value.items) {
    const menu = menuById.get(item.menuItemId);
    if (menu === undefined) {
      cartIssues.push(
        operationIssue(
          POS_ISSUE.menuNotFound,
          `Menu item ${item.menuItemId} no longer exists.`,
          item.menuItemId,
        ),
      );
      continue;
    }
    cartIssues.push(...revalidateItem(item, menu, groupById, now));
  }
  if (cartIssues.length > 0) return operationFailure("conflict", cartIssues);

  const totals = calculatePosTotals(cartResult.value.items, input.pricing);
  if (input.paymentMethod === "cash" && input.cashReceived < totals.total.amount) {
    return operationFailure("conflict", [
      operationIssue(
        POS_ISSUE.paymentInsufficient,
        "Cash received is less than the checkout total.",
        "cashReceived",
        { cashReceived: input.cashReceived, total: totals.total.amount },
      ),
    ]);
  }

  const session = sessionResult.value.session;
  const checkoutSequence = identityResult.value.sequence;
  const key = identityResult.value.key;
  const orderNumber = createPosOrderNumber(input.occurredAt, checkoutSequence);
  const items: OrderItem[] = cartResult.value.items.map((item) => {
    const unitPrice =
      item.unitPrice.amount +
      item.variantSelections.reduce(
        (total, selection) => total + selection.priceAdjustment.amount,
        0,
      );
    return {
      id: item.id,
      menuItemId: item.menuItemId,
      name: item.name,
      quantity: item.quantity,
      unitPrice: IDR(item.unitPrice.amount),
      variantSelections: item.variantSelections.map((selection) => ({
        ...selection,
        priceAdjustment: { ...selection.priceAdjustment },
      })),
      note: item.note,
      lineTotal: IDR(unitPrice * item.quantity),
    };
  });
  const order: Omit<Order, "id"> = {
    orderNumber,
    outletId: session.outlet.id,
    outletName: session.outlet.name,
    channel: "pos",
    fulfillment: input.fulfillment,
    paymentStatus: "paid",
    paymentMethod: input.paymentMethod,
    status: "new",
    customer: null,
    items,
    totals,
    customerNote: "",
    internalNote: "",
    createdAt: input.occurredAt,
    updatedAt: input.occurredAt,
    events: [
      {
        id: `event:${key}`,
        status: "new",
        occurredAt: input.occurredAt,
        note: "Created from POS cashier",
      },
    ],
  };

  if (cartResult.value.revision !== identityResult.value.stateRevision) {
    return operationFailure("conflict", [
      operationIssue(
        POS_ISSUE.cartChanged,
        "POS cart changed while checkout identity was being reserved; retry from current cart.",
        "cart",
      ),
    ]);
  }

  return operationSuccess({
    idempotencyKey: key,
    expectedCheckoutKey: key,
    session,
    cart: cartResult.value,
    order,
    cashReceived:
      input.paymentMethod === "cash" ? input.cashReceived : totals.total.amount,
  });
}

function rollback(
  code: string,
  message: string,
  subject: string,
  result?: { readonly issues: readonly OperationIssue[]; readonly reason?: string },
): never {
  throw new PosCheckoutRollback([
    operationIssue(code, message, subject, result?.reason ? { reason: result.reason } : undefined),
    ...(result?.issues ?? []),
  ]);
}

/** Executes LOGIC §10 inside caller's atomic boundary. */
export async function submitPosCheckoutAtomically(
  owners: PosCheckoutOwners,
  input: SubmitPosCheckoutInput,
): Promise<OperationResult<PosCheckoutOutcome>> {
  // No writes before planning. Every business refusal returns and commits nothing.
  let plan: Awaited<ReturnType<typeof planCheckout>>;
  try {
    plan = await planCheckout(owners, input);
  } catch (error) {
    return operationFailure("failed", [
      operationIssue(
        POS_ISSUE.catalogFailed,
        error instanceof Error ? error.message : "Checkout validation failed.",
        "checkout",
      ),
    ]);
  }
  if (plan.status === "failure") return plan;

  // First write: every later non-usable ending must THROW, never return.
  let submitted: Awaited<ReturnType<OrderSubmission["submitOrder"]>>;
  try {
    submitted = await owners.orders.submitOrder({
      idempotencyKey: plan.value.idempotencyKey,
      order: plan.value.order,
    });
  } catch (error) {
    rollback(
      POS_ISSUE.orderFailed,
      "Order submission threw, so checkout was rolled back.",
      plan.value.order.orderNumber,
      { issues: [], reason: error instanceof Error ? error.message : String(error) },
    );
  }
  if (!isOperationUsable(submitted)) {
    rollback(
      POS_ISSUE.orderFailed,
      "Order could not be submitted, so checkout was rolled back.",
      plan.value.order.orderNumber,
      submitted,
    );
  }

  const order = submitted.value.order;
  let consumed: Awaited<ReturnType<StockConsumption["consumeOrder"]>>;
  try {
    consumed = await owners.inventory.consumeOrder(order);
  } catch (error) {
    rollback(
      POS_ISSUE.inventoryFailed,
      `Stock consumption threw for ${order.orderNumber}, so checkout was rolled back.`,
      order.id,
      { issues: [], reason: error instanceof Error ? error.message : String(error) },
    );
  }
  if (!isOperationUsable(consumed)) {
    rollback(
      POS_ISSUE.inventoryFailed,
      `Stock could not be consumed for ${order.orderNumber}, so checkout was rolled back.`,
      order.id,
      consumed,
    );
  }

  // D23: automatic finance sale is pure projection from committed order. Validate
  // projection now; never call manual transaction writer and create duplicate sale.
  let financeRows: ReturnType<typeof projectOrderToFinanceTransactions>;
  try {
    financeRows = projectOrderToFinanceTransactions(order);
  } catch (error) {
    rollback(
      POS_ISSUE.financeFailed,
      `Finance projection failed for ${order.orderNumber}, so checkout was rolled back.`,
      order.id,
      { issues: [], reason: error instanceof Error ? error.message : String(error) },
    );
  }
  if (financeRows.length !== 1 || financeRows[0]?.type !== "sale") {
    rollback(
      POS_ISSUE.financeFailed,
      `Finance could not derive one sale for ${order.orderNumber}, so checkout was rolled back.`,
      order.id,
    );
  }

  let cleared: Awaited<ReturnType<PosCart["clear"]>>;
  try {
    cleared = await owners.cart.clear({
      expectedRevision: plan.value.cart.revision,
      checkout: {
        expectedKey: plan.value.expectedCheckoutKey,
        cashSaleAmount: input.paymentMethod === "cash" ? order.totals.total.amount : 0,
        orderFingerprint: posCartFingerprint(plan.value.cart.items),
      },
    });
  } catch (error) {
    rollback(
      POS_ISSUE.finalizationFailed,
      `Committed cart could not be cleared for ${order.orderNumber}, so checkout was rolled back.`,
      order.id,
      { issues: [], reason: error instanceof Error ? error.message : String(error) },
    );
  }
  if (!isOperationUsable(cleared)) {
    rollback(
      POS_ISSUE.finalizationFailed,
      `Committed cart changed before it could be cleared for ${order.orderNumber}; checkout was rolled back.`,
      order.id,
      cleared,
    );
  }

  const receipt: PosReceipt = {
    orderId: order.id,
    orderNumber: order.orderNumber,
    paymentMethod: input.paymentMethod,
    totals: order.totals,
    cashReceived: IDR(plan.value.cashReceived),
    change: IDR(Math.max(0, plan.value.cashReceived - order.totals.total.amount)),
    issuedAt: input.occurredAt,
  };
  const outcome: PosCheckoutOutcome = {
    order,
    receipt,
    orderReplayed: submitted.value.replayed,
    inventoryReplayed: consumed.value.replayed,
  };
  const issues: OperationIssue[] = [];
  if (submitted.value.replayed) {
    issues.push(
      operationIssue(
        POS_ISSUE.orderReplay,
        `Order ${order.orderNumber} was replayed; no duplicate order was written.`,
        order.id,
      ),
    );
  }
  if (consumed.value.replayed) {
    issues.push(
      operationIssue(
        POS_ISSUE.inventoryReplay,
        `Inventory for ${order.orderNumber} was already consumed.`,
        order.id,
      ),
    );
  }
  issues.push(
    ...consumed.value.skippedMenuItemIds.map((menuItemId) =>
      operationIssue(
        POS_ISSUE.inventorySkipped,
        "This menu item has no recipe, so checkout committed without consuming stock for it.",
        menuItemId,
      ),
    ),
  );

  return operationDegraded(outcome, issues);
}
