// packages/admin-engine/src/engines/orders/children/order-submission/orderSubmission.test.ts
//
// Protected order persistence handoff: validate fully before writing, let the store
// judge retries authoritatively, and publish through the real capability graph.

import { describe, expect, it, vi } from "vitest";
import type { Money, Order } from "@warungmeng/domain";
import { defineLogicChild } from "@warungmeng/module-system";
import type { AdminEngineSnapshot } from "../../../../adminEngineContracts";
import { createAdminEngine } from "../../../../createAdminEngine";
import type {
  OrderSubmission,
  OrderSubmissionCommit,
  OrderSubmissionRecord,
  OrdersStorePort,
  SubmitOrderInput,
} from "../../ordersContracts";
import {
  ORDERS_STORE_PORT,
  ORDER_SUBMISSION,
  ORDER_SUBMISSION_ID,
} from "../../ordersContracts";
import ordersEngine from "../../ordersEngine";
import orderSubmissionChild, { validateOrderSubmission } from "./orderSubmissionChild";

const IDR = (amount: number): Money => ({ amount, currency: "IDR" });

function record(overrides: Partial<OrderSubmissionRecord> = {}): OrderSubmissionRecord {
  const createdAt = overrides.createdAt ?? "2026-03-02T02:00:00.000Z";
  const total = overrides.totals?.total ?? IDR(50_000);
  return {
    orderNumber: "WM-1001",
    outletId: "wm-1",
    outletName: "Warung Meng",
    channel: "pos",
    fulfillment: "dine-in",
    paymentStatus: "paid",
    paymentMethod: "cash",
    status: "new",
    customer: null,
    items: [
      {
        id: "line-1",
        menuItemId: "menu-1",
        name: "Nasi Goreng",
        quantity: 1,
        unitPrice: IDR(50_000),
        variantSelections: [],
        note: "",
        lineTotal: IDR(50_000),
      },
    ],
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
    createdAt,
    updatedAt: createdAt,
    events: [
      {
        id: "event-1",
        status: "new",
        occurredAt: createdAt,
        note: "Created from POS cashier",
      },
    ],
    ...overrides,
  };
}

function input(overrides: Partial<SubmitOrderInput> = {}): SubmitOrderInput {
  return {
    idempotencyKey: "checkout-session-1:sequence-1",
    order: record(),
    ...overrides,
  };
}

const cancelNotUsed: OrdersStorePort["cancelOrder"] = async () => {
  throw new Error("cancel path not used by order-submission");
};

const progressNotUsed: OrdersStorePort["progressOrder"] = async () => {
  throw new Error("progression path not used by order-submission");
};

function storedOrder(orderRecord = record(), id = "order-1"): Order {
  return { ...orderRecord, id };
}

function runtimeWith(store?: OrdersStorePort): {
  readonly submission: OrderSubmission | undefined;
  readonly snapshot: AdminEngineSnapshot;
  readonly dispose: () => void;
} {
  let captured: OrderSubmission | undefined;

  const probe = defineLogicChild({
    id: "admin.orders.test-submission-probe",
    parentId: ordersEngine.id,
    requires: [ORDER_SUBMISSION_ID],
    create(context) {
      const resolution = context.capabilities.resolve(ORDER_SUBMISSION);
      if (resolution.status === "available") captured = resolution.value;
      return undefined;
    },
  });

  const runtime = createAdminEngine({
    definitions: { engines: [ordersEngine], children: [orderSubmissionChild, probe] },
    ports: {
      resolve: (token) =>
        token.id === ORDERS_STORE_PORT.id && store !== undefined ? (store as never) : undefined,
    },
  });

  return { submission: captured, snapshot: runtime.getSnapshot(), dispose: runtime.dispose };
}

describe("submission validation", () => {
  it("accepts the complete caller-planned SOURCE shape", () => {
    expect(validateOrderSubmission(input())).toEqual([]);
  });

  it("requires a durable idempotency key and one order item", () => {
    const issues = validateOrderSubmission(
      input({ idempotencyKey: "  ", order: record({ items: [] }) }),
    );

    expect(issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["order-field-required", "empty-order"]),
    );
  });

  it("accepts a signed rounding adjustment while other money remains non-negative", () => {
    const base = record();
    const issues = validateOrderSubmission(
      input({
        order: record({
          totals: { ...base.totals, rounding: IDR(-50), total: IDR(9_950) },
        }),
      }),
    );

    expect(issues).toEqual([]);
  });

  it("enforces whole non-negative IDR amounts and positive whole quantities", () => {
    const base = record();
    const first = base.items[0];
    if (first === undefined) throw new Error("fixture requires one item");

    const issues = validateOrderSubmission(
      input({
        order: record({
          items: [
            {
              ...first,
              quantity: 0.5,
              unitPrice: { amount: -1, currency: "IDR" },
              lineTotal: { amount: 12.5, currency: "IDR" },
            },
          ],
          totals: {
            ...base.totals,
            total: { amount: 10, currency: "USD" } as unknown as Money,
          },
        }),
      }),
    );

    expect(issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["invalid-order-quantity", "invalid-order-money"]),
    );
  });

  it("requires a unique item id, valid timestamps, and a coherent initial event", () => {
    const base = record();
    const first = base.items[0];
    if (first === undefined) throw new Error("fixture requires one item");

    const issues = validateOrderSubmission(
      input({
        order: record({
          status: "accepted",
          createdAt: "not-a-date",
          updatedAt: "2026-03-03T00:00:00.000Z",
          items: [first, { ...first }],
          events: [
            {
              id: "event-1",
              status: "new",
              occurredAt: "2026-03-04T00:00:00.000Z",
              note: "",
            },
          ],
        }),
      }),
    );

    expect(issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "invalid-order-timestamp",
        "duplicate-order-item-id",
        "invalid-initial-order-status",
        "initial-event-status-mismatch",
        "initial-event-time-mismatch",
        "initial-update-time-mismatch",
      ]),
    );
  });
});

