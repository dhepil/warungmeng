// packages/admin-engine/src/engines/finance/financeContracts.ts
//
// Stable contracts owned by the Finance area (LOGIC §6: a `<area>Contracts.ts`
// exports capability, port, input, and output types — never behavior).
//
// Finance is shaped differently from Menu and Inventory, and the difference is
// worth stating up front because every decision below follows from it:
//
//   **Most of this area's data is DERIVED, not stored.** The store holds only
//   transactions a person typed in. Every sale and every refund is computed from
//   the orders themselves at read time and never written down. So the ledger is a
//   merge of two sources, keyed by a deterministic id built from the order — which
//   means recording the same sale twice is impossible by construction rather than
//   prevented by a guard. That is SOURCE's design and it is a good one; it is
//   preserved deliberately.
//
// A consequence to expect: this area needs order data but LOGIC §8 gives
// `admin.finance.ledger-read` no required capability, so orders arrive through a
// second injected port rather than from the Orders area. SOURCE did the same
// thing, and said why: Finance never imports the Orders repository.
//
// No UI vocabulary anywhere (LOGIC §5/§13): no label, column, route, or icon. The
// constants below are rules, not widget settings — each says where SOURCE kept it.

import type {
  FinanceAttachmentMetadata,
  FinanceCategory,
  FinanceCategorySummary,
  FinanceDirection,
  FinancePaymentMethod,
  FinancePaymentMethodSummary,
  FinanceSummary,
  FinanceTransaction,
  FinanceTransactionQuery,
  ManualFinanceStatus,
  ManualFinanceTransactionType,
  Money,
  Order,
} from "@warungmeng/domain";
import type { OperationResult } from "@warungmeng/module-system";
import { createCapabilityToken, createOutboundPortToken } from "@warungmeng/module-system";

// ─── Rules lifted out of the SOURCE form components ──────────────────────────
//
// Every constant here was an AntD prop in SOURCE's transaction dialog — a
// `maxLength`, a `precision`, an `accept`, or a `rules={[...]}` entry — which
// means it was a real rule enforced by a widget with no authority over rules.
// Anything not submitted through that one dialog skipped it entirely, and the P5
// UI rebuild would have had to rediscover every one. LOGIC §13 puts validation
// below the screen.

/** SOURCE: `<Input.TextArea maxLength={300}>` on the description field. */
export const TRANSACTION_DESCRIPTION_MAX_LENGTH = 300;

/** SOURCE: `<Input maxLength={80}>` on the reference-number field. */
export const TRANSACTION_REFERENCE_MAX_LENGTH = 80;

/** SOURCE: `<Input maxLength={80}>` on the custom-category label field. */
export const CUSTOM_CATEGORY_LABEL_MAX_LENGTH = 80;

/**
 * The prefix marking a category the user named themselves.
 *
 * SOURCE built these ids in the dialog (`custom:` + a slug of the label) and read
 * the prefix back in three separate components to decide whether to translate the
 * label or show it verbatim. It is a data convention, not a display detail, so it
 * belongs here — and see `CUSTOM_CATEGORY_DIRECTION_UNCHECKED` below for the hole
 * it opened.
 */
export const CUSTOM_CATEGORY_PREFIX = "custom:";

/** SOURCE's temporary form value meaning "use the separately entered label". */
export const CUSTOM_CATEGORY_SELECTION = "custom";

/**
 * How many recent transactions the overview keeps. SOURCE: `.slice(0, 5)` inside
 * its overview view-model — a product decision expressed as a magic number.
 */
export const RECENT_TRANSACTION_COUNT = 5;

/**
 * The time zone the area reckons a calendar day in.
 *
 * This is the one rule in the area that had two disagreeing implementations, and
 * it is the same defect class as inventory's four low-stock rules.
 *
 * SOURCE computed its date presets with `dayjs()` — the machine's LOCAL time — and
 * then handed the resulting `YYYY-MM-DD` strings to the domain's filter, which
 * expands a plain date to UTC midnight-to-midnight. Meanwhile the reporting module
 * does the job properly, resolving a calendar day in an explicit zone. So on a
 * machine set to anything other than UTC, "today" as chosen by the preset and
 * "today" as applied by the filter were different windows, and a transaction near
 * midnight could fall outside the very preset that was meant to include it.
 *
 * Resolved to ONE rule, in the domain's declared reporting zone, because that is
 * the only one of the three that is correct for a warung in Jakarta and because
 * the reporting module already treats it as the answer. `DEFAULT_REPORTING_TIME_ZONE`
 * is imported rather than restated so a second copy cannot drift.
 *
 * Consequence worth knowing: the boundary now moves with Jakarta rather than with
 * whatever clock the browser happens to be set to. On a UTC machine this changes
 * which transactions a preset selects near midnight — correctly, but visibly.
 */
