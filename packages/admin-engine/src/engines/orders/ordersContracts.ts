// packages/admin-engine/src/engines/orders/ordersContracts.ts
//
// Stable contracts owned by the Orders area: one injected store, the read and
// submission capabilities built in S7, progression added in PD DS-B, and the
// area's non-domain query/outcome shapes. `Order` and its nested vocabulary come
// from the domain and are never restated here.
//
// Cancellation arrived in S8 as its own capability and atomic workflow; neither S7
// child was widened into a multi-owner operation to accommodate it.

import type { FinanceTransaction, Money, Order, OrderChannel, OrderStatus } from "@warungmeng/domain";
import type { OperationResult } from "@warungmeng/module-system";
import { createCapabilityToken, createOutboundPortToken } from "@warungmeng/module-system";

// ─── Persistence port ─────────────────────────────────────────────────────────

/** The complete caller-planned aggregate before the store assigns its canonical id. */
export type OrderSubmissionRecord = Omit<Order, "id">;

/**
 * The Orders area's narrow window onto persistence.
 *
 * Reads are intentionally raw. SOURCE put filtering and newest-first ordering in
 * its in-memory repository, so changing adapter could silently change visible
 * behavior. `order-read` owns those promises and the port promises no order.
 * Exact-id lookup remains a separate port operation because Admin detail and later
 * cancellation both need one row; forcing either to scan a paged backend collection
 * would make an adapter limitation part of the capability contract. This differs
 * from Finance's removed get-by-id method, which had no production caller.
 *
 * Submission stays a persistence handoff: its caller has already planned prices,
 * totals, order number, channel defaults, timestamps, and the initial event. That
 * is exactly what SOURCE POS and Storefront did. The store assigns only the
 * canonical id and returns the persisted aggregate.
 *
 * `idempotencyKey` is required by the backend target. SOURCE had no durable retry
 * identity and created a duplicate on every repeated call; making the key explicit
 * closes that hole without moving POS/cart/inventory/finance orchestration here.
 * The store is the authoritative replay judge — a child-side pre-read would race.
 *
 * `cancelOrder` is the store's authoritative status write, and it is deliberately
 * narrow: it cancels, and it cannot do anything else. SOURCE published a general
 * `updateStatus(orderId, status)` that accepted `"cancelled"` too, wired straight to
 * the repository — so the whole multi-owner cancellation workflow could be bypassed
 * by one call, flipping a paid order to cancelled/refunded with no stock reversal and
 * outside any transaction. SOURCE's own comment claimed `cancel` was "the single
 * active cancellation command" while that sibling contradicted it, and the invariant
 * survived only because one screen filtered `"cancelled"` out of its button list. A
 * capability is not allowed to depend on a screen for its correctness, so the door
 * does not exist here. DS-B adds the separate `progressOrder` door below, whose
 * target type excludes both `new` and `cancelled`; it can only request one of the
 * four forward statuses.
 *
 * The store computes the transition itself and answers authoritatively, exactly as
 * Finance's writes do: no child-side pre-read, because a read-then-write is both a
 * second judge and a race.
 */
export interface OrdersStorePort {
  listOrders(): Promise<readonly Order[]>;
  getOrderById(id: string): Promise<Order | null>;
  submitOrder(
    idempotencyKey: string,
    record: OrderSubmissionRecord,
  ): Promise<OrderSubmissionCommit>;
  progressOrder(
    orderId: string,
    nextStatus: ForwardOrderStatus,
  ): Promise<OrderProgressionCommit>;
  cancelOrder(orderId: string): Promise<OrderCancellationCommit>;
}

/** The only statuses progression may request. Cancellation is structurally absent. */
export const FORWARD_ORDER_STATUSES = [
  "accepted",
  "preparing",
  "ready",
  "completed",
] as const;

export type ForwardOrderStatus = (typeof FORWARD_ORDER_STATUSES)[number];

/**
 * The store decides and writes one forward transition against its current row.
 *
 * A child-side read would race, so the clock, event id, domain
 * `transitionOrderStatus` call, and commit belong inside the authoritative store
 * operation. `invalid-transition` carries the unchanged row so the caller can
 * report the current status honestly.
 */
export type OrderProgressionCommit =
  | { readonly status: "updated"; readonly order: Order }
  | { readonly status: "not-found" }
  | { readonly status: "invalid-transition"; readonly order: Order };

/**
 * What the store reports back from a cancellation attempt.
 *
 * `invalid-transition` carries the unchanged order so a caller can say *why* it was
 * refused (already cancelled, or completed) instead of showing a bare error, which is
 * the one thing SOURCE's shape got right and is kept.
 */
export type OrderCancellationCommit =
  | { readonly status: "cancelled"; readonly order: Order }
  | { readonly status: "not-found" }
  | { readonly status: "invalid-transition"; readonly order: Order };

export type OrderSubmissionCommit =
  | { readonly status: "created"; readonly order: Order }
  | { readonly status: "replayed"; readonly order: Order }
  | {
      readonly status: "conflict";
      readonly order: Order;
      readonly message: string;
    };

export const ORDERS_STORE_PORT = createOutboundPortToken<OrdersStorePort>("admin.orders.store");

// ─── Read contracts (child: order-read) ───────────────────────────────────────

/** Calendar-day filtering is aligned with Finance and reporting. */
export { DEFAULT_REPORTING_TIME_ZONE as ORDERS_TIME_ZONE } from "@warungmeng/domain";

