// Protected forward-only order progression through a probe child and real runtime.
// No React, DOM, renderer, or direct create() calls.

import type { Money, Order } from "@warungmeng/domain";
import { transitionOrderStatus } from "@warungmeng/domain";
import { describe, expect, it } from "vitest";
import { defineLogicChild } from "@warungmeng/module-system";
import type { AdminEngineSnapshot } from "../../../../adminEngineContracts";
import { createAdminEngine } from "../../../../createAdminEngine";
import type {
  ForwardOrderStatus,
  OrderProgression,
  OrdersStorePort,
} from "../../ordersContracts";
import {
  ORDERS_STORE_PORT,
  ORDER_PROGRESSION,
  ORDER_PROGRESSION_ID,
  ORDER_READ_ID,
  PROGRESSION_ISSUE,
} from "../../ordersContracts";
import ordersEngine from "../../ordersEngine";
import orderReadChild from "../order-read/orderReadChild";
import orderProgressionChild from "./orderProgressionChild";

const WHEN = "2026-08-01T10:00:00.000Z";
const IDR = (amount: number): Money => ({ amount, currency: "IDR" });

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: "o-1",
    orderNumber: "WM-0001",
    outletId: "wm-1",
    outletName: "Warung Meng Pusat",
    channel: "pos",
    fulfillment: "dine-in",
    paymentStatus: "paid",
    paymentMethod: "cash",
    status: "new",
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
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-01T09:00:00.000Z",
    events: [],
    ...overrides,
  };
}

interface ProgressCall {
  readonly orderId: string;
  readonly nextStatus: ForwardOrderStatus;
}

function storeOver(options: {
  readonly rows?: readonly Order[];
  readonly throwOnProgress?: boolean;
} = {}): OrdersStorePort & {
  readonly progressCalls: ProgressCall[];
  readonly readCalls: string[];
  current(orderId: string): Order | undefined;
} {
  const rows = [...(options.rows ?? [order()])];
  const progressCalls: ProgressCall[] = [];
  const readCalls: string[] = [];

  return {
    progressCalls,
    readCalls,
    current: (orderId) => rows.find((entry) => entry.id === orderId),
    listOrders: async () => {
      readCalls.push("listOrders");
      return rows;
    },
    getOrderById: async (orderId) => {
      readCalls.push(`getOrderById:${orderId}`);
      return rows.find((entry) => entry.id === orderId) ?? null;
    },
    submitOrder: async () => {
      throw new Error("submission not used by order-progression");
    },
    progressOrder: async (orderId, nextStatus) => {
      if (options.throwOnProgress === true) {
        throw new Error("orders backend unreachable");
      }

      progressCalls.push({ orderId, nextStatus });
      const index = rows.findIndex((entry) => entry.id === orderId);
      if (index === -1) return { status: "not-found" };

      const current = rows[index]!;
      const updated = transitionOrderStatus(
        current,
        nextStatus,
        WHEN,
        `progress-event-${progressCalls.length}`,
      );
      if (updated === null) return { status: "invalid-transition", order: current };

      rows[index] = updated;
      return { status: "updated", order: updated };
    },
    cancelOrder: async () => {
      throw new Error("cancellation not used by order-progression");
    },
  };
}

function ordersArea(snapshot: AdminEngineSnapshot) {
  return snapshot.areas.find((entry) => entry.engineId === ordersEngine.id);
}

function runtimeWith(options: {
  readonly store?: OrdersStorePort;
  readonly withRead?: boolean;
} = {}): {
  readonly progression: OrderProgression | undefined;
  readonly snapshot: AdminEngineSnapshot;
  readonly dispose: () => void;
} {
  let captured: OrderProgression | undefined;

  // Reach the capability exactly as a real consumer does. A wrong capability id
  // makes the probe unavailable instead of letting tests call create() directly.
  const probe = defineLogicChild({
    id: "admin.orders.progression-test-probe",
    parentId: ordersEngine.id,
    requires: [ORDER_PROGRESSION_ID],
    create(context) {
      const resolution = context.capabilities.resolve(ORDER_PROGRESSION);
      if (resolution.status === "available") captured = resolution.value;
      return undefined;
    },
  });

  const children =
    options.withRead === false
      ? [orderProgressionChild, probe]
      : [orderReadChild, orderProgressionChild, probe];

  const engine = createAdminEngine({
    definitions: { engines: [ordersEngine], children },
    ports: {
      resolve: (token) =>
        token.id === ORDERS_STORE_PORT.id && options.store !== undefined
          ? (options.store as never)
          : undefined,
    },
  });

  return {
    progression: captured,
    snapshot: engine.getSnapshot(),
    dispose: engine.dispose,
  };
}

