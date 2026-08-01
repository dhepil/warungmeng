// packages/admin-engine/src/engines/inventory/inventoryContracts.ts
//
// Stable contracts owned by the Inventory area (LOGIC §6: a `<area>Contracts.ts`
// exports capability, port, input, and output types — never behavior).
//
// Three things live here and nothing else: the capability tokens the area's
// children publish, the one outbound port the area uses to reach storage, and
// the area's own input/output shapes. `InventoryIngredient`, `InventorySupplier`,
// `InventoryStockBalance` and `InventoryMovement` are domain types and are
// imported, never redefined; a list filter is an admin concern.
//
// No UI vocabulary anywhere (LOGIC §5/§13): no label, column, route, or icon.
// The numeric limits below are rules, not widget settings — see the comment on
// each one for where SOURCE had been keeping them.
//
// This file covers slices S4 (materials-read, stock-movements, stock-adjustment)
// and is extended by S5 (stock-consumption, stock-reversal, hpp-calculation).

import type {
  InventoryIngredient,
  InventoryIngredientStatus,
  InventoryMovement,
  InventoryMovementType,
  InventoryStockBalance,
  InventorySupplier,
  InventoryUnit,
  MenuHppBreakdown,
  MenuRecipe,
  Money,
  Order,
} from "@warungmeng/domain";
import type { OperationIssue, OperationResult } from "@warungmeng/module-system";
import {
  createCapabilityToken,
  createOutboundPortToken,
} from "@warungmeng/module-system";

// ─── Rules lifted out of the SOURCE form components ──────────────────────────
//
// Every constant here was an AntD prop in SOURCE — `min`, `precision`, or a
// `rules={[...]}` entry — which meant it was a real rule enforced somewhere with
// no authority over rules. Anything not submitted through that one dialog
// skipped it, and the UI rebuild in P5 would have had to rediscover it. LOGIC
// §13 puts validation below the screen, so the rules live here and the write
// child enforces them.

/**
 * A movement must move something. SOURCE: `min: 0.01` on the quantity rule and
 * on the input itself (`InventoryMovementDialog`).
 *
 * Note this is stricter than the domain, which rejects only negatives and so
 * accepts a zero-quantity movement. A zero movement would write a ledger row
 * that changes no stock, which is a rule the dialog was quietly enforcing.
 */
export const MOVEMENT_QUANTITY_MINIMUM = 0.01;

/**
 * Entered quantities and money carry at most two decimals. SOURCE: `precision={2}`
 * on every numeric input in the area.
 *
 * This rounds rather than rejects, because that is what the widget did before
 * submitting. It applies to values a caller *enters*; a quantity the area
 * *derives* (750 ml expressed in litres is 0.75) is not re-rounded.
 */
export const INVENTORY_DECIMAL_PLACES = 2;

/** SOURCE: `min: 0` on the minimum-stock rule and input. */
export const MINIMUM_STOCK_FLOOR = 0;

/** SOURCE: `min: 0` on the initial-cost and unit-cost inputs. */
export const UNIT_COST_FLOOR = 0;

// ─── Persistence port ────────────────────────────────────────────────────────

/** `Omit<T, "id">` — the store assigns the id, as in the Menu area. */
export type InventoryCreateInput<TEntity extends { readonly id: string }> = Omit<TEntity, "id">;

/**
 * A patch over an ingredient's editable fields.
 *
 * Both cost fields are excluded, which is how "cost cannot be edited after
 * creation" becomes structural rather than advisory. SOURCE expressed the same
 * intent three separate ways — a `disabled` attribute on the input, the hook
 * omitting the keys, and an `Omit` on its own update type — and only the last
 * one had any force. Costs change through a `purchase` movement, never through
 * an edit.
 */
export type InventoryIngredientPatch = Partial<
  Omit<InventoryIngredient, "id" | "lastPurchaseUnitCost" | "averageUnitCost">
>;

/** What a generated id is for, so an adapter can prefix or route by kind. */
export type InventoryIdKind = "ingredient" | "movement";

/**
 * A stock balance to write, identified by its composite key.
 *
 * `InventoryStockBalance` has no `id` — a balance is keyed by
 * (ingredientId, outletId) — so the port takes the whole row and upserts it.
 */
