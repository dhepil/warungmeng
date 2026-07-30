// packages/admin-engine/src/engines/menu/children/catalog-read/catalogReadChild.ts
//
// Menu catalog reading (capability `admin.menu.catalog-read`).
//
// This is the Menu area's read side, and the capability LOGIC §8 shows two other
// areas depending on — inventory HPP and POS checkout both list against it. It
// requires nothing itself, which is why the Menu area could be built first.
//
// Ported from SOURCE:
//   - apps/admin/src/features/menu/application/catalogReadCapability.ts (the
//     three list methods, already extracted there as a capability interface)
//   - apps/admin/src/features/menu/application/menuListModel.ts (search,
//     category and availability filtering, and the two count projections)
//   - apps/admin/src/features/menu/application/variantGroupListModel.ts (the
//     flattened variant option rows and their filters and counts)
//   - the load half of application/useMenuList.ts and useVariantGroupList.ts,
//     which held the same behavior wrapped in React state; the wrapper is gone
//     and the behavior is here, where it can be tested without a renderer.
//
// Three things are deliberately NOT carried over:
//   - The React hooks' cached state and `reloadVersion` retry counter. SOURCE
//     had no cache across mounts and no invalidation when another screen wrote,
//     so a cache here would be a new mechanism, not a ported one. Every read
//     goes to the store; a caller that wants to re-read, re-reads.
//   - `MenuListQuery`, the store-side search that no caller ever used.
//   - The module-level repository singleton behind a Proxy. That is the seam
//     this child replaces: the store arrives through the injected port.

import type { MenuCategory, MenuItem, MenuVariantGroup } from "@warungmeng/domain";
import type { LogicChildContext, OperationResult } from "@warungmeng/module-system";
import {
  defineLogicChild,
  operationFailure,
  operationIssue,
  operationSuccess,
  severityForCode,
} from "@warungmeng/module-system";
import { MENU_ENGINE_ID } from "../../menuEngine";
import type {
  CatalogRead,
  MenuCatalogPort,
  MenuCollection,
  MenuListFilters,
  VariantOptionCollection,
  VariantOptionListFilters,
  VariantOptionListItem,
} from "../../menuContracts";
import {
  DEFAULT_MENU_LIST_FILTERS,
  DEFAULT_VARIANT_OPTION_LIST_FILTERS,
  MENU_CATALOG_PORT,
  MENU_CATALOG_READ,
  MENU_CATALOG_READ_ID,
} from "../../menuContracts";

// ─── Ordering ────────────────────────────────────────────────────────────────

/**
 * Sort order, then name (SOURCE `InMemoryMenuCatalogRepository.bySortOrderThenName`).
 *
 * This moved from the store into the engine on purpose. In SOURCE the ordering
 * was a property of one in-memory implementation, so plugging in a different
 * store would have silently changed the order menus appear in. Ordering is
 * behavior, and behavior belongs to the child that promises it.
 */
function bySortOrderThenName<TEntity extends { readonly sortOrder: number; readonly name: string }>(
  left: TEntity,
  right: TEntity,
): number {
  return left.sortOrder - right.sortOrder || left.name.localeCompare(right.name);
}

function sorted<TEntity extends { readonly sortOrder: number; readonly name: string }>(
  entities: readonly TEntity[],
): readonly TEntity[] {
  return [...entities].sort(bySortOrderThenName);
}

// ─── Pure projections ────────────────────────────────────────────────────────
//
// Exported for the test beside this file. Discovery reads the default export, so
// naming these does not make the file ambiguous.

/** SOURCE's normalization: trimmed and lowercased, empty meaning "match all". */
function normalizeSearch(search: string): string {
  return search.trim().toLocaleLowerCase();
}

function includesSearch(value: string, search: string): boolean {
  return value.toLocaleLowerCase().includes(search);
}

/**
 * Search matches name OR description; category and availability are exact.
 *
 * The availability comparison is against `availability.status` only, so a menu
 * whose `unavailableUntil` window has already elapsed still counts as
 * unavailable here. That is SOURCE's behavior and it is kept deliberately: the
 * domain has a time-and-stock-aware `isMenuAvailable`, which is a different and
 * stricter question. Answering the stricter one here would silently change what
 * the list shows, so the two notions stay distinct and a caller that wants the
 * time-aware one asks the domain for it.
 */
