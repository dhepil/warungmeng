// packages/admin-engine/src/engines/orders/children/order-cancellation/orderCancellation.test.ts
//
// Protected behavior for the multi-owner cancellation workflow.
//
// This is the widest composition in the port so far: THREE areas (orders,
// inventory, finance) plus the atomic port, because LOGIC §8 gives this child four
// requirements. It is also the first test that exercises the atomic seam built in
// S1 — until now that republish was declared and never used by a real consumer.
//
// The load-bearing sections, in order of how much they would cost to get wrong:
//
//   1. "stock comes back even when the order was never paid" — tech-debt D18, the
//      whole reason this slice needed an owner decision.
//   2. "a failed reversal rolls the cancellation back" — the atomic promise. If
//      this regresses, an order can be cancelled with its stock still deducted,
//      which is precisely the state the boundary exists to make impossible.
//   3. "an order that consumed nothing still cancels" — the trap created by
//      calling the reversal unconditionally, since the reversal child reports
//      "never consumed" as a failure.
//
// No React, no DOM, no renderer (LOGIC §6).

import { describe, expect, it, vi } from "vitest";
import type { InventoryMovement, Money, Order } from "@warungmeng/domain";
import { defineLogicChild } from "@warungmeng/module-system";
import {
  operationDegraded,
  operationFailure,
  operationIssue,
  operationSuccess,
} from "@warungmeng/module-system";
import type { AdminEngineSnapshot } from "../../../../adminEngineContracts";
import { createAdminEngine } from "../../../../createAdminEngine";
import { ATOMIC_OPERATION_PORT } from "../../../../shared/atomicOperationPort";
import type { AtomicOperationPort } from "../../../../shared/atomicOperationPort";
import type { RefundProjecting } from "../../../finance/financeContracts";
import {
  REFUND_PROJECTION,
  REFUND_PROJECTION_ID,
} from "../../../finance/financeContracts";
import financeEngine from "../../../finance/financeEngine";
import type { StockReversal } from "../../../inventory/inventoryContracts";
import {
  CONSUMPTION_ISSUE,
  STOCK_REVERSAL,
  STOCK_REVERSAL_ID,
} from "../../../inventory/inventoryContracts";
import inventoryEngine from "../../../inventory/inventoryEngine";
import type { OrderCancellation, OrdersStorePort } from "../../ordersContracts";
import {
  CANCELLATION_ISSUE,
  ORDERS_STORE_PORT,
  ORDER_CANCEL,
  ORDER_CANCEL_ID,
  ORDER_READ_ID,
} from "../../ordersContracts";
import ordersEngine from "../../ordersEngine";
import orderReadChild from "../order-read/orderReadChild";
import orderCancellationChild from "./orderCancellationChild";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const IDR = (amount: number): Money => ({ amount, currency: "IDR" });

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: "o-1",
    orderNumber: "WM-0001",
    outletId: "wm-1",
    outletName: "Warung Meng Pusat",
    channel: "pos",
    fulfillment: "dine-in",
    status: "preparing",
    paymentStatus: "unpaid",
    paymentMethod: "cash",
    customer: null,
    items: [],
    totals: {
      subtotal: IDR(50_000),
      discount: IDR(0),
      tax: IDR(0),
      serviceCharge: IDR(0),
      rounding: IDR(0),
      total: IDR(50_000),
    },
    customerNote: "",
    internalNote: "",
    createdAt: "2026-07-01T02:00:00.000Z",
    updatedAt: "2026-07-01T02:00:00.000Z",
    events: [],
    ...overrides,
  };
}

function movement(id: string): InventoryMovement {
  return {
    id,
    ingredientId: "ing-1",
    outletId: "wm-1",
    type: "adjustment-in",
    quantity: 100,
    unit: "g",
    baseQuantityDelta: 100,
    unitCost: null,
    note: "reversal",
    referenceId: "o-1",
    occurredAt: "2026-07-01T03:00:00.000Z",
  };
}

/**
 * A store whose cancel behaves like the real one: it is the judge, and it only
 * mutates when the transition is legal. `cancelled` records what was committed so a
 * test can assert a rollback actually undid it.
 */