export type StockBalanceUpsert = InventoryStockBalance;

/**
 * One committed stock movement: the ledger row plus the two rows it changes.
 *
 * This is the shape that makes the area's central invariant enforceable. In
 * SOURCE, `recordMovement` was a single store method that internally computed
 * the balance delta, mutated the balance, recomputed the ingredient's average
 * cost, and only then appended the ledger row — so the arithmetic lived in the
 * adapter, three writes happened in an order the caller could not see, and a
 * throw partway left stock changed with no audit record.
 *
 * Here the child does all of the deciding and hands the store a finished plan:
 * every number is already computed and validated, and the store's only job is to
 * persist these together. That inverts the responsibility on purpose —
 * arithmetic is behavior and belongs in logic (LOGIC §3), while atomicity is a
 * storage property and belongs to whoever owns the storage.
 *
 * `ingredient` is present only when the movement changes cost (a purchase with a
 * unit cost); otherwise the ingredient row is untouched.
 */
export interface StockMovementCommit {
  readonly movement: InventoryMovement;
  readonly balance: StockBalanceUpsert;
  readonly ingredient: InventoryIngredient | null;
}

/**
 * The Inventory area's window onto storage.
 *
 * Ported from SOURCE `packages/data/src/repositories/InventoryRepository.ts`,
 * keeping its result conventions because callers depend on them: `null` from a
 * get or update means not-found, and create returns the stored entity carrying
 * its new id.
 *
 * Four deliberate departures from SOURCE:
 *
 *   - **`recordMovement` is replaced by `commitMovement`.** SOURCE's method
 *     computed and mutated; this one persists a decided plan. See
 *     `StockMovementCommit`. The commit is expected to be all-or-nothing; an
 *     adapter that cannot promise that must say so by rejecting, not by
 *     half-writing. This is the primitive S5's consumption and reversal children
 *     go through as well, which is why it is defined here at area level and not
 *     inside the write child.
 *   - **`listIngredients` takes no query.** SOURCE's `InventoryIngredientQuery`
 *     carried `search`, `status`, `outletId` and `lowStockOnly`, and the
 *     `outletId` did nothing at all unless `lowStockOnly` was also set — every
 *     caller passed it believing it scoped the list, but ingredients are global.
 *     Worse, `lowStockOnly` was computed by walking balances, so it silently
 *     disagreed with the low-stock badge the same list rendered. Both are read
 *     concerns; the read child now owns them and the port just returns rows.
 *   - **No ordering is promised.** SOURCE sorted inside its in-memory
 *     repository, so a different adapter would have changed the order the list
 *     appears in. Ordering is a promise the engine makes.
 *   - **`newId` is part of the port**, as in the Menu area, so a movement id can
 *     be minted before the row is written and a test can make ids deterministic.
 */
export interface InventoryStorePort {
  listIngredients(): Promise<readonly InventoryIngredient[]>;
  getIngredientById(id: string): Promise<InventoryIngredient | null>;
  createIngredient(
    input: InventoryCreateInput<InventoryIngredient>,
  ): Promise<InventoryIngredient>;
  updateIngredient(
    id: string,
    patch: InventoryIngredientPatch,
  ): Promise<InventoryIngredient | null>;

  listSuppliers(): Promise<readonly InventorySupplier[]>;

  listStockBalances(outletId?: string): Promise<readonly InventoryStockBalance[]>;
  listMovements(query?: MovementStoreQuery): Promise<readonly InventoryMovement[]>;

  /**
   * Recipes, added in S5 for `hpp-calculation` (tech-debt D16).
   *
   * Read-only on purpose. SOURCE also had `saveRecipe`, but recipe *editing* is a
   * P5 screen concern with no child in LOGIC §8 owning it, and a port method
   * nobody calls invites an adapter to implement dead surface. Whoever builds the
   * recipe editor adds the write method then.
   */
  listRecipes(): Promise<readonly MenuRecipe[]>;

  /** Persists a decided movement — ledger row, balance, and cost — together. */
  commitMovement(commit: StockMovementCommit): Promise<void>;