export { DEFAULT_REPORTING_TIME_ZONE as FINANCE_TIME_ZONE } from "@warungmeng/domain";

// ─── Persistence port ────────────────────────────────────────────────────────

/**
 * The Finance area's window onto storage — MANUAL transactions only.
 *
 * Ported from SOURCE `packages/data/src/repositories/FinanceRepository.ts`, but
 * with its ambiguous write results made explicit below. SOURCE also exposed
 * `getManualTransactionById`; no production caller used it — only repository tests
 * did — so it is deliberately absent rather than carried as dead surface.
 *
 * Note what is absent. There is no method to write a sale or a refund, because
 * neither is ever stored — both are projected from orders. Adding one would create
 * the second writer of a fact that already has an owner, and would make the
 * ledger's de-duplication load-bearing instead of incidental.
 *
 * Two departures from SOURCE:
 *
 * `createManualTransaction` and `updateManualTransaction` take an input the child
 * has ALREADY validated, and the store does not re-judge it. SOURCE's in-memory
 * implementation called the domain validator itself and THREW a `RangeError` —
 * validation living in the adapter, after the caller had already committed to
 * writing. Same inversion S4 fixed for inventory: decide, then write. A caller
 * that skips the child's validation gets whatever the adapter does; the engine's
 * job is to not be that caller.
 *
 * There is deliberately no `newId`. Unlike Menu's nested options or Inventory's
 * movement plan, no finance caller needs the id before the row is written; SOURCE's
 * repository minted it inside `createManualTransaction`. Adding an exposed
 * generator here would be dead surface.
 *
 * No ordering is promised. SOURCE's implementation sorted inside `listManualTransactions`
 * by delegating to the domain's filter; the read child sorts its own results now, so
 * ledger order does not depend on which adapter is plugged in.
 */
export interface FinanceStorePort {
  listManualTransactions(
    query?: FinanceTransactionQuery,
  ): Promise<readonly FinanceTransaction[]>;
  createManualTransaction(input: ManualTransactionRecord): Promise<FinanceTransaction>;
  updateManualTransaction(id: string, input: ManualTransactionRecord): Promise<FinanceUpdateCommit>;
  voidManualTransaction(id: string): Promise<FinanceVoidCommit>;
}

/**
 * The store's authoritative answer to an edit.
 *
 * SOURCE returned `null` for three different facts: missing id, automatic row,
 * or already-voided row. A child cannot turn that into an honest result, and a
 * pre-read would introduce a second, weaker judge plus a race. The write therefore
 * says which decision it made.
 */
export type FinanceUpdateCommit =
  | { readonly status: "updated"; readonly transaction: FinanceTransaction }
  | { readonly status: "not-found" }
  | {
      readonly status: "not-editable";
      readonly reason: "automatic" | "voided";
      readonly transaction: FinanceTransaction;
    };

/**
 * The store's authoritative answer to an idempotent void.
 *
 * SOURCE returned the row alone, so a fresh void and a replay were
 * indistinguishable. A pre-read in the child would introduce the same race as an
 * edit. The write itself reports whether it changed the row — the same judge
 * decides and writes, per the S5 rule.
 */
export type FinanceVoidCommit =
  | { readonly status: "voided"; readonly transaction: FinanceTransaction }
  | { readonly status: "already-voided"; readonly transaction: FinanceTransaction }
  | { readonly status: "not-found" }
  | { readonly status: "not-voidable"; readonly transaction: FinanceTransaction };

export const FINANCE_STORE_PORT = createOutboundPortToken<FinanceStorePort>(
  "admin.finance.store",
);

