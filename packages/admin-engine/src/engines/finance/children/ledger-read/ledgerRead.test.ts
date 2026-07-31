// packages/admin-engine/src/engines/finance/children/ledger-read/ledgerRead.test.ts
//
// Protected behavior for the merged finance ledger.
//
// Load-bearing sections: "one failed source does not erase the other" protects the
// S5 degrading-policy rule; "one calendar-day rule" protects the correction from
// machine-local preset + UTC filtering to one Jakarta-day interpretation.

import { describe, expect, it, vi } from "vitest";
import type { FinanceTransaction, Money, Order } from "@warungmeng/domain";
import { defineLogicChild } from "@warungmeng/module-system";
import type { AdminEngineSnapshot } from "../../../../adminEngineContracts";
import { createAdminEngine } from "../../../../createAdminEngine";
import type {
  FinanceOrderReadPort,
  FinanceStorePort,
  LedgerRead,
  ManualTransactionRecord,
} from "../../financeContracts";
import {
  FINANCE_ORDER_READ_PORT,
  FINANCE_STORE_PORT,
  LEDGER_READ,
  LEDGER_READ_ID,
} from "../../financeContracts";
import financeEngine from "../../financeEngine";
import ledgerReadChild, {
  identifyFinanceDateRange,
  queryFinanceTransactions,
  resolveFinanceDatePreset,
} from "./ledgerReadChild";

const IDR = (amount: number): Money => ({ amount, currency: "IDR" });

function order(overrides: Partial<Order> & Pick<Order, "id">): Order {
  return {
    orderNumber: `WM-${overrides.id}`,
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
      subtotal: IDR(50_000),
      discount: IDR(0),
      tax: IDR(0),
      serviceCharge: IDR(0),
      rounding: IDR(0),
      total: IDR(50_000),
    },
    customerNote: "",
    internalNote: "",
    createdAt: "2026-03-01T02:00:00.000Z",
    updatedAt: "2026-03-01T02:00:00.000Z",
    events: [],
    ...overrides,
  };
}

function transaction(
  overrides: Partial<FinanceTransaction> & Pick<FinanceTransaction, "id">,
): FinanceTransaction {
  return {
    occurredAt: "2026-03-01T03:00:00.000Z",
    direction: "outflow",
    type: "expense",
    source: "manual",
    status: "posted",
    categoryId: "ingredients",
    categoryLabel: "Bahan Baku",
    amount: IDR(10_000),
    paymentMethod: "cash",
    description: "Rice",
    referenceNumber: "EXP-1",
    sourceReference: null,
    attachment: null,
    createdAt: "2026-03-01T03:00:00.000Z",
    updatedAt: "2026-03-01T03:00:00.000Z",
    ...overrides,
  };
}

function financeStoreOver(options: {
  rows?: readonly FinanceTransaction[];
  fail?: boolean;
} = {}): FinanceStorePort {
  const unsupported = (): never => {
    throw new Error("not used by ledger-read");
  };
  return {
    listManualTransactions: async () => {
      if (options.fail) throw new Error("manual ledger unavailable");
      return options.rows ?? [];
    },
    createManualTransaction: unsupported,
    updateManualTransaction: unsupported,
    voidManualTransaction: unsupported,
  };
}

function orderReadOver(options: { rows?: readonly Order[]; fail?: boolean } = {}): FinanceOrderReadPort {
  return {
    listOrders: vi.fn(async () => {
      if (options.fail) throw new Error("orders unavailable");
      return options.rows ?? [];
    }),
  };
}

function runtimeWith(options: {
  store?: FinanceStorePort;
  orders?: FinanceOrderReadPort;
}): {
  readonly ledger: LedgerRead | undefined;
  readonly snapshot: AdminEngineSnapshot;
  readonly dispose: () => void;
} {
  let captured: LedgerRead | undefined;
  const probe = defineLogicChild({
    id: "admin.finance.test-probe",
    parentId: financeEngine.id,
    requires: [LEDGER_READ_ID],
    create(context) {
      const resolution = context.capabilities.resolve(LEDGER_READ);
      if (resolution.status === "available") captured = resolution.value;
      return undefined;
    },
  });

  const engine = createAdminEngine({
    definitions: { engines: [financeEngine], children: [ledgerReadChild, probe] },
    ports: {
      resolve: (token) => {
        if (token.id === FINANCE_STORE_PORT.id) return options.store as never;
        if (token.id === FINANCE_ORDER_READ_PORT.id) return options.orders as never;
        return undefined;
      },
    },
  });

  return { ledger: captured, snapshot: engine.getSnapshot(), dispose: engine.dispose };
}

