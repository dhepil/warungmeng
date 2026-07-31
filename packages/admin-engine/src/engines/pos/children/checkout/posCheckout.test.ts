// Protected POS checkout behavior through a probe child and real dependency graph.

import type {
  FinanceTransaction,
  InventoryMovement,
  MenuItem,
  Money,
  Order,
} from "@warungmeng/domain";
import { describe, expect, it, vi } from "vitest";
import { defineLogicChild, operationDegraded, operationFailure, operationIssue, operationSuccess } from "@warungmeng/module-system";
import { createAdminEngine } from "../../../../createAdminEngine";
import { ATOMIC_OPERATION_PORT } from "../../../../shared/atomicOperationPort";
import type { AtomicOperationPort } from "../../../../shared/atomicOperationPort";
import type { TransactionRecording } from "../../../finance/financeContracts";
import { TRANSACTION_RECORDING, TRANSACTION_RECORDING_ID } from "../../../finance/financeContracts";
import financeEngine from "../../../finance/financeEngine";
import type { StockConsumption } from "../../../inventory/inventoryContracts";
import { STOCK_CONSUMPTION, STOCK_CONSUMPTION_ID } from "../../../inventory/inventoryContracts";
import inventoryEngine from "../../../inventory/inventoryEngine";
import type { CatalogRead } from "../../../menu/menuContracts";
import { MENU_CATALOG_READ, MENU_CATALOG_READ_ID } from "../../../menu/menuContracts";
import menuEngine from "../../../menu/menuEngine";
import type { OrderSubmission } from "../../../orders/ordersContracts";
import { ORDER_SUBMISSION, ORDER_SUBMISSION_ID } from "../../../orders/ordersContracts";
import ordersEngine from "../../../orders/ordersEngine";
import type {
  PosCart,
  PosCartItem,
  PosCheckout,
  PosSession,
  SubmitPosCheckoutInput,
} from "../../posContracts";
import {
  POS_CART,
  POS_CART_ID,
  POS_CHECKOUT,
  POS_CHECKOUT_ID,
  POS_ISSUE,
  POS_SESSION,
  POS_SESSION_ID,
  posCartFingerprint,
} from "../../posContracts";
import posEngine from "../../posEngine";
import posCheckoutChild from "./posCheckoutChild";
import { calculatePosTotals, createPosOrderNumber } from "./submitPosCheckoutAtomically";

const IDR = (amount: number): Money => ({ amount, currency: "IDR" });
const occurredAt = "2026-08-01T03:30:45.000Z"; // 10:30:45 Jakarta
const outlet = { id: "wm-1", name: "WARUNG MENG" };

function item(overrides: Partial<PosCartItem> = {}): PosCartItem {
  return {
    id: "line-1",
    menuItemId: "menu-1",
    name: "Tea",
    unitPrice: IDR(9_135),
    variantSelections: [],
    quantity: 1,
    note: "",
    ...overrides,
  };
}

function menu(overrides: Partial<MenuItem> = {}): MenuItem {
  return {
    id: "menu-1",
    name: "Tea",
    slug: "tea",
    categoryId: "drinks",
    description: "",
    image: null,
    price: IDR(9_135),
    compareAtPrice: null,
    availability: { status: "available" },
    inventory: { mode: "untracked" },
    visibility: "visible",
    salesSchedule: { mode: "always" },
    variantGroupIds: [],
    sortOrder: 1,
    ...overrides,
  };
}

function checkoutInput(overrides: Partial<SubmitPosCheckoutInput> = {}): SubmitPosCheckoutInput {
  return {
    fulfillment: "dine-in",
    paymentMethod: "cash",
    cashReceived: 20_000,
    pricing: {
      discountAmount: 0,
      serviceChargeAmount: 0,
      taxRate: 0.1,
      roundingStep: 100,
    },
    occurredAt,
    ...overrides,
  };
}

