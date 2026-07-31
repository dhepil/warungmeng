// packages/admin-engine/src/engines/orders/children/order-cancellation/cancelOrderAtomically.ts
//
// The multi-owner cancellation workflow (LOGIC §10), kept separate from the child
// that publishes it so the sequence can be read — and tested — without a runtime.
//
// LOGIC §10 states the order:
//
//   validate order → cancel order → reverse inventory → project finance refund
//     → commit as one operation
//   any failure → rollback all affected owners → return normalized failure
//
// Everything here runs INSIDE the caller's atomic boundary. That has one
// consequence which drives the whole design: rollback is triggered by a THROW.
// A normalized failure returned from inside the boundary would be a value, and the
// boundary would commit it. So the two kinds of ending are strictly separated:
//
//   * A business refusal (not-found, not cancellable) wrote nothing, so it must NOT
//     roll back — it is returned as a value and reported honestly.
//   * A real failure after the write must throw, so every owner is rolled back.
//
// Getting that backwards in either direction is the failure mode this file exists
// to prevent: throw on a refusal and a healthy runtime looks broken; return on a
// genuine failure and a cancelled order keeps its stock deducted.

import type { OperationIssue, OperationResult } from "@warungmeng/module-system";
import {
  isOperationUsable,
  operationDegraded,
  operationFailure,
  operationIssue,
  operationSuccess,
} from "@warungmeng/module-system";
import { CONSUMPTION_ISSUE } from "../../../inventory/inventoryContracts";
import type { StockReversal } from "../../../inventory/inventoryContracts";
import type { RefundProjecting } from "../../../finance/financeContracts";
import type {
  OrderCancellationOutcome,
  OrdersStorePort,
} from "../../ordersContracts";
import { CANCELLATION_ISSUE } from "../../ordersContracts";

/**
 * Thrown to force the atomic boundary to roll back. Never escapes the child: the
 * caller catches it and converts it to a normalized failure, so the capability
 * still honours LOGIC §5 and returns rather than throws.
 */
export class CancellationRollback extends Error {
  readonly issues: readonly OperationIssue[];

  constructor(issues: readonly OperationIssue[], cause?: unknown) {
    super(issues[0]?.message ?? "Order cancellation was rolled back");
    this.name = "CancellationRollback";
    this.issues = issues;
    if (cause !== undefined) this.cause = cause;
  }
}

export interface CancellationOwners {
  readonly store: OrdersStorePort;
  readonly reversal: StockReversal;
  readonly refunds: RefundProjecting;
}

/**
 * Reversal endings that are NOT failures of the cancellation.
 *
 * This is where tech-debt D18 is actually resolved, so it is worth being explicit.
 * The reversal is now attempted for EVERY cancellation, paid or not, because the
 * reversal child is the only owner that authoritatively knows whether this order
 * consumed anything. Two of its endings mean "there was correctly nothing to do":
 *
 *   * `order-never-consumed` — the order never took stock. The reversal child
 *     reports this as a failure, and it is right to: for a caller asking "undo this
 *     consumption", nothing to undo IS a failure. But for cancellation it is an
 *     ordinary, expected outcome — most unpaid or never-started orders will hit it.
 *     Treating it as fatal would roll back every such cancellation and make the
 *     order impossible to cancel at all.
 *   * `order-already-reversed` — a previous attempt returned the stock. That is a
 *     replay, already reported as degraded, and must not write twice.
 *
 * Every OTHER reversal failure — the store threw, a balance went negative, the port
 * was missing — is a genuine failure of a multi-owner workflow and must roll the
 * cancellation back, because a cancelled order whose stock silently stayed deducted
 * is exactly the drift the owner asked to eliminate.
 */
function isBenignReversalEnding(result: OperationResult<unknown>): boolean {
  return (
    result.status === "failure" &&
    result.reason === "not-found" &&
    result.issues.some((issue) => issue.code === CONSUMPTION_ISSUE.neverConsumed)
  );
}

/**
 * Runs the LOGIC §10 sequence. The caller supplies the atomic boundary; this
 * function assumes it is already inside one.
 *
 * Returns a refusal value for endings that wrote nothing, and throws
 * `CancellationRollback` for anything that must undo the write.
 */
