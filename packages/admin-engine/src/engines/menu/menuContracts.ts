// packages/admin-engine/src/engines/menu/menuContracts.ts
//
// Stable contracts owned by the Menu area (LOGIC §6: a `<area>Contracts.ts`
// exports capability, port, input, and output types — never behavior).
//
// Three things live here, and nothing else:
//   1. The capability tokens the area's children publish, so a consumer in
//      another area can resolve them without importing a child (LOGIC §9).
//   2. The one outbound port the area needs to reach storage. Children may not
//      import a concrete adapter (LOGIC §11), so persistence arrives injected.
//   3. The area's own input/output shapes — the ones that are NOT domain
//      vocabulary. `MenuItem`, `MenuCategory`, and `MenuVariantGroup` are
//      domain types and are imported, not redefined; a list filter is an admin
//      concern the domain has no business knowing about.
//
// No UI vocabulary anywhere (LOGIC §5/§13): no label, column, route, or icon.
// A filter is a query input, not a screen control.

import type {
  MenuAvailability,
  MenuCategory,
  MenuItem,
  MenuVariantGroup,
  SalesInterval,
  Weekday,
} from "@warungmeng/domain";
import type { OperationResult } from "@warungmeng/module-system";
import { createCapabilityToken, createOutboundPortToken } from "@warungmeng/module-system";

// ─── Persistence port ────────────────────────────────────────────────────────

/** `Omit<T, "id">` — the store assigns the id. Ported from SOURCE `CreateEntity`. */
export type CatalogCreateInput<TEntity extends { readonly id: string }> = Omit<TEntity, "id">;

/** A partial update. `id` is not patchable; it identifies the row. */
export type CatalogPatch<TEntity extends { readonly id: string }> = Partial<
  Omit<TEntity, "id">
>;

/** What a generated id is for, so an adapter can prefix or route by kind. */
export type CatalogIdKind =
  | "menu"
  | "category"
  | "variant-group"
  | "variant-option"
  | "sales-interval";

/**
 * The Menu area's window onto storage.
 *
 * Ported from SOURCE `packages/data/src/repositories/MenuCatalogRepository.ts`,
 * with its result conventions kept exactly, because callers depend on them:
 * `null` from a get or update means not-found, the boolean from a delete means
 * did-delete, and create returns the stored entity carrying its new id.
 *
 * Two deliberate departures from SOURCE:
 *
 *   - `listMenus` takes no query. SOURCE's `MenuListQuery` was dead — every
 *     caller passed nothing and filtered client-side — and its implementation
 *     duplicated the search rule that also lives in the list model. Two owners
 *     for one rule is exactly the drift this port is meant to prevent.
 *   - `newId` is part of the port. SOURCE's repository already owned id
 *     minting via an injectable factory, and nested entities (a variant option,
 *     a sales interval) need ids before their parent row is written. Keeping it
 *     here means one injection point rather than two, and a test can make ids
 *     deterministic by supplying one fake.
 *
 * No ordering is promised. SOURCE happened to sort inside its in-memory
 * repository; the read child now sorts its own results, so catalog order does
 * not silently depend on which adapter is plugged in.
 */
export interface MenuCatalogPort {
  listMenus(): Promise<readonly MenuItem[]>;
  getMenuById(id: string): Promise<MenuItem | null>;
  createMenu(input: CatalogCreateInput<MenuItem>): Promise<MenuItem>;
  updateMenu(id: string, patch: CatalogPatch<MenuItem>): Promise<MenuItem | null>;
  deleteMenu(id: string): Promise<boolean>;

  listCategories(): Promise<readonly MenuCategory[]>;
  getCategoryById(id: string): Promise<MenuCategory | null>;
  createCategory(input: CatalogCreateInput<MenuCategory>): Promise<MenuCategory>;
  updateCategory(id: string, patch: CatalogPatch<MenuCategory>): Promise<MenuCategory | null>;
  deleteCategory(id: string): Promise<boolean>;

  listVariantGroups(): Promise<readonly MenuVariantGroup[]>;
  getVariantGroupById(id: string): Promise<MenuVariantGroup | null>;
  createVariantGroup(input: CatalogCreateInput<MenuVariantGroup>): Promise<MenuVariantGroup>;
  updateVariantGroup(
    id: string,
    patch: CatalogPatch<MenuVariantGroup>,
  ): Promise<MenuVariantGroup | null>;
  deleteVariantGroup(id: string): Promise<boolean>;

  newId(kind: CatalogIdKind): string;
}

