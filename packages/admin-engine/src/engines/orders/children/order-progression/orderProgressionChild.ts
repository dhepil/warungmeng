// packages/admin-engine/src/engines/orders/children/order-progression/orderProgressionChild.ts
//
// Forward-only Admin order progression. Cancellation is structurally excluded
// from both the capability and store port target type, then rejected again at the
// runtime boundary before the authoritative store can be called.

import type { LogicChildContext, OperationResult } from "@warungmeng/module-system";
import {
  defineLogicChild,
  operationFailure,
  operationIssue,
  operationSuccess,
  severityForCode,
} from "@warungmeng/module-system";
import type {
  ForwardOrderStatus,
  OrderProgression,
  OrderProgressionOutcome,
  OrdersStorePort,
  ProgressOrderInput,
} from "../../ordersContracts";
import {
  FORWARD_ORDER_STATUSES,
  ORDERS_STORE_PORT,
  ORDER_PROGRESSION,
  ORDER_PROGRESSION_ID,
  ORDER_READ_ID,
  PROGRESSION_ISSUE,
} from "../../ordersContracts";
import { ORDERS_ENGINE_ID } from "../../ordersEngine";

function noStore(): OperationResult<OrderProgressionOutcome> {
  return operationFailure("unsatisfied-dependency", [
    operationIssue(
      PROGRESSION_ISSUE.noStore,
      "No orders store is connected, so the order cannot progress.",
      "progressOrder",
    ),
  ]);
}

function isForwardOrderStatus(value: unknown): value is ForwardOrderStatus {
  return (
    typeof value === "string" &&
    (FORWARD_ORDER_STATUSES as readonly string[]).includes(value)
  );
}

function orderProgressionOverStore(store: OrdersStorePort): OrderProgression {
  return {
    async progressOrder(
      input: ProgressOrderInput,
    ): Promise<OperationResult<OrderProgressionOutcome>> {
      const unsafeInput = input as unknown as {
        readonly orderId?: unknown;
        readonly nextStatus?: unknown;
      } | null;
      const orderId =
        typeof unsafeInput?.orderId === "string" ? unsafeInput.orderId.trim() : "";
      const nextStatus = unsafeInput?.nextStatus;

      if (orderId.length === 0) {
        return operationFailure("invalid-input", [
          operationIssue(
            PROGRESSION_ISSUE.invalidOrderId,
            "An order id is required.",
            "progressOrder",
          ),
        ]);
      }

      // This guard is deliberately BEFORE the store call. The domain transition
      // machine permits cancellation and refunds paid orders, so passing the value
      // through would recreate S8's unsafe general status-setter door.
      if (nextStatus === "cancelled") {
        return operationFailure("invalid-input", [
          operationIssue(
            PROGRESSION_ISSUE.cancellationForbidden,
            "Cancellation must use the atomic order-cancellation workflow.",
            orderId,
          ),
        ]);
      }

      if (!isForwardOrderStatus(nextStatus)) {
        return operationFailure("invalid-input", [
          operationIssue(
            PROGRESSION_ISSUE.invalidStatus,
            "An order may progress only to accepted, preparing, ready, or completed.",
            orderId,
            { nextStatus: typeof nextStatus === "string" ? nextStatus : null },
          ),
        ]);
      }

      let commit: Awaited<ReturnType<OrdersStorePort["progressOrder"]>>;
      try {
        // One call decides against the store's current row and commits. There is
        // no child-side read: that would create a second judge and a race.
        commit = await store.progressOrder(orderId, nextStatus);
      } catch (error) {
        return operationFailure("failed", [
          operationIssue(
            PROGRESSION_ISSUE.storeFailed,
            error instanceof Error ? error.message : "The orders store failed.",
            orderId,
          ),
        ]);
      }

      if (commit.status === "not-found") {
        return operationFailure("not-found", [
          operationIssue(
            PROGRESSION_ISSUE.notFound,
            `Order ${orderId} was not found.`,
            orderId,
          ),
        ]);
      }

      if (commit.status === "invalid-transition") {
        return operationFailure("conflict", [
          operationIssue(
            PROGRESSION_ISSUE.invalidTransition,
            `Order ${orderId} cannot move from ${commit.order.status} to ${nextStatus}.`,
            orderId,
            { currentStatus: commit.order.status, nextStatus },
          ),
        ]);
      }

      return operationSuccess({ order: commit.order });
    },
  };
}

function orderProgressionWithoutStore(): OrderProgression {
  return { progressOrder: async () => noStore() };
}

export function createOrderProgression(context: LogicChildContext): OrderProgression {
  const store = context.ports.resolve(ORDERS_STORE_PORT);

  if (store === undefined) {
    context.diagnostics.report({
      code: "missing-dependency",
      severity: severityForCode("missing-dependency"),
      message:
        "No orders store was supplied to the Orders area, so progression returns a normalized " +
        "failure. The capability is published and callers stay working.",
      childId: context.childId,
      engineId: context.parentId,
      source: "orderProgressionChild",
    });
  }

  const capability =
    store === undefined ? orderProgressionWithoutStore() : orderProgressionOverStore(store);
  context.capabilities.provide(ORDER_PROGRESSION, capability);
  return capability;
}

export default defineLogicChild<OrderProgression>({
  id: ORDER_PROGRESSION_ID,
  parentId: ORDERS_ENGINE_ID,
  provides: [ORDER_PROGRESSION_ID],
  // LOGIC §8 requires Orders read to be alive before a lifecycle writer is safe
  // to publish. It is intentionally not called: the store's write remains the one
  // authoritative transition judge, so there is no read-then-write race.
  requires: [ORDER_READ_ID],
  create: createOrderProgression,
});