  /**
   * Persists several decided movements together, added in S5.
   *
   * Consumption and reversal each write one row per recipe component, and those
   * rows are one accounting event: a half-consumed order is a worse state than a
   * refused one. SOURCE wrote them in a loop of single writes, so a failure
   * partway left stock decremented with no way to finish — and its own guard then
   * latched on the partial set and returned it forever.
   *
   * This does NOT make the batch atomic by itself; only an adapter can promise
   * that. It makes the batch *expressible*, so the atomic port (LOGIC §10) that
   * POS checkout and order cancellation own can wrap one call instead of N. An
   * adapter that cannot commit all of them must reject and write none.
   */
  commitMovements(commits: readonly StockMovementCommit[]): Promise<void>;

  newId(kind: InventoryIdKind): string;
}

/**
 * The filters the store itself can apply to the ledger.
 *
 * These are the three SOURCE's `InventoryMovementQuery` had and honoured. They
 * stay on the port rather than moving into the read child because a real backend
 * would push them down to the query — unlike ordering, which is a promise about
 * the answer, a filter is a description of what to fetch.
 *
 * `referenceId` is deliberately absent, matching SOURCE. It is a public field on
 * every movement and S5's idempotency check depends on it, so that slice will
 * have to add it here — noted in `plan/tech-debt.md`.
 */
export interface MovementStoreQuery {
  readonly ingredientId?: string;
  readonly outletId?: string;
  readonly type?: InventoryMovementType;
  /**
   * Added in S5, closing tech-debt D14. The automated paths identify their own
   * rows by the order that caused them, so idempotency is a query, not a scan.
   * SOURCE had the field on every movement and even displayed it, but left it off
   * the query — so its guards filtered the entire movement array in memory on
   * every checkout.
   */
  readonly referenceId?: string;
}

/**
 * Supplied by the composition root. Unresolved is a legal state: the area's
 * children still load and still publish their capabilities, and every call
 * returns a normalized failure instead of throwing.
 */
export const INVENTORY_STORE_PORT = createOutboundPortToken<InventoryStorePort>(
  "admin.inventory.store",
);

// ─── Read contracts (child: materials-read) ──────────────────────────────────

export type IngredientStatusFilter = "all" | InventoryIngredientStatus;

/**
 * Query input for the materials collection.
 *
 * `outletId` is required and it genuinely scopes: stock balances ARE per-outlet,
 * so which outlet you ask about decides every quantity and therefore every
 * low-stock verdict. SOURCE accepted an `outletId` that was ignored unless a
 * low-stock filter was also set, which implied a scoping that did not exist;
 * making it required and always applied removes the ambiguity.
 */
export interface MaterialListFilters {
  readonly search: string;
  readonly status: IngredientStatusFilter;
  readonly outletId: string;
  readonly lowStockOnly: boolean;
}

export const DEFAULT_MATERIAL_LIST_FILTERS: Omit<MaterialListFilters, "outletId"> = {
  search: "",
  status: "active",
  lowStockOnly: false,
};

/**
 * An ingredient joined to its stock level in one outlet.
 *
 * `quantity` is the balance for the requested outlet, or zero when no balance
 * row exists. `hasBalanceRecord` distinguishes those two cases, because they are
 * genuinely different — "counted and empty" and "never counted" look identical
 * once both read as zero, and SOURCE's disagreement between its list badge and
 * its list filter came directly from that conflation.
 *
 * `isLowStock` is the ONE answer to the low-stock question in this runtime. It is
 * computed here, once, so the flag a caller renders and the filter a caller
 * applies can never disagree again.
 */
export interface MaterialListItem {
  readonly ingredient: InventoryIngredient;
  readonly outletId: string;
  readonly quantity: number;
  readonly hasBalanceRecord: boolean;
  readonly isLowStock: boolean;
  /** Resolved from `supplierId`; null when unset or when the supplier is gone. */
  readonly supplier: InventorySupplier | null;
}

/**
 * A filtered collection plus the counts beside it.
 *
 * `lowStockCount` relaxes the low-stock dimension of the filter and keeps every
 * other one, the same rule the Menu area's count projections follow: ticking the
 * low-stock filter must not zero out the count that tells you how many there are.
 */
export interface MaterialCollection {
  readonly materials: readonly MaterialListItem[];
  readonly totalCount: number;
  readonly lowStockCount: number;
}