export function filterMenus(
  menus: readonly MenuItem[],
  filters: MenuListFilters,
): readonly MenuItem[] {
  const search = normalizeSearch(filters.search);

  return menus.filter((menu) => {
    const matchesSearch =
      !search || includesSearch(menu.name, search) || includesSearch(menu.description, search);
    const matchesCategory = !filters.categoryId || menu.categoryId === filters.categoryId;
    const matchesAvailability =
      filters.availability === "all" || menu.availability.status === filters.availability;

    return matchesSearch && matchesCategory && matchesAvailability;
  });
}

/**
 * Counts per category with the category filter relaxed, so selecting one
 * category does not zero every other category's count. Categories with no
 * matches are absent rather than zero, as in SOURCE.
 */
export function countMenusByCategory(
  menus: readonly MenuItem[],
  filters: MenuListFilters,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();

  for (const menu of filterMenus(menus, { ...filters, categoryId: null })) {
    counts.set(menu.categoryId, (counts.get(menu.categoryId) ?? 0) + 1);
  }

  return counts;
}

/** The same relaxation for the availability dimension. */
export function countMenusByAvailability(
  menus: readonly MenuItem[],
  filters: MenuListFilters,
  availability: MenuListFilters["availability"],
): number {
  return filterMenus(menus, { ...filters, availability }).length;
}

export function projectMenuCollection(
  menus: readonly MenuItem[],
  filters: MenuListFilters,
): MenuCollection {
  return {
    menus: filterMenus(menus, filters),
    countsByCategory: countMenusByCategory(menus, filters),
    totalCount: countMenusByAvailability(menus, filters, "all"),
    unavailableCount: countMenusByAvailability(menus, filters, "unavailable"),
  };
}

/**
 * One row per option, in group order then option order.
 *
 * Options are NOT re-sorted. SOURCE stored them in array order and only
 * rewrote `sortOrder` on a full editor save, so sorting them here would show a
 * different order than the editor does.
 */
export function flattenVariantOptions(
  groups: readonly MenuVariantGroup[],
): readonly VariantOptionListItem[] {
  return groups.flatMap((group) =>
    group.options.map((option) => ({
      id: `${group.id}:${option.id}`,
      groupId: group.id,
      groupName: group.name,
      option,
    })),
  );
}

/**
 * Search matches the group name OR the option name.
 *
 * One correction to SOURCE: its availability branch compared against the
 * literal `"unavailable"` instead of the requested filter value. The filter
 * only offers "all" and "unavailable" today, so the two agree on every input
 * that can currently occur — but the literal would have quietly ignored any
 * value added later. Comparing against the argument is behavior-identical now
 * and honest afterwards.
 */
export function filterVariantOptions(
  groups: readonly MenuVariantGroup[],
  filters: VariantOptionListFilters,
): readonly VariantOptionListItem[] {
  const search = normalizeSearch(filters.search);

  return flattenVariantOptions(groups).filter((item) => {
    const matchesSearch =
      !search ||
      includesSearch(item.groupName, search) ||
      includesSearch(item.option.name, search);
    const matchesGroup = !filters.groupId || item.groupId === filters.groupId;
    const matchesAvailability =
      filters.availability === "all" || item.option.availability.status === filters.availability;

    return matchesSearch && matchesGroup && matchesAvailability;
  });
}

export function countVariantOptionsByGroup(
  groups: readonly MenuVariantGroup[],
  filters: VariantOptionListFilters,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();

  for (const item of filterVariantOptions(groups, { ...filters, groupId: null })) {
    counts.set(item.groupId, (counts.get(item.groupId) ?? 0) + 1);
  }

  return counts;
}

export function countVariantOptionsByAvailability(
  groups: readonly MenuVariantGroup[],
  filters: VariantOptionListFilters,
  availability: VariantOptionListFilters["availability"],
): number {
  return filterVariantOptions(groups, { ...filters, availability }).length;
}

export function projectVariantOptionCollection(
  groups: readonly MenuVariantGroup[],
  filters: VariantOptionListFilters,
): VariantOptionCollection {
  return {
    options: filterVariantOptions(groups, filters),
    countsByGroup: countVariantOptionsByGroup(groups, filters),
    totalCount: countVariantOptionsByAvailability(groups, filters, "all"),
    unavailableCount: countVariantOptionsByAvailability(groups, filters, "unavailable"),
  };
}

