// packages/domain/src/domainRules.test.ts
//
// Protected-behavior tests for the pure domain package. Consolidated from the SOURCE
// per-module tests (catalog, orders, inventory, finance) into one suite that exercises
// the public barrel. These lock in the behavior the port must preserve, and are the
// safety net for the optional S7 tidy pass.

import { describe, expect, it } from "vitest";
import type {
  FinanceTransaction,
  InventoryIngredient,
  InventoryStockBalance,
  MenuCategory,
  MenuItem,
  MenuRecipe,
  MenuVariantGroup,
  Money,
  Order,
} from "./index";
import {
  applyStockDelta,
  areInventoryUnitsCompatible,
  buildFinanceLedger,
  calculateGrossMarginPercentage,
  calculateMenuHpp,
  calculateMovementBaseDelta,
  calculateRecommendedSellingPrice,
  canTransitionOrderStatus,
  convertInventoryQuantity,
  getAllowedOrderStatusTransitions,
  isLowStock,
  isMenuAvailable,
  transitionOrderStatus,
  validateMenuCategory,
  validateMenuItem,
  validateMenuVariantGroup,
} from "./index";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const zero: Money = { amount: 0, currency: "IDR" };

function createMenu(overrides: Partial<MenuItem> = {}): MenuItem {
  return {
    id: "menu-1",
    name: "Gado-gado",
    slug: "gado-gado",
    categoryId: "category-food",
    description: "Sayuran dengan saus kacang",
    image: null,
    price: { amount: 22_000, currency: "IDR" },
    compareAtPrice: null,
    availability: { status: "available" },
    inventory: { mode: "untracked" },
    visibility: "visible",
    salesSchedule: { mode: "always" },
    variantGroupIds: [],
    sortOrder: 0,
    ...overrides,
  };
}

function createVariantGroup(overrides: Partial<MenuVariantGroup> = {}): MenuVariantGroup {
  return {
    id: "variant-temperature",
    name: "Suhu",
    description: "",
    visibility: "visible",
    selection: { minSelections: 1, maxSelections: 1 },
    options: [
      {
        id: "hot",
        name: "Panas",
        priceAdjustment: { amount: 0, currency: "IDR" },
        availability: { status: "available" },
        inventory: { mode: "untracked" },
        sortOrder: 0,
      },
    ],
    sortOrder: 0,
    ...overrides,
  };
}

function createOrder(): Order {
  return {
    id: "order-1",
    orderNumber: "WM-001",
    outletId: "wm-1",
    outletName: "WARUNG MENG",
    channel: "pos",
    fulfillment: "takeaway",
    paymentStatus: "paid",
    paymentMethod: "cash",
    status: "new",
    customer: null,
    items: [],
    totals: {
      subtotal: zero,
      discount: zero,
      tax: zero,
      serviceCharge: zero,
      rounding: zero,
      total: { amount: 22_000, currency: "IDR" },
    },
    customerNote: "",
    internalNote: "",
    createdAt: "2026-07-19T10:00:00.000Z",
    updatedAt: "2026-07-19T10:00:00.000Z",
    events: [{ id: "event-1", status: "new", occurredAt: "2026-07-19T10:00:00.000Z", note: "" }],
  };
}

const ingredient: InventoryIngredient = {
  id: "rice",
  name: "Rice",
  baseUnit: "g",
  supplierId: null,
  status: "active",
  minimumStock: 1000,
  lastPurchaseUnitCost: { amount: 0.02, currency: "IDR" },
  averageUnitCost: { amount: 0.02, currency: "IDR" },
};
const balance: InventoryStockBalance = {
  ingredientId: "rice",
  outletId: "wm-1",
  quantity: 1200,
  updatedAt: "2026-07-19T00:00:00.000Z",
};

// ─── Catalog ─────────────────────────────────────────────────────────────────