/**
 * The Inventory area's materials read surface — the capability LOGIC §8 names
 * `admin.inventory.materials-read`, required by `admin.dashboard.overview`.
 *
 * The dashboard is a real second consumer and it needs raw entities, not the
 * joined list rows: SOURCE reached into the store's own shape via a structural
 * `Pick<InventoryRepository, ...>` declared inside the dashboard feature, which
 * is a second competing definition of "inventory read" that would drift. The
 * three plain list methods exist so that consumer can come through this
 * capability instead.
 *
 * Everything returns a normalized result rather than throwing (LOGIC §5).
 */
export interface MaterialsRead {
  listIngredients(): Promise<OperationResult<readonly InventoryIngredient[]>>;
  listSuppliers(): Promise<OperationResult<readonly InventorySupplier[]>>;
  listStockBalances(outletId: string): Promise<OperationResult<readonly InventoryStockBalance[]>>;
  queryMaterials(filters: MaterialListFilters): Promise<OperationResult<MaterialCollection>>;
}

export const MATERIALS_READ_ID = "admin.inventory.materials-read";

export const MATERIALS_READ = createCapabilityToken<MaterialsRead>(MATERIALS_READ_ID);

// ─── Ledger contracts (child: stock-movements) ───────────────────────────────

export type MovementTypeFilter = "all" | InventoryMovementType;

/**
 * Query input for the movement ledger.
 *
 * These are the three dimensions SOURCE's store query carried and honoured. They
 * are expressed as a filter here — `"all"` and `null` mean unfiltered — and
 * translated into the port's narrower query, so a caller never has to build the
 * store's shape itself.
 *
 * There is deliberately no date-range filter: SOURCE had none, and adding one
 * would be a new feature rather than a ported one.
 */
export interface MovementListFilters {
  readonly ingredientId: string | null;
  readonly outletId: string | null;
  readonly type: MovementTypeFilter;
}

export const DEFAULT_MOVEMENT_LIST_FILTERS: MovementListFilters = {
  ingredientId: null,
  outletId: null,
  type: "all",
};

/**
 * A ledger row joined to the ingredient it moved.
 *
 * SOURCE's table looked the ingredient up while rendering, from a separately
 * fetched list of active ingredients — so a movement whose ingredient had since
 * been archived rendered with a blank name. Joining here means the row either
 * carries its ingredient or says plainly that it could not be resolved.
 *
 * `ingredient` is null when the movement references an ingredient the store no
 * longer returns. That is a dangling reference, and it is surfaced rather than
 * hidden: the ledger is an audit record, so a row that cannot be explained is
 * information, not something to filter out.
 */
export interface MovementListItem {
  readonly movement: InventoryMovement;
  readonly ingredient: InventoryIngredient | null;
}

/**
 * The Inventory area's ledger read surface — the capability LOGIC §8 names
 * `admin.inventory.stock-movements`, required by `admin.dashboard.reports`.
 *
 * `listMovements` returns raw domain rows for the reporting consumer;
 * `queryMovements` returns the joined rows the admin list shows. Both are
 * ordered newest-first with a deterministic tie-break — see the child.
 */
export interface StockMovements {
  listMovements(
    filters?: MovementListFilters,
  ): Promise<OperationResult<readonly InventoryMovement[]>>;
  queryMovements(
    filters?: MovementListFilters,
  ): Promise<OperationResult<readonly MovementListItem[]>>;
}

export const STOCK_MOVEMENTS_ID = "admin.inventory.stock-movements";

export const STOCK_MOVEMENTS = createCapabilityToken<StockMovements>(STOCK_MOVEMENTS_ID);

