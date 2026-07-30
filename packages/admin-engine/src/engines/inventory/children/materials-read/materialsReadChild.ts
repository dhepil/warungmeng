// packages/admin-engine/src/engines/inventory/children/materials-read/materialsReadChild.ts
//
// Inventory materials reading (capability `admin.inventory.materials-read`).
//
// The Inventory area's ingredient read side, and the capability LOGIC §8 shows
// `admin.dashboard.overview` depending on. It requires nothing itself.
//
// Ported from SOURCE:
//   - apps/admin/src/features/inventory/application/useInventoryMaterials.ts
//     (the ingredient/balance/supplier load, the filters, the balance lookup map)
//   - packages/data/src/mocks/InMemoryInventoryRepository.ts (the search, status
//     and low-stock filtering, and the name ordering, all of which lived in the
//     adapter and now live here)
//   - apps/admin/src/features/inventory/components/InventoryMaterialsTable.tsx
//     (the inline low-stock rule it computed while rendering)
//
// Not carried over: the React hook's boolean `error` flag, which discarded the
// store's message; the debounce-free refetch on every keystroke; and the
// module-level repository singleton the injected port replaces.

import type {
  InventoryIngredient,
  InventoryStockBalance,
  InventorySupplier,
} from "@warungmeng/domain";
import type { LogicChildContext, OperationResult } from "@warungmeng/module-system";
import {
  defineLogicChild,
  operationFailure,
  operationIssue,
  operationSuccess,
  severityForCode,
} from "@warungmeng/module-system";
import { INVENTORY_ENGINE_ID } from "../../inventoryEngine";
import type {
  MaterialCollection,
  MaterialListFilters,
  MaterialListItem,
  MaterialsRead,
  InventoryStorePort,
} from "../../inventoryContracts";
import {
  INVENTORY_STORE_PORT,
  MATERIALS_READ,
  MATERIALS_READ_ID,
} from "../../inventoryContracts";

// ─── Ordering ────────────────────────────────────────────────────────────────

/**
 * By name, then by id.
 *
 * Two changes from SOURCE, which sorted `name.localeCompare` inside its
 * in-memory repository. The sort moved out of the store, because ordering is a
 * promise the engine makes and leaving it in the adapter meant a different
 * adapter would silently reorder the list. And the id tie-break is new: nothing
 * prevents two ingredients sharing a name (see `tech-debt.md` D3 — the same
 * absence of uniqueness rules the Menu area found), so name alone left the order
 * of duplicates up to the sort implementation.
 */