describe("catalog validation", () => {
  it("accepts valid category, menu, and variant group entities", () => {
    const category: MenuCategory = {
      id: "category-food",
      name: "Makanan",
      slug: "makanan",
      visibility: "visible",
      sortOrder: 0,
    };

    expect(validateMenuCategory(category)).toEqual([]);
    expect(validateMenuItem(createMenu())).toEqual([]);
    expect(validateMenuVariantGroup(createVariantGroup())).toEqual([]);
  });

  it("rejects invalid money, compare price, and tracked inventory", () => {
    const issues = validateMenuItem(
      createMenu({
        price: { amount: -1, currency: "IDR" },
        compareAtPrice: { amount: -2, currency: "IDR" },
        inventory: { mode: "tracked", quantity: -1 },
      }),
    );

    expect(issues).toEqual(
      expect.arrayContaining([
        { path: "price", code: "invalid_money" },
        { path: "compareAtPrice", code: "invalid_money" },
        { path: "compareAtPrice.amount", code: "invalid_range" },
        { path: "inventory.quantity", code: "invalid_integer" },
      ]),
    );
  });

  it("rejects malformed, duplicate, and overlapping scheduled intervals", () => {
    const issues = validateMenuItem(
      createMenu({
        salesSchedule: {
          mode: "scheduled",
          activeDays: ["mon", "mon"],
          allDay: false,
          intervals: [
            { id: "morning", start: "09:00", end: "12:00" },
            { id: "morning", start: "11:00", end: "13:00" },
            { id: "broken", start: "25:00", end: "08:00" },
          ],
        },
      }),
    );

    expect(issues).toEqual(
      expect.arrayContaining([
        { path: "salesSchedule.activeDays.1", code: "duplicate" },
        { path: "salesSchedule.intervals.id.1", code: "duplicate" },
        { path: "salesSchedule.intervals.1", code: "overlap" },
        { path: "salesSchedule.intervals.2.start", code: "invalid_time" },
      ]),
    );
  });

  it("rejects invalid variant selection rules and duplicate option IDs", () => {
    const baseOption = createVariantGroup().options[0];
    if (!baseOption) throw new Error("Test fixture requires one option");

    const issues = validateMenuVariantGroup(
      createVariantGroup({
        selection: { minSelections: 2, maxSelections: 3 },
        options: [baseOption, { ...baseOption, name: "Dingin" }],
      }),
    );

    expect(issues).toEqual(
      expect.arrayContaining([
        { path: "selection.maxSelections", code: "invalid_range" },
        { path: "options.id.1", code: "duplicate" },
      ]),
    );
  });
});

describe("isMenuAvailable", () => {
  const now = new Date("2026-07-18T12:00:00.000Z");

  it("handles inventory and temporary availability independently of visibility", () => {
    expect(isMenuAvailable(createMenu({ visibility: "hidden" }), now)).toBe(true);
    expect(isMenuAvailable(createMenu({ inventory: { mode: "tracked", quantity: 0 } }), now)).toBe(
      false,
    );
    expect(
      isMenuAvailable(
        createMenu({
          availability: { status: "unavailable", unavailableUntil: "2026-07-18T11:00:00.000Z" },
        }),
        now,
      ),
    ).toBe(true);
    expect(
      isMenuAvailable(
        createMenu({
          availability: { status: "unavailable", unavailableUntil: "2026-07-18T13:00:00.000Z" },
        }),
        now,
      ),
    ).toBe(false);
  });
});

// ─── Orders ──────────────────────────────────────────────────────────────────

describe("order status transitions", () => {
  it("exposes only the valid next states", () => {
    expect(getAllowedOrderStatusTransitions("new")).toEqual(["accepted", "cancelled"]);
    expect(getAllowedOrderStatusTransitions("completed")).toEqual([]);
    expect(canTransitionOrderStatus("preparing", "ready")).toBe(true);
    expect(canTransitionOrderStatus("preparing", "completed")).toBe(false);
  });

  it("returns a new order and appends an event for a valid transition", () => {
    const order = createOrder();
    const updated = transitionOrderStatus(order, "accepted", "2026-07-19T10:05:00.000Z", "event-2");

    expect(updated).toMatchObject({ status: "accepted", updatedAt: "2026-07-19T10:05:00.000Z" });
    expect(updated?.events).toHaveLength(2);
    expect(order.status).toBe("new");
    expect(order.events).toHaveLength(1);
  });

  it("rejects invalid and terminal transitions", () => {
    const order = createOrder();

    expect(transitionOrderStatus(order, "ready", "2026-07-19T10:05:00.000Z", "event-2")).toBeNull();
    expect(
      transitionOrderStatus(
        { ...order, status: "completed" },
        "cancelled",
        "2026-07-19T10:05:00.000Z",
        "event-2",
      ),
    ).toBeNull();
  });

  it("settles a paid order as refunded when it is cancelled (QA-ADM-005)", () => {
    const cancelled = transitionOrderStatus(
      createOrder(),
      "cancelled",
      "2026-07-19T11:00:00.000Z",
      "e-2",
    );
    expect(cancelled).toMatchObject({ status: "cancelled", paymentStatus: "refunded" });
  });

  it("keeps the payment status when cancelling an unpaid order", () => {
    const order = { ...createOrder(), paymentStatus: "unpaid" as const };
    const cancelled = transitionOrderStatus(order, "cancelled", "2026-07-19T11:00:00.000Z", "e-2");
    expect(cancelled).toMatchObject({ status: "cancelled", paymentStatus: "unpaid" });
  });
});