// ─── The shared write primitive ──────────────────────────────────────────────
//
// WHY THIS ONE FUNCTION LIVES IN A CONTRACTS FILE.
//
// This file otherwise holds no behavior, by the rule stated at the top. This is
// a deliberate, narrow exception and it is worth explaining, because the
// alternative was worse.
//
// Every write in this area — the manual adjustment in S4, and the automated
// consumption and reversal in S5 — goes through the same planning step: resolve
// the ingredient, check it can move, convert the quantity, compute the signed
// delta, apply it to the balance, reject a negative result, recompute cost on a
// purchase, and assemble the ledger row. In SOURCE that sequence lived inside the
// store's `recordMovement`, which is why the arithmetic was in the adapter and
// why a throw partway left stock changed with no audit record.
//
// LOGIC §8 shows neither S5 child requiring a capability from a sibling, so
// `stock-consumption` cannot depend on `stock-adjustment`. If the planning lived
// in the adjustment child, S5 would have to either import across siblings —
// which the area-slice pattern forbids — or reimplement the invariants, which is
// how SOURCE ended up with four copies of its low-stock rule. `plan.json` lists
// no shared-helper slot inside an area, and `packages/domain` is a closed phase.
//
// So it sits next to `StockMovementCommit`, the type it constructs, and it is
// pure: no store, no I/O, no capability. The domain still owns the arithmetic —
// this function calls `convertInventoryQuantity`, `calculateMovementBaseDelta`
// and `applyStockDelta` rather than restating any of them. Flagged in
// `plan/tech-debt.md` so the owner can decide whether a shared slot belongs in
// `plan.json` before S5 builds on it.

/**
 * Where a movement's quantity came from, which decides which rules apply to it.
 *
 * This distinction is load-bearing and was invisible in SOURCE. Two of the rules
 * lifted out of the movement form — the 0.01 minimum and two-decimal rounding —
 * are rules about what a PERSON may type, and SOURCE only ever applied them
 * there. A consumption quantity is computed
 * (`component.quantity × item.quantity × (1 + waste/100)`) and can legitimately
 * be very small or carry many decimals; applying the typed-entry rules to it
 * would refuse orders the old app accepted and silently round recipe maths.
 *
 * So one primitive, with the difference stated rather than assumed:
 *   - `entered` — rounded to `INVENTORY_DECIMAL_PLACES`, then must be at least
 *     `MOVEMENT_QUANTITY_MINIMUM`.
 *   - `derived` — not rounded, and only has to be finite and above zero. A
 *     zero-quantity row would change no stock and is noise in an audit ledger.
 *
 * Every other invariant — the ingredient exists and is active, the unit
 * converts, a purchase carries a cost, the balance may not go negative — applies
 * identically to both, which is the whole reason there is one primitive.
 */
export type QuantitySource = "entered" | "derived";

/** What a caller supplies to record a movement. Ids and derived values are not theirs to set. */
export interface StockMovementDraftInput {
  readonly ingredientId: string;
  readonly outletId: string;
  readonly type: InventoryMovementType;
  readonly quantity: number;
  readonly quantitySource: QuantitySource;
  readonly unit: InventoryUnit;
  readonly unitCost: Money | null;
  readonly referenceId: string | null;
  readonly note: string;
  readonly occurredAt: string;
}

/** Issue codes a planning failure can carry, so a caller can branch on the reason. */
export const MOVEMENT_ISSUE = {
  archivedIngredient: "ingredient-archived",
  quantityTooSmall: "quantity-below-minimum",
  quantityNotFinite: "quantity-not-finite",
  incompatibleUnit: "unit-incompatible",
  missingUnitCost: "unit-cost-required",
  negativeUnitCost: "unit-cost-negative",
  negativeStock: "negative-stock",
} as const;

// ─── Write contracts (child: stock-adjustment) ───────────────────────────────

/**
 * What a caller supplies to record a manual movement.
 *
 * `occurredAt` is the caller's, as in SOURCE, which stamped it from the client
 * clock. Deliberately not defaulted here: a logic child inventing a timestamp
 * would be reaching for a clock it does not own, and the atomic operations in S5
 * need to stamp a whole batch with one instant.
 */
export interface RecordMovementInput {
  readonly ingredientId: string;
  readonly outletId: string;
  readonly type: InventoryMovementType;
  readonly quantity: number;
  readonly unit: InventoryUnit;
  readonly unitCost: Money | null;
  readonly note: string;
  readonly occurredAt: string;
}

/** The editable half of an ingredient. Costs are absent by design — see `InventoryIngredientPatch`. */
export interface IngredientValues {
  readonly name: string;
  readonly baseUnit: InventoryUnit;
  readonly supplierId: string | null;
  readonly minimumStock: number;
}