// ─── Merging and ordering ────────────────────────────────────────────────────

describe("the merged ledger", () => {
  it("combines manual rows with sale and refund rows derived from orders", async () => {
    const { ledger, dispose } = runtimeWith({
      store: financeStoreOver({ rows: [transaction({ id: "manual-1" })] }),
      orders: orderReadOver({
        rows: [order({ id: "paid" }), order({ id: "refunded", paymentStatus: "refunded" })],
      }),
    });

    const result = await ledger!.listTransactions();
    expect(result.status).toBe("success");
    if (result.status !== "failure") {
      expect(result.value.map((row) => row.type).sort()).toEqual([
        "expense",
        "refund",
        "sale",
        "sale",
      ]);
    }
    dispose();
  });

  it("does not derive a transaction from an unpaid order", async () => {
    const { ledger, dispose } = runtimeWith({
      store: financeStoreOver(),
      orders: orderReadOver({ rows: [order({ id: "unpaid", paymentStatus: "unpaid" })] }),
    });

    const result = await ledger!.listTransactions();
    expect(result.status === "failure" ? null : result.value).toEqual([]);
    dispose();
  });

  it("orders newest first with id as the tie-break", async () => {
    const occurredAt = "2026-03-04T10:00:00.000Z";
    const { ledger, dispose } = runtimeWith({
      store: financeStoreOver({
        rows: [
          transaction({ id: "b", occurredAt }),
          transaction({ id: "a", occurredAt }),
          transaction({ id: "newest", occurredAt: "2026-03-05T10:00:00.000Z" }),
        ],
      }),
      orders: orderReadOver(),
    });

    const result = await ledger!.listTransactions();
    expect(result.status === "failure" ? [] : result.value.map((row) => row.id)).toEqual([
      "newest",
      "a",
      "b",
    ]);
    dispose();
  });

  it("requests only the configured outlet from the order reader", async () => {
    const orders = orderReadOver();
    const { ledger, dispose } = runtimeWith({ store: financeStoreOver(), orders });

    await ledger!.listTransactions("outlet-2");
    expect(orders.listOrders).toHaveBeenCalledWith({ outletId: "outlet-2" });
    dispose();
  });
});

// ─── One failed source does not erase the other ──────────────────────────────

describe("one failed source does not erase the other", () => {
  it("keeps derived sales when the manual store fails", async () => {
    const { ledger, dispose } = runtimeWith({
      store: financeStoreOver({ fail: true }),
      orders: orderReadOver({ rows: [order({ id: "o1" })] }),
    });

    const result = await ledger!.listTransactions();
    expect(result.status).toBe("degraded");
    if (result.status === "degraded") {
      expect(result.value.map((row) => row.type)).toEqual(["sale"]);
      expect(result.issues.map((issue) => issue.code)).toContain("finance-store-failed");
    }
    dispose();
  });

  it("keeps manual expenses when the order reader fails", async () => {
    const { ledger, dispose } = runtimeWith({
      store: financeStoreOver({ rows: [transaction({ id: "expense-1" })] }),
      orders: orderReadOver({ fail: true }),
    });

    const result = await ledger!.listTransactions();
    expect(result.status).toBe("degraded");
    if (result.status === "degraded") {
      expect(result.value.map((row) => row.id)).toEqual(["expense-1"]);
      expect(result.issues.map((issue) => issue.code)).toContain("finance-order-read-failed");
    }
    dispose();
  });

  it("publishes an honest failure when neither port exists", async () => {
    const { ledger, snapshot, dispose } = runtimeWith({});

    expect(ledger).toBeDefined();
    await expect(ledger!.listTransactions()).resolves.toMatchObject({
      status: "failure",
      reason: "unsatisfied-dependency",
    });
    const missing = snapshot.diagnostics.filter((entry) => entry.code === "missing-dependency");
    expect(missing).toHaveLength(1);
    expect(missing[0]?.message).toContain("manual-transaction store");
    expect(missing[0]?.message).toContain("order reader");
    dispose();
  });
});

// ─── One calendar-day rule ───────────────────────────────────────────────────

