// Protected POS cart behavior through the real capability graph.

import { describe, expect, it } from "vitest";
import type { Money, OrderVariantSelection } from "@warungmeng/domain";
import { defineLogicChild } from "@warungmeng/module-system";
import type { AdminEngineSnapshot } from "../../../../adminEngineContracts";
import { createAdminEngine } from "../../../../createAdminEngine";
import type {
  PosCart,
  PosCartItem,
  PosOperationalState,
  PosOperationalStatePort,
} from "../../posContracts";
import {
  POS_CART,
  POS_CART_ID,
  POS_ISSUE,
  POS_OPERATIONAL_STATE_PORT,
} from "../../posContracts";
import posEngine from "../../posEngine";
import { posCartFingerprint } from "../../posOperations";
import posCartChild, {
  posCartItemLineTotal,
  posCartItemUnitPrice,
} from "./posCartChild";

const IDR = (amount: number): Money => ({ amount, currency: "IDR" });
const outlet = { id: "wm-1", name: "WARUNG MENG" };

function selection(overrides: Partial<OrderVariantSelection> = {}): OrderVariantSelection {
  return {
    groupId: "size",
    groupName: "Ukuran",
    optionId: "large",
    optionName: "Besar",
    priceAdjustment: IDR(4_000),
    ...overrides,
  };
}

function item(overrides: Partial<PosCartItem> = {}): PosCartItem {
  return {
    id: "line-1",
    menuItemId: "menu-1",
    name: "Gado-gado",
    unitPrice: IDR(22_000),
    variantSelections: [],
    quantity: 1,
    note: "",
    ...overrides,
  };
}

function initial(overrides: Partial<PosOperationalState> = {}): PosOperationalState {
  return {
    revision: 0,
    session: { status: "closed", outlet, openingBalance: IDR(0), openedAt: null },
    cartItems: [],
    cashSales: 0,
    checkoutSequence: 1,
    checkoutKey: null,
    lastCloseRecord: null,
    ...overrides,
  };
}

function statePort(seed = initial()): PosOperationalStatePort & {
  read(): PosOperationalState;
  rejectNext(): void;
} {
  let state = seed;
  let reject = false;
  return {
    load: async () => state,
    commit: async (expectedRevision, next) => {
      if (reject || expectedRevision !== state.revision) {
        reject = false;
        return false;
      }
      state = next;
      return true;
    },
    read: () => state,
    rejectNext: () => {
      reject = true;
    },
  };
}

function runtimeWith(port?: PosOperationalStatePort): {
  readonly cart: PosCart | undefined;
  readonly snapshot: AdminEngineSnapshot;
  readonly dispose: () => void;
} {
  let captured: PosCart | undefined;
  const probe = defineLogicChild({
    id: "admin.pos.test-cart-probe",
    parentId: posEngine.id,
    requires: [POS_CART_ID],
    create(context) {
      const result = context.capabilities.resolve(POS_CART);
      if (result.status === "available") captured = result.value;
      return undefined;
    },
  });
  const runtime = createAdminEngine({
    definitions: { engines: [posEngine], children: [posCartChild, probe] },
    ports: {
      resolve: (token) =>
        token.id === POS_OPERATIONAL_STATE_PORT.id && port !== undefined
          ? (port as never)
          : undefined,
    },
  });
  return { cart: captured, snapshot: runtime.getSnapshot(), dispose: runtime.dispose };
}