function storeOver(seed: {
  rows?: readonly Order[];
  throwOnCancel?: boolean;
}): OrdersStorePort & { readonly committed: Order[] } {
  const rows = [...(seed.rows ?? [order()])];
  const committed: Order[] = [];

  return {
    committed,
    listOrders: async () => rows,
    getOrderById: async (id) => rows.find((entry) => entry.id === id) ?? null,
    submitOrder: async () => {
      throw new Error("submission not used by order-cancellation");
    },
    cancelOrder: async (orderId) => {
      if (seed.throwOnCancel === true) {
        throw new Error("orders backend unreachable");
      }

      const index = rows.findIndex((entry) => entry.id === orderId);
      if (index === -1) return { status: "not-found" };

      const current = rows[index]!;
      if (current.status === "cancelled" || current.status === "completed") {
        return { status: "invalid-transition", order: current };
      }

      const updated: Order = {
        ...current,
        status: "cancelled",
        paymentStatus: current.paymentStatus === "paid" ? "refunded" : current.paymentStatus,
        updatedAt: "2026-07-01T03:00:00.000Z",
      };
      rows[index] = updated;
      committed.push(updated);
      return { status: "cancelled", order: updated };
    },
  };
}

type ReversalMode =
  | "reversed"
  | "already-reversed"
  | "never-consumed"
  | "conflict"
  | "throws";

function reversalOver(mode: ReversalMode): StockReversal & { readonly calls: Order[] } {
  const calls: Order[] = [];

  return {
    calls,
    revertOrderConsumption: async (subject) => {
      calls.push(subject);

      switch (mode) {
        case "reversed":
          return operationSuccess({
            movements: [movement("mv-1")],
            replayed: false,
            skippedMenuItemIds: [],
          });
        case "already-reversed":
          return operationDegraded(
            { movements: [movement("mv-1")], replayed: true, skippedMenuItemIds: [] },
            [
              operationIssue(
                CONSUMPTION_ISSUE.alreadyReversed,
                "already reversed",
                subject.id,
              ),
            ],
          );
        case "never-consumed":
          return operationFailure("not-found", [
            operationIssue(CONSUMPTION_ISSUE.neverConsumed, "never consumed", subject.id),
          ]);
        case "conflict":
          return operationFailure("conflict", [
            operationIssue("stock-would-go-negative", "balance would go negative", subject.id),
          ]);
        case "throws":
          throw new Error("inventory backend unreachable");
      }
    },
  };
}

function refundsOver(refundable: boolean, throws = false): RefundProjecting {
  return {
    projectRefund: (subject) => {
      if (throws) throw new Error("projection blew up");
      return {
        transactions: [],
        refundable,
        totalRefund: refundable ? subject.totals.total : IDR(0),
      };
    },
  };
}

/**
 * An atomic port that really rolls back, so the test proves the workflow's
 * behavior rather than trusting a pass-through stub.
 *
 * `restore` is registered by the caller and invoked on any throw, which is the
 * same snapshot/restore shape SOURCE's in-memory transaction used.
 */
function atomicPortOver(restore: () => void): AtomicOperationPort & {
  readonly rollbacks: number[];
} {
  const rollbacks: number[] = [];

  return {
    rollbacks,
    execute: async (operation) => {
      try {
        return await operation();
      } catch (error) {
        rollbacks.push(1);
        restore();
        throw error;
      }
    },
  };
}

/** The Orders area's own slice of the snapshot; unavailability is reported per area. */
function ordersArea(snapshot: AdminEngineSnapshot) {
  return snapshot.areas.find((entry) => entry.engineId === ordersEngine.id);
}