function byNameThenId<TEntity extends { readonly id: string; readonly name: string }>(
  left: TEntity,
  right: TEntity,
): number {
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

function sorted<TEntity extends { readonly id: string; readonly name: string }>(
  entities: readonly TEntity[],
): readonly TEntity[] {
  return [...entities].sort(byNameThenId);
}

// ─── The low-stock rule ──────────────────────────────────────────────────────

/**
 * Whether a stock level is at or below its ingredient's minimum.
 *
 * **This is the single definition of low stock in the admin runtime**, and
 * consolidating it is the main reason this child exists in the shape it does.
 * SOURCE had four live implementations plus an unused one in the domain, and
 * they disagreed about the case that matters most — an ingredient with no
 * balance row at all:
 *
 *   - the materials table defaulted a missing row to zero, so the ingredient
 *     rendered with a low-stock warning;
 *   - the store's `lowStockOnly` filter was computed by walking balance rows, so
 *     an ingredient without one could not appear;
 *   - the dashboard excluded a missing row explicitly;
 *   - the usage report treated it as zero, contradicting the dashboard;
 *   - the domain's `isLowStock` took a balance as a required argument, so it
 *     could not express the case at all, and nothing ever called it.
 *
 * The user-visible result was that ticking "low stock only" HID rows the same
 * list had just badged as low. The filter was strictly less inclusive than the
 * badge it appeared to filter on.
 *
 * Resolved in favour of the badge: a missing balance row counts as zero and is
 * therefore low, because an ingredient nobody has stocked is exactly the thing a
 * low-stock list should surface. The badge was also the behavior the owner could
 * actually see, so this keeps the list looking the way it looked and fixes the
 * filter that contradicted it. `MaterialListItem.hasBalanceRecord` preserves the
 * distinction for any caller that needs "never counted" rather than "empty".
 *
 * The comparison is `<=`, matching all four SOURCE copies.
 */
export function isLowStockLevel(ingredient: InventoryIngredient, quantity: number): boolean {
  return quantity <= ingredient.minimumStock;
}

// ─── Pure projections ────────────────────────────────────────────────────────
//
// Exported for the test beside this file. Discovery reads the default export, so
// naming these does not make the file ambiguous.

/** SOURCE's normalization: trimmed and lowercased, empty meaning "match all". */
function normalizeSearch(search: string): string {
  return search.trim().toLocaleLowerCase();
}

/**
 * Joins ingredients to their balance in one outlet and to their supplier.
 *
 * Balances are indexed by ingredient id after being narrowed to the requested
 * outlet. SOURCE built the same map in a React hook from a list it had already
 * filtered by outlet; doing the narrowing here means a store that ignores its
 * `outletId` argument cannot leak another outlet's quantity into this one's row.
 */
export function joinMaterials(
  ingredients: readonly InventoryIngredient[],
  balances: readonly InventoryStockBalance[],
  suppliers: readonly InventorySupplier[],
  outletId: string,
): readonly MaterialListItem[] {
  const balanceByIngredientId = new Map<string, InventoryStockBalance>();
  for (const balance of balances) {
    if (balance.outletId === outletId) {
      balanceByIngredientId.set(balance.ingredientId, balance);
    }
  }

  const supplierById = new Map(suppliers.map((supplier) => [supplier.id, supplier]));

  return sorted(ingredients).map((ingredient) => {
    const balance = balanceByIngredientId.get(ingredient.id);
    const quantity = balance?.quantity ?? 0;

    return {
      ingredient,
      outletId,
      quantity,
      hasBalanceRecord: balance !== undefined,
      isLowStock: isLowStockLevel(ingredient, quantity),
      supplier:
        ingredient.supplierId === null ? null : supplierById.get(ingredient.supplierId) ?? null,
    };
  });
}

/**
 * Search matches the ingredient name only, as in SOURCE — not the supplier and
 * not the id. Status and low-stock are exact.
 */
export function filterMaterials(
  materials: readonly MaterialListItem[],
  filters: MaterialListFilters,
): readonly MaterialListItem[] {
  const search = normalizeSearch(filters.search);

  return materials.filter((item) => {
    const matchesSearch = !search || item.ingredient.name.toLocaleLowerCase().includes(search);
    const matchesStatus = filters.status === "all" || item.ingredient.status === filters.status;
    const matchesLowStock = !filters.lowStockOnly || item.isLowStock;

    return matchesSearch && matchesStatus && matchesLowStock;
  });
}

/**
 * The collection plus its counts.
 *
 * `lowStockCount` relaxes the low-stock dimension and keeps the others, the same
 * rule the Menu area's count projections follow: ticking the filter must not zero
 * the number that tells you how many there are. `totalCount` is therefore the
 * total within the current search and status, not the whole store.
 *
 * Note the count is honest about status: with the default `status: "active"` an
 * archived low-stock ingredient is excluded from both numbers. SOURCE's badge and
 * store filter both ignored status here while its two reporting copies did not.
 */
export function projectMaterialCollection(
  materials: readonly MaterialListItem[],
  filters: MaterialListFilters,
): MaterialCollection {
  return {
    materials: filterMaterials(materials, filters),
    totalCount: filterMaterials(materials, { ...filters, lowStockOnly: false }).length,
    lowStockCount: filterMaterials(materials, { ...filters, lowStockOnly: true }).length,
  };
}

// ─── Store access ────────────────────────────────────────────────────────────

const NO_STORE = "no-inventory-store";
const STORE_FAILED = "inventory-store-failed";

function noStore<TValue>(operation: string): OperationResult<TValue> {
  return operationFailure("unsatisfied-dependency", [
    operationIssue(
      NO_STORE,
      "No inventory store is connected, so inventory cannot be read.",
      operation,
    ),
  ]);
}

/**
 * Runs a store call and normalizes whatever comes back.
 *
 * SOURCE's hooks caught a rejection and set an opaque boolean, so a dead backend
 * and a rejected write were indistinguishable. The store's own message is carried
 * through instead (LOGIC §5).
 */
async function fromStore<TValue>(
  operation: string,
  read: () => Promise<TValue>,
): Promise<OperationResult<TValue>> {
  try {
    return operationSuccess(await read());
  } catch (error) {
    return operationFailure("failed", [
      operationIssue(
        STORE_FAILED,
        error instanceof Error ? error.message : "The inventory store failed.",
        operation,
      ),
    ]);
  }
}

function materialsReadOverStore(store: InventoryStorePort): MaterialsRead {
  return {
    listIngredients: async (): Promise<OperationResult<readonly InventoryIngredient[]>> =>
      fromStore("listIngredients", async () => sorted(await store.listIngredients())),

    listSuppliers: async (): Promise<OperationResult<readonly InventorySupplier[]>> =>
      fromStore("listSuppliers", async () => sorted(await store.listSuppliers())),

    listStockBalances: async (
      outletId: string,
    ): Promise<OperationResult<readonly InventoryStockBalance[]>> =>
      fromStore("listStockBalances", async () =>
        (await store.listStockBalances(outletId)).filter(
          (balance) => balance.outletId === outletId,
        ),
      ),

    async queryMaterials(
      filters: MaterialListFilters,
    ): Promise<OperationResult<MaterialCollection>> {
      return fromStore("queryMaterials", async () => {
        const [ingredients, balances, suppliers] = await Promise.all([
          store.listIngredients(),
          store.listStockBalances(filters.outletId),
          store.listSuppliers(),
        ]);

        return projectMaterialCollection(
          joinMaterials(ingredients, balances, suppliers, filters.outletId),
          filters,
        );
      });
    },
  };
}

/**
 * The capability published when no store is connected.
 *
 * The child still loads and still publishes — it declared no requirements, so the
 * dependency graph has no reason to exclude it, and a consumer resolving it gets
 * an honest "no store" answer rather than an unexplained absence. `unavailable`
 * means a required capability was never published, and this one was.
 */
function materialsReadWithoutStore(): MaterialsRead {
  return {
    listIngredients: async () => noStore("listIngredients"),
    listSuppliers: async () => noStore("listSuppliers"),
    listStockBalances: async () => noStore("listStockBalances"),
    queryMaterials: async () => noStore("queryMaterials"),
  };
}

export function createMaterialsRead(context: LogicChildContext): MaterialsRead {
  const store = context.ports.resolve(INVENTORY_STORE_PORT);

  if (store === undefined) {
    // Reported once, at creation, rather than on every call: a diagnostic per
    // read would bury the one fact worth knowing under its own repetition.
    context.diagnostics.report({
      code: "missing-dependency",
      severity: severityForCode("missing-dependency"),
      message:
        "No inventory store was supplied to the Inventory area, so material reads return " +
        "a normalized failure. The capability is published and callers stay working.",
      childId: context.childId,
      engineId: context.parentId,
      source: "materialsReadChild",
    });
  }

  const capability =
    store === undefined ? materialsReadWithoutStore() : materialsReadOverStore(store);

  context.capabilities.provide(MATERIALS_READ, capability);

  return capability;
}

export default defineLogicChild<MaterialsRead>({
  id: MATERIALS_READ_ID,
  parentId: INVENTORY_ENGINE_ID,
  provides: [MATERIALS_READ_ID],
  requires: [],
  create: createMaterialsRead,
});
