// packages/admin-engine/src/engines/pos/children/cart/posCartChild.ts
//
// POS cart state, quantity rules, subtotal, configuration identity and guarded
// clearing. Catalog selection/revalidation belongs to S10, whose LOGIC §8 edge
// resolves `admin.menu.catalog-read`; this independent child imports no sibling.

import type { Money, OrderVariantSelection } from "@warungmeng/domain";
import type { LogicChildContext, OperationIssue, OperationResult } from "@warungmeng/module-system";
import {
  defineLogicChild,
  operationFailure,
  operationIssue,
  operationSuccess,
  severityForCode,
} from "@warungmeng/module-system";
import type {
  PosCart,
  PosCartItem,
  PosCartSnapshot,
  PosOperationalState,
  PosOperationalStatePort,
} from "../../posContracts";
import {
  POS_CART,
  POS_CART_ID,
  POS_ISSUE,
  POS_OPERATIONAL_STATE_PORT,
} from "../../posContracts";
import { POS_ENGINE_ID } from "../../posEngine";
import { posCartFingerprint } from "../../posOperations";

const IDR = (amount: number): Money => ({ amount, currency: "IDR" });

function validMoney(value: Money): boolean {
  return value.currency === "IDR" && Number.isInteger(value.amount) && value.amount >= 0;
}

function validText(value: string): boolean {
  return value.trim().length > 0;
}

function validSelection(selection: OrderVariantSelection): boolean {
  return (
    validText(selection.groupId) &&
    validText(selection.groupName) &&
    validText(selection.optionId) &&
    validText(selection.optionName) &&
    validMoney(selection.priceAdjustment)
  );
}

function cloneSelection(selection: OrderVariantSelection): OrderVariantSelection {
  return { ...selection, priceAdjustment: { ...selection.priceAdjustment } };
}

function cloneItem(item: PosCartItem): PosCartItem {
  return {
    ...item,
    unitPrice: { ...item.unitPrice },
    variantSelections: item.variantSelections.map(cloneSelection),
  };
}

export function posCartItemUnitPrice(item: PosCartItem): number {
  return (
    item.unitPrice.amount +
    item.variantSelections.reduce(
      (total, selection) => total + selection.priceAdjustment.amount,
      0,
    )
  );
}

export function posCartItemLineTotal(item: PosCartItem): number {
  return posCartItemUnitPrice(item) * item.quantity;
}

export function projectPosCart(state: PosOperationalState): PosCartSnapshot {
  return {
    revision: state.revision,
    items: state.cartItems.map(cloneItem),
    itemCount: state.cartItems.reduce((total, item) => total + item.quantity, 0),
    subtotal: IDR(
      state.cartItems.reduce((total, item) => total + posCartItemLineTotal(item), 0),
    ),
  };
}

function configurationKey(item: Pick<PosCartItem, "menuItemId" | "variantSelections" | "note">): string {
  const variants = item.variantSelections
    .map((selection) => `${selection.groupId}:${selection.optionId}`)
    .sort()
    .join("|");
  return `${item.menuItemId}::${variants}::${item.note.trim()}`;
}

function validateItem(item: PosCartItem): readonly OperationIssue[] {
  const issues: OperationIssue[] = [];
  if (
    !validText(item.id) ||
    !validText(item.menuItemId) ||
    !validText(item.name) ||
    !validMoney(item.unitPrice) ||
    item.variantSelections.some((selection) => !validSelection(selection))
  ) {
    issues.push(
      operationIssue(
        POS_ISSUE.invalidItem,
        "A cart item needs ids, a name, whole non-negative IDR prices, and valid variant snapshots.",
        item.id,
      ),
    );
  }
  if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
    issues.push(
      operationIssue(
        POS_ISSUE.invalidQuantity,
        "Cart quantity must be a positive whole number.",
        item.id,
      ),
    );
  }
  return issues;
}

function validateConfiguration(
  itemId: string,
  selections: readonly OrderVariantSelection[],
): readonly OperationIssue[] {
  return selections.some((selection) => !validSelection(selection))
    ? [
        operationIssue(
          POS_ISSUE.invalidItem,
          "Every cart variant must carry ids, names, and a whole non-negative IDR adjustment.",
          itemId,
        ),
      ]
    : [];
}

function noState<TValue>(): OperationResult<TValue> {
  return operationFailure("unsatisfied-dependency", [
    operationIssue(POS_ISSUE.noState, "No POS operational-state store is connected.", "posCart"),
  ]);
}

function stateFailed<TValue>(operation: string, error: unknown): OperationResult<TValue> {
  return operationFailure("failed", [
    operationIssue(
      POS_ISSUE.stateFailed,
      error instanceof Error ? error.message : "The POS operational-state store failed.",
      operation,
    ),
  ]);
}

function staleState<TValue>(operation: string): OperationResult<TValue> {
  return operationFailure("conflict", [
    operationIssue(
      POS_ISSUE.staleState,
      "POS state changed while this command was running; reload and retry.",
      operation,
    ),
  ]);
}

function itemNotFound<TValue>(itemId: string): OperationResult<TValue> {
  return operationFailure("not-found", [
    operationIssue(POS_ISSUE.itemNotFound, `No cart item with id ${itemId} exists.`, itemId),
  ]);
}

async function loadState(
  port: PosOperationalStatePort,
  operation: string,
): Promise<OperationResult<PosOperationalState>> {
  try {
    return operationSuccess(await port.load());
  } catch (error) {
    return stateFailed(operation, error);
  }
}