function runtimeWith(options: {
  store?: OrdersStorePort;
  reversal?: StockReversal;
  refunds?: RefundProjecting;
  atomic?: AtomicOperationPort;
  withInventory?: boolean;
  withFinance?: boolean;
  withAtomicPort?: boolean;
}): {
  readonly cancellation: OrderCancellation | undefined;
  readonly snapshot: AdminEngineSnapshot;
  readonly dispose: () => void;
} {
  const withInventory = options.withInventory !== false;
  const withFinance = options.withFinance !== false;
  const withAtomicPort = options.withAtomicPort !== false;
  let captured: OrderCancellation | undefined;

  // The sibling capabilities are supplied by stub children rather than the real
  // inventory/finance children, so this suite tests the cancellation workflow and
  // not their internals. They still publish under the REAL capability ids, which is
  // the part that has to be right — a wrong id must fail this suite.
  const reversalStub = defineLogicChild({
    id: "admin.inventory.test-reversal",
    parentId: inventoryEngine.id,
    provides: [STOCK_REVERSAL_ID],
    create(context) {
      context.capabilities.provide(STOCK_REVERSAL, options.reversal ?? reversalOver("reversed"));
      return undefined;
    },
  });

  const refundStub = defineLogicChild({
    id: "admin.finance.test-refunds",
    parentId: financeEngine.id,
    provides: [REFUND_PROJECTION_ID],
    create(context) {
      context.capabilities.provide(REFUND_PROJECTION, options.refunds ?? refundsOver(false));
      return undefined;
    },
  });

  // Reaches the capability the way a real consumer does — declared in `requires`
  // and resolved from context — so a capability published under the wrong id fails
  // rather than silently passing.
  const probe = defineLogicChild({
    id: "admin.orders.test-probe",
    parentId: ordersEngine.id,
    requires: [ORDER_CANCEL_ID],
    create(context) {
      const resolution = context.capabilities.resolve(ORDER_CANCEL);
      if (resolution.status === "available") {
        captured = resolution.value;
      }
      return undefined;
    },
  });

  const engines = [ordersEngine];
  if (withInventory) engines.push(inventoryEngine);
  if (withFinance) engines.push(financeEngine);

  const children = [orderReadChild, orderCancellationChild, probe];
  if (withInventory) children.push(reversalStub);
  if (withFinance) children.push(refundStub);

  const engine = createAdminEngine({
    definitions: { engines, children },
    ports: {
      resolve: (token) => {
        if (token.id === ORDERS_STORE_PORT.id) {
          return (options.store as never) ?? undefined;
        }
        if (token.id === ATOMIC_OPERATION_PORT.id && withAtomicPort) {
          return (options.atomic as never) ?? (atomicPortOver(() => {}) as never);
        }
        return undefined;
      },
    },
  });

  return { cancellation: captured, snapshot: engine.getSnapshot(), dispose: engine.dispose };
}

// ─── Wiring ──────────────────────────────────────────────────────────────────

describe("order cancellation wiring", () => {
  it("publishes admin.orders.cancel — the id LOGIC §8 names, not the child id", () => {
    const { cancellation, dispose } = runtimeWith({ store: storeOver({}) });

    expect(cancellation).toBeDefined();
    expect(ORDER_CANCEL_ID).toBe("admin.orders.cancel");
    dispose();
  });

  it("declares exactly the four LOGIC §8 requirements", () => {
    expect([...orderCancellationChild.requires].sort()).toEqual(
      [
        ORDER_READ_ID,
        STOCK_REVERSAL_ID,
        REFUND_PROJECTION_ID,
        "admin.atomic-operation",
      ].sort(),
    );
  });

  it.each([
    ["inventory", { withInventory: false }],
    ["finance", { withFinance: false }],
    ["the atomic port", { withAtomicPort: false }],
  ])(
    "is not created at all when %s is absent, rather than publishing a broken capability",
    (_label, missing) => {
      const { cancellation, snapshot, dispose } = runtimeWith({
        store: storeOver({}),
        ...missing,
      });

      expect(cancellation).toBeUndefined();
      expect(ordersArea(snapshot)?.unavailableChildIds).toContain(orderCancellationChild.id);
      dispose();
    },
  );
});

// ─── D18: the stock trigger ──────────────────────────────────────────────────

describe("stock return is decided by stock, never by money", () => {
  it("returns stock for an UNPAID order that had consumed it (tech-debt D18)", async () => {
    const store = storeOver({ rows: [order({ paymentStatus: "unpaid" })] });
    const reversal = reversalOver("reversed");
    const { cancellation, dispose } = runtimeWith({
      store,
      reversal,
      refunds: refundsOver(false),
    });

    const result = await cancellation!.cancelOrder("o-1");

    expect(result.status).toBe("success");
    // The reversal was attempted even though no money was refunded. SOURCE skipped
    // it here, which is exactly how stock went permanently missing.
    expect(reversal.calls).toHaveLength(1);
    expect(result.status === "success" && result.value.stockReturned).toBe(true);
    expect(result.status === "success" && result.value.refundOwed).toBe(false);
    dispose();
  });

  it("returns stock for a PAID order and also reports the refund owed", async () => {
    const store = storeOver({ rows: [order({ paymentStatus: "paid" })] });
    const reversal = reversalOver("reversed");
    const { cancellation, dispose } = runtimeWith({
      store,
      reversal,
      refunds: refundsOver(true),
    });

    const result = await cancellation!.cancelOrder("o-1");

    expect(result.status).toBe("success");
    expect(reversal.calls).toHaveLength(1);
    expect(result.status === "success" && result.value.stockReturned).toBe(true);
    expect(result.status === "success" && result.value.refundOwed).toBe(true);
    expect(result.status === "success" && result.value.refundTotal.amount).toBe(50_000);
    dispose();
  });

  it("does not let the refund projection gate the reversal", async () => {
    // The projection says "no refund" for both, and the reversal still runs for
    // both. If the SOURCE gate were reintroduced, neither of these would call it.
    for (const paymentStatus of ["unpaid", "refunded"] as const) {
      const reversal = reversalOver("reversed");
      const { cancellation, dispose } = runtimeWith({
        store: storeOver({ rows: [order({ paymentStatus })] }),
        reversal,
        refunds: refundsOver(false),
      });

      await cancellation!.cancelOrder("o-1");
      expect(reversal.calls).toHaveLength(1);
      dispose();
    }
  });
});