export async function cancelOrderAtomically(
  owners: CancellationOwners,
  orderId: string,
): Promise<OperationResult<OrderCancellationOutcome>> {
  // ── validate order ─────────────────────────────────────────────────────────
  // The store is the judge, exactly as in Finance's writes: it computes the
  // transition and answers authoritatively. SOURCE also wrote first and read the
  // result, and that part was right — a child-side pre-read would be a second judge
  // and a race. What SOURCE lacked was any distinction between the endings below.
  let commit: Awaited<ReturnType<OrdersStorePort["cancelOrder"]>>;
  try {
    commit = await owners.store.cancelOrder(orderId);
  } catch (error) {
    throw new CancellationRollback(
      [
        operationIssue(
          CANCELLATION_ISSUE.storeFailed,
          `The orders store could not cancel ${orderId}.`,
          orderId,
          { cause: error instanceof Error ? error.message : String(error) },
        ),
      ],
      error,
    );
  }

  // ── cancel order ───────────────────────────────────────────────────────────
  if (commit.status === "not-found") {
    return operationFailure("not-found", [
      operationIssue(
        CANCELLATION_ISSUE.notFound,
        `No order with id ${orderId} exists.`,
        orderId,
      ),
    ]);
  }

  if (commit.status === "invalid-transition") {
    // Kept distinguishable rather than collapsed into one error. An order that is
    // already cancelled is a benign repeat — the operator pressed twice, and the
    // work is done. A completed order is a real refusal. SOURCE showed one generic
    // warning for both.
    const alreadyCancelled = commit.order.status === "cancelled";
    return operationFailure("conflict", [
      operationIssue(
        alreadyCancelled
          ? CANCELLATION_ISSUE.alreadyCancelled
          : CANCELLATION_ISSUE.invalidTransition,
        alreadyCancelled
          ? `Order ${commit.order.orderNumber} is already cancelled.`
          : `Order ${commit.order.orderNumber} cannot be cancelled from status ${commit.order.status}.`,
        commit.order.id,
        { status: commit.order.status },
      ),
    ]);
  }

  const cancelled = commit.order;

  // ── reverse inventory ──────────────────────────────────────────────────────
  // Attempted unconditionally. See `isBenignReversalEnding` for why this is the
  // resolution of D18 and not merely a reordering.
  //
  // Note the ordering dependency, which is not incidental: the reversal stamps its
  // rows from `order.updatedAt`, so the order must already carry its cancellation
  // timestamp when this runs. LOGIC §10's sequence and the reversal child's clock
  // agree, and they have to.
  let reversalResult: OperationResult<{ readonly replayed: boolean }>;
  try {
    reversalResult = await owners.reversal.revertOrderConsumption(cancelled);
  } catch (error) {
    throw new CancellationRollback(
      [
        operationIssue(
          CANCELLATION_ISSUE.reversalFailed,
          `Stock could not be returned for order ${cancelled.orderNumber}, so the cancellation was rolled back.`,
          cancelled.id,
          { cause: error instanceof Error ? error.message : String(error) },
        ),
      ],
      error,
    );
  }

  let stockReturned = false;
  let stockAlreadyReturned = false;

  if (isOperationUsable(reversalResult)) {
    stockAlreadyReturned = reversalResult.value.replayed;
    stockReturned = !reversalResult.value.replayed;
  } else if (!isBenignReversalEnding(reversalResult)) {
    throw new CancellationRollback([
      operationIssue(
        CANCELLATION_ISSUE.reversalFailed,
        `Stock could not be returned for order ${cancelled.orderNumber}, so the cancellation was rolled back.`,
        cancelled.id,
        { reversalReason: reversalResult.reason },
      ),
      ...reversalResult.issues,
    ]);
  }

  // ── project finance refund ─────────────────────────────────────────────────
  // Deliberately last, and deliberately powerless. In SOURCE this projection ran
  // FIRST and its result was the gate for the reversal above; now it decides
  // nothing and only reports. It is pure — no write, no persisted refund row —
  // because Finance derives refunds from settled orders (S6), so there is no second
  // writer and the refund cannot be recorded twice.
  let refund: ReturnType<RefundProjecting["projectRefund"]>;
  try {
    refund = owners.refunds.projectRefund(cancelled);
  } catch (error) {
    throw new CancellationRollback(
      [
        operationIssue(
          CANCELLATION_ISSUE.atomicFailed,
          `The refund projection failed for order ${cancelled.orderNumber}, so the cancellation was rolled back.`,
          cancelled.id,
          { cause: error instanceof Error ? error.message : String(error) },
        ),
      ],
      error,
    );
  }

  const outcome: OrderCancellationOutcome = {
    order: cancelled,
    stockReturned,
    stockAlreadyReturned,
    refundOwed: refund.refundable,
    refundTotal: refund.totalRefund,
    refundTransactions: refund.transactions,
  };

  // A replayed reversal is a usable outcome with something worth saying, which is
  // what `degraded` is for — the same treatment S7 gave a replayed submission.
  const issues: OperationIssue[] = [];
  if (stockAlreadyReturned) {
    issues.push(
      operationIssue(
        CONSUMPTION_ISSUE.alreadyReversed,
        `Stock for order ${cancelled.orderNumber} had already been returned; nothing was written.`,
        cancelled.id,
      ),
    );
  }

  return issues.length > 0 ? operationDegraded(outcome, issues) : operationSuccess(outcome);
}
