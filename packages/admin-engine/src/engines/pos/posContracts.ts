// packages/admin-engine/src/engines/pos/posContracts.ts
//
// Stable POS contracts. Session and cart own one operational state through one
// narrow compare-and-set port: both children may change their own fields, while a
// stale writer cannot overwrite a sibling's newer change. Checkout arrives in S10.

import type {
  Money,
  Order,
  OrderFulfillment,
  OrderPaymentMethod,
  OrderTotals,
  OrderVariantSelection,
} from "@warungmeng/domain";
import type { OperationResult } from "@warungmeng/module-system";
import { createCapabilityToken, createOutboundPortToken } from "@warungmeng/module-system";

// ─── Operational state port ───────────────────────────────────────────────────

export interface PosOutlet {
  readonly id: string;
  readonly name: string;
}

export type PosSessionState =
  | {
      readonly status: "closed";
      readonly outlet: PosOutlet;
      readonly openingBalance: Money;
      readonly openedAt: null;
    }
  | {
      readonly status: "open";
      readonly outlet: PosOutlet;
      readonly openingBalance: Money;
      readonly openedAt: string;
    };

export interface PosSessionCloseRecord {
  readonly outlet: PosOutlet;
  readonly openedAt: string;
  readonly closedAt: string;
  readonly openingBalance: Money;
  readonly cashSales: Money;
  readonly expectedCash: Money;
  readonly actualCash: Money;
  /** Signed: positive is surplus, negative is shortage. */
  readonly variance: Money;
}

export interface PosCartItem {
  readonly id: string;
  readonly menuItemId: string;
  readonly name: string;
  readonly unitPrice: Money;
  readonly variantSelections: readonly OrderVariantSelection[];
  readonly quantity: number;
  readonly note: string;
}

/**
 * State needed by S9 plus identity/cash fields S10 must update transactionally.
 * Receipt and pending-sync state stay out: S10's target is atomic, unlike SOURCE's
 * partial-success retry queue.
 */
export interface PosOperationalState {
  readonly revision: number;
  readonly session: PosSessionState;
  readonly cartItems: readonly PosCartItem[];
  readonly cashSales: number;
  readonly checkoutSequence: number;
  readonly checkoutKey: string | null;
  readonly lastCloseRecord: PosSessionCloseRecord | null;
}

/**
 * One authoritative compare-and-set seam for session and cart.
 *
 * SOURCE exposed `update(updater)` over its whole cashier state, so any caller
 * could rewrite every invariant. The target port accepts a finished state and lets
 * storage reject a stale revision. That makes persisted backend state possible and
 * stops one child silently erasing a concurrent sibling write.
 */
export interface PosOperationalStatePort {
  load(): Promise<PosOperationalState>;
  commit(expectedRevision: number, state: PosOperationalState): Promise<boolean>;
}

export const POS_OPERATIONAL_STATE_PORT = createOutboundPortToken<PosOperationalStatePort>(
  "admin.pos.operational-state",
);

// ─── Session contracts ────────────────────────────────────────────────────────

export interface OpenPosSessionInput {
  readonly outlet: PosOutlet;
  readonly openingBalance: number;
  readonly openedAt: string;
}

export interface ClosePosSessionInput {
  readonly actualCash: number;
  readonly closedAt: string;
}

export interface PosSessionSnapshot {
  readonly revision: number;
  readonly session: PosSessionState;
  readonly cashSales: Money;
  readonly expectedCash: Money;
  /** Durable per-till counter used by S10's idempotency key and receipt number. */
  readonly checkoutSequence: number;
  /** Reserved checkout identity reused until an attempt reaches a terminal result. */
  readonly checkoutKey: string | null;
  readonly lastCloseRecord: PosSessionCloseRecord | null;
}

export interface PosSessionClosingOutcome {
  readonly revision: number;
  readonly session: Extract<PosSessionState, { readonly status: "closed" }>;
  readonly record: PosSessionCloseRecord;
  /** Cart remains independently owned; caller decides whether to discard it. */
  readonly cartItemCount: number;
}

export interface PosCheckoutIdentity {
  readonly key: string;
  readonly sequence: number;
  readonly stateRevision: number;
}

export interface PosSession {
  getSession(): Promise<OperationResult<PosSessionSnapshot>>;
  /** Reserves or reuses a durable retry key before any order/inventory write. */
  beginCheckout(): Promise<OperationResult<PosCheckoutIdentity>>;
  openSession(input: OpenPosSessionInput): Promise<OperationResult<PosSessionSnapshot>>;
  closeSession(input: ClosePosSessionInput): Promise<OperationResult<PosSessionClosingOutcome>>;
}

export const POS_SESSION_ID = "admin.pos.session";
export const POS_SESSION = createCapabilityToken<PosSession>(POS_SESSION_ID);

// ─── Cart contracts ───────────────────────────────────────────────────────────

export interface PosCartSnapshot {
  readonly revision: number;
  readonly items: readonly PosCartItem[];
  readonly itemCount: number;
  readonly subtotal: Money;
}

