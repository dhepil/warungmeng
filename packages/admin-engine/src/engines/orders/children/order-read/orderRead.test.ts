// packages/admin-engine/src/engines/orders/children/order-read/orderRead.test.ts
//
// Protected order collection/detail behavior. Pure filter/order rules are tested
// directly; capability publication goes through a real Admin runtime and a probe.

import { describe, expect, it } from "vitest";
import type { Money, Order } from "@warungmeng/domain";
import { defineLogicChild } from "@warungmeng/module-system";
import type { AdminEngineSnapshot } from "../../../../adminEngineContracts";
import { createAdminEngine } from "../../../../createAdminEngine";
import type {
  OrderListFilters,
  OrderRead,
  OrdersStorePort,
} from "../../ordersContracts";
import {
  DEFAULT_ORDER_LIST_FILTERS,
  ORDERS_STORE_PORT,
  ORDER_READ,
  ORDER_READ_ID,
} from "../../ordersContracts";
import ordersEngine from "../../ordersEngine";
import orderReadChild, { filterOrders, queryOrders, sortOrders } from "./orderReadChild";

const IDR = (amount: number): Money => ({ amount, currency: "IDR" });

function order(
  overrides: Partial<Order> & Pick<Order, "id" | "createdAt">,
): Order {
  const total = overrides.totals?.total ?? IDR(50_000);
  return {
    orderNumber: `WM-${overrides.id}`,
    outletId: "wm-1",
    outletName: "Warung Meng",
    channel: "pos",
    fulfillment: "dine-in",
    paymentStatus: "paid",
    paymentMethod: "cash",
    status: "new",
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
    updatedAt: overrides.createdAt,
    events: [],
    ...overrides,
  };
}

function filters(overrides: Partial<OrderListFilters> = {}): OrderListFilters {
  return { ...DEFAULT_ORDER_LIST_FILTERS, ...overrides };
}

function storeOver(rows: readonly Order[]): OrdersStorePort {
  return {
    listOrders: async () => rows,
    getOrderById: async (id) => rows.find((entry) => entry.id === id) ?? null,
    submitOrder: async () => {
      throw new Error("write path not used by order-read");
    },
  };
}

function runtimeWith(store?: OrdersStorePort): {
  readonly reader: OrderRead | undefined;
  readonly snapshot: AdminEngineSnapshot;
  readonly dispose: () => void;
} {
  let captured: OrderRead | undefined;

  const probe = defineLogicChild({
    id: "admin.orders.test-read-probe",
    parentId: ordersEngine.id,
    requires: [ORDER_READ_ID],
    create(context) {
      const resolution = context.capabilities.resolve(ORDER_READ);
      if (resolution.status === "available") captured = resolution.value;
      return undefined;
    },
  });

  const runtime = createAdminEngine({
    definitions: { engines: [ordersEngine], children: [orderReadChild, probe] },
    ports: {
      resolve: (token) =>
        token.id === ORDERS_STORE_PORT.id && store !== undefined ? (store as never) : undefined,
    },
  });

  return { reader: captured, snapshot: runtime.getSnapshot(), dispose: runtime.dispose };
}

describe("order ordering", () => {
  it("sorts newest first and breaks a timestamp tie by id", () => {
    const sameTime = "2026-03-02T10:00:00.000Z";
    const sorted = sortOrders([
      order({ id: "o-a", createdAt: sameTime }),
      order({ id: "o-c", createdAt: sameTime }),
      order({ id: "o-old", createdAt: "2026-03-01T10:00:00.000Z" }),
      order({ id: "o-b", createdAt: sameTime }),
    ]);

    expect(sorted.map((entry) => entry.id)).toEqual(["o-c", "o-b", "o-a", "o-old"]);
  });

  it("is input-order independent and does not mutate its input", () => {
    const sameTime = "2026-03-02T10:00:00.000Z";
    const rows = [
      order({ id: "o-a", createdAt: sameTime }),
      order({ id: "o-b", createdAt: sameTime }),
    ];

    expect(sortOrders(rows).map((entry) => entry.id)).toEqual(
      sortOrders([...rows].reverse()).map((entry) => entry.id),
    );
    expect(rows.map((entry) => entry.id)).toEqual(["o-a", "o-b"]);
  });
});