function sessionOver(options: { closed?: boolean; key?: string | null } = {}): PosSession {
  let key = options.key ?? null;
  const session = options.closed
    ? ({ status: "closed", outlet, openingBalance: IDR(0), openedAt: null } as const)
    : ({ status: "open", outlet, openingBalance: IDR(100_000), openedAt: "2026-08-01T01:00:00.000Z" } as const);
  return {
    getSession: async () => operationSuccess({
      revision: key === null ? 4 : 5,
      session,
      cashSales: IDR(0),
      expectedCash: IDR(100_000),
      checkoutSequence: 1,
      checkoutKey: key,
      lastCloseRecord: null,
    }),
    beginCheckout: async () => {
      if (session.status === "closed") {
        return operationFailure("conflict", [
          operationIssue(POS_ISSUE.sessionClosed, "closed"),
        ]);
      }
      key ??= `pos:${outlet.id}:${session.openedAt}:1`;
      return operationSuccess({ key, sequence: 1, stateRevision: 5 });
    },
    openSession: async () => operationFailure("conflict", []),
    closeSession: async () => operationFailure("conflict", []),
  };
}

function cartOver(
  options: {
    items?: readonly PosCartItem[];
    clearFails?: boolean;
    mutateBeforeClear?: boolean;
  } = {},
): PosCart & {
  readonly clears: Array<{
    expectedRevision: number;
    cashSaleAmount: number;
    orderFingerprint: string;
  }>;
} {
  let items = options.items ?? [item()];
  const clears: Array<{
    expectedRevision: number;
    cashSaleAmount: number;
    orderFingerprint: string;
  }> = [];
  return {
    clears,
    getCart: async () => operationSuccess({
      revision: 5,
      items,
      itemCount: items.reduce((sum, entry) => sum + entry.quantity, 0),
      subtotal: IDR(items.reduce((sum, entry) => sum + entry.unitPrice.amount * entry.quantity, 0)),
    }),
    addItem: async () => operationFailure("failed", []),
    setItemQuantity: async () => operationFailure("failed", []),
    updateItem: async () => operationFailure("failed", []),
    removeItem: async () => operationFailure("failed", []),
    clear: async (input) => {
      clears.push({
        expectedRevision: input.expectedRevision,
        cashSaleAmount: input.checkout?.cashSaleAmount ?? 0,
        orderFingerprint: input.checkout?.orderFingerprint ?? "",
      });
      if (options.mutateBeforeClear) {
        items = [...items, item({ id: "new-line", menuItemId: "new-menu", name: "New item" })];
      }
      if (
        options.clearFails ||
        input.checkout?.orderFingerprint !== posCartFingerprint(items)
      ) {
        return operationFailure("conflict", [operationIssue(POS_ISSUE.staleState, "stale")]);
      }
      return operationSuccess({ revision: 6, items: [], itemCount: 0, subtotal: IDR(0) });
    },
  };
}

function catalogOver(menus: readonly MenuItem[] = [menu()]): CatalogRead {
  return {
    listMenus: async () => operationSuccess(menus),
    listCategories: async () => operationSuccess([]),
    listVariantGroups: async () => operationSuccess([]),
    queryMenus: async () => operationFailure("failed", []),
    queryVariantOptions: async () => operationFailure("failed", []),
  };
}

function stored(record: Omit<Order, "id">): Order {
  return { ...record, id: "order-1" };
}

function ordersOver(
  options: {
    replayed?: boolean;
    fails?: boolean;
    /** The store returns the STORED order, which may have moved on since it was written. */
    storedPaymentStatus?: Order["paymentStatus"];
  } = {},
): OrderSubmission & {
  readonly keys: string[];
} {
  const keys: string[] = [];
  return {
    keys,
    submitOrder: async (input) => {
      keys.push(input.idempotencyKey);
      if (options.fails) {
        return operationFailure("failed", [operationIssue("orders-store-failed", "down")]);
      }
      const outcome = {
        order: stored(
          options.storedPaymentStatus
            ? { ...input.order, paymentStatus: options.storedPaymentStatus }
            : input.order,
        ),
        replayed: options.replayed === true,
      };
      return options.replayed
        ? operationDegraded(outcome, [operationIssue("order-submission-replayed", "replay")])
        : operationSuccess(outcome);
    },
  };
}

function inventoryOver(options: { replayed?: boolean; fails?: boolean; skipped?: boolean } = {}): StockConsumption & {
  readonly orders: Order[];
} {
  const orders: Order[] = [];
  return {
    orders,
    consumeOrder: async (order) => {
      orders.push(order);
      if (options.fails) {
        return operationFailure("conflict", [operationIssue("negative-stock", "short")]);
      }
      const movement: InventoryMovement = {
        id: "move-1",
        ingredientId: "ingredient-1",
        outletId: order.outletId,
        type: "consumption",
        quantity: 1,
        unit: "piece",
        baseQuantityDelta: -1,
        unitCost: null,
        referenceId: order.id,
        note: "POS",
        occurredAt: order.createdAt,
      };
      const outcome = {
        movements: [movement],
        replayed: options.replayed === true,
        skippedMenuItemIds: options.skipped ? ["menu-without-recipe"] : [],
      };
      return options.replayed
        ? operationDegraded(outcome, [operationIssue("order-already-consumed", "replay")])
        : operationSuccess(outcome);
    },
  };
}

