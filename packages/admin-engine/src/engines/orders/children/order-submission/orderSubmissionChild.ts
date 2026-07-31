// packages/admin-engine/src/engines/orders/children/order-submission/orderSubmissionChild.ts
//
// The narrow order persistence handoff required by later POS checkout. This child
// validates a complete planned aggregate and submits it idempotently; it does not
// calculate prices, consume stock, record Finance rows, or own cancellation.

import type { Money } from "@warungmeng/domain";
import type { LogicChildContext, OperationIssue, OperationResult } from "@warungmeng/module-system";
import {
  defineLogicChild,
  operationDegraded,
  operationFailure,
  operationIssue,
  operationSuccess,
  severityForCode,
} from "@warungmeng/module-system";
import type {
  OrderSubmission,
  OrderSubmissionOutcome,
  OrdersStorePort,
  SubmitOrderInput,
} from "../../ordersContracts";
import {
  ORDERS_STORE_PORT,
  ORDER_SUBMISSION,
  ORDER_SUBMISSION_ID,
} from "../../ordersContracts";
import { ORDERS_ENGINE_ID } from "../../ordersEngine";

const NO_STORE = "no-orders-store";
const STORE_FAILED = "orders-store-failed";
const SUBMISSION_REPLAYED = "order-submission-replayed";
const IDEMPOTENCY_CONFLICT = "order-idempotency-conflict";

function issue(code: string, message: string, subject: string): OperationIssue {
  return operationIssue(code, message, subject);
}

function validateText(
  value: string,
  path: string,
  issues: OperationIssue[],
): void {
  if (value.trim().length === 0) {
    issues.push(issue("order-field-required", `${path} is required.`, path));
  }
}

function validateTimestamp(
  value: string,
  path: string,
  issues: OperationIssue[],
): void {
  if (!Number.isFinite(Date.parse(value))) {
    issues.push(issue("invalid-order-timestamp", `${path} must be an ISO timestamp.`, path));
  }
}

function validateMoney(
  value: Money,
  path: string,
  issues: OperationIssue[],
): void {
  if (value.currency !== "IDR" || !Number.isInteger(value.amount) || value.amount < 0) {
    issues.push(
      issue(
        "invalid-order-money",
        `${path} must be a non-negative whole IDR amount.`,
        path,
      ),
    );
  }
}

/**
 * Validates invariants shared by both SOURCE submitters before any persistence.
 * Application-specific choices stay with their owners: POS and Storefront still
 * choose channel, fulfillment, payment, prices, notes, clock, and number.
 */
export function validateOrderSubmission(
  input: SubmitOrderInput,
): readonly OperationIssue[] {
  const issues: OperationIssue[] = [];
  const { order } = input;

  validateText(input.idempotencyKey, "idempotencyKey", issues);
  validateText(order.orderNumber, "order.orderNumber", issues);
  validateText(order.outletId, "order.outletId", issues);
  validateText(order.outletName, "order.outletName", issues);
  validateTimestamp(order.createdAt, "order.createdAt", issues);
  validateTimestamp(order.updatedAt, "order.updatedAt", issues);

  if (order.items.length === 0) {
    issues.push(issue("empty-order", "An order must contain at least one item.", "order.items"));
  }

  const itemIds = new Set<string>();
  order.items.forEach((item, index) => {
    const path = `order.items.${index}`;
    validateText(item.id, `${path}.id`, issues);
    validateText(item.menuItemId, `${path}.menuItemId`, issues);
    validateText(item.name, `${path}.name`, issues);
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      issues.push(
        issue(
          "invalid-order-quantity",
          `${path}.quantity must be a positive whole number.`,
          `${path}.quantity`,
        ),
      );
    }
    validateMoney(item.unitPrice, `${path}.unitPrice`, issues);
    validateMoney(item.lineTotal, `${path}.lineTotal`, issues);
    item.variantSelections.forEach((selection, selectionIndex) =>
      validateMoney(
        selection.priceAdjustment,
        `${path}.variantSelections.${selectionIndex}.priceAdjustment`,
        issues,
      ),
    );

    if (itemIds.has(item.id)) {
      issues.push(issue("duplicate-order-item-id", `Duplicate order item id ${item.id}.`, item.id));
    }
    itemIds.add(item.id);
  });

  validateMoney(order.totals.subtotal, "order.totals.subtotal", issues);
  validateMoney(order.totals.discount, "order.totals.discount", issues);
  validateMoney(order.totals.tax, "order.totals.tax", issues);
  validateMoney(order.totals.serviceCharge, "order.totals.serviceCharge", issues);
  validateMoney(order.totals.rounding, "order.totals.rounding", issues);
  validateMoney(order.totals.total, "order.totals.total", issues);

  if (order.events.length === 0) {
    issues.push(
      issue("missing-order-event", "An order must record its initial status event.", "order.events"),
    );
  }
  order.events.forEach((event, index) => {
    const path = `order.events.${index}`;
    validateText(event.id, `${path}.id`, issues);
    validateTimestamp(event.occurredAt, `${path}.occurredAt`, issues);
  });

  const initialEvent = order.events[0];
  if (order.status !== "new") {
    issues.push(
      issue(
        "invalid-initial-order-status",
        'A submitted order must start with status "new".',
        "order.status",
      ),
    );
  }
  if (initialEvent !== undefined && initialEvent.status !== order.status) {
    issues.push(
      issue(
        "initial-event-status-mismatch",
        "The initial event status must match the order status.",
        "order.events.0.status",
      ),
    );
  }
  if (initialEvent !== undefined && initialEvent.occurredAt !== order.createdAt) {
    issues.push(
      issue(
        "initial-event-time-mismatch",
        "The initial event must occur when the order was created.",
        "order.events.0.occurredAt",
      ),
    );
  }
  if (order.updatedAt !== order.createdAt) {
    issues.push(
      issue(
        "initial-update-time-mismatch",
        "A new order's updatedAt must equal its createdAt.",
        "order.updatedAt",
      ),
    );
  }

  return issues;
}