/**
 * Supplied by the composition root. Unresolved is a legal state: the area's
 * children still load and still publish their capabilities, and every call
 * returns a normalized failure instead of throwing. An Admin with no store
 * configured is a degraded Admin that can explain itself, not a crash.
 */
export const MENU_CATALOG_PORT = createOutboundPortToken<MenuCatalogPort>(
  "admin.menu.catalog-store",
);

// ─── Read contracts (child: catalog-read) ────────────────────────────────────

export type MenuAvailabilityFilter = "all" | MenuAvailability["status"];

/** Query input for the menu collection. `null` category means every category. */
export interface MenuListFilters {
  readonly search: string;
  readonly categoryId: string | null;
  readonly availability: MenuAvailabilityFilter;
}

export const DEFAULT_MENU_LIST_FILTERS: MenuListFilters = {
  search: "",
  categoryId: null,
  availability: "all",
};

/**
 * SOURCE's variant filter has no "available" member, unlike the menu filter.
 * Kept asymmetric on purpose: the variant list only ever offered "all" and
 * "unavailable", and widening it here would add an option no behavior supports.
 */
export type VariantOptionAvailabilityFilter = "all" | "unavailable";

export interface VariantOptionListFilters {
  readonly search: string;
  readonly groupId: string | null;
  readonly availability: VariantOptionAvailabilityFilter;
}

export const DEFAULT_VARIANT_OPTION_LIST_FILTERS: VariantOptionListFilters = {
  search: "",
  groupId: null,
  availability: "all",
};

/**
 * A variant option flattened out of its group, carrying the group it came from
 * so a caller never has to look the parent back up. The composite `id`
 * (`groupId:optionId`) is SOURCE's, and it matters: option ids are only unique
 * within a group, so the flattened row needs its own key.
 */
export interface VariantOptionListItem {
  readonly id: string;
  readonly groupId: string;
  readonly groupName: string;
  readonly option: MenuVariantGroup["options"][number];
}

/**
 * A filtered collection plus the counts that sit beside it.
 *
 * The counts are computed with one dimension of the filter deliberately
 * relaxed — category counts ignore the selected category, availability counts
 * ignore the selected availability — so selecting one value does not zero out
 * every other value's count. That behavior is SOURCE's and it is load-bearing:
 * counts that collapsed on selection would make the other choices look empty.
 *
 * `countsByCategory` omits categories with no matches; a reader treats an
 * absent key as zero, as SOURCE's callers did.
 */
export interface MenuCollection {
  readonly menus: readonly MenuItem[];
  readonly countsByCategory: ReadonlyMap<string, number>;
  readonly totalCount: number;
  readonly unavailableCount: number;
}

export interface VariantOptionCollection {
  readonly options: readonly VariantOptionListItem[];
  readonly countsByGroup: ReadonlyMap<string, number>;
  readonly totalCount: number;
  readonly unavailableCount: number;
}

/**
 * The Menu area's read surface — the capability several other areas require
 * (LOGIC §8: inventory HPP and POS checkout both list on it).
 *
 * The three list methods are the shape SOURCE had already extracted as
 * `CatalogReadCapability`, and they are what cross-area consumers use. The two
 * collection queries are the admin list behavior, which SOURCE kept in a React
 * hook and a model file; they belong here because they are query behavior, and
 * query behavior belongs to a child (LOGIC §3).
 *
 * Everything returns a normalized result rather than throwing (LOGIC §5), so a
 * store that is missing or failing degrades a caller instead of breaking it.
 */
export interface CatalogRead {
  listMenus(): Promise<OperationResult<readonly MenuItem[]>>;
  listCategories(): Promise<OperationResult<readonly MenuCategory[]>>;
  listVariantGroups(): Promise<OperationResult<readonly MenuVariantGroup[]>>;
  queryMenus(filters?: MenuListFilters): Promise<OperationResult<MenuCollection>>;
  queryVariantOptions(
    filters?: VariantOptionListFilters,
  ): Promise<OperationResult<VariantOptionCollection>>;
}

/** Capability id as a plain string, for `provides`/`requires` lists. */
export const MENU_CATALOG_READ_ID = "admin.menu.catalog-read";

export const MENU_CATALOG_READ = createCapabilityToken<CatalogRead>(MENU_CATALOG_READ_ID);

// ─── Editor contracts (child: menu-editor) ───────────────────────────────────