/**
 * Creating an ingredient also sets its opening cost, which is the only moment a
 * cost is written directly. Every later change comes from a purchase movement.
 */
export interface CreateIngredientInput {
  readonly values: IngredientValues;
  readonly initialUnitCost: Money;
}

/**
 * Manual stock writing: recording a movement, and maintaining the ingredients
 * movements refer to.
 *
 * One child rather than two, per LOGIC §12 rule 6: an ingredient's `baseUnit` and
 * its stock movements share an invariant (every movement converts into that
 * unit), so splitting them would put the same rule in two places.
 *
 * Nothing here throws (LOGIC §5). SOURCE surfaced every failure — archived
 * ingredient, incompatible unit, insufficient stock, dead backend — through one
 * generic toast, so the user could not tell which had happened.
 */
export interface StockAdjustment {
  recordMovement(input: RecordMovementInput): Promise<OperationResult<InventoryMovement>>;
  createIngredient(input: CreateIngredientInput): Promise<OperationResult<InventoryIngredient>>;
  updateIngredient(
    ingredientId: string,
    values: IngredientValues,
  ): Promise<OperationResult<InventoryIngredient>>;
  /** Refuses an ingredient that is already archived. */
  archiveIngredient(ingredientId: string): Promise<OperationResult<InventoryIngredient>>;
}

/**
 * LOGIC §8 names no capability for this child, so it takes its own id — the same
 * default the Menu area applied to `menu-editor` and `variant-management`.
 */
export const STOCK_ADJUSTMENT_ID = "admin.inventory.stock-adjustment";

export const STOCK_ADJUSTMENT = createCapabilityToken<StockAdjustment>(STOCK_ADJUSTMENT_ID);

// ─── Automated write contracts (children: stock-consumption, stock-reversal) ──

/**
 * Why an order's stock could not be consumed, or could not be reversed.
 *
 * Named codes rather than one opaque failure, because the callers act
 * differently on each: POS checkout retries a transient store failure but must
 * not retry an archived ingredient, and order cancellation has to tell the user
 * whether the stock came back.
 */
export const CONSUMPTION_ISSUE = {
  /** A menu item in the order has no recipe, so nothing was consumed for it. */
  noRecipe: "menu-item-has-no-recipe",
  /** The order consumed nothing at all — every item lacked a recipe. */
  nothingToConsume: "order-consumes-nothing",
  /** Already consumed. Carries the existing rows; not an error. */
  alreadyConsumed: "order-already-consumed",
  /** Nothing was ever consumed for this order, so there is nothing to reverse. */
  neverConsumed: "order-never-consumed",
  /** Already reversed. Carries the existing rows; not an error. */
  alreadyReversed: "order-already-reversed",
} as const;

/**
 * The outcome of consuming or reversing an order's stock.
 *
 * `movements` is what exists in the ledger for this order afterwards — freshly
 * written rows, or the rows a replay found. `replayed` distinguishes those two,
 * which SOURCE could not: its guard returned the existing rows and the caller had
 * no way to tell a real write from a no-op, so a retry reported success for an
 * order it had not actually finished.
 *
 * `skippedMenuItemIds` names order items that consumed nothing because they have
 * no recipe. SOURCE skipped them in silence, which is how an order of entirely
 * recipe-less items recorded zero rows — and then, because the idempotency guard
 * keys on rows existing, never latched, so every retry re-ran it.
 */
export interface StockLedgerOutcome {
  readonly movements: readonly InventoryMovement[];
  readonly replayed: boolean;
  readonly skippedMenuItemIds: readonly string[];
}

/**
 * Consuming an order's ingredients (capability `admin.inventory.stock-consumption`,
 * required by `admin.pos.checkout` per LOGIC §8).
 *
 * Idempotent by `(order.id, "consumption")`, as in SOURCE — but the result says so
 * rather than hiding it.
 *
 * NOT atomic by itself, deliberately: LOGIC §10 gives the atomic boundary to POS
 * checkout, which owns the whole multi-owner workflow. This child plans every row
 * before writing any, and writes them through one `commitMovements`, so the
 * caller's transaction has a single call to wrap.
 */
export interface StockConsumption {
  consumeOrder(order: Order): Promise<OperationResult<StockLedgerOutcome>>;
}

