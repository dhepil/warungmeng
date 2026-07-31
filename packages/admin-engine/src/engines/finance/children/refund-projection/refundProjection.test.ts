// packages/admin-engine/src/engines/finance/children/refund-projection/refundProjection.test.ts
//
// Protected behavior for the refund projection.
//
// Small but load-bearing: `admin.orders.order-cancellation` (slice 8) requires this
// capability, and SOURCE used its emptiness as the gate for reversing stock. The
// section that matters most is "what refundable actually answers" — it pins down
// the meaning slice 8 must not misread, and tech-debt D18 exists because SOURCE
// did misread it.
//
// No React, no DOM, no renderer (LOGIC §6).

import { describe, expect, it } from "vitest";
import type { Money, Order, OrderPaymentStatus } from "@warungmeng/domain";
import { defineLogicChild } from "@warungmeng/module-system";
import { createAdminEngine } from "../../../../createAdminEngine";
import type { RefundProjecting } from "../../financeContracts";
import { REFUND_PROJECTION, REFUND_PROJECTION_ID } from "../../financeContracts";
import financeEngine from "../../financeEngine";
import refundProjectionChild, { projectOrderRefund } from "./refundProjectionChild";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const IDR = (amount: number): Money => ({ amount, currency: "IDR" });

function order(overrides: Partial<Order> = {}): Order {
  const total = overrides.totals?.total ?? IDR(50_000);
  return {
    id: "o1",
    orderNumber: "WM-001",
    outletId: "wm-1",
    outletName: "Warung Meng",
    channel: "pos",
    fulfillment: "dine-in",
    paymentStatus: "paid",
    paymentMethod: "cash",
    status: "completed",
    customer: null,
    items: [],
    totals: {
      subtotal: total,
      discount: IDR(0),
      tax: IDR(0),
      serviceCharge: IDR(0),
      rounding: IDR(0),
      total,
    },
    customerNote: "",
    internalNote: "",
    createdAt: "2026-03-01T02:00:00.000Z",
    updatedAt: "2026-03-02T05:00:00.000Z",
    events: [],
    ...overrides,
  };
}

/**
 * Reaches the capability through a probe child that declares it in `requires`,
 * which is the path a real consumer uses. Calling `create()` directly would pass
 * even if the capability were published under the wrong id.
 */
function runtimeCapability(): {
  readonly refunds: RefundProjecting | undefined;
  readonly dispose: () => void;
} {
  let captured: RefundProjecting | undefined;

  const probe = defineLogicChild({
    id: "admin.finance.test-probe",
    parentId: financeEngine.id,
    requires: [REFUND_PROJECTION_ID],
    create(context) {
      const resolution = context.capabilities.resolve(REFUND_PROJECTION);
      if (resolution.status === "available") {
        captured = resolution.value;
      }
      return undefined;
    },
  });

  const engine = createAdminEngine({
    definitions: { engines: [financeEngine], children: [refundProjectionChild, probe] },
  });

  return { refunds: captured, dispose: engine.dispose };
}

// ─── What `refundable` actually answers ──────────────────────────────────────

describe("what refundable answers", () => {
  // This block is the contract slice 8 reads. If any of it changes, the
  // cancellation slice's stock-reversal trigger has to be revisited.

  it("reports a refund for an order whose payment was settled as refunded", () => {
    const projection = projectOrderRefund(
      order({ paymentStatus: "refunded", status: "cancelled" }),
    );

    expect(projection.refundable).toBe(true);
    expect(projection.transactions).toHaveLength(1);
    expect(projection.totalRefund).toEqual(IDR(50_000));
  });

  it("reports NO refund for an unpaid order, even a cancelled one", () => {
    // The D18 case. An unpaid order may still have consumed stock, and this
    // projection cannot see that — which is exactly why slice 8 must not use
    // `refundable` as its stock-reversal trigger.
    const projection = projectOrderRefund(
      order({ paymentStatus: "unpaid", status: "cancelled" }),
    );

    expect(projection.refundable).toBe(false);
    expect(projection.transactions).toEqual([]);
    expect(projection.totalRefund).toEqual(IDR(0));
  });

  it("reports no refund for a paid order that has not been cancelled", () => {
    const projection = projectOrderRefund(order({ paymentStatus: "paid" }));

    expect(projection.refundable).toBe(false);
    expect(projection.transactions).toEqual([]);
  });

  it.each<OrderPaymentStatus>(["unpaid", "paid"])(
    "treats payment status %s as nothing to refund",
    (paymentStatus) => {
      expect(projectOrderRefund(order({ paymentStatus })).refundable).toBe(false);
    },
  );
});