function noStore(): OperationResult<OrderSubmissionOutcome> {
  return operationFailure("unsatisfied-dependency", [
    operationIssue(
      NO_STORE,
      "No orders store is connected, so the order cannot be submitted.",
      "submitOrder",
    ),
  ]);
}

function storeFailed(error: unknown): OperationResult<OrderSubmissionOutcome> {
  return operationFailure("failed", [
    operationIssue(
      STORE_FAILED,
      error instanceof Error ? error.message : "The orders store failed.",
      "submitOrder",
    ),
  ]);
}

function orderSubmissionOverStore(store: OrdersStorePort): OrderSubmission {
  return {
    async submitOrder(input: SubmitOrderInput): Promise<OperationResult<OrderSubmissionOutcome>> {
      const validationIssues = validateOrderSubmission(input);
      if (validationIssues.length > 0) {
        return operationFailure("invalid-input", validationIssues);
      }

      let commit: Awaited<ReturnType<OrdersStorePort["submitOrder"]>>;
      try {
        commit = await store.submitOrder(input.idempotencyKey.trim(), input.order);
      } catch (error) {
        return storeFailed(error);
      }

      if (commit.status === "conflict") {
        return operationFailure("conflict", [
          operationIssue(IDEMPOTENCY_CONFLICT, commit.message, input.idempotencyKey, {
            existingOrderId: commit.order.id,
          }),
        ]);
      }

      const outcome: OrderSubmissionOutcome = {
        order: commit.order,
        replayed: commit.status === "replayed",
      };
      return commit.status === "replayed"
        ? operationDegraded(outcome, [
            operationIssue(
              SUBMISSION_REPLAYED,
              `Order ${commit.order.orderNumber} was already submitted; nothing was written.`,
              commit.order.id,
            ),
          ])
        : operationSuccess(outcome);
    },
  };
}

function orderSubmissionWithoutStore(): OrderSubmission {
  return { submitOrder: async () => noStore() };
}

export function createOrderSubmission(context: LogicChildContext): OrderSubmission {
  const store = context.ports.resolve(ORDERS_STORE_PORT);

  if (store === undefined) {
    context.diagnostics.report({
      code: "missing-dependency",
      severity: severityForCode("missing-dependency"),
      message:
        "No orders store was supplied to the Orders area, so submissions return a normalized " +
        "failure. The capability is published and callers stay working.",
      childId: context.childId,
      engineId: context.parentId,
      source: "orderSubmissionChild",
    });
  }

  const capability =
    store === undefined ? orderSubmissionWithoutStore() : orderSubmissionOverStore(store);
  context.capabilities.provide(ORDER_SUBMISSION, capability);
  return capability;
}

export default defineLogicChild<OrderSubmission>({
  id: ORDER_SUBMISSION_ID,
  parentId: ORDERS_ENGINE_ID,
  provides: [ORDER_SUBMISSION_ID],
  requires: [],
  create: createOrderSubmission,
});
