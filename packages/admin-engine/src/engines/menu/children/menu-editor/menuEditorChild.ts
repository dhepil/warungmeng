// packages/admin-engine/src/engines/menu/children/menu-editor/menuEditorChild.ts
//
// Writing menus and categories (capability `admin.menu.menu-editor`).
//
// Ported from SOURCE:
//   - application/menuEditorModel.ts (draft values, the entity↔editor mapping,
//     slugify, and the validation delegate)
//   - application/menuCategoryCommands.ts (the guarded category delete)
//   - the write half of application/useMenuList.ts (availability and visibility
//     toggles)
//   - the save/delete orchestration inlined in screens/MenuEditorScreen.tsx and
//     screens/MenuListScreen.tsx, including the next-sort-order rule
//   - the field limits that existed only as `maxLength` on form inputs
//
// Create and edit share this one child on purpose (LOGIC §12 rule 6): they have
// the same invariant and the same lifecycle, and splitting them would put the
// same validation in two places. The list's toggles belong here for the same
// reason — they write a menu item, so they answer to the menu item's rules.
//
// This child requires no capability. It reads what it needs through the same
// injected store the read child uses, rather than depending on catalog-read,
// which is what LOGIC §8 shows: no menu child requires anything.

import type {
  CatalogValidationIssue,
  MenuCategory,
  MenuItem,
  MenuVariantGroup,
} from "@warungmeng/domain";
import { validateMenuItem } from "@warungmeng/domain";
import type { LogicChildContext, OperationIssue, OperationResult } from "@warungmeng/module-system";
import {
  defineLogicChild,
  operationFailure,
  operationIssue,
  operationSuccess,
  severityForCode,
} from "@warungmeng/module-system";
import { MENU_ENGINE_ID } from "../../menuEngine";
import type {
  CategoryEditorValues,
  MenuCatalogPort,
  MenuDraft,
  MenuEditor,
  MenuEditorValues,
  SaveCategoryInput,
  SaveMenuInput,
} from "../../menuContracts";
import {
  CATEGORY_NAME_MAX_LENGTH,
  MENU_CATALOG_PORT,
  MENU_DESCRIPTION_MAX_LENGTH,
  MENU_EDITOR,
  MENU_EDITOR_ID,
  MENU_EDITOR_WEEKDAYS,
  MENU_NAME_MAX_LENGTH,
} from "../../menuContracts";

// ─── Pure mapping ────────────────────────────────────────────────────────────

/**
 * SOURCE `slugifyMenuName`, unchanged: strip accents, lowercase, collapse
 * anything non-alphanumeric to a dash, and trim dashes off both ends.
 */
export function slugifyMenuName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The values a brand-new menu starts from. */
export function defaultMenuEditorValues(intervalId: string): MenuEditorValues {
  return {
    name: "",
    categoryId: "",
    description: "",
    imageUrl: "",
    priceAmount: 0,
    available: true,
    visible: true,
    inventoryMode: "untracked",
    stockQuantity: 0,
    salesMode: "always",
    activeDays: [...MENU_EDITOR_WEEKDAYS],
    allDay: true,
    intervals: [{ id: intervalId, start: "09:00", end: "21:00" }],
    variantGroupIds: [],
  };
}

/**
 * A stored menu flattened back into editable values.
 *
 * `intervalId` is supplied rather than hardcoded. SOURCE fell back to the
 * literal `"sales-interval-default"` here while its create path used a freshly
 * minted id, so two menus edited in one session could both carry that same
 * interval id. The uniqueness rule is per-menu, so nothing failed — it was just
 * quietly wrong. Taking the id from the store's own generator removes the
 * source of the collision without changing what the values mean.
 */
export function menuToEditorValues(menu: MenuItem, intervalId: string): MenuEditorValues {
  const scheduled = menu.salesSchedule.mode === "scheduled" ? menu.salesSchedule : null;

  return {
    name: menu.name,
    categoryId: menu.categoryId,
    description: menu.description,
    imageUrl: menu.image?.url ?? "",
    priceAmount: menu.price.amount,
    available: menu.availability.status === "available",
    visible: menu.visibility === "visible",
    inventoryMode: menu.inventory.mode,
    stockQuantity: menu.inventory.mode === "tracked" ? menu.inventory.quantity : 0,
    salesMode: menu.salesSchedule.mode,
    activeDays: scheduled?.activeDays ?? [...MENU_EDITOR_WEEKDAYS],
    allDay: scheduled?.allDay ?? true,
    intervals: scheduled?.intervals.length
      ? scheduled.intervals.map((interval) => ({ ...interval }))
      : [{ id: intervalId, start: "09:00", end: "21:00" }],
    variantGroupIds: [...menu.variantGroupIds],
  };
}