// ─── The projected row ───────────────────────────────────────────────────────

describe("the projected refund row", () => {
  it("is an outflow against the refund category, carrying the order as its source", () => {
    const [refund] = projectOrderRefund(
      order({ paymentStatus: "refunded", id: "o-42", orderNumber: "WM-042" }),
    ).transactions;

    expect(refund).toMatchObject({
      direction: "outflow",
      type: "refund",
      source: "automatic",
      status: "posted",
      categoryId: "refund",
      sourceReference: "o-42",
      referenceNumber: "WM-042",
    });
  });

  it("occurs when the order was last updated, not when it was created", () => {
    // The refund happened at cancellation time. Dating it from createdAt would put
    // it in the wrong reporting period.
    const [refund] = projectOrderRefund(
      order({
        paymentStatus: "refunded",
        createdAt: "2026-03-01T02:00:00.000Z",
        updatedAt: "2026-03-09T11:00:00.000Z",
      }),
    ).transactions;

    expect(refund?.occurredAt).toBe("2026-03-09T11:00:00.000Z");
  });

  it("refunds the order total, including tax and service charge", () => {
    const projection = projectOrderRefund(
      order({
        paymentStatus: "refunded",
        totals: {
          subtotal: IDR(100_000),
          discount: IDR(10_000),
          tax: IDR(9_000),
          serviceCharge: IDR(5_000),
          rounding: IDR(0),
          total: IDR(104_000),
        },
      }),
    );

    expect(projection.totalRefund).toEqual(IDR(104_000));
  });

  it("is deterministic — the same order always yields the same id", () => {
    // This is what makes exactly-once refund semantics come from order state
    // rather than from a persisted write, so slice 8 can retry safely.
    const settled = order({ paymentStatus: "refunded" });

    expect(projectOrderRefund(settled).transactions[0]?.id).toBe(
      projectOrderRefund(settled).transactions[0]?.id,
    );
    expect(projectOrderRefund(settled).transactions[0]?.id).toContain("o1");
  });

  it("does not include the sale row", () => {
    // A settled-then-refunded order projects BOTH a sale and a refund. Only the
    // refund belongs to this capability; returning the sale would double-count.
    const projection = projectOrderRefund(order({ paymentStatus: "refunded" }));

    expect(projection.transactions.every((entry) => entry.type === "refund")).toBe(true);
  });
});

// ─── Composition ─────────────────────────────────────────────────────────────

describe("the child in a runtime", () => {
  it("publishes the capability under the id LOGIC §8 names", () => {
    const { refunds, dispose } = runtimeCapability();

    expect(refunds).toBeDefined();
    expect(refunds?.projectRefund(order({ paymentStatus: "refunded" })).refundable).toBe(true);

    dispose();
  });

  it("needs no port, so it is never degraded", () => {
    // Every sibling in this area can be missing its store and still publish a
    // capability that answers honestly. This one cannot fail to work at all —
    // composed with no ports whatsoever, it is fully functional.
    const { refunds, dispose } = runtimeCapability();

    expect(refunds?.projectRefund(order({ paymentStatus: "unpaid" }))).toEqual({
      transactions: [],
      refundable: false,
      totalRefund: IDR(0),
    });

    dispose();
  });
});
