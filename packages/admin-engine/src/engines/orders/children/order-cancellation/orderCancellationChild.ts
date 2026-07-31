// packages/admin-engine/src/engines/orders/children/order-cancellation/orderCancellationChild.ts
//
// Admin order cancellation (capability `admin.orders.cancel` — the id LOGIC §8
// names, which is why this is the one child in the area whose capability id is not
// its child id).
//
// This is the first child in the port to require the atomic capability, so it is
// the first place the S1 seam is exercised for real rather than declared. The
// sequence itself lives in `cancelOrderAtomically.ts`; this file owns the wiring:
// resolving four dependencies, opening the boundary, and converting a rollback back
// into a normalized failure so the capability returns rather than throws (LOGIC §5).

import type { LogicChildContext, OperationResult } from "@warungmeng/module-system";
import {
  defineLogicChild,
  operationFailure,
  operationIssue,
  severityForCode,
} from "@warungmeng/module-system";
import {
  ADMIN_ATOMIC_OPERATION,
  ADMIN_ATOMIC_OPERATION_ID,
} from "../../../../shared/atomicOperationPort";
import type { AtomicOperationPort } from "../../../../shared/atomicOperationPort";
import { REFUND_PROJECTION, REFUND_PROJECTION_ID } from "../../../finance/financeContracts";
import type { RefundProjecting } from "../../../finance/financeContracts";
import { STOCK_REVERSAL, STOCK_REVERSAL_ID } from "../../../inventory/inventoryContracts";
import type { StockReversal } from "../../../inventory/inventoryContracts";
import type {
  OrderCancellation,
  OrderCancellationOutcome,
  OrdersStorePort,
} from "../../ordersContracts";
import {
  CANCELLATION_ISSUE,
  ORDERS_STORE_PORT,
  ORDER_CANCEL,
  ORDER_CANCELLATION_CHILD_ID,
  ORDER_READ_ID,
} from "../../ordersContracts";
import { ORDERS_ENGINE_ID } from "../../ordersEngine";
import { CancellationRollback, cancelOrderAtomically } from "./cancelOrderAtomically";

function noStore(): OperationResult<never> {
  return operationFailure("unsatisfied-dependency", [
    operationIssue(
      CANCELLATION_ISSUE.noStore,
      "No orders store was supplied, so no order can be cancelled.",
    ),
  ]);
}

function invalidOrderId(): OperationResult<never> {
  return operationFailure("invalid-input", [
    operationIssue(CANCELLATION_ISSUE.invalidOrderId, "An order id is required."),
  ]);
}

interface CancellationDependencies {
  readonly store: OrdersStorePort;
  readonly reversal: StockReversal;
  readonly refunds: RefundProjecting;
  readonly atomic: AtomicOperationPort;
}

function orderCancellationOver(
  dependencies: CancellationDependencies,
): OrderCancellation {
  return {
    async cancelOrder(orderId) {
      if (typeof orderId !== "string" || orderId.trim() === "") {
        return invalidOrderId();
      }

      try {
        // Everything the workflow writes happens inside this one call, so a
        // rollback covers all three owners together. The child does not claim
        // atomicity itself — only the supplied port can promise that — it makes the
        // whole workflow expressible as one unit, the same way S5's `commitMovements`
        // made a multi-row consumption one call.
        return await dependencies.atomic.execute<OperationResult<OrderCancellationOutcome>>(
          () =>
            cancelOrderAtomically(
              {
                store: dependencies.store,
                reversal: dependencies.reversal,
                refunds: dependencies.refunds,
              },
              orderId.trim(),
            ),
        );
      } catch (error) {
        // A rollback carries its own explanation, so it is reported as itself
        // rather than flattened into a generic infrastructure error. SOURCE
        // collapsed every ending into one `failed` outcome with a hardcoded
        // `retryable: true` and `dataChanged: false` — literals, never computed —
        // so a caller could not tell a rolled-back cancellation from a dead
        // backend, and was told to retry either way.
        if (error instanceof CancellationRollback) {
          return operationFailure("failed", error.issues);
        }

        return operationFailure("failed", [
          operationIssue(
            CANCELLATION_ISSUE.atomicFailed,
            `The atomic boundary failed while cancelling ${orderId}, so nothing was committed.`,
            orderId,
            { cause: error instanceof Error ? error.message : String(error) },
          ),
        ]);
      }
    },
  };
}

function orderCancellationWithoutStore(): OrderCancellation {
  return { cancelOrder: async () => noStore() };
}

export function createOrderCancellation(context: LogicChildContext): OrderCancellation {
  const store = context.ports.resolve(ORDERS_STORE_PORT);
  const reversal = context.capabilities.resolve(STOCK_REVERSAL);
  const refunds = context.capabilities.resolve(REFUND_PROJECTION);
  const atomic = context.capabilities.resolve(ADMIN_ATOMIC_OPERATION);

  if (store === undefined) {
    context.diagnostics.report({
      code: "missing-dependency",
      severity: severityForCode("missing-dependency"),
      message:
        "No orders store was supplied to the Orders area, so cancellation returns a normalized " +
        "failure. The capability is published and callers stay working.",
      childId: context.childId,
      engineId: context.parentId,
      source: "orderCancellationChild",
    });
  }

  // All three capabilities are in `requires`, so the dependency graph will not
  // create this child unless every one of them was published — an unavailable
  // resolution here is a contradiction rather than a state to design for, exactly
  // as in `hpp-calculation`. Note the asymmetry that keeps recurring: a missing
  // required CAPABILITY means no child; a missing injected PORT is legal and the
  // child still publishes and answers honestly.
  const ready =
    store !== undefined &&
    reversal.status === "available" &&
    refunds.status === "available" &&
    atomic.status === "available";

  const capability = ready
    ? orderCancellationOver({
        store,
        reversal: reversal.value,
        refunds: refunds.value,
        atomic: atomic.value,
      })
    : orderCancellationWithoutStore();

  context.capabilities.provide(ORDER_CANCEL, capability);

  return capability;
}

export default defineLogicChild<OrderCancellation>({
  id: ORDER_CANCELLATION_CHILD_ID,
  parentId: ORDERS_ENGINE_ID,
  // The capability id LOGIC §8 states, not the child id — the one place in the
  // area where those differ.
  provides: [ORDER_CANCEL.id],
  // Exactly the four LOGIC §8 lists. Three are resolved and called.
  //
  // `admin.orders.read` is declared and NOT called, deliberately: the store's
  // `cancelOrder` is the authoritative judge of whether this order exists and may
  // be cancelled, and reading first would be a second judge and a race — the rule
  // S6 and S7 both settled. The declaration is kept because LOGIC §8 states it and
  // the doc is the structural authority (and because it is not inert: it keeps
  // cancellation out of a runtime whose Orders read capability never came up, which
  // would be an Orders area too broken to cancel through). Recorded as D29 rather
  // than quietly dropped or quietly satisfied with a pointless call.
  requires: [
    ORDER_READ_ID,
    STOCK_REVERSAL_ID,
    REFUND_PROJECTION_ID,
    ADMIN_ATOMIC_OPERATION_ID,
  ],
  create: createOrderCancellation,
});
