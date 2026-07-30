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
import {
  applyStockDelta,
  areInventoryUnitsCompatible,
  calculateMovementBaseDelta,
  convertInventoryQuantity,
} from "@warungmeng/domain";
import type { OperationResult } from "@warungmeng/module-system";
import {
  createCapabilityToken,
  createOutboundPortToken,
  operationFailure,
  operationIssue,
  operationSuccess,
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

/** What a caller supplies to record a movement. Ids and derived values are not theirs to set. */
export interface StockMovementDraftInput {
  readonly ingredientId: string;
  readonly outletId: string;
  readonly type: InventoryMovementType;
  readonly quantity: number;
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

/**
 * Rounds an entered value to the area's decimal precision.
 *
 * SOURCE enforced this as `precision={2}` on the input widget, so it applied only
 * to values typed into that one dialog and nothing else — a movement submitted
 * any other way kept full float precision. Rounding here makes it a rule.
 *
 * Applies to what a caller ENTERS. A quantity the area derives (750 ml expressed
 * in litres is 0.75) is not re-rounded, and neither is money the area computes.
 */
export function roundEntered(value: number): number {
  const factor = 10 ** INVENTORY_DECIMAL_PLACES;
  // The `Number.EPSILON` nudge matches the domain's own `roundMoney`. Without it
  // a value like 1.005 — which is really 1.00499… in binary floating point —
  // rounds DOWN, so two places in one runtime would round the same input
  // differently. One rounding convention, as with diagnostic severity.
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * Recomputes an ingredient's weighted-average unit cost after a purchase.
 *
 * Ported from SOURCE `InMemoryInventoryRepository.recordMovement`, keeping the
 * arithmetic exactly: the pre-movement quantity weights the old average, the
 * purchased quantity weights the new unit cost, and a purchase into empty stock
 * takes the new cost outright. `Math.max(0, previousQuantity)` is SOURCE's too —
 * a negative starting balance is treated as empty rather than allowed to invert
 * the weighting.
 *
 * `previousQuantity` must be the balance BEFORE the delta is applied. SOURCE
 * depended on the same thing implicitly, by reading a variable it had already
 * overwritten in the array; here it is a parameter, so the requirement is visible.
 *
 * Deliberately NOT rounded, matching SOURCE. See `plan/tech-debt.md` — the value
 * feeds HPP and therefore prices, and rounding it would change every cost figure
 * the owner currently sees. That is a decision for the owner, not a port.
 */
export function recomputeAverageUnitCost(
  ingredient: InventoryIngredient,
  previousQuantity: number,
  purchasedBaseQuantity: number,
  baseUnitCost: number,
): { readonly lastPurchaseUnitCost: Money; readonly averageUnitCost: Money } {
  const held = Math.max(0, previousQuantity);
  const total = held + purchasedBaseQuantity;
  const average =
    total === 0
      ? baseUnitCost
      : (held * ingredient.averageUnitCost.amount + purchasedBaseQuantity * baseUnitCost) / total;

  return {
    lastPurchaseUnitCost: { amount: baseUnitCost, currency: ingredient.averageUnitCost.currency },
    averageUnitCost: { amount: average, currency: ingredient.averageUnitCost.currency },
  };
}

/**
 * Decides one stock movement in full, or explains why it cannot happen.
 *
 * This is the shared write primitive. It validates, computes, and assembles —
 * and touches nothing. The caller persists the returned commit through
 * `InventoryStorePort.commitMovement`, which is the only step that can leave a
 * trace, so a rejected movement changes nothing at all.
 *
 * That ordering is the fix for SOURCE's central defect. There, `recordMovement`
 * pushed a zero-quantity balance row for a new (ingredient, outlet) pair, THEN
 * applied the delta — so a movement rejected for negative stock left behind a
 * balance row that had not existed before, which in turn changed how that
 * ingredient answered the low-stock filter. A failed write silently altered query
 * results. Here the new zero row is only ever part of a plan; if validation fails,
 * the plan is discarded.
 *
 * Rules enforced, and where SOURCE kept each one:
 *
 *   - the ingredient must exist and be active — SOURCE: the store, kept
 *   - quantity finite and at least `MOVEMENT_QUANTITY_MINIMUM` — SOURCE: an AntD
 *     `min` rule, so logic accepted a zero-quantity movement that wrote a ledger
 *     row changing nothing
 *   - the entered quantity is rounded to 2 decimals — SOURCE: `precision={2}`
 *     on the widget only
 *   - the unit must share a dimension with the ingredient's base unit — SOURCE:
 *     the dropdown was pre-filtered, so the domain's check was unreachable and a
 *     non-UI caller bypassed it entirely
 *   - a purchase requires a unit cost — SOURCE: a conditionally rendered field,
 *     and the payload coerced a missing cost to zero, which would silently drag
 *     the weighted average toward zero
 *   - a unit cost may not be negative — SOURCE: `min={0}` on the widget
 *   - the resulting balance may not go negative — SOURCE: the domain, kept
 *
 * `allowNegativeStock` is not exposed. The domain parameter exists and defaults to
 * false; no SOURCE caller ever set it, not even a test. Threading a flag no
 * caller uses would be inventing a feature.
 */
export function planStockMovement(
  input: StockMovementDraftInput,
  ingredient: InventoryIngredient | null,
  balance: InventoryStockBalance | null,
  movementId: string,
): OperationResult<StockMovementCommit> {
  if (ingredient === null) {
    return operationFailure("not-found", [
      operationIssue(
        "ingredient-not-found",
        `Ingredient ${input.ingredientId} was not found.`,
        input.ingredientId,
      ),
    ]);
  }

  if (ingredient.status !== "active") {
    return operationFailure("conflict", [
      operationIssue(
        MOVEMENT_ISSUE.archivedIngredient,
        `${ingredient.name} is archived, so its stock cannot move.`,
        ingredient.id,
      ),
    ]);
  }

  if (!Number.isFinite(input.quantity)) {
    return operationFailure("invalid-input", [
      operationIssue(
        MOVEMENT_ISSUE.quantityNotFinite,
        "A movement quantity must be a finite number.",
        ingredient.id,
      ),
    ]);
  }

  const quantity = roundEntered(input.quantity);

  if (quantity < MOVEMENT_QUANTITY_MINIMUM) {
    return operationFailure("invalid-input", [
      operationIssue(
        MOVEMENT_ISSUE.quantityTooSmall,
        `A movement must move at least ${MOVEMENT_QUANTITY_MINIMUM} ${input.unit}.`,
        ingredient.id,
        { quantity, minimum: MOVEMENT_QUANTITY_MINIMUM },
      ),
    ]);
  }

  if (!areInventoryUnitsCompatible(input.unit, ingredient.baseUnit)) {
    return operationFailure("invalid-input", [
      operationIssue(
        MOVEMENT_ISSUE.incompatibleUnit,
        `${input.unit} cannot be converted to ${ingredient.baseUnit}.`,
        ingredient.id,
        { from: input.unit, to: ingredient.baseUnit },
      ),
    ]);
  }

  if (input.type === "purchase" && input.unitCost === null) {
    return operationFailure("invalid-input", [
      operationIssue(
        MOVEMENT_ISSUE.missingUnitCost,
        "A purchase must carry a unit cost, because it sets the ingredient's average cost.",
        ingredient.id,
      ),
    ]);
  }

  if (input.unitCost !== null && input.unitCost.amount < UNIT_COST_FLOOR) {
    return operationFailure("invalid-input", [
      operationIssue(
        MOVEMENT_ISSUE.negativeUnitCost,
        "A unit cost cannot be negative.",
        ingredient.id,
      ),
    ]);
  }

  const draft = { type: input.type, quantity, unit: input.unit };
  const baseQuantityDelta = calculateMovementBaseDelta(ingredient, draft);

  // The row a first-ever movement would create. It exists only inside this plan
  // until the caller commits, which is what stops a rejected movement from
  // leaving one behind.
  const current: InventoryStockBalance = balance ?? {
    ingredientId: input.ingredientId,
    outletId: input.outletId,
    quantity: 0,
    updatedAt: input.occurredAt,
  };

  let nextBalance: InventoryStockBalance;
  try {
    nextBalance = applyStockDelta(current, baseQuantityDelta);
  } catch {
    // The domain's own rejection, restated as a typed issue naming the numbers.
    // SOURCE let the RangeError reach a catch-all that showed one generic toast,
    // so "not enough stock" and "the backend is down" looked identical.
    return operationFailure("conflict", [
      operationIssue(
        MOVEMENT_ISSUE.negativeStock,
        `${ingredient.name} has ${current.quantity} ${ingredient.baseUnit}, which is not ` +
          `enough for this movement.`,
        ingredient.id,
        { available: current.quantity, delta: baseQuantityDelta },
      ),
    ]);
  }

  const costed =
    input.type === "purchase" && input.unitCost !== null
      ? recomputeAverageUnitCost(
          ingredient,
          current.quantity,
          Math.abs(baseQuantityDelta),
          input.unitCost.amount / convertInventoryQuantity(1, input.unit, ingredient.baseUnit),
        )
      : null;

  return operationSuccess({
    movement: {
      id: movementId,
      ingredientId: input.ingredientId,
      outletId: input.outletId,
      type: input.type,
      quantity,
      unit: input.unit,
      baseQuantityDelta,
      unitCost: input.unitCost,
      referenceId: input.referenceId,
      note: input.note,
      occurredAt: input.occurredAt,
    },
    balance: { ...nextBalance, updatedAt: input.occurredAt },
    ingredient: costed === null ? null : { ...ingredient, ...costed },
  });
}

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