// ─── The unconditional-reversal trap ─────────────────────────────────────────

describe("an order that consumed nothing", () => {
  it("still cancels, and says no stock came back", async () => {
    const store = storeOver({});
    const { cancellation, dispose } = runtimeWith({
      store,
      reversal: reversalOver("never-consumed"),
    });

    const result = await cancellation!.cancelOrder("o-1");

    // The reversal child reports "never consumed" as a FAILURE, which is right for
    // its own caller and must not be fatal here — otherwise calling the reversal
    // unconditionally would make most orders impossible to cancel.
    expect(result.status).toBe("success");
    expect(result.status === "success" && result.value.stockReturned).toBe(false);
    expect(result.status === "success" && result.value.order.status).toBe("cancelled");
    expect(store.committed).toHaveLength(1);
    dispose();
  });

  it("reports an already-returned reversal as degraded, not as a fresh return", async () => {
    const { cancellation, dispose } = runtimeWith({
      store: storeOver({}),
      reversal: reversalOver("already-reversed"),
    });

    const result = await cancellation!.cancelOrder("o-1");

    expect(result.status).toBe("degraded");
    expect(result.status === "degraded" && result.value.stockAlreadyReturned).toBe(true);
    expect(result.status === "degraded" && result.value.stockReturned).toBe(false);
    expect(
      result.status === "degraded" &&
        result.issues.some((issue) => issue.code === CONSUMPTION_ISSUE.alreadyReversed),
    ).toBe(true);
    dispose();
  });
});

// ─── The atomic promise ──────────────────────────────────────────────────────