/**
 * Editor values converted back into a storable menu.
 *
 * Three details are load-bearing and come straight from SOURCE:
 *   - the slug is taken from the baseline when there is one, so renaming a menu
 *     never changes its slug;
 *   - `compareAtPrice` is preserved from the baseline, because the editor has
 *     no field for it and rebuilding without it would silently clear it;
 *   - `variantGroupIds` is de-duplicated on the way out.
 */
export function editorValuesToMenu(
  values: MenuEditorValues,
  baseline: MenuItem | null,
  sortOrder: number,
): Omit<MenuItem, "id"> {
  const name = values.name.trim();
  const imageUrl = values.imageUrl.trim();

  return {
    name,
    slug: baseline?.slug ?? slugifyMenuName(name),
    categoryId: values.categoryId,
    description: values.description.trim(),
    image: imageUrl ? { url: imageUrl, alt: name } : null,
    price: { amount: values.priceAmount, currency: "IDR" },
    compareAtPrice: baseline?.compareAtPrice ?? null,
    availability: values.available
      ? { status: "available" }
      : { status: "unavailable", unavailableUntil: null },
    inventory:
      values.inventoryMode === "tracked"
        ? { mode: "tracked", quantity: values.stockQuantity }
        : { mode: "untracked" },
    visibility: values.visible ? "visible" : "hidden",
    salesSchedule:
      values.salesMode === "always"
        ? { mode: "always" }
        : {
            mode: "scheduled",
            activeDays: values.activeDays,
            allDay: values.allDay,
            intervals: values.allDay ? [] : values.intervals,
          },
    variantGroupIds: [...new Set(values.variantGroupIds)],
    sortOrder,
  };
}

/** Only visible groups may be attached (SOURCE `getSelectableVariantGroups`). */
export function selectableVariantGroups(
  groups: readonly MenuVariantGroup[],
): readonly MenuVariantGroup[] {
  return groups.filter((group) => group.visibility === "visible");
}

/** SOURCE's next-sort-order rule, computed identically for menus and categories. */
export function nextSortOrder(entities: readonly { readonly sortOrder: number }[]): number {
  return entities.reduce((highest, entity) => Math.max(highest, entity.sortOrder), -1) + 1;
}

// ─── Validation ──────────────────────────────────────────────────────────────

const TOO_LONG = "too_long";

function asIssue(issue: CatalogValidationIssue): OperationIssue {
  return operationIssue(issue.code, `${issue.path} is ${issue.code}`, issue.path);
}

function tooLong(path: string, limit: number): OperationIssue {
  return operationIssue(TOO_LONG, `${path} must be at most ${limit} characters`, path, {
    limit,
  });
}

/**
 * Everything that must hold before a menu is written.
 *
 * The domain validator owns the entity's own invariants — required fields,
 * money, the schedule rules — and is not re-implemented here. What this adds is
 * only the length limits, which had no owner below the form.
 *
 * Issues accumulate rather than failing fast, matching the domain validator, so
 * a caller can show everything that is wrong at once instead of one thing at a
 * time.
 */
export function validateMenuDraft(
  values: MenuEditorValues,
  baseline: MenuItem | null,
  sortOrder: number,
): readonly OperationIssue[] {
  const candidate = editorValuesToMenu(values, baseline, sortOrder);
  const issues = validateMenuItem({
    id: baseline?.id ?? "menu-editor-draft",
    ...candidate,
  }).map(asIssue);

  const lengthIssues: OperationIssue[] = [];
  if (candidate.name.length > MENU_NAME_MAX_LENGTH) {
    lengthIssues.push(tooLong("name", MENU_NAME_MAX_LENGTH));
  }
  if (candidate.description.length > MENU_DESCRIPTION_MAX_LENGTH) {
    lengthIssues.push(tooLong("description", MENU_DESCRIPTION_MAX_LENGTH));
  }

  return [...issues, ...lengthIssues];
}

export function validateCategoryDraft(values: CategoryEditorValues): readonly OperationIssue[] {
  const name = values.name.trim();
  const issues: OperationIssue[] = [];

  if (name.length === 0) {
    issues.push(operationIssue("required", "name is required", "name"));
  }
  if (name.length > CATEGORY_NAME_MAX_LENGTH) {
    issues.push(tooLong("name", CATEGORY_NAME_MAX_LENGTH));
  }

  return issues;
}

// ─── Store access ────────────────────────────────────────────────────────────