/**
 * Field length limits, lifted out of the SOURCE form components.
 *
 * In SOURCE these existed only as `maxLength` on an input, so they were real
 * rules enforced in a place that has no authority over rules — anything not
 * going through that one form skipped them entirely, and the UI rebuild in a
 * later phase would have had to rediscover them. LOGIC §13 puts validation
 * below the screen, so they live here and the editor enforces them.
 */
export const MENU_NAME_MAX_LENGTH = 120;
export const MENU_DESCRIPTION_MAX_LENGTH = 500;
export const CATEGORY_NAME_MAX_LENGTH = 80;

/** The weekdays a scheduled menu defaults to — every day. */
export const MENU_EDITOR_WEEKDAYS: readonly Weekday[] = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
];

/** SOURCE's cap, matching the domain's own `MAX_SALES_INTERVALS`. */
export const MENU_EDITOR_MAX_INTERVALS = 3;

export type MenuEditorInventoryMode = "untracked" | "tracked";
export type MenuEditorSalesMode = "always" | "scheduled";

/**
 * The flattened shape a menu is edited in.
 *
 * Deliberately NOT `MenuItem`. A `MenuItem` models availability, inventory and
 * schedule as discriminated unions, which is right for storage and awkward to
 * edit one field at a time; SOURCE flattened them for its form and converted
 * back on save. That conversion is behavior, so it comes along — but the shape
 * carries no UI vocabulary: these are values, not fields, and nothing here says
 * how any of them is presented.
 */
export interface MenuEditorValues {
  readonly name: string;
  readonly categoryId: string;
  readonly description: string;
  readonly imageUrl: string;
  readonly priceAmount: number;
  readonly available: boolean;
  readonly visible: boolean;
  readonly inventoryMode: MenuEditorInventoryMode;
  readonly stockQuantity: number;
  readonly salesMode: MenuEditorSalesMode;
  readonly activeDays: readonly Weekday[];
  readonly allDay: boolean;
  readonly intervals: readonly SalesInterval[];
  readonly variantGroupIds: readonly string[];
}

/**
 * Everything needed to start editing: the values themselves, the categories to
 * choose from, and the variant groups that may be attached.
 *
 * `baseline` is null for a new menu. It is carried so a caller can tell create
 * from edit without inspecting an id, and so the values can be compared against
 * what was stored.
 */
export interface MenuDraft {
  readonly baseline: MenuItem | null;
  readonly values: MenuEditorValues;
  readonly categories: readonly MenuCategory[];
  /**
   * Only groups with `visibility: "visible"` (SOURCE
   * `getSelectableVariantGroups`). A hidden group already attached to this menu
   * stays attached — it is absent from the choices, not stripped from `values`.
   */
  readonly selectableVariantGroups: readonly MenuVariantGroup[];
}

export interface SaveMenuInput {
  /** Null creates; an id updates. */
  readonly menuId: string | null;
  readonly values: MenuEditorValues;
}

export interface CategoryEditorValues {
  readonly name: string;
  readonly visible: boolean;
}

export interface SaveCategoryInput {
  readonly categoryId: string | null;
  readonly values: CategoryEditorValues;
}

/**
 * Writing menus and categories — create, edit, delete, and the list's
 * availability and visibility toggles.
 *
 * One child rather than several, per LOGIC §12 rule 6: create and edit share an
 * invariant and a lifecycle, and the toggles are edits to the same entity
 * reached from a different screen. Splitting them would have put the same
 * validation in two places.
 *
 * Every command returns a normalized result and none of them throws (LOGIC §5).
 */
export interface MenuEditor {
  startMenuDraft(): Promise<OperationResult<MenuDraft>>;
  loadMenuDraft(menuId: string): Promise<OperationResult<MenuDraft>>;
  saveMenu(input: SaveMenuInput): Promise<OperationResult<MenuItem>>;
  deleteMenu(menuId: string): Promise<OperationResult<string>>;
  setMenuAvailability(menuId: string, available: boolean): Promise<OperationResult<MenuItem>>;
  setMenuVisibility(menuId: string, visible: boolean): Promise<OperationResult<MenuItem>>;
  saveCategory(input: SaveCategoryInput): Promise<OperationResult<MenuCategory>>;
  /**
   * Refuses while any menu still points at the category, reporting how many do
   * (SOURCE `deleteMenuCategoryIfUnused` — the one guarded write in the area).
   */
  deleteCategory(categoryId: string): Promise<OperationResult<string>>;
}

export const MENU_EDITOR_ID = "admin.menu.menu-editor";

export const MENU_EDITOR = createCapabilityToken<MenuEditor>(MENU_EDITOR_ID);