describe("one calendar-day rule", () => {
  const now = new Date("2026-03-01T18:00:00.000Z"); // 02 Mar 01:00 in Jakarta.

  it("resolves today in Jakarta rather than UTC or the machine's local zone", () => {
    expect(resolveFinanceDatePreset("today", now)).toEqual({
      dateFrom: "2026-03-02",
      dateTo: "2026-03-02",
    });
  });

  it("makes last7 inclusive of today and six preceding days", () => {
    expect(resolveFinanceDatePreset("last7", now)).toEqual({
      dateFrom: "2026-02-24",
      dateTo: "2026-03-02",
    });
  });

  it("makes month start on the first day of Jakarta's current month", () => {
    expect(resolveFinanceDatePreset("month", now)).toEqual({
      dateFrom: "2026-03-01",
      dateTo: "2026-03-02",
    });
  });

  it("identifies a matching preset and calls a different range custom", () => {
    expect(identifyFinanceDateRange({ dateFrom: "2026-02-24", dateTo: "2026-03-02" }, now)).toBe(
      "last7",
    );
    expect(identifyFinanceDateRange({ dateFrom: "2026-02-25", dateTo: "2026-03-02" }, now)).toBe(
      "custom",
    );
  });

  it("includes a late-UTC transaction in the next Jakarta calendar day", () => {
    const row = transaction({ id: "near-midnight", occurredAt: "2026-03-01T17:30:00.000Z" });

    expect(
      queryFinanceTransactions([row], { dateFrom: "2026-03-02", dateTo: "2026-03-02" }),
    ).toEqual([row]);
    expect(
      queryFinanceTransactions([row], { dateFrom: "2026-03-01", dateTo: "2026-03-01" }),
    ).toEqual([]);
  });

  it("rejects malformed and reversed date windows as invalid input", async () => {
    const { ledger, dispose } = runtimeWith({ store: financeStoreOver(), orders: orderReadOver() });

    await expect(ledger!.queryLedger({ dateFrom: "2026-02-31" })).resolves.toMatchObject({
      status: "failure",
      reason: "invalid-input",
    });
    await expect(
      ledger!.queryLedger({ dateFrom: "2026-03-02", dateTo: "2026-03-01" }),
    ).resolves.toMatchObject({ status: "failure", reason: "invalid-input" });
    dispose();
  });
});

// ─── One filtered set owns every projection ──────────────────────────────────

describe("the ledger view", () => {
  it("summaries, payment methods, expenses, recent rows all use the same filtered set", async () => {
    const { ledger, dispose } = runtimeWith({
      store: financeStoreOver({
        rows: [
          transaction({ id: "cash-expense", amount: IDR(10_000) }),
          transaction({
            id: "qris-income",
            direction: "inflow",
            type: "manual-income",
            categoryId: "other-income",
            categoryLabel: "Other",
            amount: IDR(40_000),
            paymentMethod: "qris",
          }),
          transaction({ id: "voided", status: "voided", amount: IDR(999_000) }),
        ],
      }),
      orders: orderReadOver(),
    });

    const result = await ledger!.queryLedger({ status: "posted" });
    expect(result.status).toBe("success");
    if (result.status !== "failure") {
      expect(result.value.transactions).toHaveLength(2);
      expect(result.value.summary).toMatchObject({
        totalInflow: IDR(40_000),
        totalOutflow: IDR(10_000),
        netCashflow: IDR(30_000),
        postedCount: 2,
      });
      expect(result.value.paymentMethods).toHaveLength(2);
      expect(result.value.expenseCategories).toMatchObject([
        { categoryId: "ingredients", total: IDR(10_000), transactionCount: 1 },
      ]);
      expect(result.value.recentTransactions).toEqual(result.value.transactions);
    }
    dispose();
  });

  it("keeps only five recent rows while preserving the full collection", async () => {
    const rows = Array.from({ length: 7 }, (_, index) =>
      transaction({ id: `t-${index}`, occurredAt: `2026-03-0${index + 1}T03:00:00.000Z` }),
    );
    const { ledger, dispose } = runtimeWith({
      store: financeStoreOver({ rows }),
      orders: orderReadOver(),
    });

    const result = await ledger!.queryLedger();
    if (result.status === "failure") throw new Error("expected a usable ledger");
    expect(result.value.transactions).toHaveLength(7);
    expect(result.value.recentTransactions).toHaveLength(5);
    expect(result.value.recentTransactions[0]?.id).toBe("t-6");
    dispose();
  });

  it("filters by search and payment method in the child, not the store", async () => {
    // The fake store ignores the query entirely. The child must still enforce it.
    const { ledger, dispose } = runtimeWith({
      store: financeStoreOver({
        rows: [
          transaction({ id: "rice", description: "Buy rice", paymentMethod: "cash" }),
          transaction({ id: "power", description: "Electric bill", paymentMethod: "card" }),
        ],
      }),
      orders: orderReadOver(),
    });

    const result = await ledger!.queryLedger({ search: "electric", paymentMethod: "card" });
    expect(result.status === "failure" ? [] : result.value.transactions.map((row) => row.id)).toEqual([
      "power",
    ]);
    dispose();
  });
});