const NO_STORE = "no-catalog-store";
const STORE_FAILED = "catalog-store-failed";
const NOT_FOUND = "not-found";
const CATEGORY_IN_USE = "category-in-use";

function noStore<TValue>(operation: string): OperationResult<TValue> {
  return operationFailure("unsatisfied-dependency", [
    operationIssue(
      NO_STORE,
      "No catalog store is connected, so the menu catalog cannot be written.",
      operation,
    ),
  ]);
}

function storeFailed<TValue>(operation: string, error: unknown): OperationResult<TValue> {
  return operationFailure("failed", [
    operationIssue(
      STORE_FAILED,
      error instanceof Error ? error.message : "The catalog store failed.",
      operation,
    ),
  ]);
}

function notFound<TValue>(operation: string, id: string): OperationResult<TValue> {
  return operationFailure("not-found", [
    operationIssue(NOT_FOUND, `${id} was not found.`, operation),
  ]);
}

function menuEditorOverStore(store: MenuCatalogPort): MenuEditor {
  /**
   * Loads the three collections every draft needs. Categories and groups are
   * returned unsorted here; ordering for display is the read child's promise,
   * and duplicating it would give two owners for one rule.
   */
  async function draftContext(): Promise<{
    readonly menus: readonly MenuItem[];
    readonly categories: readonly MenuCategory[];
    readonly groups: readonly MenuVariantGroup[];
  }> {
    const [menus, categories, groups] = await Promise.all([
      store.listMenus(),
      store.listCategories(),
      store.listVariantGroups(),
    ]);
    return { menus, categories, groups };
  }

  return {
    async startMenuDraft(): Promise<OperationResult<MenuDraft>> {
      try {
        const { categories, groups } = await draftContext();
        return operationSuccess({
          baseline: null,
          values: defaultMenuEditorValues(store.newId("sales-interval")),
          categories,
          selectableVariantGroups: selectableVariantGroups(groups),
        });
      } catch (error) {
        return storeFailed("startMenuDraft", error);
      }
    },

    async loadMenuDraft(menuId: string): Promise<OperationResult<MenuDraft>> {
      try {
        const [menu, context] = await Promise.all([store.getMenuById(menuId), draftContext()]);
        if (menu === null) {
          return notFound("loadMenuDraft", menuId);
        }

        return operationSuccess({
          baseline: menu,
          values: menuToEditorValues(menu, store.newId("sales-interval")),
          categories: context.categories,
          selectableVariantGroups: selectableVariantGroups(context.groups),
        });
      } catch (error) {
        return storeFailed("loadMenuDraft", error);
      }
    },

    /**
     * Validates, then writes.
     *
     * The baseline is re-read here rather than accepted from the caller. SOURCE
     * held it in screen state from the moment the editor mounted, which is how
     * a stale slug or a dropped `compareAtPrice` would get written after
     * something else changed the menu. Reading it at save time costs one call
     * and removes the whole class of problem.
     */
    async saveMenu({ menuId, values }: SaveMenuInput): Promise<OperationResult<MenuItem>> {
      try {
        const baseline = menuId === null ? null : await store.getMenuById(menuId);
        if (menuId !== null && baseline === null) {
          return notFound("saveMenu", menuId);
        }

        const sortOrder = baseline?.sortOrder ?? nextSortOrder(await store.listMenus());
        const issues = validateMenuDraft(values, baseline, sortOrder);
        if (issues.length > 0) {
          return operationFailure("invalid-input", issues);
        }

        const input = editorValuesToMenu(values, baseline, sortOrder);
        if (menuId === null) {
          return operationSuccess(await store.createMenu(input));
        }

        const updated = await store.updateMenu(menuId, input);
        return updated === null ? notFound("saveMenu", menuId) : operationSuccess(updated);
      } catch (error) {
        return storeFailed("saveMenu", error);
      }
    },

    /**
     * Deletes without a guard, as SOURCE did.
     *
     * A menu can be deleted while variant groups still reference it and while
     * its own `variantGroupIds` still point at groups; SOURCE cleaned up
     * neither direction, and POS is the only place a dangling link is noticed,
     * at read time. Adding referential cleanup here would be a new rule rather
     * than a ported one, so it stays out and stays written down.
     */
    async deleteMenu(menuId: string): Promise<OperationResult<string>> {
      try {
        const deleted = await store.deleteMenu(menuId);
        return deleted ? operationSuccess(menuId) : notFound("deleteMenu", menuId);
      } catch (error) {
        return storeFailed("deleteMenu", error);
      }
    },

    async setMenuAvailability(
      menuId: string,
      available: boolean,
    ): Promise<OperationResult<MenuItem>> {
      try {
        const updated = await store.updateMenu(menuId, {
          availability: available
            ? { status: "available" }
            : { status: "unavailable", unavailableUntil: null },
        });
        return updated === null
          ? notFound("setMenuAvailability", menuId)
          : operationSuccess(updated);
      } catch (error) {
        return storeFailed("setMenuAvailability", error);
      }
    },

    async setMenuVisibility(menuId: string, visible: boolean): Promise<OperationResult<MenuItem>> {
      try {
        const updated = await store.updateMenu(menuId, {
          visibility: visible ? "visible" : "hidden",
        });
        return updated === null ? notFound("setMenuVisibility", menuId) : operationSuccess(updated);
      } catch (error) {
        return storeFailed("setMenuVisibility", error);
      }
    },

    /**
     * Note the asymmetry with menus: a category's slug is recomputed from its
     * name on every save, while a menu's is frozen after creation. That is
     * SOURCE's behavior in both cases and it is kept rather than harmonized —
     * a menu slug is the one that could be linked to.
     */
    async saveCategory({
      categoryId,
      values,
    }: SaveCategoryInput): Promise<OperationResult<MenuCategory>> {
      try {
        const issues = validateCategoryDraft(values);
        if (issues.length > 0) {
          return operationFailure("invalid-input", issues);
        }

        const existing = categoryId === null ? null : await store.getCategoryById(categoryId);
        if (categoryId !== null && existing === null) {
          return notFound("saveCategory", categoryId);
        }

        const name = values.name.trim();
        const input = {
          name,
          slug: slugifyMenuName(name),
          visibility: values.visible ? ("visible" as const) : ("hidden" as const),
          sortOrder: existing?.sortOrder ?? nextSortOrder(await store.listCategories()),
        };

        if (categoryId === null) {
          return operationSuccess(await store.createCategory(input));
        }

        const updated = await store.updateCategory(categoryId, input);
        return updated === null ? notFound("saveCategory", categoryId) : operationSuccess(updated);
      } catch (error) {
        return storeFailed("saveCategory", error);
      }
    },

    /**
     * The area's one guarded write (SOURCE `deleteMenuCategoryIfUnused`).
     *
     * "In use" is a conflict, not a fault: the request was well-formed and the
     * store is healthy, the category simply still has menus in it. The count
     * rides along so a caller can say how many rather than only that there were
     * some.
     */
    async deleteCategory(categoryId: string): Promise<OperationResult<string>> {
      try {
        const menus = await store.listMenus();
        const inUse = menus.filter((menu) => menu.categoryId === categoryId).length;

        if (inUse > 0) {
          return operationFailure("conflict", [
            operationIssue(
              CATEGORY_IN_USE,
              `${inUse} menu(s) still use this category, so it was not deleted.`,
              "deleteCategory",
              { menuCount: inUse },
            ),
          ]);
        }

        const deleted = await store.deleteCategory(categoryId);
        return deleted ? operationSuccess(categoryId) : notFound("deleteCategory", categoryId);
      } catch (error) {
        return storeFailed("deleteCategory", error);
      }
    },
  };
}