function financeOver(record = vi.fn()): TransactionRecording {
  const automatic: FinanceTransaction = {
    id: "manual-unused",
    occurredAt,
    direction: "inflow",
    type: "manual-income",
    source: "manual",
    status: "posted",
    categoryId: "sales",
    categoryLabel: "Sales",
    amount: IDR(1),
    paymentMethod: "cash",
    description: "unused",
    referenceNumber: "unused",
    sourceReference: null,
    attachment: null,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
  return {
    recordTransaction: async (...args) => {
      record(...args);
      return operationSuccess(automatic);
    },
    updateTransaction: async () => operationFailure("failed", []),
    voidTransaction: async () => operationFailure("failed", []),
  };
}

function atomicOver(restore = vi.fn()): AtomicOperationPort & { readonly rollbacks: number[] } {
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

function runtimeWith(options: {
  session?: PosSession;
  cart?: PosCart;
  catalog?: CatalogRead;
  inventory?: StockConsumption;
  orders?: OrderSubmission;
  finance?: TransactionRecording;
  atomic?: AtomicOperationPort;
  missing?: "session" | "cart" | "catalog" | "inventory" | "orders" | "finance" | "atomic";
}) {
  let captured: PosCheckout | undefined;
  const children = [
    options.missing === "session"
      ? null
      : defineLogicChild({
          id: "admin.pos.test-session",
          parentId: posEngine.id,
          provides: [POS_SESSION_ID],
          create(context) {
            context.capabilities.provide(POS_SESSION, options.session ?? sessionOver());
          },
        }),
    options.missing === "cart"
      ? null
      : defineLogicChild({
          id: "admin.pos.test-cart",
          parentId: posEngine.id,
          provides: [POS_CART_ID],
          create(context) {
            context.capabilities.provide(POS_CART, options.cart ?? cartOver());
          },
        }),
    options.missing === "catalog"
      ? null
      : defineLogicChild({
          id: "admin.menu.test-catalog",
          parentId: menuEngine.id,
          provides: [MENU_CATALOG_READ_ID],
          create(context) {
            context.capabilities.provide(MENU_CATALOG_READ, options.catalog ?? catalogOver());
          },
        }),
    options.missing === "inventory"
      ? null
      : defineLogicChild({
          id: "admin.inventory.test-consumption",
          parentId: inventoryEngine.id,
          provides: [STOCK_CONSUMPTION_ID],
          create(context) {
            context.capabilities.provide(STOCK_CONSUMPTION, options.inventory ?? inventoryOver());
          },
        }),
    options.missing === "orders"
      ? null
      : defineLogicChild({
          id: "admin.orders.test-submission",
          parentId: ordersEngine.id,
          provides: [ORDER_SUBMISSION_ID],
          create(context) {
            context.capabilities.provide(ORDER_SUBMISSION, options.orders ?? ordersOver());
          },
        }),
    options.missing === "finance"
      ? null
      : defineLogicChild({
          id: "admin.finance.test-recording",
          parentId: financeEngine.id,
          provides: [TRANSACTION_RECORDING_ID],
          create(context) {
            context.capabilities.provide(TRANSACTION_RECORDING, options.finance ?? financeOver());
          },
        }),
  ].filter((child) => child !== null);
  const probe = defineLogicChild({
    id: "admin.pos.test-checkout-probe",
    parentId: posEngine.id,
    requires: [POS_CHECKOUT_ID],
    create(context) {
      const result = context.capabilities.resolve(POS_CHECKOUT);
      if (result.status === "available") captured = result.value;
      return undefined;
    },
  });
  const runtime = createAdminEngine({
    definitions: {
      engines: [posEngine, menuEngine, inventoryEngine, ordersEngine, financeEngine],
      children: [...children, posCheckoutChild, probe],
    },
    ports: {
      resolve: (token) =>
        token.id === ATOMIC_OPERATION_PORT.id && options.missing !== "atomic"
          ? ((options.atomic ?? atomicOver()) as never)
          : undefined,
    },
  });
  return { checkout: captured, snapshot: runtime.getSnapshot(), dispose: runtime.dispose };
}

describe("POS checkout wiring", () => {
  it("publishes through a probe and declares exactly seven LOGIC §8 requirements", () => {
    const runtime = runtimeWith({});
    expect(runtime.checkout).toBeDefined();
    expect(POS_CHECKOUT_ID).toBe("admin.pos.checkout");
    expect([...posCheckoutChild.requires].sort()).toEqual(
      [
        POS_SESSION_ID,
        POS_CART_ID,
        MENU_CATALOG_READ_ID,
        STOCK_CONSUMPTION_ID,
        ORDER_SUBMISSION_ID,
        TRANSACTION_RECORDING_ID,
        "admin.atomic-operation",
      ].sort(),
    );
    runtime.dispose();
  });

  it.each(["session", "cart", "catalog", "inventory", "orders", "finance", "atomic"] as const)(
    "stays unavailable when %s requirement is missing",
    (missing) => {
      const runtime = runtimeWith({ missing });
      expect(runtime.checkout).toBeUndefined();
      expect(
        runtime.snapshot.areas.find((area) => area.engineId === posEngine.id)?.unavailableChildIds,
      ).toContain(POS_CHECKOUT_ID);
      runtime.dispose();
    },
  );
});

describe("POS checkout behavior", () => {
  it("validates session, cart, catalog, payment, then commits order, stock, derived finance, and cart", async () => {
    const cart = cartOver();
    const orders = ordersOver();
    const inventory = inventoryOver();
    const manualFinance = vi.fn();
    const runtime = runtimeWith({ cart, orders, inventory, finance: financeOver(manualFinance) });

    const result = await runtime.checkout!.submitCheckout(checkoutInput());

    expect(result).toMatchObject({
      status: "success",
      value: {
        order: {
          orderNumber: "WM-POS-260801-103045-001",
          channel: "pos",
          paymentStatus: "paid",
          totals: { rounding: { amount: -49 }, total: { amount: 10_000 } },
        },
        receipt: {
          cashReceived: { amount: 20_000 },
          change: { amount: 10_000 },
        },
      },
    });
    expect(orders.keys).toEqual(["pos:wm-1:2026-08-01T01:00:00.000Z:1"]);
    expect(inventory.orders).toHaveLength(1);
    expect(cart.clears).toEqual([
      {
        expectedRevision: 5,
        cashSaleAmount: 10_000,
        orderFingerprint: JSON.stringify([item()]),
      },
    ]);
    // D23: finance capability is required, but manual writer is never called; sale
    // derives from committed paid order with deterministic finance id.
    expect(manualFinance).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it("rolls back when the committed order does not derive exactly one sale", async () => {
    // A mutation round found the D23 guard unprotected: deleting the check that the
    // projection yields exactly one `sale` row left all 16 tests passing. Asserting
    // only "the manual writer was not called" proves there is no SECOND writer, but
    // says nothing about the row the runtime actually relies on.
    //
    // The guard is reachable, not defensive padding. Checkout stamps `paid`, but the
    // store returns the STORED order, and on an idempotent replay that order may have
    // been cancelled since it was written — the domain settles paid → refunded on
    // cancellation (orders.ts), and a refunded order projects TWO rows (sale + refund).
    // Deriving the till's sale from that silently books a refund the cash drawer never
    // paid out, which is exactly the ledger/till disagreement D23 exists to prevent.
    const atomic = atomicOver();
    const inventory = inventoryOver();
    const cart = cartOver();
    const manualFinance = vi.fn();
    const runtime = runtimeWith({
      orders: ordersOver({ storedPaymentStatus: "refunded" }),
      inventory,
      cart,
      atomic,
      finance: financeOver(manualFinance),
    });

    const result = await runtime.checkout!.submitCheckout(checkoutInput());

    expect(result.status).toBe("failure");
    expect(
      result.status === "failure" &&
        result.issues.some((issue) => issue.code === POS_ISSUE.financeFailed),
    ).toBe(true);
    // Refusing after the first write must roll every owner back, and must not
    // finalize the till: no cart clear, no cash-sale increment, no manual write.
    expect(atomic.rollbacks).toHaveLength(1);
    expect(cart.clears).toHaveLength(0);
    expect(manualFinance).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it("returns pre-write refusals without rollback or owner writes", async () => {
    const cart = cartOver({ items: [] });
    const orders = ordersOver();
    const inventory = inventoryOver();
    const atomic = atomicOver();
    const runtime = runtimeWith({ cart, orders, inventory, atomic });

    expect(await runtime.checkout!.submitCheckout(checkoutInput())).toMatchObject({
      status: "failure",
      issues: [{ code: POS_ISSUE.emptyCart }],
    });
    expect(orders.keys).toHaveLength(0);
    expect(inventory.orders).toHaveLength(0);
    expect(atomic.rollbacks).toHaveLength(0);
    runtime.dispose();
  });

  it("revalidates price/availability and refuses insufficient cash before first write", async () => {
    const orders = ordersOver();
    const unavailable = runtimeWith({
      catalog: catalogOver([menu({ availability: { status: "unavailable", unavailableUntil: null } })]),
      orders,
    });
    expect(await unavailable.checkout!.submitCheckout(checkoutInput())).toMatchObject({
      status: "failure",
      reason: "conflict",
      issues: [{ code: POS_ISSUE.menuUnavailable }],
    });
    unavailable.dispose();

    const insufficient = runtimeWith({ orders });
    expect(
      await insufficient.checkout!.submitCheckout(checkoutInput({ cashReceived: 9_999 })),
    ).toMatchObject({ status: "failure", issues: [{ code: POS_ISSUE.paymentInsufficient }] });
    expect(orders.keys).toHaveLength(0);
    insufficient.dispose();
  });

  it("throws after first write so inventory failure rolls every owner back", async () => {
    const restore = vi.fn();
    const atomic = atomicOver(restore);
    const runtime = runtimeWith({ inventory: inventoryOver({ fails: true }), atomic });

    const result = await runtime.checkout!.submitCheckout(checkoutInput());

    expect(result.status).toBe("failure");
    expect(
      result.status === "failure" &&
        result.issues.some((issue) => issue.code === POS_ISSUE.inventoryFailed),
    ).toBe(true);
    expect(atomic.rollbacks).toHaveLength(1);
    expect(restore).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it("rolls back when committed-cart finalization sees a newer revision", async () => {
    const atomic = atomicOver();
    const runtime = runtimeWith({ cart: cartOver({ clearFails: true }), atomic });

    const result = await runtime.checkout!.submitCheckout(checkoutInput());
    expect(result.status).toBe("failure");
    expect(
      result.status === "failure" &&
        result.issues.some((issue) => issue.code === POS_ISSUE.finalizationFailed),
    ).toBe(true);
    expect(atomic.rollbacks).toHaveLength(1);
    runtime.dispose();
  });

  it("preserves items added after submission instead of clearing newer cart content", async () => {
    const atomic = atomicOver();
    const runtime = runtimeWith({ cart: cartOver({ mutateBeforeClear: true }), atomic });

    const result = await runtime.checkout!.submitCheckout(checkoutInput());

    expect(result.status).toBe("failure");
    expect(atomic.rollbacks).toHaveLength(1);
    runtime.dispose();
  });

  it("reuses stable identity and reports order/inventory replays instead of duplicating", async () => {
    const session = sessionOver({ key: "stable-checkout-key" });
    const orders = ordersOver({ replayed: true });
    const inventory = inventoryOver({ replayed: true });
    const runtime = runtimeWith({ session, orders, inventory });

    const result = await runtime.checkout!.submitCheckout(checkoutInput());

    expect(result).toMatchObject({
      status: "degraded",
      value: { orderReplayed: true, inventoryReplayed: true },
      issues: expect.arrayContaining([
        expect.objectContaining({ code: POS_ISSUE.orderReplay }),
        expect.objectContaining({ code: POS_ISSUE.inventoryReplay }),
      ]),
    });
    expect(orders.keys).toEqual(["stable-checkout-key"]);
    runtime.dispose();
  });
});

describe("POS checkout pure calculations", () => {
  it("preserves nearest-Rp100 signed rounding and Jakarta order-number time", () => {
    expect(calculatePosTotals([item()], checkoutInput().pricing)).toMatchObject({
      subtotal: { amount: 9_135 },
      tax: { amount: 914 },
      rounding: { amount: -49 },
      total: { amount: 10_000 },
    });
    expect(createPosOrderNumber(occurredAt, 7)).toBe("WM-POS-260801-103045-007");
  });
});