// ─── Inventory ───────────────────────────────────────────────────────────────

describe("inventory unit conversion", () => {
  it("converts across compatible units and rejects incompatible or negative input", () => {
    expect(convertInventoryQuantity(1.5, "kg", "g")).toBe(1500);
    expect(convertInventoryQuantity(750, "ml", "l")).toBe(0.75);
    expect(areInventoryUnitsCompatible("g", "ml")).toBe(false);
    expect(() => convertInventoryQuantity(1, "g", "ml")).toThrow(RangeError);
    expect(() => convertInventoryQuantity(-1, "kg", "g")).toThrow(RangeError);
  });
});

describe("inventory stock", () => {
  it("signs movement deltas and guards against a negative balance", () => {
    expect(calculateMovementBaseDelta(ingredient, { type: "purchase", quantity: 2, unit: "kg" })).toBe(
      2000,
    );
    expect(
      calculateMovementBaseDelta(ingredient, { type: "consumption", quantity: 250, unit: "g" }),
    ).toBe(-250);
    expect(() => applyStockDelta(balance, -1201)).toThrow(RangeError);
    expect(isLowStock(ingredient, { ...balance, quantity: 1000 })).toBe(true);
    expect(isLowStock(ingredient, balance)).toBe(false);
  });
});

// ─── Finance (HPP + ledger) ──────────────────────────────────────────────────

describe("HPP and pricing math", () => {
  const hppIngredients: InventoryIngredient[] = [
    {
      id: "tea",
      name: "Tea",
      baseUnit: "g",
      supplierId: null,
      status: "active",
      minimumStock: 0,
      lastPurchaseUnitCost: { amount: 100, currency: "IDR" },
      averageUnitCost: { amount: 100, currency: "IDR" },
    },
  ];
  const recipe: MenuRecipe = {
    menuItemId: "iced-tea",
    components: [
      { id: "component-1", ingredientId: "tea", quantity: 10, unit: "g", wastePercentage: 10 },
    ],
    packagingCost: { amount: 500, currency: "IDR" },
    additionalCost: { amount: 250, currency: "IDR" },
    updatedAt: "2026-07-19T00:00:00.000Z",
  };

  it("calculates ingredient, waste, packaging, and additional costs", () => {
    const hpp = calculateMenuHpp(recipe, hppIngredients);
    expect(hpp.ingredientTotal.amount).toBe(1100);
    expect(hpp.total.amount).toBe(1850);
  });

  it("computes margin and recommended price, and rejects a missing ingredient", () => {
    expect(calculateGrossMarginPercentage(10_000, 4000)).toBe(60);
    expect(calculateGrossMarginPercentage(0, 4000)).toBeNull();
    expect(calculateRecommendedSellingPrice(4100, 60, 500)).toBe(10_500);
    expect(() => calculateMenuHpp(recipe, [])).toThrow(RangeError);
  });
});

describe("finance ledger projection", () => {
  it("projects a paid order into a posted sale transaction", () => {
    const ledger = buildFinanceLedger([createOrder()], []);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      type: "sale",
      status: "posted",
      direction: "inflow",
      amount: { amount: 22_000, currency: "IDR" },
    });
  });

  it("omits unpaid orders from the ledger", () => {
    const unpaid = { ...createOrder(), paymentStatus: "unpaid" as const };
    expect(buildFinanceLedger([unpaid], [])).toHaveLength(0);
  });

  it("deep-clones merged manual transactions (no shared references)", () => {
    const manual: FinanceTransaction = {
      id: "manual-1",
      occurredAt: "2026-07-20T07:00:00.000Z",
      direction: "outflow",
      type: "expense",
      source: "manual",
      status: "posted",
      categoryId: "ingredients",
      categoryLabel: "Bahan Baku",
      amount: { amount: 10_000, currency: "IDR" },
      paymentMethod: "cash",
      description: "Belanja bahan",
      referenceNumber: "EXP-001",
      sourceReference: null,
      attachment: null,
      createdAt: "2026-07-20T07:00:00.000Z",
      updatedAt: "2026-07-20T07:00:00.000Z",
    };
    const ledger = buildFinanceLedger([createOrder()], [manual]);

    expect(ledger.map((transaction) => transaction.id)).toEqual([
      "manual-1",
      "finance-order-order-1-sale",
    ]);
    expect(ledger[0]).toEqual(manual);
    expect(ledger[0]).not.toBe(manual);
    expect(ledger[0]?.amount).not.toBe(manual.amount);
  });
});
