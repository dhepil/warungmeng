// packages/admin-engine/src/engines/inventory/children/stock-adjustment/stockAdjustment.test.ts
//
// Protected behavior for the Inventory area's manual write side.
//
// Three layers here rather than two. `planStockMovement` is tested directly
// because it is the shared primitive S5's consumption and reversal also go
// through, so its invariants are the area's, not this child's. The ingredient
// validation is tested directly. The child itself goes through a real Admin
// runtime with an injected store.
//
// The section that matters most is "nothing is written before it is decided" —
// SOURCE's write left a balance row behind when it refused a movement.
//
// No React, no DOM, no renderer (LOGIC §6).

import { describe, expect, it } from "vitest";
import type {
  InventoryIngredient,
  InventoryStockBalance,
  InventoryUnit,
  Money,
} from "@warungmeng/domain";
import { defineLogicChild } from "@warungmeng/module-system";
import type { AdminEngineSnapshot } from "../../../../adminEngineContracts";
import { createAdminEngine } from "../../../../createAdminEngine";
import type {
  InventoryStorePort,
  RecordMovementInput,
  StockAdjustment,
  StockMovementCommit,
} from "../../inventoryContracts";
import {
  INVENTORY_STORE_PORT,
  MOVEMENT_ISSUE,
  planStockMovement,
  recomputeAverageUnitCost,
  roundEntered,
  STOCK_ADJUSTMENT,
  STOCK_ADJUSTMENT_ID,
} from "../../inventoryContracts";
import inventoryEngine from "../../inventoryEngine";
import stockAdjustmentChild, { validateIngredientValues } from "./stockAdjustmentChild";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const OUTLET = "wm-1";
const WHEN = "2026-03-01T10:00:00.000Z";
const IDR = (amount: number): Money => ({ amount, currency: "IDR" });

function ingredient(
  overrides: Partial<InventoryIngredient> & Pick<InventoryIngredient, "id" | "name">,
): InventoryIngredient {
  return {
    baseUnit: "g",
    supplierId: null,
    status: "active",
    minimumStock: 10,
    lastPurchaseUnitCost: IDR(100),
    averageUnitCost: IDR(100),
    ...overrides,
  };
}