// ─── Store access ────────────────────────────────────────────────────────────

const NO_STORE = "no-catalog-store";
const STORE_FAILED = "catalog-store-failed";

function noStore<TValue>(operation: string): OperationResult<TValue> {
  return operationFailure("unsatisfied-dependency", [
    operationIssue(
      NO_STORE,
      "No catalog store is connected, so the menu catalog cannot be read.",
      operation,
    ),
  ]);
}

/**
 * Runs a store call and normalizes whatever comes back.
 *
 * SOURCE's hooks caught a rejected promise and set an opaque `error: "load"`
 * flag. The same outcome is expressed here as a normalized failure carrying the
 * store's own message, so a caller can say what went wrong rather than only
 * that something did (LOGIC §5).
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
        error instanceof Error ? error.message : "The catalog store failed.",
        operation,
      ),
    ]);
  }
}

/**
 * Builds the read capability over a connected store.
 *
 * Every method sorts before it filters or projects, so ordering is applied once
 * and every answer this child gives is in the same order.
 */
function catalogReadOverStore(store: MenuCatalogPort): CatalogRead {
  async function menus(): Promise<OperationResult<readonly MenuItem[]>> {
    return fromStore("listMenus", async () => sorted(await store.listMenus()));
  }

  async function variantGroups(): Promise<OperationResult<readonly MenuVariantGroup[]>> {
    return fromStore("listVariantGroups", async () => sorted(await store.listVariantGroups()));
  }

  return {
    listMenus: menus,

    listCategories: async (): Promise<OperationResult<readonly MenuCategory[]>> =>
      fromStore("listCategories", async () => sorted(await store.listCategories())),

    listVariantGroups: variantGroups,

    async queryMenus(
      filters: MenuListFilters = DEFAULT_MENU_LIST_FILTERS,
    ): Promise<OperationResult<MenuCollection>> {
      const loaded = await menus();
      if (loaded.status === "failure") {
        return loaded;
      }
      return operationSuccess(projectMenuCollection(loaded.value, filters));
    },

    async queryVariantOptions(
      filters: VariantOptionListFilters = DEFAULT_VARIANT_OPTION_LIST_FILTERS,
    ): Promise<OperationResult<VariantOptionCollection>> {
      const loaded = await variantGroups();
      if (loaded.status === "failure") {
        return loaded;
      }
      return operationSuccess(projectVariantOptionCollection(loaded.value, filters));
    },
  };
}

/**
 * The capability published when no store is connected.
 *
 * The child still loads and still publishes — it declared no requirements, so
 * the dependency graph has no reason to exclude it, and a consumer resolving it
 * gets an honest "no store" answer rather than an unexplained absence. Marking
 * it unavailable would be wrong: `unavailable` means a required capability was
 * never published, and this capability was.
 */
function catalogReadWithoutStore(): CatalogRead {
  return {
    listMenus: async () => noStore("listMenus"),
    listCategories: async () => noStore("listCategories"),
    listVariantGroups: async () => noStore("listVariantGroups"),
    queryMenus: async () => noStore("queryMenus"),
    queryVariantOptions: async () => noStore("queryVariantOptions"),
  };
}

export function createCatalogRead(context: LogicChildContext): CatalogRead {
  const store = context.ports.resolve(MENU_CATALOG_PORT);

  if (store === undefined) {
    // Reported once, at creation, rather than on every call: a diagnostic per
    // read would bury the one fact worth knowing under its own repetition.
    context.diagnostics.report({
      code: "missing-dependency",
      severity: severityForCode("missing-dependency"),
      message:
        "No catalog store was supplied to the Menu area, so menu reads return a " +
        "normalized failure. The capability is published and callers stay working.",
      childId: context.childId,
      engineId: context.parentId,
      source: "catalogReadChild",
    });
  }

  const capability = store === undefined ? catalogReadWithoutStore() : catalogReadOverStore(store);

  context.capabilities.provide(MENU_CATALOG_READ, capability);

  return capability;
}

export default defineLogicChild<CatalogRead>({
  id: MENU_CATALOG_READ_ID,
  parentId: MENU_ENGINE_ID,
  provides: [MENU_CATALOG_READ_ID],
  requires: [],
  create: createCatalogRead,
});