describe("the child in a real runtime", () => {
  it("publishes the capability and persists a fresh order once", async () => {
    const rows: Order[] = [];
    const submitOrder = vi.fn(
      async (_key: string, orderRecord: OrderSubmissionRecord): Promise<OrderSubmissionCommit> => {
        const order = storedOrder(orderRecord);
        rows.push(order);
        return { status: "created", order };
      },
    );
    const store: OrdersStorePort = {
      listOrders: async () => rows,
      getOrderById: async (id) => rows.find((entry) => entry.id === id) ?? null,
      submitOrder,
      progressOrder: progressNotUsed,
      cancelOrder: cancelNotUsed,
    };
    const { submission, dispose } = runtimeWith(store);

    const result = await submission?.submitOrder(input());

    expect(result).toEqual({
      status: "success",
      value: { order: expect.objectContaining({ id: "order-1" }), replayed: false },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.orderNumber).toBe("WM-1001");
    expect(submitOrder).toHaveBeenCalledWith("checkout-session-1:sequence-1", input().order);
    dispose();
  });

  it("rejects invalid input before any write", async () => {
    const submitOrder = vi.fn(
      async (): Promise<OrderSubmissionCommit> => ({
        status: "created",
        order: storedOrder(),
      }),
    );
    const { submission, dispose } = runtimeWith({
      listOrders: async () => [],
      getOrderById: async () => null,
      submitOrder,
      progressOrder: progressNotUsed,
      cancelOrder: cancelNotUsed,
    });

    const result = await submission?.submitOrder(input({ order: record({ items: [] }) }));

    expect(result).toMatchObject({ status: "failure", reason: "invalid-input" });
    expect(submitOrder).not.toHaveBeenCalled();
    dispose();
  });

  it("reports an authoritative replay and writes no duplicate", async () => {
    const existing = storedOrder();
    const submitOrder = vi.fn(
      async (): Promise<OrderSubmissionCommit> => ({ status: "replayed", order: existing }),
    );
    const { submission, dispose } = runtimeWith({
      listOrders: async () => [existing],
      getOrderById: async (id) => (id === existing.id ? existing : null),
      submitOrder,
      progressOrder: progressNotUsed,
      cancelOrder: cancelNotUsed,
    });

    const result = await submission?.submitOrder(input());

    expect(result).toMatchObject({
      status: "degraded",
      value: { order: { id: "order-1" }, replayed: true },
      issues: [{ code: "order-submission-replayed" }],
    });
    expect(submitOrder).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("keeps key reuse with different payload distinct from infrastructure failure", async () => {
    const existing = storedOrder();
    const conflictStore: OrdersStorePort = {
      listOrders: async () => [existing],
      getOrderById: async (id) => (id === existing.id ? existing : null),
      submitOrder: async () => ({
        status: "conflict",
        order: existing,
        message: "Idempotency key already belongs to another payload",
      }),
      progressOrder: progressNotUsed,
      cancelOrder: cancelNotUsed,
    };
    const { submission: conflict, dispose: disposeConflict } = runtimeWith(conflictStore);

    const conflictResult = await conflict?.submitOrder(input());
    expect(conflictResult).toMatchObject({ status: "failure", reason: "conflict" });
    if (conflictResult?.status === "failure") {
      expect(conflictResult.issues[0]?.message).toBe(
        "Idempotency key already belongs to another payload",
      );
    }
    disposeConflict();

    const failingStore: OrdersStorePort = {
      listOrders: async () => [],
      getOrderById: async () => null,
      submitOrder: async () => {
        throw new Error("create order timed out");
      },
      progressOrder: progressNotUsed,
      cancelOrder: cancelNotUsed,
    };
    const { submission: failing, dispose: disposeFailing } = runtimeWith(failingStore);
    const failed = await failing?.submitOrder(input());
    expect(failed).toMatchObject({ status: "failure", reason: "failed" });
    if (failed?.status === "failure") {
      expect(failed.issues[0]?.message).toBe("create order timed out");
    }
    disposeFailing();
  });

  it("still publishes without a store and reports the missing port once", async () => {
    const { submission, snapshot, dispose } = runtimeWith(undefined);

    expect(submission).toBeDefined();
    expect(await submission?.submitOrder(input())).toMatchObject({
      status: "failure",
      reason: "unsatisfied-dependency",
    });

    const area = snapshot.areas.find((entry) => entry.engineId === ordersEngine.id);
    expect(area?.unavailableChildIds).not.toContain(ORDER_SUBMISSION_ID);
    expect(area?.failedChildIds).not.toContain(ORDER_SUBMISSION_ID);
    expect(
      snapshot.diagnostics.filter(
        (entry) => entry.source === "orderSubmissionChild" && entry.code === "missing-dependency",
      ),
    ).toHaveLength(1);
    dispose();
  });
});