function balance(
  overrides: Partial<InventoryStockBalance> & Pick<InventoryStockBalance, "ingredientId">,
): InventoryStockBalance {
  return {
    outletId: OUTLET,
    quantity: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const draft = (overrides: Partial<RecordMovementInput> = {}): RecordMovementInput => ({
  ingredientId: "i1",
  outletId: OUTLET,
  type: "adjustment-in",
  quantity: 5,
  unit: "g",
  unitCost: null,
  note: "",
  occurredAt: WHEN,
  ...overrides,
});

/** Calls the shared primitive with a fixed movement id. */
function plan(
  input: RecordMovementInput,
  subject: InventoryIngredient | null,
  current: InventoryStockBalance | null = null,
) {
  return planStockMovement(
    { ...input, quantitySource: "entered", referenceId: null },
    subject,
    current,
    "mv-1",
  );
}

/** A recording store that captures what it was asked to write. */
function storeOver(seed: {
  ingredients?: readonly InventoryIngredient[];
  balances?: readonly InventoryStockBalance[];
  failCommit?: boolean;
}): InventoryStorePort & {
  readonly commits: StockMovementCommit[];
  readonly patches: { id: string; patch: unknown }[];
} {
  const commits: StockMovementCommit[] = [];
  const patches: { id: string; patch: unknown }[] = [];
  let ingredients = [...(seed.ingredients ?? [])];

  return {
    commits,
    patches,
    listIngredients: async () => ingredients,
    getIngredientById: async (id) => ingredients.find((entry) => entry.id === id) ?? null,
    createIngredient: async (input) => {
      const created = { ...input, id: "ing-new" };
      ingredients = [...ingredients, created];
      return created;
    },
    updateIngredient: async (id, patch) => {
      patches.push({ id, patch });
      const found = ingredients.find((entry) => entry.id === id);
      if (found === undefined) {
        return null;
      }
      const updated = { ...found, ...patch };
      ingredients = ingredients.map((entry) => (entry.id === id ? updated : entry));
      return updated;
    },
    listSuppliers: async () => [],
    listStockBalances: async (outletId) =>
      (seed.balances ?? []).filter(
        (entry) => outletId === undefined || entry.outletId === outletId,
      ),
    listMovements: async () => [],
    listRecipes: async () => [],
    commitMovement: async (commit) => {
      if (seed.failCommit === true) {
        throw new Error("commit rejected");
      }
      commits.push(commit);
    },
    commitMovements: async (batch) => {
      if (seed.failCommit === true) {
        throw new Error("commit rejected");
      }
      commits.push(...batch);
    },
    newId: (kind) => `${kind}-test`,
  };
}

/**
 * Composes a real Admin runtime holding the Inventory area plus a probe child
 * that REQUIRES the write capability and captures it — so a capability published
 * under the wrong id fails the suite, which a direct `create()` could not catch.
 */
function runtimeWith(store?: InventoryStorePort): {
  readonly writes: StockAdjustment | undefined;
  readonly snapshot: AdminEngineSnapshot;
  readonly dispose: () => void;
} {
  let captured: StockAdjustment | undefined;

  const probe = defineLogicChild({
    id: "admin.inventory.test-probe",
    parentId: inventoryEngine.id,
    requires: [STOCK_ADJUSTMENT_ID],
    create(context) {
      const resolution = context.capabilities.resolve(STOCK_ADJUSTMENT);
      if (resolution.status === "available") {
        captured = resolution.value;
      }
      return undefined;
    },
  });

  const engine = createAdminEngine({
    definitions: { engines: [inventoryEngine], children: [stockAdjustmentChild, probe] },
    ports: {
      resolve: (token) =>
        token.id === INVENTORY_STORE_PORT.id && store !== undefined ? (store as never) : undefined,
    },
  });

  return { writes: captured, snapshot: engine.getSnapshot(), dispose: engine.dispose };
}

// ─── The rules that were living in form props ────────────────────────────────
//
// Each of these was an AntD attribute in SOURCE, so it applied only to the one
// dialog and any other caller skipped it entirely.

describe("movement rules lifted out of the form", () => {
  const flour = ingredient({ id: "i1", name: "Flour", baseUnit: "g" });

  it("refuses a quantity below the minimum, which logic used to accept", () => {
    // The domain rejects only negatives, so a zero-quantity movement was legal
    // and would write a ledger row that changed no stock. Only `min: 0.01` on
    // the widget prevented it.
    const zero = plan(draft({ quantity: 0 }), flour);
    expect(zero.status).toBe("failure");
    if (zero.status === "failure") {
      expect(zero.reason).toBe("invalid-input");
      expect(zero.issues[0]?.code).toBe(MOVEMENT_ISSUE.quantityTooSmall);
    }

    expect(plan(draft({ quantity: 0.01 }), flour).status).toBe("success");
  });

  it("rounds before checking the minimum, as the widget did", () => {
    // Order matters and this is the SOURCE behavior: `precision={2}` applied as
    // the value was entered, and the `min` rule then validated what rounding had
    // produced. So 0.009 became 0.01 and was accepted, while 0.004 became 0 and
    // was not. Checking before rounding would refuse a quantity the old app took.
    expect(plan(draft({ quantity: 0.009 }), flour).status).toBe("success");

    const vanished = plan(draft({ quantity: 0.004 }), flour);
    expect(vanished.status).toBe("failure");
    if (vanished.status === "failure") {
      expect(vanished.issues[0]?.code).toBe(MOVEMENT_ISSUE.quantityTooSmall);
    }
  });

  it("rounds an entered quantity to two decimals instead of storing raw float", () => {
    const rounded = plan(draft({ quantity: 5.128 }), flour);
    expect(rounded.status).toBe("success");
    if (rounded.status === "success") {
      expect(rounded.value.movement.quantity).toBe(5.13);
    }
  });

  it("refuses a non-finite quantity", () => {
    expect(plan(draft({ quantity: Number.NaN }), flour).status).toBe("failure");
  });

  it("refuses a unit that cannot convert to the ingredient's base unit", () => {
    // SOURCE pre-filtered the dropdown, so the domain's check was unreachable
    // through the UI and absent for every other caller.
    const wrong = plan(draft({ unit: "ml" }), flour);
    expect(wrong.status).toBe("failure");
    if (wrong.status === "failure") {
      expect(wrong.issues[0]?.code).toBe(MOVEMENT_ISSUE.incompatibleUnit);
    }
  });

  it("refuses a purchase with no unit cost instead of coercing it to zero", () => {
    // SOURCE's payload sent `unitCost ?? 0`, which would have dragged the
    // weighted average toward zero; the store then skipped the cost update
    // entirely when it was null, so a purchase could silently record no cost.
    const free = plan(draft({ type: "purchase", unitCost: null }), flour);
    expect(free.status).toBe("failure");
    if (free.status === "failure") {
      expect(free.issues[0]?.code).toBe(MOVEMENT_ISSUE.missingUnitCost);
    }
  });

  it("refuses a negative unit cost", () => {
    const negative = plan(draft({ type: "purchase", unitCost: IDR(-1) }), flour);
    expect(negative.status).toBe("failure");
    if (negative.status === "failure") {
      expect(negative.issues[0]?.code).toBe(MOVEMENT_ISSUE.negativeUnitCost);
    }
  });

  it("refuses to move an archived ingredient, naming the reason", () => {
    const archived = ingredient({ id: "i1", name: "Old Spice", status: "archived" });
    const refused = plan(draft(), archived);

    expect(refused.status).toBe("failure");
    if (refused.status === "failure") {
      expect(refused.reason).toBe("conflict");
      expect(refused.issues[0]?.code).toBe(MOVEMENT_ISSUE.archivedIngredient);
    }
  });

  it("distinguishes a missing ingredient from every other failure", () => {
    const missing = plan(draft(), null);
    expect(missing.status).toBe("failure");
    if (missing.status === "failure") {
      expect(missing.reason).toBe("not-found");
    }
  });

  it("refuses a movement that would drive stock negative, naming the numbers", () => {
    // SOURCE threw a RangeError into a catch-all that showed one generic toast,
    // so "not enough stock" and "the backend is down" looked identical.
    const short = plan(
      draft({ type: "adjustment-out", quantity: 50 }),
      flour,
      balance({ ingredientId: "i1", quantity: 10 }),
    );

    expect(short.status).toBe("failure");
    if (short.status === "failure") {
      expect(short.reason).toBe("conflict");
      expect(short.issues[0]?.code).toBe(MOVEMENT_ISSUE.negativeStock);
      expect(short.issues[0]?.details?.available).toBe(10);
    }
  });
});

// ─── The plan is complete and touches nothing ────────────────────────────────

describe("planning a movement", () => {
  const flour = ingredient({ id: "i1", name: "Flour", baseUnit: "g" });

  it("converts the entered unit into the base unit and signs the delta", () => {
    const inbound = plan(draft({ type: "purchase", quantity: 2, unit: "kg", unitCost: IDR(20_000) }), flour);
    expect(inbound.status).toBe("success");
    if (inbound.status === "success") {
      expect(inbound.value.movement.baseQuantityDelta).toBe(2000);
    }

    const outbound = plan(
      draft({ type: "adjustment-out", quantity: 1, unit: "kg" }),
      flour,
      balance({ ingredientId: "i1", quantity: 5000 }),
    );
    if (outbound.status === "success") {
      expect(outbound.value.movement.baseQuantityDelta).toBe(-1000);
    }
  });

  it("plans the balance row a first-ever movement needs, without creating it", () => {
    // The row exists only inside the plan. SOURCE pushed it into the store BEFORE
    // applying the delta, so a refused movement left it behind permanently.
    const first = plan(draft({ quantity: 5 }), flour, null);

    expect(first.status).toBe("success");
    if (first.status === "success") {
      expect(first.value.balance.ingredientId).toBe("i1");
      expect(first.value.balance.outletId).toBe(OUTLET);
      expect(first.value.balance.quantity).toBe(5);
      expect(first.value.balance.updatedAt).toBe(WHEN);
    }
  });

  it("leaves the ingredient untouched unless the movement changes cost", () => {
    const noCost = plan(draft({ type: "adjustment-in" }), flour);
    if (noCost.status === "success") {
      expect(noCost.value.ingredient).toBeNull();
    }

    const purchase = plan(
      draft({ type: "purchase", quantity: 1, unit: "kg", unitCost: IDR(20_000) }),
      flour,
    );
    if (purchase.status === "success") {
      expect(purchase.value.ingredient).not.toBeNull();
    }
  });

  it("weights the average cost by the stock held BEFORE the purchase", () => {
    // 1000 g held at 100/g, buying 1 kg at 20000 per kg = 20/g.
    const purchase = plan(
      draft({ type: "purchase", quantity: 1, unit: "kg", unitCost: IDR(20_000) }),
      flour,
      balance({ ingredientId: "i1", quantity: 1000 }),
    );

    expect(purchase.status).toBe("success");
    if (purchase.status === "success") {
      expect(purchase.value.ingredient?.averageUnitCost.amount).toBe(60);
      expect(purchase.value.ingredient?.lastPurchaseUnitCost.amount).toBe(20);
    }
  });

  it("takes the new cost outright when buying into empty stock", () => {
    const purchase = plan(
      draft({ type: "purchase", quantity: 1, unit: "kg", unitCost: IDR(20_000) }),
      flour,
      null,
    );

    if (purchase.status === "success") {
      expect(purchase.value.ingredient?.averageUnitCost.amount).toBe(20);
    }
  });

  it("treats a negative starting balance as empty when weighting, as SOURCE did", () => {
    const recomputed = recomputeAverageUnitCost(flour, -500, 1000, 20);
    expect(recomputed.averageUnitCost.amount).toBe(20);
  });

  it("carries the caller's timestamp onto both the row and the balance", () => {
    const planned = plan(draft({ occurredAt: WHEN }), flour);
    if (planned.status === "success") {
      expect(planned.value.movement.occurredAt).toBe(WHEN);
      expect(planned.value.balance.updatedAt).toBe(WHEN);
    }
  });
});

// ─── Ingredient validation ───────────────────────────────────────────────────

describe("ingredient validation", () => {
  const values = {
    name: "Flour",
    baseUnit: "g" as InventoryUnit,
    supplierId: null,
    minimumStock: 10,
  };

  it("requires a name that is not blank once trimmed", () => {
    expect(validateIngredientValues({ ...values, name: "   " }).status).toBe("failure");
  });

  it("trims the stored name", () => {
    const checked = validateIngredientValues({ ...values, name: "  Flour  " });
    if (checked.status === "success") {
      expect(checked.value.name).toBe("Flour");
    }
  });

  it("refuses a negative minimum stock and rounds a precise one", () => {
    expect(validateIngredientValues({ ...values, minimumStock: -1 }).status).toBe("failure");

    const checked = validateIngredientValues({ ...values, minimumStock: 10.128 });
    if (checked.status === "success") {
      expect(checked.value.minimumStock).toBe(10.13);
    }
  });

  it("refuses a non-finite minimum stock", () => {
    expect(
      validateIngredientValues({ ...values, minimumStock: Number.POSITIVE_INFINITY }).status,
    ).toBe("failure");
  });

  it("rounds an entered value half-up at two decimals", () => {
    expect(roundEntered(1.005)).toBe(1.01);
    expect(roundEntered(1.004)).toBe(1);
  });
});

// ─── Nothing is written before it is decided ─────────────────────────────────
//
// The section that matters most in this child.

describe("the child in a real runtime", () => {
  it("publishes the capability", () => {
    const { writes, dispose } = runtimeWith(storeOver({}));
    expect(writes).toBeDefined();
    dispose();
  });

  it("commits the ledger row, the balance and the cost together, once", async () => {
    const store = storeOver({
      ingredients: [ingredient({ id: "i1", name: "Flour", baseUnit: "g" })],
      balances: [balance({ ingredientId: "i1", quantity: 1000 })],
    });
    const { writes, dispose } = runtimeWith(store);

    const result = await writes?.recordMovement(
      draft({ type: "purchase", quantity: 1, unit: "kg", unitCost: IDR(20_000) }),
    );

    expect(result?.status).toBe("success");
    expect(store.commits).toHaveLength(1);
    expect(store.commits[0]?.movement.baseQuantityDelta).toBe(1000);
    expect(store.commits[0]?.balance.quantity).toBe(2000);
    expect(store.commits[0]?.ingredient?.averageUnitCost.amount).toBe(60);
    dispose();
  });

  it("writes NOTHING when the movement is refused for insufficient stock", async () => {
    // The defect this design removes. SOURCE created a zero-quantity balance row
    // for a new (ingredient, outlet) pair and then applied the delta, so a
    // refused movement left a row behind that had not existed — which changed
    // how that ingredient answered the low-stock filter afterwards.
    const store = storeOver({
      ingredients: [ingredient({ id: "i1", name: "Flour", baseUnit: "g" })],
    });
    const { writes, dispose } = runtimeWith(store);

    const result = await writes?.recordMovement(draft({ type: "adjustment-out", quantity: 5 }));

    expect(result?.status).toBe("failure");
    if (result?.status === "failure") {
      expect(result.issues[0]?.code).toBe(MOVEMENT_ISSUE.negativeStock);
    }
    expect(store.commits).toHaveLength(0);
    expect(store.patches).toHaveLength(0);
    dispose();
  });

  it("writes nothing when the ingredient is archived", async () => {
    const store = storeOver({
      ingredients: [ingredient({ id: "i1", name: "Old Spice", status: "archived" })],
    });
    const { writes, dispose } = runtimeWith(store);

    await writes?.recordMovement(draft());

    expect(store.commits).toHaveLength(0);
    dispose();
  });

  it("reports a failed commit as a store failure, not as a rejected movement", async () => {
    const store = storeOver({
      ingredients: [ingredient({ id: "i1", name: "Flour" })],
      failCommit: true,
    });
    const { writes, dispose } = runtimeWith(store);

    const result = await writes?.recordMovement(draft());

    expect(result?.status).toBe("failure");
    if (result?.status === "failure") {
      expect(result.reason).toBe("failed");
      expect(result.issues[0]?.message).toBe("commit rejected");
    }
    dispose();
  });

  it("never sends a cost field in an ingredient patch", async () => {
    // "Cost cannot be edited after creation" is structural here: the patch type
    // excludes both cost fields. SOURCE relied on a disabled input for it.
    const store = storeOver({
      ingredients: [ingredient({ id: "i1", name: "Flour", averageUnitCost: IDR(100) })],
    });
    const { writes, dispose } = runtimeWith(store);

    await writes?.updateIngredient("i1", {
      name: "Flour Premium",
      baseUnit: "g",
      supplierId: null,
      minimumStock: 20,
    });

    expect(store.patches).toHaveLength(1);
    expect(Object.keys(store.patches[0]?.patch as object)).not.toContain("averageUnitCost");
    expect(Object.keys(store.patches[0]?.patch as object)).not.toContain("lastPurchaseUnitCost");
    dispose();
  });

  it("sets both costs from the opening cost when creating", async () => {
    const store = storeOver({});
    const { writes, dispose } = runtimeWith(store);

    const result = await writes?.createIngredient({
      values: { name: "Sugar", baseUnit: "g", supplierId: null, minimumStock: 5 },
      initialUnitCost: IDR(250),
    });

    expect(result?.status).toBe("success");
    if (result?.status === "success") {
      expect(result.value.averageUnitCost.amount).toBe(250);
      expect(result.value.lastPurchaseUnitCost.amount).toBe(250);
      expect(result.value.status).toBe("active");
    }
    dispose();
  });

  it("refuses to archive an already-archived ingredient", async () => {
    // SOURCE's only guard was a conditionally rendered button; the store set the
    // status unconditionally and reported success either way.
    const store = storeOver({
      ingredients: [ingredient({ id: "i1", name: "Old Spice", status: "archived" })],
    });
    const { writes, dispose } = runtimeWith(store);

    const result = await writes?.archiveIngredient("i1");

    expect(result?.status).toBe("failure");
    if (result?.status === "failure") {
      expect(result.reason).toBe("conflict");
      expect(result.issues[0]?.code).toBe("ingredient-already-archived");
    }
    expect(store.patches).toHaveLength(0);
    dispose();
  });

  it("archives an active ingredient", async () => {
    const store = storeOver({ ingredients: [ingredient({ id: "i1", name: "Flour" })] });
    const { writes, dispose } = runtimeWith(store);

    const result = await writes?.archiveIngredient("i1");

    expect(result?.status).toBe("success");
    if (result?.status === "success") {
      expect(result.value.status).toBe("archived");
    }
    dispose();
  });

  it("reports a vanished ingredient instead of reporting success", async () => {
    // SOURCE's hook ignored the store's null return and showed a success toast,
    // so editing a deleted ingredient looked like it worked.
    const store = storeOver({});
    const { writes, dispose } = runtimeWith(store);

    const result = await writes?.updateIngredient("gone", {
      name: "Flour",
      baseUnit: "g",
      supplierId: null,
      minimumStock: 10,
    });

    expect(result?.status).toBe("failure");
    if (result?.status === "failure") {
      expect(result.reason).toBe("not-found");
    }
    dispose();
  });

  it("still publishes with no store, answering with a normalized failure", async () => {
    const { writes, snapshot, dispose } = runtimeWith(undefined);

    expect(writes).toBeDefined();
    const area = snapshot.areas.find((entry) => entry.engineId === inventoryEngine.id);
    expect(area?.unavailableChildIds).not.toContain(STOCK_ADJUSTMENT_ID);
    expect(area?.failedChildIds).not.toContain(STOCK_ADJUSTMENT_ID);

    const result = await writes?.recordMovement(draft());
    expect(result?.status).toBe("failure");
    if (result?.status === "failure") {
      expect(result.reason).toBe("unsatisfied-dependency");
      expect(result.issues[0]?.code).toBe("no-inventory-store");
    }
    dispose();
  });

  it("reports the missing store once, at creation, not per call", async () => {
    const { writes, snapshot, dispose } = runtimeWith(undefined);

    await writes?.recordMovement(draft());
    await writes?.archiveIngredient("i1");

    const reported = snapshot.diagnostics.filter(
      (entry) => entry.source === "stockAdjustmentChild" && entry.code === "missing-dependency",
    );
    expect(reported).toHaveLength(1);
    dispose();
  });
});
