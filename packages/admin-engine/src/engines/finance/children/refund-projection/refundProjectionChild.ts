// packages/admin-engine/src/engines/finance/children/refund-projection/refundProjectionChild.ts
//
// What cancelling an order would refund (capability
// `admin.finance.refund-projection`, required by `admin.orders.order-cancellation`
// per LOGIC §8).
//
// Ported from SOURCE `apps/admin/src/features/finance/application/financeRefundProjection.ts`
// and the `FinanceRefundCapability` it was published as. The arithmetic is the
// domain's (`projectOrderToFinanceTransactions`) and is not restated here.
//
// The only child in the area with no port. It reads nothing and writes nothing:
// a refund is a pure function of the order's own settled state, which is what
// makes exactly-once refund semantics come from order state rather than from a
// persisted refund write. That property is load-bearing for slice 8 and is the
// reason this stays a projection rather than becoming a ledger entry.

import type { Money, Order } from "@warungmeng/domain";
import { projectOrderToFinanceTransactions } from "@warungmeng/domain";
import type { LogicChildContext } from "@warungmeng/module-system";
import { defineLogicChild } from "@warungmeng/module-system";
import { FINANCE_ENGINE_ID } from "../../financeEngine";
import type { RefundProjecting, RefundProjection } from "../../financeContracts";
import { REFUND_PROJECTION, REFUND_PROJECTION_ID } from "../../financeContracts";

const NO_REFUND: Money = { amount: 0, currency: "IDR" };

/**
 * The refund rows a settled order implies.
 *
 * Exported for direct testing and because it is genuinely pure — there is nothing
 * to inject, so a caller holding the capability and a caller holding this function
 * get identical answers.
 *
 * **What `refundable` actually means, stated plainly because slice 8 depends on
 * it.** The domain projects a refund row only when the order's `paymentStatus` is
 * `refunded`, and it sets that status when a *paid* order is cancelled. So this
 * answers "was money taken for this order", not "does this order need undoing".
 *
 * SOURCE's cancellation command used exactly this as the gate for reversing stock
 * (`projectRefund(order).length > 0`), which is why an UNPAID order that had
 * already consumed ingredients never got them back — the till consumes stock for
 * every order regardless of payment. That is tech-debt D18, and it belongs to the
 * cancellation slice rather than here: supplying the projection is finance's job,
 * deciding what to do about stock is not. The naming here is deliberate so slice 8
 * cannot reach for this flag believing it means something it does not.
 */
export function projectOrderRefund(order: Order): RefundProjection {
  const transactions = projectOrderToFinanceTransactions(order).filter(
    (transaction) => transaction.type === "refund",
  );

  if (transactions.length === 0) {
    return { transactions, refundable: false, totalRefund: NO_REFUND };
  }

  // Summed rather than assumed to be one row. The domain returns at most one
  // refund per order today, but a caller that indexes [0] would silently drop the
  // rest if that ever changed, and a total is what a caller actually wants.
  const amount = transactions.reduce((total, transaction) => total + transaction.amount.amount, 0);

  return {
    transactions,
    refundable: true,
    totalRefund: { amount, currency: transactions[0]?.amount.currency ?? "IDR" },
  };
}

export function createRefundProjection(context: LogicChildContext): RefundProjecting {
  // No port to resolve and therefore no missing-dependency diagnostic: this child
  // is never degraded. Every sibling in the area can be missing its store and still
  // publish; this one cannot fail to work at all.
  const capability: RefundProjecting = { projectRefund: projectOrderRefund };

  context.capabilities.provide(REFUND_PROJECTION, capability);

  return capability;
}

export default defineLogicChild<RefundProjecting>({
  id: REFUND_PROJECTION_ID,
  parentId: FINANCE_ENGINE_ID,
  provides: [REFUND_PROJECTION_ID],
  create: createRefundProjection,
});
