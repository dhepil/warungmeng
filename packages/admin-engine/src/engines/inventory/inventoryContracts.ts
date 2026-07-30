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
  Money,
} from "@warungmeng/domain";
import type { OperationResult } from "@warungmeng/module-system";
import { createCapabilityToken, createOutboundPortToken } from "@warungmeng/module-system";

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

/**
 * The movement types that reduce stock, and therefore the ones a caller may
 * record as an outbound adjustment.
 *
 * The domain owns the sign of a movement (`calculateMovementBaseDelta`). This
 * list exists only so the write child can name which types belong to a manual
 * adjustment versus the automated ones, and it is derived from the domain's own
 * type union rather than restated as strings.
 */
export const MANUAL_MOVEMENT_TYPES: readonly InventoryMovementType[] = [
  "purchase",
  "adjustment-in",
  "adjustment-out",
  "waste",
];

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

  /** Persists a decided movement — ledger row, balance, and cost — together. */
  commitMovement(commit: StockMovementCommit): Promise<void>;

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