describe("order progression wiring", () => {
  it("publishes the exact child/capability id through a probe", () => {
    const { progression, dispose } = runtimeWith({ store: storeOver() });

    expect(progression).toBeDefined();
    expect(ORDER_PROGRESSION_ID).toBe("admin.orders.order-progression");
    expect(orderProgressionChild.provides).toEqual([ORDER_PROGRESSION_ID]);
    dispose();
  });

  it("declares exactly the LOGIC §8 read requirement", () => {
    expect(orderProgressionChild.requires).toEqual([ORDER_READ_ID]);
  });

  it("is not created when Orders read is absent", () => {
    const { progression, snapshot, dispose } = runtimeWith({
      store: storeOver(),
      withRead: false,
    });

    expect(progression).toBeUndefined();
    expect(ordersArea(snapshot)?.unavailableChildIds).toContain(ORDER_PROGRESSION_ID);
    dispose();
  });

  it("stays active and reports one diagnostic when the store port is absent", async () => {
    const { progression, snapshot, dispose } = runtimeWith();

    expect(progression).toBeDefined();
    await expect(
      progression!.progressOrder({ orderId: "o-1", nextStatus: "accepted" }),
    ).resolves.toMatchObject({
      status: "failure",
      reason: "unsatisfied-dependency",
      issues: [{ code: PROGRESSION_ISSUE.noStore }],
    });
    expect(ordersArea(snapshot)?.unavailableChildIds).not.toContain(ORDER_PROGRESSION_ID);
    expect(
      snapshot.diagnostics.filter(
        (entry) => entry.source === "orderProgressionChild" && entry.code === "missing-dependency",
      ),
    ).toHaveLength(1);
    dispose();
  });
});

describe("forward status transitions", () => {
  it("advances new → accepted → preparing → ready → completed through the domain machine", async () => {
    const store = storeOver();
    const { progression, dispose } = runtimeWith({ store });

    for (const nextStatus of ["accepted", "preparing", "ready", "completed"] as const) {
      const result = await progression!.progressOrder({ orderId: "o-1", nextStatus });
      expect(result).toMatchObject({
        status: "success",
        value: { order: { status: nextStatus, paymentStatus: "paid", updatedAt: WHEN } },
      });
    }

    expect(store.current("o-1")?.events.map((event) => event.status)).toEqual([
      "accepted",
      "preparing",
      "ready",
      "completed",
    ]);
    expect(store.readCalls).toEqual([]);
    dispose();
  });

  it("preserves the store's authoritative invalid-transition outcome", async () => {
    const store = storeOver();
    const { progression, dispose } = runtimeWith({ store });

    await expect(
      progression!.progressOrder({ orderId: "o-1", nextStatus: "ready" }),
    ).resolves.toMatchObject({
      status: "failure",
      reason: "conflict",
      issues: [{ code: PROGRESSION_ISSUE.invalidTransition }],
    });
    expect(store.current("o-1")?.status).toBe("new");
    expect(store.progressCalls).toHaveLength(1);
    dispose();
  });

  it("preserves the store's authoritative not-found outcome", async () => {
    const store = storeOver({ rows: [] });
    const { progression, dispose } = runtimeWith({ store });

    await expect(
      progression!.progressOrder({ orderId: "missing", nextStatus: "accepted" }),
    ).resolves.toMatchObject({
      status: "failure",
      reason: "not-found",
      issues: [{ code: PROGRESSION_ISSUE.notFound }],
    });
    dispose();
  });
});

describe("the cancellation door stays closed", () => {
  it("rejects cancelled before the domain-backed store can refund or write", async () => {
    const store = storeOver({ rows: [order({ status: "accepted", paymentStatus: "paid" })] });
    const { progression, dispose } = runtimeWith({ store });
    const unsafeCaller = progression as unknown as {
      progressOrder(input: {
        readonly orderId: string;
        readonly nextStatus: string;
      }): ReturnType<OrderProgression["progressOrder"]>;
    };

    await expect(
      unsafeCaller.progressOrder({ orderId: "o-1", nextStatus: "cancelled" }),
    ).resolves.toMatchObject({
      status: "failure",
      reason: "invalid-input",
      issues: [{ code: PROGRESSION_ISSUE.cancellationForbidden }],
    });
    expect(store.progressCalls).toEqual([]);
    expect(store.current("o-1")).toMatchObject({ status: "accepted", paymentStatus: "paid" });
    dispose();
  });

  it.each(["new", "unknown"])("rejects non-forward target %s before the store", async (nextStatus) => {
    const store = storeOver();
    const { progression, dispose } = runtimeWith({ store });
    const unsafeCaller = progression as unknown as {
      progressOrder(input: {
        readonly orderId: string;
        readonly nextStatus: string;
      }): ReturnType<OrderProgression["progressOrder"]>;
    };

    await expect(
      unsafeCaller.progressOrder({ orderId: "o-1", nextStatus }),
    ).resolves.toMatchObject({
      status: "failure",
      reason: "invalid-input",
      issues: [{ code: PROGRESSION_ISSUE.invalidStatus }],
    });
    expect(store.progressCalls).toEqual([]);
    dispose();
  });
});

describe("input and infrastructure failures", () => {
  it("rejects a blank order id before the store", async () => {
    const store = storeOver();
    const { progression, dispose } = runtimeWith({ store });

    await expect(
      progression!.progressOrder({ orderId: "   ", nextStatus: "accepted" }),
    ).resolves.toMatchObject({
      status: "failure",
      reason: "invalid-input",
      issues: [{ code: PROGRESSION_ISSUE.invalidOrderId }],
    });
    expect(store.progressCalls).toEqual([]);
    dispose();
  });

  it("normalizes a store exception instead of throwing", async () => {
    const store = storeOver({ throwOnProgress: true });
    const { progression, dispose } = runtimeWith({ store });

    await expect(
      progression!.progressOrder({ orderId: "o-1", nextStatus: "accepted" }),
    ).resolves.toMatchObject({
      status: "failure",
      reason: "failed",
      issues: [{ code: PROGRESSION_ISSUE.storeFailed }],
    });
    dispose();
  });
});