export interface AddPosCartItemInput {
  readonly item: PosCartItem;
}

export interface UpdatePosCartItemInput {
  readonly itemId: string;
  readonly variantSelections: readonly OrderVariantSelection[];
  readonly note: string;
}

export interface ClearPosCartInput {
  /** S10 clears only the snapshot it committed; newer items must survive. */
  readonly expectedRevision: number;
  /** Checkout finalization increments till state in the same guarded write. */
  readonly checkout?: {
    readonly expectedKey: string;
    readonly cashSaleAmount: number;
    /** Stable identity guard: only clear when this aggregate is the committed one. */
    readonly orderFingerprint: string;
  };
}

export interface PosCart {
  getCart(): Promise<OperationResult<PosCartSnapshot>>;
  addItem(input: AddPosCartItemInput): Promise<OperationResult<PosCartSnapshot>>;
  setItemQuantity(itemId: string, quantity: number): Promise<OperationResult<PosCartSnapshot>>;
  updateItem(input: UpdatePosCartItemInput): Promise<OperationResult<PosCartSnapshot>>;
  removeItem(itemId: string): Promise<OperationResult<PosCartSnapshot>>;
  clear(input: ClearPosCartInput): Promise<OperationResult<PosCartSnapshot>>;
}

export const POS_CART_ID = "admin.pos.cart";
export const POS_CART = createCapabilityToken<PosCart>(POS_CART_ID);

// ─── Checkout contracts ───────────────────────────────────────────────────────

/** SOURCE defaults shown to every cashier before checkout. */
export const DEFAULT_POS_CHECKOUT = {
  fulfillment: "dine-in",
  paymentMethod: "cash",
  cashReceived: 0,
  pricing: {
    discountAmount: 0,
    serviceChargeAmount: 0,
    taxRate: 0.1,
    roundingStep: 100,
  },
} as const;

export interface PosPricingOptions {
  readonly discountAmount: number;
  readonly serviceChargeAmount: number;
  readonly taxRate: number;
  readonly roundingStep: number;
}

export interface SubmitPosCheckoutInput {
  readonly fulfillment: Extract<OrderFulfillment, "dine-in" | "takeaway">;
  readonly paymentMethod: Exclude<OrderPaymentMethod, "unknown">;
  readonly cashReceived: number;
  readonly pricing: PosPricingOptions;
  /** One instant owns order number, aggregate timestamps, event, and receipt. */
  readonly occurredAt: string;
}

export interface PosReceipt {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly paymentMethod: Exclude<OrderPaymentMethod, "unknown">;
  readonly totals: OrderTotals;
  readonly cashReceived: Money;
  readonly change: Money;
  readonly issuedAt: string;
}

export interface PosCheckoutOutcome {
  readonly order: Order;
  readonly receipt: PosReceipt;
  /** True when the order store replayed the stable checkout key. */
  readonly orderReplayed: boolean;
  /** True when inventory reported that this order was already consumed. */
  readonly inventoryReplayed: boolean;
}

export interface PosCheckout {
  submitCheckout(input: SubmitPosCheckoutInput): Promise<OperationResult<PosCheckoutOutcome>>;
}

/** LOGIC §8 names both the child and capability `admin.pos.checkout`. */
export const POS_CHECKOUT_ID = "admin.pos.checkout";
export const POS_CHECKOUT = createCapabilityToken<PosCheckout>(POS_CHECKOUT_ID);

export const POS_ISSUE = {
  noState: "no-pos-operational-state",
  stateFailed: "pos-operational-state-failed",
  staleState: "pos-operational-state-stale",
  invalidOutlet: "invalid-pos-outlet",
  invalidAmount: "invalid-pos-amount",
  invalidTimestamp: "invalid-pos-timestamp",
  sessionAlreadyOpen: "pos-session-already-open",
  sessionAlreadyClosed: "pos-session-already-closed",
  invalidItem: "invalid-pos-cart-item",
  invalidQuantity: "invalid-pos-cart-quantity",
  itemNotFound: "pos-cart-item-not-found",
  sessionClosed: "pos-checkout-session-closed",
  emptyCart: "pos-checkout-cart-empty",
  invalidCheckout: "invalid-pos-checkout",
  catalogFailed: "pos-checkout-catalog-failed",
  menuNotFound: "pos-checkout-menu-not-found",
  menuUnavailable: "pos-checkout-menu-unavailable",
  cartChanged: "pos-checkout-cart-changed",
  paymentInsufficient: "pos-payment-insufficient",
  orderFailed: "pos-order-submission-failed",
  inventoryFailed: "pos-inventory-consumption-failed",
  financeFailed: "pos-finance-projection-failed",
  orderReplay: "pos-order-replayed",
  inventoryReplay: "pos-inventory-replayed",
  inventorySkipped: "pos-inventory-item-skipped",
  finalizationFailed: "pos-checkout-finalization-failed",
  atomicFailed: "pos-atomic-operation-failed",
} as const;