describe("order filtering", () => {
  const rows = [
    order({
      id: "o-1",
      createdAt: "2026-03-01T18:30:00.000Z",
      orderNumber: "WM-1001",
      customer: { name: "Siti", phone: "081234" },
      items: [
        {
          id: "line-1",
          menuItemId: "menu-1",
          name: "Es Teh",
          quantity: 1,
          unitPrice: IDR(5_000),
          variantSelections: [],
          note: "",
          lineTotal: IDR(5_000),
        },
      ],
    }),
    order({
      id: "o-2",
      createdAt: "2026-03-02T02:00:00.000Z",
      orderNumber: "WM-2002",
      outletId: "wm-2",
      channel: "storefront",
      status: "completed",
    }),
  ];

  it("trims and case-folds search over number, customer name/phone, and item name", () => {
    expect(filterOrders(rows, filters({ search: "  wm-1001 " })).map((entry) => entry.id)).toEqual([
      "o-1",
    ]);
    expect(filterOrders(rows, filters({ search: "SITI" })).map((entry) => entry.id)).toEqual([
      "o-1",
    ]);
    expect(filterOrders(rows, filters({ search: "1234" })).map((entry) => entry.id)).toEqual([
      "o-1",
    ]);
    expect(filterOrders(rows, filters({ search: "es teh" })).map((entry) => entry.id)).toEqual([
      "o-1",
    ]);
    expect(filterOrders(rows, filters({ search: "   " }))).toHaveLength(2);
  });

  it("combines status, outlet, channel, and dates with AND semantics", () => {
    expect(
      filterOrders(
        rows,
        filters({
          status: "completed",
          outletId: "wm-2",
          channel: "storefront",
          dateFrom: "2026-03-02",
          dateTo: "2026-03-02",
        }),
      ).map((entry) => entry.id),
    ).toEqual(["o-2"]);
  });

  it("uses the Jakarta calendar day shared with Finance and reporting", () => {
    // 18:30Z is 01:30 the next day in Jakarta. SOURCE's UTC filter put this row
    // under March 1 while its local display could show March 2.
    expect(
      filterOrders(rows, filters({ dateFrom: "2026-03-02", dateTo: "2026-03-02" })).map(
        (entry) => entry.id,
      ),
    ).toEqual(["o-1", "o-2"]);
    expect(
      filterOrders(rows, filters({ dateFrom: "2026-03-01", dateTo: "2026-03-01" })),
    ).toEqual([]);
  });

  it("rejects malformed, impossible, and reversed date ranges", () => {
    expect(() => filterOrders(rows, filters({ dateFrom: "2026-3-2" }))).toThrow(
      "Invalid order date",
    );
    expect(() => filterOrders(rows, filters({ dateFrom: "2026-02-30" }))).toThrow(
      "Invalid order date",
    );
    expect(() =>
      filterOrders(rows, filters({ dateFrom: "2026-03-03", dateTo: "2026-03-02" })),
    ).toThrow("dateFrom must not be after dateTo");
  });
});

describe("the child in a real runtime", () => {
  it("publishes the exact shared read capability and returns rows plus count", async () => {
    const { reader, dispose } = runtimeWith(
      storeOver([
        order({ id: "o-1", createdAt: "2026-03-01T00:00:00.000Z" }),
        order({ id: "o-2", createdAt: "2026-03-02T00:00:00.000Z", status: "completed" }),
      ]),
    );

    const result = await reader?.listOrders(filters({ status: "completed" }));
    expect(result).toEqual({
      status: "success",
      value: { orders: [expect.objectContaining({ id: "o-2" })], totalCount: 1 },
    });
    dispose();
  });

  it("finds an exact id and distinguishes not-found from backend failure", async () => {
    const { reader, dispose } = runtimeWith(
      storeOver([order({ id: "o-1", createdAt: "2026-03-01T00:00:00.000Z" })]),
    );

    expect(await reader?.getOrderById("o-1")).toMatchObject({
      status: "success",
      value: { id: "o-1" },
    });
    expect(await reader?.getOrderById(" o-1 ")).toMatchObject({
      status: "failure",
      reason: "not-found",
    });
    expect(await reader?.getOrderById("missing")).toMatchObject({
      status: "failure",
      reason: "not-found",
    });
    expect(await reader?.getOrderById("   ")).toMatchObject({
      status: "failure",
      reason: "invalid-input",
    });
    dispose();
  });

  it("normalizes invalid dates before doing I/O", async () => {
    let reads = 0;
    const store: OrdersStorePort = {
      ...storeOver([]),
      listOrders: async () => {
        reads += 1;
        return [];
      },
    };
    const { reader, dispose } = runtimeWith(store);

    const result = await reader?.listOrders(filters({ dateFrom: "bad-date" }));
    expect(result).toMatchObject({ status: "failure", reason: "invalid-input" });
    expect(reads).toBe(0);
    dispose();
  });

  it("carries the store's own failure message", async () => {
    const failing: OrdersStorePort = {
      ...storeOver([]),
      listOrders: async () => {
        throw new Error("orders backend unavailable");
      },
    };
    const { reader, dispose } = runtimeWith(failing);

    const result = await reader?.listOrders();
    expect(result).toMatchObject({ status: "failure", reason: "failed" });
    if (result?.status === "failure") {
      expect(result.issues[0]?.message).toBe("orders backend unavailable");
    }
    dispose();
  });

  it("still publishes without a store and reports the missing port once", async () => {
    const { reader, snapshot, dispose } = runtimeWith(undefined);

    expect(reader).toBeDefined();
    expect(await reader?.listOrders()).toMatchObject({
      status: "failure",
      reason: "unsatisfied-dependency",
    });
    expect(await reader?.getOrderById("o-1")).toMatchObject({
      status: "failure",
      reason: "unsatisfied-dependency",
    });

    const area = snapshot.areas.find((entry) => entry.engineId === ordersEngine.id);
    expect(area?.unavailableChildIds).not.toContain("admin.orders.order-read");
    expect(area?.failedChildIds).not.toContain("admin.orders.order-read");
    expect(
      snapshot.diagnostics.filter(
        (entry) => entry.source === "orderReadChild" && entry.code === "missing-dependency",
      ),
    ).toHaveLength(1);
    dispose();
  });

  it("keeps the default query unfiltered", async () => {
    const collection = queryOrders([
      order({ id: "o-1", createdAt: "2026-03-01T00:00:00.000Z" }),
      order({ id: "o-2", createdAt: "2026-03-02T00:00:00.000Z" }),
    ]);

    expect(collection.totalCount).toBe(2);
    expect(collection.orders.map((entry) => entry.id)).toEqual(["o-2", "o-1"]);
  });
});