describe("POS cart", () => {
  it("publishes admin.pos.cart through a requiring probe", () => {
    const { cart, dispose } = runtimeWith(statePort());
    expect(cart).toBeDefined();
    expect(POS_CART_ID).toBe("admin.pos.cart");
    dispose();
  });

  it("prices variants per unit and projects quantity/subtotal", async () => {
    const configured = item({ variantSelections: [selection()], quantity: 2 });
    expect(posCartItemUnitPrice(configured)).toBe(26_000);
    expect(posCartItemLineTotal(configured)).toBe(52_000);

    const { cart, dispose } = runtimeWith(statePort(initial({ cartItems: [configured] })));
    expect(await cart!.getCart()).toMatchObject({
      status: "success",
      value: { itemCount: 2, subtotal: { amount: 52_000 } },
    });
    dispose();
  });

  it("merges equal configurations regardless of variant order or edge whitespace", async () => {
    const first = item({
      variantSelections: [selection(), selection({ groupId: "heat", optionId: "hot" })],
      note: " Pedas ",
    });
    const incoming = item({
      id: "line-2",
      quantity: 2,
      variantSelections: [selection({ groupId: "heat", optionId: "hot" }), selection()],
      note: "Pedas",
    });
    const port = statePort(initial({ cartItems: [first] }));
    const { cart, dispose } = runtimeWith(port);

    const result = await cart!.addItem({ item: incoming });

    expect(result).toMatchObject({
      status: "success",
      value: { itemCount: 3, items: [{ id: "line-1", quantity: 3 }] },
    });
    expect(port.read().cartItems).toHaveLength(1);
    dispose();
  });

  it("keeps different notes separate and snapshots incoming values", async () => {
    const mutableSelections = [selection()];
    const port = statePort(initial({ cartItems: [item({ note: "Pedas" })] }));
    const { cart, dispose } = runtimeWith(port);

    const result = await cart!.addItem({
      item: item({ id: "line-2", note: "Tidak pedas", variantSelections: mutableSelections }),
    });
    mutableSelections[0] = selection({ optionName: "MUTATED" });

    expect(result.status === "success" && result.value.items).toHaveLength(2);
    expect(port.read().cartItems[1]?.variantSelections[0]?.optionName).toBe("Besar");
    dispose();
  });

  it("rejects malformed items and quantities instead of deleting by accident", async () => {
    const port = statePort(initial({ cartItems: [item()] }));
    const { cart, dispose } = runtimeWith(port);

    expect(await cart!.addItem({ item: item({ id: "", quantity: 0 }) })).toMatchObject({
      status: "failure",
      reason: "invalid-input",
    });
    expect(await cart!.setItemQuantity("line-1", 0)).toMatchObject({
      status: "failure",
      issues: [{ code: POS_ISSUE.invalidQuantity }],
    });
    expect(port.read().cartItems).toHaveLength(1);
    dispose();
  });

  it("updates quantity, configuration and removal with explicit not-found results", async () => {
    const port = statePort(initial({ cartItems: [item()] }));
    const { cart, dispose } = runtimeWith(port);

    expect(await cart!.setItemQuantity("missing", 2)).toMatchObject({
      status: "failure",
      reason: "not-found",
    });
    await cart!.setItemQuantity("line-1", 3);
    await cart!.updateItem({
      itemId: "line-1",
      variantSelections: [selection()],
      note: "Less ice",
    });
    expect(port.read().cartItems[0]).toMatchObject({ quantity: 3, note: "Less ice" });
    expect(await cart!.removeItem("line-1")).toMatchObject({
      status: "success",
      value: { items: [] },
    });
    expect(await cart!.removeItem("line-1")).toMatchObject({
      status: "failure",
      reason: "not-found",
    });
    dispose();
  });

  it("preserves SOURCE's add-only merge: editing into an equal configuration keeps two lines", async () => {
    const port = statePort(
      initial({
        cartItems: [item({ id: "line-1", note: "A" }), item({ id: "line-2", note: "B" })],
      }),
    );
    const { cart, dispose } = runtimeWith(port);

    await cart!.updateItem({ itemId: "line-2", variantSelections: [], note: "A" });

    expect(port.read().cartItems).toHaveLength(2);
    dispose();
  });

  it("clears only the committed revision so newer cart changes survive", async () => {
    const port = statePort(initial({ revision: 5, cartItems: [item()] }));
    const { cart, dispose } = runtimeWith(port);

    expect(await cart!.clear({ expectedRevision: 4 })).toMatchObject({
      status: "failure",
      issues: [{ code: POS_ISSUE.staleState }],
    });
    expect(port.read().cartItems).toHaveLength(1);
    expect(await cart!.clear({ expectedRevision: 5 })).toMatchObject({
      status: "success",
      value: { revision: 6, items: [] },
    });
    dispose();
  });

  it("finalizes checkout counters only for the reserved key and exact committed cart", async () => {
    const committed = item();
    const port = statePort(
      initial({
        revision: 5,
        cartItems: [committed],
        cashSales: 20_000,
        checkoutSequence: 7,
        checkoutKey: "stable-key",
      }),
    );
    const { cart, dispose } = runtimeWith(port);

    expect(
      await cart!.clear({
        expectedRevision: 5,
        checkout: {
          expectedKey: "wrong-key",
          cashSaleAmount: 10_000,
          orderFingerprint: posCartFingerprint([committed]),
        },
      }),
    ).toMatchObject({ status: "failure", issues: [{ code: POS_ISSUE.staleState }] });
    expect(port.read()).toMatchObject({ cashSales: 20_000, checkoutSequence: 7 });

    expect(
      await cart!.clear({
        expectedRevision: 5,
        checkout: {
          expectedKey: "stable-key",
          cashSaleAmount: 10_000,
          orderFingerprint: posCartFingerprint([
            committed,
            item({ id: "new-line", menuItemId: "menu-2" }),
          ]),
        },
      }),
    ).toMatchObject({ status: "failure", issues: [{ code: POS_ISSUE.staleState }] });
    expect(port.read().cartItems).toHaveLength(1);

    expect(
      await cart!.clear({
        expectedRevision: 5,
        checkout: {
          expectedKey: "stable-key",
          cashSaleAmount: 10_000,
          orderFingerprint: posCartFingerprint([committed]),
        },
      }),
    ).toMatchObject({ status: "success", value: { items: [] } });
    expect(port.read()).toMatchObject({
      cashSales: 30_000,
      checkoutSequence: 8,
      checkoutKey: null,
      cartItems: [],
    });
    dispose();
  });

  it("surfaces a compare-and-set conflict rather than overwriting newer state", async () => {
    const port = statePort(initial({ cartItems: [item()] }));
    port.rejectNext();
    const { cart, dispose } = runtimeWith(port);

    expect(await cart!.setItemQuantity("line-1", 2)).toMatchObject({
      status: "failure",
      issues: [{ code: POS_ISSUE.staleState }],
    });
    expect(port.read().cartItems[0]?.quantity).toBe(1);
    dispose();
  });

  it("still publishes without a port and reports that missing port once", async () => {
    const { cart, snapshot, dispose } = runtimeWith();
    expect(await cart!.getCart()).toMatchObject({
      status: "failure",
      reason: "unsatisfied-dependency",
    });
    const area = snapshot.areas.find((entry) => entry.engineId === posEngine.id);
    expect(area?.unavailableChildIds).not.toContain(POS_CART_ID);
    expect(
      snapshot.diagnostics.filter(
        (entry) => entry.source === "posCartChild" && entry.code === "missing-dependency",
      ),
    ).toHaveLength(1);
    dispose();
  });
});
