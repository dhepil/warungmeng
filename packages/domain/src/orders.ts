// packages/domain/src/orders.ts
//
// Ported from SOURCE packages/domain/src/orders/{types,transitions}.ts, consolidated
// into a single orders module per new-target LOGIC-TARGET-FILE-TREE.md §4. Pure
// TypeScript: the order model plus its status-transition state machine. No I/O.

import type { Money } from "./catalog";

// ─── Types ───────────────────────────────────────────────────────────────────

export const ORDER_STATUSES = [
  "new",
  "accepted",
  "preparing",
  "ready",
  "completed",
  "cancelled",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type OrderChannel = "pos" | "storefront" | "manual";
export type OrderFulfillment = "dine-in" | "takeaway" | "delivery";
export type OrderPaymentStatus = "unpaid" | "paid" | "refunded";
export type OrderPaymentMethod = "cash" | "qris" | "card" | "unknown";

export interface OrderCustomer {
  readonly name: string;
  readonly phone: string;
}

export interface OrderVariantSelection {
  readonly groupId: string;
  readonly groupName: string;
  readonly optionId: string;
  readonly optionName: string;
  readonly priceAdjustment: Money;
}

export interface OrderItem {
  readonly id: string;
  readonly menuItemId: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPrice: Money;
  readonly variantSelections: readonly OrderVariantSelection[];
  readonly note: string;
  readonly lineTotal: Money;
}

export interface OrderTotals {
  readonly subtotal: Money;
  readonly discount: Money;
  readonly tax: Money;
  readonly serviceCharge: Money;
  readonly rounding: Money;
  readonly total: Money;
}

export interface OrderStatusEvent {
  readonly id: string;
  readonly status: OrderStatus;
  readonly occurredAt: string;
  readonly note: string;
}

export interface Order {
  readonly id: string;
  readonly orderNumber: string;
  readonly outletId: string;
  readonly outletName: string;
  readonly channel: OrderChannel;
  readonly fulfillment: OrderFulfillment;
  readonly paymentStatus: OrderPaymentStatus;
  readonly paymentMethod: OrderPaymentMethod;
  readonly status: OrderStatus;
  readonly customer: OrderCustomer | null;
  readonly items: readonly OrderItem[];
  readonly totals: OrderTotals;
  readonly customerNote: string;
  readonly internalNote: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly events: readonly OrderStatusEvent[];
}

// ─── Status transitions ──────────────────────────────────────────────────────

const ORDER_STATUS_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  new: ["accepted", "cancelled"],
  accepted: ["preparing", "cancelled"],
  preparing: ["ready", "cancelled"],
  ready: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

export function getAllowedOrderStatusTransitions(status: OrderStatus): readonly OrderStatus[] {
  return ORDER_STATUS_TRANSITIONS[status];
}

export function canTransitionOrderStatus(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_STATUS_TRANSITIONS[from].includes(to);
}

export function transitionOrderStatus(
  order: Order,
  nextStatus: OrderStatus,
  occurredAt: string,
  eventId: string,
): Order | null {
  if (!canTransitionOrderStatus(order.status, nextStatus)) return null;

  // Policy: a paid order can never silently become cancelled — cancelling it
  // always settles the payment as refunded so the finance ledger projects a
  // compensating refund transaction.
  const paymentStatus =
    nextStatus === "cancelled" && order.paymentStatus === "paid" ? "refunded" : order.paymentStatus;

  return {
    ...order,
    status: nextStatus,
    paymentStatus,
    updatedAt: occurredAt,
    events: [
      ...order.events,
      {
        id: eventId,
        status: nextStatus,
        occurredAt,
        note: "",
      },
    ],
  };
}