/**
 * How the area reads orders, which it needs because sales and refunds are derived
 * from them.
 *
 * This is a SECOND port rather than a required capability, and that is forced
 * rather than chosen: LOGIC §8 lists no requirement for `admin.finance.ledger-read`,
 * so it cannot declare `admin.orders.read` and have the runtime satisfy it. SOURCE
 * arrived at the same shape for a different reason it stated explicitly — Finance
 * never imports the Orders repository — and injecting a narrow read keeps that
 * true here.
 *
 * Deliberately narrower than the Orders area's eventual read capability: one
 * method, no queries beyond the outlet scope. Widening it would make Finance a
 * general consumer of orders rather than a ledger that happens to need them.
 */
export interface FinanceOrderReadPort {
  listOrders(query?: { readonly outletId?: string }): Promise<readonly Order[]>;
}

export const FINANCE_ORDER_READ_PORT = createOutboundPortToken<FinanceOrderReadPort>(
  "admin.finance.order-read",
);

/**
 * The outlet whose orders feed the ledger.
 *
 * SOURCE hardcoded `"wm-1"` in its ledger hook as `ACTIVE_FINANCE_OUTLET_ID` and
 * passed it on every load, so a second outlet's sales would silently have been
 * absent from finance with nothing saying so. Kept as the default because changing
 * it would change which orders the owner sees, but it is now an explicit input the
 * caller may override rather than a literal buried in a loader.
 */
export const DEFAULT_FINANCE_OUTLET_ID = "wm-1";

// ─── Read contracts (child: ledger-read) ─────────────────────────────────────

/** A preset window over the ledger, resolved in `FINANCE_TIME_ZONE`. */
export const FINANCE_DATE_PRESETS = ["today", "last7", "last30", "month"] as const;
export type FinanceDatePreset = (typeof FINANCE_DATE_PRESETS)[number];
export type FinanceDateSelection = FinanceDatePreset | "custom";

/** An inclusive `YYYY-MM-DD` window. Both ends are calendar days, not instants. */
export interface FinanceDateRange {
  readonly dateFrom: string;
  readonly dateTo: string;
}

/**
 * The ledger plus the projections that sit beside it.
 *
 * All four are computed over the SAME filtered set, which is what makes the totals
 * reconcile against the rows on screen. SOURCE computed them together too, in a
 * view-model; that is query behavior, and query behavior belongs to a child
 * (LOGIC §3).
 */
export interface FinanceLedgerView {
  readonly transactions: readonly FinanceTransaction[];
  readonly recentTransactions: readonly FinanceTransaction[];
  readonly summary: FinanceSummary;
  readonly paymentMethods: readonly FinancePaymentMethodSummary[];
  readonly expenseCategories: readonly FinanceCategorySummary[];
}

/**
 * The Finance area's read surface — the capability the dashboard requires twice
 * (LOGIC §8: `admin.dashboard.overview` and `admin.dashboard.reports`).
 *
 * `listTransactions` returns the merged ledger unfiltered, which is the shape a
 * cross-area consumer wants; `queryLedger` is the admin list behavior. Both exist
 * for the same reason the Inventory area publishes both raw lists and joined
 * queries: the dashboard should come through a real capability rather than
 * re-deriving a store shape (tech-debt D15).
 *
 * Everything returns a normalized result rather than throwing (LOGIC §5).
 */
export interface LedgerRead {
  listTransactions(outletId?: string): Promise<OperationResult<readonly FinanceTransaction[]>>;
  queryLedger(
    query?: FinanceTransactionQuery,
    outletId?: string,
  ): Promise<OperationResult<FinanceLedgerView>>;
  /** Pure: the window a preset means, reckoned in `FINANCE_TIME_ZONE`. */
  resolveDatePreset(preset: FinanceDatePreset, now?: Date): FinanceDateRange;
  /** Pure: which preset a window corresponds to, or `"custom"`. */
  identifyDateRange(range: FinanceDateRange, now?: Date): FinanceDateSelection;
}

export const LEDGER_READ_ID = "admin.finance.ledger-read";

export const LEDGER_READ = createCapabilityToken<LedgerRead>(LEDGER_READ_ID);

// ─── Recording contracts (child: transaction-recording) ──────────────────────