export const STOCK_CONSUMPTION_ID = "admin.inventory.stock-consumption";

export const STOCK_CONSUMPTION = createCapabilityToken<StockConsumption>(STOCK_CONSUMPTION_ID);

/**
 * Returning an order's ingredients to stock (capability
 * `admin.inventory.stock-reversal`, required by `admin.orders.order-cancellation`
 * per LOGIC §8).
 *
 * Guarded both ways: an order that never consumed cannot be reversed, and one
 * already reversed is reported as a replay rather than reversed twice.
 */
export interface StockReversal {
  revertOrderConsumption(order: Order): Promise<OperationResult<StockLedgerOutcome>>;
}

export const STOCK_REVERSAL_ID = "admin.inventory.stock-reversal";

export const STOCK_REVERSAL = createCapabilityToken<StockReversal>(STOCK_REVERSAL_ID);

// ─── Costing contracts (child: hpp-calculation) ───────────────────────────────

/**
 * The pricing defaults SOURCE baked into its call site.
 *
 * `useInventoryHpp` called `calculateRecommendedSellingPrice(total)` with no
 * further arguments, so the domain's defaults — 60% target margin, rounded up to
 * the nearest 500 — were the product's pricing policy while looking like library
 * trivia. Named here so they are visible and can be changed in one place.
 */
export const HPP_TARGET_MARGIN_PERCENTAGE = 60;
export const HPP_PRICE_ROUNDING_STEP = 500;

/** Why one menu's cost could not be worked out. */
export const COSTING_ISSUE = {
  /** The recipe names an ingredient the store no longer has. */
  missingIngredient: "recipe-ingredient-missing",
  /** The recipe's costs make the total negative, so no price can be recommended. */
  negativeTotal: "recipe-total-negative",
  /** The recipe exists but has no components, so the total is packaging only. */
  emptyRecipe: "recipe-has-no-components",
  /** The recipe depends on an archived ingredient's cost. */
  archivedIngredient: "recipe-uses-archived-ingredient",
  /** The menu catalog is unreachable, so there is nothing to cost. */
  noCatalog: "menu-catalog-unavailable",
} as const;

/**
 * One menu's cost picture.
 *
 * `hpp` is null when the menu has no recipe — which is a normal state, not a
 * failure, and SOURCE showed it as a dash. `marginPercentage` and
 * `recommendedPrice` are null whenever they cannot be computed, which includes
 * having no recipe, a selling price of zero, and a recipe whose total is negative.
 */
export interface MenuCostBreakdown {
  readonly menuItemId: string;
  readonly menuName: string;
  readonly sellingPrice: Money;
  readonly hpp: MenuHppBreakdown | null;
  readonly marginPercentage: number | null;
  readonly recommendedPrice: Money | null;
  readonly issues: readonly OperationIssue[];
}

/**
 * Every menu's cost picture, plus the ones that could not be worked out.
 *
 * `failedMenuItemIds` exists because costing is per-menu and one bad recipe must
 * not take the rest down. SOURCE had two incompatible policies over exactly this
 * data: the HPP screen wrapped the whole fan-out in one `catch` and blanked every
 * row when any single menu threw, while the dashboard used `Promise.allSettled`
 * and degraded per item. The degrading one is right, so it is the only one here.
 */
export interface MenuCostCollection {
  readonly items: readonly MenuCostBreakdown[];
  readonly failedMenuItemIds: readonly string[];
}

/**
 * Costing menus against their recipes (capability
 * `admin.inventory.hpp-calculation`).
 *
 * The only inventory child that REQUIRES another area: LOGIC §8 gives it
 * `admin.menu.catalog-read`, because a cost is meaningless without the menu's name
 * and selling price. That is why the Menu area had to be built first.
 */
export interface HppCalculation {
  calculateMenuCost(menuItemId: string): Promise<OperationResult<MenuCostBreakdown>>;
  queryMenuCosts(): Promise<OperationResult<MenuCostCollection>>;
}

export const HPP_CALCULATION_ID = "admin.inventory.hpp-calculation";

export const HPP_CALCULATION = createCapabilityToken<HppCalculation>(HPP_CALCULATION_ID);