export interface OrderListFilters {
  readonly search: string;
  readonly status: OrderStatus | null;
  readonly outletId: string | null;
  readonly channel: OrderChannel | null;
  /** Inclusive calendar date in `ORDERS_TIME_ZONE`, or null for no lower bound. */
  readonly dateFrom: string | null;
  /** Inclusive calendar date in `ORDERS_TIME_ZONE`, or null for no upper bound. */
  readonly dateTo: string | null;
}

export const DEFAULT_ORDER_LIST_FILTERS: OrderListFilters = {
  search: "",
  status: null,
  outletId: null,
  channel: null,
  dateFrom: null,
  dateTo: null,
};

export interface OrderCollection {
  readonly orders: readonly Order[];
  readonly totalCount: number;
}

export interface OrderRead {
  listOrders(
    filters?: OrderListFilters,
  ): Promise<OperationResult<OrderCollection>>;
  getOrderById(orderId: string): Promise<OperationResult<Order>>;
}

/** LOGIC §8's shared read capability, consumed later by cancellation and dashboard. */
export const ORDER_READ_ID = "admin.orders.read";
export const ORDER_READ = createCapabilityToken<OrderRead>(ORDER_READ_ID);

// ─── Submission contracts (child: order-submission) ───────────────────────────

export interface SubmitOrderInput {
  /** Stable identity for safe retries; the same key must describe the same order. */
  readonly idempotencyKey: string;
  /** Complete application-planned aggregate; only the canonical id is store-owned. */
  readonly order: OrderSubmissionRecord;
}

export interface OrderSubmissionOutcome {
  readonly order: Order;
  readonly replayed: boolean;
}

export interface OrderSubmission {
  submitOrder(
    input: SubmitOrderInput,
  ): Promise<OperationResult<OrderSubmissionOutcome>>;
}

export const ORDER_SUBMISSION_ID = "admin.orders.order-submission";
export const ORDER_SUBMISSION =
  createCapabilityToken<OrderSubmission>(ORDER_SUBMISSION_ID);

// ─── Progression contracts (child: order-progression) ────────────────────────

export const PROGRESSION_ISSUE = {
  invalidOrderId: "invalid-order-id",
  invalidStatus: "invalid-order-progression-status",
  cancellationForbidden: "order-cancellation-requires-atomic-workflow",
  notFound: "order-not-found",
  invalidTransition: "invalid-order-transition",
  storeFailed: "orders-store-failed",
  noStore: "no-orders-store",
} as const;

export interface ProgressOrderInput {
  readonly orderId: string;
  readonly nextStatus: ForwardOrderStatus;
}

export interface OrderProgressionOutcome {
  readonly order: Order;
}

export interface OrderProgression {
  progressOrder(
    input: ProgressOrderInput,
  ): Promise<OperationResult<OrderProgressionOutcome>>;
}

export const ORDER_PROGRESSION_ID = "admin.orders.order-progression";
export const ORDER_PROGRESSION =
  createCapabilityToken<OrderProgression>(ORDER_PROGRESSION_ID);

// ─── Cancellation contracts (child: order-cancellation) ───────────────────────

export const CANCELLATION_ISSUE = {
  invalidOrderId: "invalid-order-id",
  notFound: "order-not-found",
  invalidTransition: "order-not-cancellable",
  alreadyCancelled: "order-already-cancelled",
  storeFailed: "orders-store-failed",
  noStore: "no-orders-store",
  reversalFailed: "stock-reversal-failed",
  atomicFailed: "atomic-operation-failed",
} as const;

/**
 * What a completed cancellation actually did, across all three owners.
 *
 * `stockReturned` and `refundOwed` are reported SEPARATELY and on purpose. This is
 * the whole of tech-debt D18: SOURCE decided whether to return stock by asking the
 * FINANCE projection — `projectRefund(order).length > 0` — which reduces to "was this
 * order paid", because the domain only settles `paid → refunded` on cancellation. A
 * money fact was answering a stock question. The consequence was silent and
 * one-directional: an UNPAID order that had consumed stock was cancelled and never
 * got the stock back, so inventory drifted permanently low, which is what raises
 * false low-stock warnings and drives over-ordering.
 *
 * The owner decided on 2026-07-31 to return stock whenever it was actually deducted.
 * So the reversal is now attempted for every cancellation and the reversal capability
 * — which already knows authoritatively whether this order consumed anything — is the
 * only judge of whether there is stock to give back. The refund projection is still
 * produced, because a cancelled paid order really does owe money, but it decides
 * nothing. It is an output, never a gate.
 *
 * `stockAlreadyReturned` and `refundOwed` let a caller tell the four real endings
 * apart — returned now, returned earlier, nothing to return, and money owed — where
 * SOURCE had a single boolean that meant "was paid" and was displayed as though it
 * meant "stock came back".
 */
export interface OrderCancellationOutcome {
  readonly order: Order;
  /** True when this call wrote reversal rows; false when there was nothing to return. */
  readonly stockReturned: boolean;
  /** True when the stock had already been returned by an earlier attempt. */
  readonly stockAlreadyReturned: boolean;
  /** Derived from the settled order. Reporting only — it never gates the reversal. */
  readonly refundOwed: boolean;
  readonly refundTotal: Money;
  readonly refundTransactions: readonly FinanceTransaction[];
}

export interface OrderCancellation {
  cancelOrder(orderId: string): Promise<OperationResult<OrderCancellationOutcome>>;
}

/** LOGIC §8 names this capability `admin.orders.cancel`, not the child id. */
export const ORDER_CANCEL_ID = "admin.orders.cancel";
export const ORDER_CANCEL = createCapabilityToken<OrderCancellation>(ORDER_CANCEL_ID);

export const ORDER_CANCELLATION_CHILD_ID = "admin.orders.order-cancellation";