async function commitCart(
  port: PosOperationalStatePort,
  current: PosOperationalState,
  items: readonly PosCartItem[],
  operation: string,
  checkout?: {
    readonly expectedKey: string;
    readonly cashSaleAmount: number;
    readonly orderFingerprint: string;
  },
): Promise<OperationResult<PosCartSnapshot>> {
  const next: PosOperationalState = {
    ...current,
    revision: current.revision + 1,
    cartItems: items.map(cloneItem),
    ...(checkout === undefined
      ? {}
      : {
          cashSales: current.cashSales + checkout.cashSaleAmount,
          checkoutSequence: current.checkoutSequence + 1,
          checkoutKey: null,
        }),
  };

  try {
    return (await port.commit(current.revision, next))
      ? operationSuccess(projectPosCart(next))
      : staleState(operation);
  } catch (error) {
    return stateFailed(operation, error);
  }
}

function cartOverState(port: PosOperationalStatePort): PosCart {
  return {
    async getCart() {
      const current = await loadState(port, "getCart");
      return current.status === "failure" ? current : operationSuccess(projectPosCart(current.value));
    },

    async addItem(input) {
      const issues = validateItem(input.item);
      if (issues.length > 0) return operationFailure("invalid-input", issues);

      const loaded = await loadState(port, "addItem");
      if (loaded.status === "failure") return loaded;
      const incoming = cloneItem(input.item);
      const existing = loaded.value.cartItems.find(
        (item) => configurationKey(item) === configurationKey(incoming),
      );
      const items = existing
        ? loaded.value.cartItems.map((item) =>
            item.id === existing.id
              ? { ...item, quantity: item.quantity + incoming.quantity }
              : item,
          )
        : [...loaded.value.cartItems, incoming];

      return commitCart(port, loaded.value, items, "addItem");
    },

    async setItemQuantity(itemId, quantity) {
      if (!validText(itemId) || !Number.isInteger(quantity) || quantity <= 0) {
        return operationFailure("invalid-input", [
          operationIssue(
            POS_ISSUE.invalidQuantity,
            "Cart quantity must be a positive whole number; use removeItem to delete a line.",
            itemId,
          ),
        ]);
      }

      const loaded = await loadState(port, "setItemQuantity");
      if (loaded.status === "failure") return loaded;
      if (!loaded.value.cartItems.some((item) => item.id === itemId)) return itemNotFound(itemId);
      return commitCart(
        port,
        loaded.value,
        loaded.value.cartItems.map((item) =>
          item.id === itemId ? { ...item, quantity } : item,
        ),
        "setItemQuantity",
      );
    },

    async updateItem(input) {
      const issues = validateConfiguration(input.itemId, input.variantSelections);
      if (!validText(input.itemId)) {
        return operationFailure("invalid-input", [
          operationIssue(POS_ISSUE.invalidItem, "Cart item id is required.", "itemId"),
          ...issues,
        ]);
      }
      if (issues.length > 0) return operationFailure("invalid-input", issues);

      const loaded = await loadState(port, "updateItem");
      if (loaded.status === "failure") return loaded;
      if (!loaded.value.cartItems.some((item) => item.id === input.itemId)) {
        return itemNotFound(input.itemId);
      }
      // SOURCE merged on add but not on edit. Preserved: changing a line into an
      // existing configuration leaves two independently editable lines.
      return commitCart(
        port,
        loaded.value,
        loaded.value.cartItems.map((item) =>
          item.id === input.itemId
            ? {
                ...item,
                variantSelections: input.variantSelections.map(cloneSelection),
                note: input.note,
              }
            : item,
        ),
        "updateItem",
      );
    },

    async removeItem(itemId) {
      if (!validText(itemId)) {
        return operationFailure("invalid-input", [
          operationIssue(POS_ISSUE.invalidItem, "Cart item id is required.", "itemId"),
        ]);
      }
      const loaded = await loadState(port, "removeItem");
      if (loaded.status === "failure") return loaded;
      if (!loaded.value.cartItems.some((item) => item.id === itemId)) return itemNotFound(itemId);
      return commitCart(
        port,
        loaded.value,
        loaded.value.cartItems.filter((item) => item.id !== itemId),
        "removeItem",
      );
    },

    async clear(input) {
      const loaded = await loadState(port, "clear");
      if (loaded.status === "failure") return loaded;
      if (
        loaded.value.revision !== input.expectedRevision ||
        (input.checkout !== undefined &&
          (input.checkout.cashSaleAmount < 0 ||
            !Number.isInteger(input.checkout.cashSaleAmount) ||
            loaded.value.checkoutKey !== input.checkout.expectedKey ||
            posCartFingerprint(loaded.value.cartItems) !== input.checkout.orderFingerprint))
      ) {
        return staleState("clear");
      }
      return commitCart(port, loaded.value, [], "clear", input.checkout);
    },
  };
}

function cartWithoutState(): PosCart {
  return {
    getCart: async () => noState(),
    addItem: async () => noState(),
    setItemQuantity: async () => noState(),
    updateItem: async () => noState(),
    removeItem: async () => noState(),
    clear: async () => noState(),
  };
}

export function createPosCart(context: LogicChildContext): PosCart {
  const port = context.ports.resolve(POS_OPERATIONAL_STATE_PORT);

  if (port === undefined) {
    context.diagnostics.report({
      code: "missing-dependency",
      severity: severityForCode("missing-dependency"),
      message:
        "No POS operational-state store was supplied, so cart commands return a normalized " +
        "failure. The capability is published and callers stay working.",
      childId: context.childId,
      engineId: context.parentId,
      source: "posCartChild",
    });
  }

  const capability = port === undefined ? cartWithoutState() : cartOverState(port);
  context.capabilities.provide(POS_CART, capability);
  return capability;
}

export default defineLogicChild<PosCart>({
  id: POS_CART_ID,
  parentId: POS_ENGINE_ID,
  provides: [POS_CART_ID],
  requires: [],
  create: createPosCart,
});
