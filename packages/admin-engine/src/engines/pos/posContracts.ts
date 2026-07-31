// packages/admin-engine/src/engines/pos/posContracts.ts
//
// Stable POS contracts. Session and cart own one operational state through one
// narrow compare-and-set port: both children may change their own fields, while a
// stale writer cannot overwrite a sibling's newer change. Checkout arrives in S10.

import type { Money, OrderVariantSelection } from "@warungmeng/domain";
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
  readonly lastCloseRecord: PosSessionCloseRecord | null;
}

export interface PosSessionClosingOutcome {
  readonly revision: number;
  readonly session: Extract<PosSessionState, { readonly status: "closed" }>;
  readonly record: PosSessionCloseRecord;
  /** Cart remains independently owned; caller decides whether to discard it. */
  readonly cartItemCount: number;
}

export interface PosSession {
  getSession(): Promise<OperationResult<PosSessionSnapshot>>;
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
} as const;