/**
 * What a caller supplies to record a manual transaction.
 *
 * Deliberately NOT the domain's `ManualFinanceTransactionInput`. Two differences,
 * both of them rules SOURCE kept in the dialog:
 *
 *   - `type` is absent. SOURCE decided it with one line inside its submit handler
 *     (`direction === "inflow" ? "manual-income" : "expense"`), which is why three
 *     of the types the domain accepts — `cash-in`, `cash-out`, `adjustment` — were
 *     unreachable through the only screen that could write one. The child derives
 *     it from the direction exactly as SOURCE did, so behavior is unchanged, and
 *     `TRANSACTION_TYPE_FOR_DIRECTION` names the rule instead of hiding it in a
 *     ternary. See `UNREACHABLE_MANUAL_TYPES`.
 *   - `categoryLabel` is absent. SOURCE resolved it from the selected category, or
 *     used the typed custom label. Deriving it is the child's job; asking a caller
 *     for a label it would have to look up invites the two from disagreeing.
 */
export interface RecordTransactionInput {
  readonly occurredAt: string;
  readonly direction: FinanceDirection;
  readonly status: ManualFinanceStatus;
  /** A `FINANCE_CATEGORIES` id or `CUSTOM_CATEGORY_SELECTION`. */
  readonly categoryId: string;
  /** Required when `categoryId` is `CUSTOM_CATEGORY_SELECTION`. */
  readonly customCategoryLabel?: string;
  readonly amount: Money;
  readonly paymentMethod: FinancePaymentMethod;
  readonly description: string;
  readonly referenceNumber: string;
  readonly attachment: FinanceAttachmentMetadata | null;
}

/**
 * The row a validated input becomes, ready for the store.
 *
 * This is the domain's own input type; it is aliased rather than redefined so the
 * store port speaks the domain's vocabulary and the child owns the conversion.
 */
export type ManualTransactionRecord = {
  readonly occurredAt: string;
  readonly direction: FinanceDirection;
  readonly type: ManualFinanceTransactionType;
  readonly status: ManualFinanceStatus;
  readonly categoryId: string;
  readonly categoryLabel: string;
  readonly amount: Money;
  readonly paymentMethod: FinancePaymentMethod;
  readonly description: string;
  readonly referenceNumber: string;
  readonly attachment: FinanceAttachmentMetadata | null;
};

/**
 * Which manual type a direction produces — SOURCE's rule, named.
 *
 * The domain permits `cash-in`/`cash-out`/`adjustment` as well, and nothing in
 * SOURCE could ever create one. They stay unreachable here, because making them
 * reachable is a feature rather than a port: it needs a decision about what the
 * user is choosing between and what each one means for the cash balance.
 */
export const TRANSACTION_TYPE_FOR_DIRECTION: Readonly<
  Record<FinanceDirection, ManualFinanceTransactionType>
> = {
  inflow: "manual-income",
  outflow: "expense",
};

/**
 * The validation hole a custom category opens, and why the child closes it.
 *
 * The domain's validator looks the `categoryId` up in `FINANCE_CATEGORIES` and,
 * only if it finds one, checks that the category's direction matches the
 * transaction's. A `custom:` id is in no such list, so the lookup misses and the
 * check is skipped entirely — meaning a custom category can be attached to either
 * direction with nothing objecting, while a built-in one cannot.
 *
 * SOURCE never noticed because its dialog rebuilt the category choices whenever the
 * direction changed and cleared the selection, so the mismatch was unreachable
 * through the screen. That is a screen preventing a mistake, not a rule.
 *
 * `packages/domain` is a closed phase, so the child validates the custom case
 * itself: a custom category is legal in either direction, but its label must be
 * present and within length, and it is recorded with the direction it was created
 * under. Written here because the next reader will otherwise assume the domain
 * validator covers every category. No constant — this is a note, and a `true` that
 * nothing reads would be dead surface.
 */

/** Recorded for the register: types the domain accepts that no caller can produce. */
export const UNREACHABLE_MANUAL_TYPES: readonly ManualFinanceTransactionType[] = [
  "cash-in",
  "cash-out",
  "adjustment",
];

/**
 * Whether a void actually changed anything.
 *
 * `alreadyVoided` exists because SOURCE's store returned the existing row for a
 * second void and the screen reported success either way — the same
 * silent-idempotency defect S5 fixed for stock consumption. A caller that cannot
 * tell a fresh void from a replay will report work it did not do.
 */
export interface VoidTransactionOutcome {
  readonly transaction: FinanceTransaction;
  readonly alreadyVoided: boolean;
}