function menuEditorWithoutStore(): MenuEditor {
  return {
    startMenuDraft: async () => noStore("startMenuDraft"),
    loadMenuDraft: async () => noStore("loadMenuDraft"),
    saveMenu: async () => noStore("saveMenu"),
    deleteMenu: async () => noStore("deleteMenu"),
    setMenuAvailability: async () => noStore("setMenuAvailability"),
    setMenuVisibility: async () => noStore("setMenuVisibility"),
    saveCategory: async () => noStore("saveCategory"),
    deleteCategory: async () => noStore("deleteCategory"),
  };
}

export function createMenuEditor(context: LogicChildContext): MenuEditor {
  const store = context.ports.resolve(MENU_CATALOG_PORT);

  if (store === undefined) {
    context.diagnostics.report({
      code: "missing-dependency",
      severity: severityForCode("missing-dependency"),
      message:
        "No catalog store was supplied to the Menu area, so menu and category edits " +
        "return a normalized failure. The capability is published and callers stay working.",
      childId: context.childId,
      engineId: context.parentId,
      source: "menuEditorChild",
    });
  }

  const capability = store === undefined ? menuEditorWithoutStore() : menuEditorOverStore(store);

  context.capabilities.provide(MENU_EDITOR, capability);

  return capability;
}

export default defineLogicChild<MenuEditor>({
  id: MENU_EDITOR_ID,
  parentId: MENU_ENGINE_ID,
  provides: [MENU_EDITOR_ID],
  requires: [],
  create: createMenuEditor,
});
