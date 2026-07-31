// packages/admin-engine/src/engines/orders/ordersContracts.ts
//
// Stable contracts owned by the Orders area: one injected store, the read and
// submission capabilities built in S7, and the area's non-domain query/outcome
// shapes. `Order` and its nested vocabulary come from the domain and are never
// restated here.
//
// Cancellation is deliberately absent. Slice 8 adds its contract and atomic
// workflow without widening either S7 child into a multi-owner operation.

import type { Order, OrderChannel, OrderStatus } from "@warungmeng/domain";
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
 */
export interface OrdersStorePort {
  listOrders(): Promise<readonly Order[]>;
  getOrderById(id: string): Promise<Order | null>;
  submitOrder(
    idempotencyKey: string,
    record: OrderSubmissionRecord,
  ): Promise<OrderSubmissionCommit>;
}

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
