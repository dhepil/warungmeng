// packages/admin-engine/src/engines/orders/children/order-read/orderReadChild.ts
//
// Admin order collection and exact-id reading (capability `admin.orders.read`).
// Filtering and total ordering are engine promises, not adapter accidents.

import type { Order } from "@warungmeng/domain";
import { getReportingDateKey } from "@warungmeng/domain";
import type { LogicChildContext, OperationResult } from "@warungmeng/module-system";
import {
  defineLogicChild,
  operationFailure,
  operationIssue,
  operationSuccess,
  severityForCode,
} from "@warungmeng/module-system";
import type {
  OrderCollection,
  OrderListFilters,
  OrderRead,
  OrdersStorePort,
} from "../../ordersContracts";
import {
  DEFAULT_ORDER_LIST_FILTERS,
  ORDERS_STORE_PORT,
  ORDERS_TIME_ZONE,
  ORDER_READ,
  ORDER_READ_ID,
} from "../../ordersContracts";
import { ORDERS_ENGINE_ID } from "../../ordersEngine";

const NO_STORE = "no-orders-store";
const STORE_FAILED = "orders-store-failed";
const INVALID_QUERY = "invalid-order-query";
const INVALID_ORDER_ID = "invalid-order-id";
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function assertDateKey(value: string): void {
  if (!DATE_KEY_PATTERN.test(value)) {
    throw new RangeError(`Invalid order date: ${value}`);
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new RangeError(`Invalid order date: ${value}`);
  }
}

function validateFilters(filters: OrderListFilters): void {
  if (filters.dateFrom !== null) assertDateKey(filters.dateFrom);
  if (filters.dateTo !== null) assertDateKey(filters.dateTo);
  if (
    filters.dateFrom !== null &&
    filters.dateTo !== null &&
    filters.dateFrom > filters.dateTo
  ) {
    throw new RangeError("Order dateFrom must not be after dateTo");
  }
}

/** Newest first, then by id so equal creation times still have a total order. */
export function sortOrders(orders: readonly Order[]): readonly Order[] {
  return [...orders].sort(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
  );
}

/**
 * SOURCE's search and six AND-combined dimensions, with one calendar correction.
 *
 * SOURCE expanded date-only filters as UTC while displaying timestamps in machine
 * local time. Finance and reporting already agree on Jakarta, so Orders uses the
 * same declared calendar instead of maintaining a third definition of a day.
 */
export function filterOrders(
  orders: readonly Order[],
  filters: OrderListFilters = DEFAULT_ORDER_LIST_FILTERS,
): readonly Order[] {
  validateFilters(filters);
  const search = filters.search.trim().toLocaleLowerCase();

  return orders.filter((order) => {
    const matchesSearch =
      search.length === 0 ||
      order.orderNumber.toLocaleLowerCase().includes(search) ||
      order.customer?.name.toLocaleLowerCase().includes(search) === true ||
      order.customer?.phone.toLocaleLowerCase().includes(search) === true ||
      order.items.some((item) => item.name.toLocaleLowerCase().includes(search));
    const matchesStatus = filters.status === null || order.status === filters.status;
    const matchesOutlet = filters.outletId === null || order.outletId === filters.outletId;
    const matchesChannel = filters.channel === null || order.channel === filters.channel;

    const needsDate = filters.dateFrom !== null || filters.dateTo !== null;
    const dateKey = needsDate
      ? getReportingDateKey(order.createdAt, ORDERS_TIME_ZONE)
      : null;
    const matchesDate =
      !needsDate ||
      (dateKey !== null &&
        (filters.dateFrom === null || dateKey >= filters.dateFrom) &&
        (filters.dateTo === null || dateKey <= filters.dateTo));

    return matchesSearch && matchesStatus && matchesOutlet && matchesChannel && matchesDate;
  });
}

export function queryOrders(
  orders: readonly Order[],
  filters: OrderListFilters = DEFAULT_ORDER_LIST_FILTERS,
): OrderCollection {
  const selected = sortOrders(filterOrders(orders, filters));
  return { orders: selected, totalCount: selected.length };
}

function noStore<TValue>(operation: string): OperationResult<TValue> {
  return operationFailure("unsatisfied-dependency", [
    operationIssue(
      NO_STORE,
      "No orders store is connected, so orders cannot be read.",
      operation,
    ),
  ]);
}

function storeFailed<TValue>(operation: string, error: unknown): OperationResult<TValue> {
  return operationFailure("failed", [
    operationIssue(
      STORE_FAILED,
      error instanceof Error ? error.message : "The orders store failed.",
      operation,
    ),
  ]);
}

function orderReadOverStore(store: OrdersStorePort): OrderRead {
  return {
    async listOrders(
      filters: OrderListFilters = DEFAULT_ORDER_LIST_FILTERS,
    ): Promise<OperationResult<OrderCollection>> {
      try {
        validateFilters(filters);
      } catch (error) {
        return operationFailure("invalid-input", [
          operationIssue(
            INVALID_QUERY,
            error instanceof Error ? error.message : "The order query is invalid.",
            "listOrders",
          ),
        ]);
      }

      try {
        return operationSuccess(queryOrders(await store.listOrders(), filters));
      } catch (error) {
        return storeFailed("listOrders", error);
      }
    },

    async getOrderById(orderId: string): Promise<OperationResult<Order>> {
      if (orderId.trim().length === 0) {
        return operationFailure("invalid-input", [
          operationIssue(INVALID_ORDER_ID, "Order id is required.", "getOrderById"),
        ]);
      }

      try {
        const order = (await store.listOrders()).find((candidate) => candidate.id === orderId);
        return order === undefined
          ? operationFailure("not-found", [
              operationIssue("order-not-found", `Order ${orderId} was not found.`, orderId),
            ])
          : operationSuccess(order);
      } catch (error) {
        return storeFailed("getOrderById", error);
      }
    },
  };
}

function orderReadWithoutStore(): OrderRead {
  return {
    listOrders: async () => noStore("listOrders"),
    getOrderById: async () => noStore("getOrderById"),
  };
}

export function createOrderRead(context: LogicChildContext): OrderRead {
  const store = context.ports.resolve(ORDERS_STORE_PORT);

  if (store === undefined) {
    context.diagnostics.report({
      code: "missing-dependency",
      severity: severityForCode("missing-dependency"),
      message:
        "No orders store was supplied to the Orders area, so reads return a normalized " +
        "failure. The capability is published and callers stay working.",
      childId: context.childId,
      engineId: context.parentId,
      source: "orderReadChild",
    });
  }

  const capability = store === undefined ? orderReadWithoutStore() : orderReadOverStore(store);
  context.capabilities.provide(ORDER_READ, capability);
  return capability;
}

export default defineLogicChild<OrderRead>({
  id: "admin.orders.order-read",
  parentId: ORDERS_ENGINE_ID,
  provides: [ORDER_READ_ID],
  requires: [],
  create: createOrderRead,
});