describe("a failure after the write rolls every owner back", () => {
  it("rolls back the cancellation when the reversal fails", async () => {
    const store = storeOver({});
    const restore = vi.fn();
    const atomic = atomicPortOver(restore);
    const { cancellation, dispose } = runtimeWith({
      store,
      reversal: reversalOver("conflict"),
      atomic,
    });

    const result = await cancellation!.cancelOrder("o-1");

    // A cancelled order whose stock stayed deducted is the exact state the atomic
    // boundary exists to prevent, so this must be a failure AND a rollback.
    expect(result.status).toBe("failure");
    expect(atomic.rollbacks).toHaveLength(1);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(
      result.status === "failure" &&
        result.issues.some((issue) => issue.code === CANCELLATION_ISSUE.reversalFailed),
    ).toBe(true);
    dispose();
  });

  it("rolls back when the reversal throws", async () => {
    const restore = vi.fn();
    const atomic = atomicPortOver(restore);
    const { cancellation, dispose } = runtimeWith({
      store: storeOver({}),
      reversal: reversalOver("throws"),
      atomic,
    });

    const result = await cancellation!.cancelOrder("o-1");

    expect(result.status).toBe("failure");
    expect(restore).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("rolls back when the refund projection throws", async () => {
    const restore = vi.fn();
    const atomic = atomicPortOver(restore);
    const { cancellation, dispose } = runtimeWith({
      store: storeOver({}),
      reversal: reversalOver("reversed"),
      refunds: refundsOver(true, true),
      atomic,
    });

    const result = await cancellation!.cancelOrder("o-1");

    expect(result.status).toBe("failure");
    expect(restore).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("does NOT roll back a refusal, because a refusal wrote nothing", async () => {
    const restore = vi.fn();
    const atomic = atomicPortOver(restore);
    const { cancellation, dispose } = runtimeWith({
      store: storeOver({ rows: [order({ status: "completed" })] }),
      atomic,
    });

    const result = await cancellation!.cancelOrder("o-1");

    // Rolling back here would be harmless but dishonest: it would report a healthy
    // runtime as having undone work it never did.
    expect(result.status).toBe("failure");
    expect(atomic.rollbacks).toHaveLength(0);
    expect(restore).not.toHaveBeenCalled();
    dispose();
  });
});

// ─── Refusals stay distinguishable ───────────────────────────────────────────

describe("endings a caller has to tell apart", () => {
  it("reports a missing order as not-found and writes nothing", async () => {
    const store = storeOver({});
    const reversal = reversalOver("reversed");
    const { cancellation, dispose } = runtimeWith({ store, reversal });

    const result = await cancellation!.cancelOrder("o-missing");

    expect(result.status === "failure" && result.reason).toBe("not-found");
    expect(reversal.calls).toHaveLength(0);
    expect(store.committed).toHaveLength(0);
    dispose();
  });

  it("separates an already-cancelled order from one that cannot be cancelled", async () => {
    const alreadyCancelled = runtimeWith({
      store: storeOver({ rows: [order({ status: "cancelled" })] }),
    });
    const cancelledResult = await alreadyCancelled.cancellation!.cancelOrder("o-1");
    expect(
      cancelledResult.status === "failure" &&
        cancelledResult.issues[0]?.code === CANCELLATION_ISSUE.alreadyCancelled,
    ).toBe(true);
    alreadyCancelled.dispose();

    const completed = runtimeWith({
      store: storeOver({ rows: [order({ status: "completed" })] }),
    });
    const completedResult = await completed.cancellation!.cancelOrder("o-1");
    // SOURCE showed one generic warning for both of these.
    expect(
      completedResult.status === "failure" &&
        completedResult.issues[0]?.code === CANCELLATION_ISSUE.invalidTransition,
    ).toBe(true);
    completed.dispose();
  });

  it("keeps a dead orders backend distinct from a business refusal", async () => {
    const restore = vi.fn();
    const atomic = atomicPortOver(restore);
    const { cancellation, dispose } = runtimeWith({
      store: storeOver({ throwOnCancel: true }),
      atomic,
    });

    const result = await cancellation!.cancelOrder("o-1");

    expect(result.status === "failure" && result.reason).toBe("failed");
    expect(
      result.status === "failure" &&
        result.issues.some((issue) => issue.code === CANCELLATION_ISSUE.storeFailed),
    ).toBe(true);
    dispose();
  });

  it("rejects a blank order id before touching any owner", async () => {
    const store = storeOver({});
    const reversal = reversalOver("reversed");
    const { cancellation, dispose } = runtimeWith({ store, reversal });

    const result = await cancellation!.cancelOrder("   ");

    expect(result.status === "failure" && result.reason).toBe("invalid-input");
    expect(store.committed).toHaveLength(0);
    expect(reversal.calls).toHaveLength(0);
    dispose();
  });

  it("answers with a normalized failure when no orders store was supplied", async () => {
    const { cancellation, snapshot, dispose } = runtimeWith({ store: undefined });

    const result = await cancellation!.cancelOrder("o-1");

    // A missing PORT is a legal state: the capability is still published and says so
    // honestly. Contrast the missing-capability cases above, where no child exists.
    expect(result.status === "failure" && result.reason).toBe("unsatisfied-dependency");
    expect(ordersArea(snapshot)?.unavailableChildIds).not.toContain(orderCancellationChild.id);
    dispose();
  });
});

// ─── Idempotency ─────────────────────────────────────────────────────────────

describe("cancelling twice", () => {
  it("is safe: the second call refuses and returns no stock again", async () => {
    const store = storeOver({});
    const reversal = reversalOver("reversed");
    const { cancellation, dispose } = runtimeWith({ store, reversal });

    const first = await cancellation!.cancelOrder("o-1");
    const second = await cancellation!.cancelOrder("o-1");

    expect(first.status).toBe("success");
    expect(
      second.status === "failure" &&
        second.issues[0]?.code === CANCELLATION_ISSUE.alreadyCancelled,
    ).toBe(true);
    // One write, one reversal — terminal status is the guard, and it holds.
    expect(store.committed).toHaveLength(1);
    expect(reversal.calls).toHaveLength(1);
    dispose();
  });
});