/**
 * Writing manual transactions.
 *
 * One child rather than three, per LOGIC §12 rule 6: create, edit and void share
 * the same validation and the same entity, and splitting them would put one rule
 * in several places.
 *
 * This is the capability LOGIC §8 has POS checkout require. Worth recording
 * plainly: **SOURCE's POS checkout never recorded a finance transaction.** Its
 * checkout seam creates an order and consumes stock, and the sale appears in the
 * ledger only because it is projected from the order. So what slice 10 should call
 * here is an open question, not a ported behavior — see tech-debt.
 */
export interface TransactionRecording {
  recordTransaction(input: RecordTransactionInput): Promise<OperationResult<FinanceTransaction>>;
  updateTransaction(
    transactionId: string,
    input: RecordTransactionInput,
  ): Promise<OperationResult<FinanceTransaction>>;
  voidTransaction(transactionId: string): Promise<OperationResult<VoidTransactionOutcome>>;
}

export const TRANSACTION_RECORDING_ID = "admin.finance.transaction-recording";

export const TRANSACTION_RECORDING =
  createCapabilityToken<TransactionRecording>(TRANSACTION_RECORDING_ID);

// ─── Expense contracts (child: expense-management) ───────────────────────────

/**
 * The expense view: outflows only, with the categories to spend against.
 *
 * Honest note on scope. This child overlaps `ledger-read` more than any other pair
 * in the port, because SOURCE's expense screen was its transaction screen with
 * `direction: "outflow"` forced on the query and the income button removed. LOGIC
 * §6 names it as its own child, so it is one — but it delegates the ledger read
 * rather than re-deriving it, and owns only what is genuinely expense-specific:
 * forcing the direction so no caller can widen it by mistake, and offering the
 * outflow categories. `total` is carried because SOURCE's breakdown needed a
 * denominator and computed percentages against it in the view.
 */
export interface ExpenseView {
  readonly transactions: readonly FinanceTransaction[];
  readonly categories: readonly FinanceCategorySummary[];
  readonly total: Money;
  readonly transactionCount: number;
}

export interface ExpenseManagement {
  /** Always outflow-scoped; a `direction` in the query is overridden, not trusted. */
  queryExpenses(
    query?: FinanceTransactionQuery,
    outletId?: string,
  ): Promise<OperationResult<ExpenseView>>;
  /** The categories an expense may be filed under — outflow only. */
  listExpenseCategories(): readonly FinanceCategory[];
  /** Records an expense. Direction is forced, so an inflow cannot arrive here. */
  recordExpense(
    input: Omit<RecordTransactionInput, "direction">,
  ): Promise<OperationResult<FinanceTransaction>>;
}

export const EXPENSE_MANAGEMENT_ID = "admin.finance.expense-management";

export const EXPENSE_MANAGEMENT =
  createCapabilityToken<ExpenseManagement>(EXPENSE_MANAGEMENT_ID);

// ─── Refund contracts (child: refund-projection) ─────────────────────────────

/**
 * What a cancellation would refund.
 *
 * Read the `refundable` flag carefully, because slice 8 depends on it and
 * tech-debt D18 is about exactly this. The projection reports a refund only when
 * the order's payment status is `refunded`, and the domain sets that status when a
 * **paid** order is cancelled. So "is there a refund" is really "was this paid",
 * and SOURCE used it as the gate for reversing stock — which is why an UNPAID order
 * that consumed stock never got the stock back.
 *
 * The flag is therefore named for what it actually answers, and the field slice 8
 * needs in order not to inherit that defect is stated separately: whether stock was
 * consumed is not something this child can know, and it must not be inferred from
 * money.
 */
export interface RefundProjection {
  readonly transactions: readonly FinanceTransaction[];
  readonly refundable: boolean;
  readonly totalRefund: Money;
}

export interface RefundProjecting {
  /**
   * Pure and deterministic: the same settled order always yields the same refund
   * rows and the same ids, which is what makes exactly-once refund semantics come
   * from order state rather than from a persisted write.
   */
  projectRefund(order: Order): RefundProjection;
}

export const REFUND_PROJECTION_ID = "admin.finance.refund-projection";

export const REFUND_PROJECTION = createCapabilityToken<RefundProjecting>(REFUND_PROJECTION_ID);
