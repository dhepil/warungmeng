// packages/admin-engine/src/engines/menu/children/menu-editor/menuEditor.test.ts
//
// Protected behavior for writing menus and categories.
//
// Same split as the read child: the pure mapping and validation are called
// directly, and the commands run against a real Admin runtime with a mutable
// in-memory store behind the injected port — so a write is checked by reading
// back what actually landed, not by asserting a call was made.
//
// No React, no DOM, no renderer (LOGIC §6).

import { describe, expect, it } from "vitest";
import type { MenuCategory, MenuItem, MenuVariantGroup, Money } from "@warungmeng/domain";
import { defineLogicChild } from "@warungmeng/module-system";
import { createAdminEngine } from "../../../../createAdminEngine";
import type {
  CatalogCreateInput,
  MenuCatalogPort,
  MenuEditor,
  MenuEditorValues,
} from "../../menuContracts";
import {
  CATEGORY_NAME_MAX_LENGTH,
  MENU_CATALOG_PORT,
  MENU_DESCRIPTION_MAX_LENGTH,
  MENU_EDITOR,
  MENU_EDITOR_ID,
  MENU_NAME_MAX_LENGTH,
} from "../../menuContracts";
import menuEngine from "../../menuEngine";
import menuEditorChild, {
  defaultMenuEditorValues,
  editorValuesToMenu,
  menuToEditorValues,
  nextSortOrder,
  selectableVariantGroups,
  slugifyMenuName,
  validateCategoryDraft,
  validateMenuDraft,
} from "./menuEditorChild";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const IDR = (amount: number): Money => ({ amount, currency: "IDR" });

function menu(overrides: Partial<MenuItem> & Pick<MenuItem, "id" | "name">): MenuItem {
  return {
    slug: overrides.id,
    categoryId: "cat-food",
    description: "",
    image: null,
    price: IDR(10_000),
    compareAtPrice: null,
    availability: { status: "available" },
    inventory: { mode: "untracked" },
    visibility: "visible",
    salesSchedule: { mode: "always" },
    variantGroupIds: [],
    sortOrder: 0,
    ...overrides,
  };
}

function category(
  overrides: Partial<MenuCategory> & Pick<MenuCategory, "id" | "name">,
): MenuCategory {
  return { slug: overrides.id, visibility: "visible", sortOrder: 0, ...overrides };
}

function group(
  overrides: Partial<MenuVariantGroup> & Pick<MenuVariantGroup, "id" | "name">,
): MenuVariantGroup {
  return {
    description: "",
    visibility: "visible",
    selection: { minSelections: 0, maxSelections: null },
    options: [],
    sortOrder: 0,
    ...overrides,
  };
}

/** Valid editor values, so a test can change exactly the field it cares about. */
function values(overrides: Partial<MenuEditorValues> = {}): MenuEditorValues {
  return { ...defaultMenuEditorValues("iv-1"), name: "Nasi Goreng", categoryId: "cat-food", ...overrides };
}

/**
 * A mutable in-memory store with deterministic ids, so a write can be verified
 * by reading it back. Ids are sequential rather than random: a test that
 * asserts on a generated id should be able to predict it.
 */
function mutableStore(seed: {
  menus?: readonly MenuItem[];
  categories?: readonly MenuCategory[];
  variantGroups?: readonly MenuVariantGroup[];
}) {
  const menus = [...(seed.menus ?? [])];
  const categories = [...(seed.categories ?? [])];
  const variantGroups = [...(seed.variantGroups ?? [])];
  const counters = new Map<string, number>();

  function patch<T extends { readonly id: string }>(
    rows: T[],
    id: string,
    changes: Partial<Omit<T, "id">>,
  ): T | null {
    const index = rows.findIndex((row) => row.id === id);
    if (index === -1) return null;
    const updated = { ...rows[index], ...changes } as T;
    rows[index] = updated;
    return updated;
  }

  function remove<T extends { readonly id: string }>(rows: T[], id: string): boolean {
    const index = rows.findIndex((row) => row.id === id);
    if (index === -1) return false;
    rows.splice(index, 1);
    return true;
  }

  const port: MenuCatalogPort = {
    listMenus: async () => [...menus],
    getMenuById: async (id) => menus.find((row) => row.id === id) ?? null,
    createMenu: async (input: CatalogCreateInput<MenuItem>) => {
      const created = { ...input, id: port.newId("menu") } as MenuItem;
      menus.push(created);
      return created;
    },
    updateMenu: async (id, changes) => patch(menus, id, changes),
    deleteMenu: async (id) => remove(menus, id),
    listCategories: async () => [...categories],
    getCategoryById: async (id) => categories.find((row) => row.id === id) ?? null,
    createCategory: async (input: CatalogCreateInput<MenuCategory>) => {
      const created = { ...input, id: port.newId("category") } as MenuCategory;
      categories.push(created);
      return created;
    },
    updateCategory: async (id, changes) => patch(categories, id, changes),
    deleteCategory: async (id) => remove(categories, id),
    listVariantGroups: async () => [...variantGroups],
    getVariantGroupById: async (id) => variantGroups.find((row) => row.id === id) ?? null,
    createVariantGroup: async (input: CatalogCreateInput<MenuVariantGroup>) => {
      const created = { ...input, id: port.newId("variant-group") } as MenuVariantGroup;
      variantGroups.push(created);
      return created;
    },
    updateVariantGroup: async (id, changes) => patch(variantGroups, id, changes),
    deleteVariantGroup: async (id) => remove(variantGroups, id),
    newId: (kind) => {
      const next = (counters.get(kind) ?? 0) + 1;
      counters.set(kind, next);
      return `${kind}-${next}`;
    },
  };

  return { port, menus, categories, variantGroups };
}

/** Composes the area and captures the editor capability through a probe child. */
function runtimeWith(store?: MenuCatalogPort): {
  readonly editor: MenuEditor | undefined;
  readonly snapshot: ReturnType<ReturnType<typeof createAdminEngine>["getSnapshot"]>;
  readonly dispose: () => void;
} {
  let captured: MenuEditor | undefined;

  const probe = defineLogicChild({
    id: "admin.menu.test-probe",
    parentId: menuEngine.id,
    requires: [MENU_EDITOR_ID],
    create(context) {
      const resolution = context.capabilities.resolve(MENU_EDITOR);
      if (resolution.status === "available") captured = resolution.value;
      return undefined;
    },
  });

  const engine = createAdminEngine({
    definitions: { engines: [menuEngine], children: [menuEditorChild, probe] },
    ports: {
      resolve: (token) =>
        token.id === MENU_CATALOG_PORT.id && store !== undefined ? (store as never) : undefined,
    },
  });

  return { editor: captured, snapshot: engine.getSnapshot(), dispose: engine.dispose };
}

// ─── Slug ────────────────────────────────────────────────────────────────────

describe("slugify", () => {
  it("lowercases and dashes a plain name", () => {
    expect(slugifyMenuName("Nasi Goreng")).toBe("nasi-goreng");
  });

  it("strips accents rather than dropping the letter", () => {
    expect(slugifyMenuName("Café")).toBe("cafe");
  });

  it("collapses runs of punctuation into a single dash", () => {
    expect(slugifyMenuName("Ayam  --  Bakar!!")).toBe("ayam-bakar");
  });

  it("trims leading and trailing dashes", () => {
    expect(slugifyMenuName("  !Sate!  ")).toBe("sate");
  });
});

// ─── Mapping ─────────────────────────────────────────────────────────────────

describe("editor values mapping", () => {
  it("flattens a stored menu into editable values", () => {
    const stored = menu({
      id: "m1",
      name: "Es Teh",
      description: "sweet",
      image: { url: "http://x/y.png", alt: "Es Teh" },
      price: IDR(5_000),
      availability: { status: "unavailable", unavailableUntil: null },
      inventory: { mode: "tracked", quantity: 7 },
      visibility: "hidden",
      variantGroupIds: ["g1"],
    });

    const mapped = menuToEditorValues(stored, "iv-1");

    expect(mapped.name).toBe("Es Teh");
    expect(mapped.imageUrl).toBe("http://x/y.png");
    expect(mapped.priceAmount).toBe(5_000);
    expect(mapped.available).toBe(false);
    expect(mapped.visible).toBe(false);
    expect(mapped.inventoryMode).toBe("tracked");
    expect(mapped.stockQuantity).toBe(7);
    expect(mapped.variantGroupIds).toEqual(["g1"]);
  });

  it("reports zero stock for an untracked menu rather than leaking a quantity", () => {
    expect(menuToEditorValues(menu({ id: "m1", name: "A" }), "iv-1").stockQuantity).toBe(0);
  });

  it("uses the supplied interval id when a scheduled menu has no intervals", () => {
    // SOURCE hardcoded "sales-interval-default" here, so two menus edited in one
    // session could carry the same interval id.
    const scheduled = menu({
      id: "m1",
      name: "A",
      salesSchedule: { mode: "scheduled", activeDays: ["mon"], allDay: true, intervals: [] },
    });
    expect(menuToEditorValues(scheduled, "iv-generated").intervals[0]?.id).toBe("iv-generated");
  });

  it("copies intervals rather than aliasing the stored ones", () => {
    const scheduled = menu({
      id: "m1",
      name: "A",
      salesSchedule: {
        mode: "scheduled",
        activeDays: ["mon"],
        allDay: false,
        intervals: [{ id: "iv-1", start: "08:00", end: "10:00" }],
      },
    });
    const mapped = menuToEditorValues(scheduled, "iv-x");
    expect(mapped.intervals[0]).not.toBe(
      scheduled.salesSchedule.mode === "scheduled"
        ? scheduled.salesSchedule.intervals[0]
        : undefined,
    );
  });

  it("builds a storable menu from values", () => {
    const built = editorValuesToMenu(values({ name: "  Nasi Goreng  " }), null, 3);
    expect(built.name).toBe("Nasi Goreng");
    expect(built.slug).toBe("nasi-goreng");
    expect(built.sortOrder).toBe(3);
    expect(built.price).toEqual(IDR(0));
  });

  it("keeps the original slug when editing, so renaming never moves a menu", () => {
    const baseline = menu({ id: "m1", name: "Old Name", slug: "old-name" });
    expect(editorValuesToMenu(values({ name: "Brand New Name" }), baseline, 0).slug).toBe(
      "old-name",
    );
  });

  it("preserves compareAtPrice, which the editor has no field for", () => {
    const baseline = menu({ id: "m1", name: "A", price: IDR(10_000), compareAtPrice: IDR(15_000) });
    expect(editorValuesToMenu(values(), baseline, 0).compareAtPrice).toEqual(IDR(15_000));
  });

  it("de-duplicates attached variant groups", () => {
    const built = editorValuesToMenu(values({ variantGroupIds: ["g1", "g2", "g1"] }), null, 0);
    expect(built.variantGroupIds).toEqual(["g1", "g2"]);
  });

  it("drops an empty image url to null instead of storing a blank image", () => {
    expect(editorValuesToMenu(values({ imageUrl: "   " }), null, 0).image).toBeNull();
  });

  it("names the image alt after the menu", () => {
    expect(editorValuesToMenu(values({ name: "Sate", imageUrl: "u" }), null, 0).image).toEqual({
      url: "u",
      alt: "Sate",
    });
  });

  it("clears intervals when a scheduled menu is marked all-day", () => {
    const built = editorValuesToMenu(
      values({ salesMode: "scheduled", allDay: true, activeDays: ["mon"] }),
      null,
      0,
    );
    expect(built.salesSchedule).toEqual({
      mode: "scheduled",
      activeDays: ["mon"],
      allDay: true,
      intervals: [],
    });
  });

  it("offers only visible variant groups for attachment", () => {
    const groups = [
      group({ id: "g1", name: "Visible" }),
      group({ id: "g2", name: "Hidden", visibility: "hidden" }),
    ];
    expect(selectableVariantGroups(groups).map((entry) => entry.id)).toEqual(["g1"]);
  });

  it("starts sort order at zero for an empty catalog and one past the highest otherwise", () => {
    expect(nextSortOrder([])).toBe(0);
    expect(nextSortOrder([{ sortOrder: 0 }, { sortOrder: 4 }, { sortOrder: 2 }])).toBe(5);
  });
});

// ─── Validation ──────────────────────────────────────────────────────────────

describe("menu validation", () => {
  it("accepts valid values", () => {
    expect(validateMenuDraft(values(), null, 0)).toEqual([]);
  });

  it("rejects a blank name", () => {
    const issues = validateMenuDraft(values({ name: "   " }), null, 0);
    expect(issues.some((issue) => issue.subject === "name" && issue.code === "required")).toBe(true);
  });

  it("rejects a missing category", () => {
    const issues = validateMenuDraft(values({ categoryId: "" }), null, 0);
    expect(issues.some((issue) => issue.subject === "categoryId")).toBe(true);
  });

  it("rejects a negative price", () => {
    const issues = validateMenuDraft(values({ priceAmount: -1 }), null, 0);
    expect(issues.some((issue) => issue.subject === "price")).toBe(true);
  });

  it("enforces the name length limit that only lived on a form input", () => {
    const issues = validateMenuDraft(values({ name: "x".repeat(MENU_NAME_MAX_LENGTH + 1) }), null, 0);
    expect(issues.some((issue) => issue.code === "too_long" && issue.subject === "name")).toBe(true);
  });

  it("accepts a name exactly at the limit", () => {
    expect(validateMenuDraft(values({ name: "x".repeat(MENU_NAME_MAX_LENGTH) }), null, 0)).toEqual(
      [],
    );
  });

  it("enforces the description length limit", () => {
    const issues = validateMenuDraft(
      values({ description: "x".repeat(MENU_DESCRIPTION_MAX_LENGTH + 1) }),
      null,
      0,
    );
    expect(issues.some((issue) => issue.code === "too_long" && issue.subject === "description")).toBe(
      true,
    );
  });

  it("measures length after trimming, matching what gets stored", () => {
    expect(
      validateMenuDraft(values({ name: `  ${"x".repeat(MENU_NAME_MAX_LENGTH)}  ` }), null, 0),
    ).toEqual([]);
  });

  it("reports every problem at once rather than stopping at the first", () => {
    const issues = validateMenuDraft(values({ name: "", categoryId: "", priceAmount: -5 }), null, 0);
    expect(issues.length).toBeGreaterThanOrEqual(3);
  });

  it("delegates schedule rules to the domain", () => {
    const issues = validateMenuDraft(
      values({
        salesMode: "scheduled",
        allDay: false,
        activeDays: ["mon"],
        intervals: [{ id: "iv-1", start: "21:00", end: "09:00" }],
      }),
      null,
      0,
    );
    expect(issues.some((issue) => issue.subject?.startsWith("salesSchedule"))).toBe(true);
  });
});

describe("category validation", () => {
  it("accepts a valid name", () => {
    expect(validateCategoryDraft({ name: "Drinks", visible: true })).toEqual([]);
  });

  it("rejects a blank name", () => {
    expect(validateCategoryDraft({ name: "   ", visible: true })).toHaveLength(1);
  });

  it("enforces the category name limit", () => {
    const issues = validateCategoryDraft({
      name: "x".repeat(CATEGORY_NAME_MAX_LENGTH + 1),
      visible: true,
    });
    expect(issues.some((issue) => issue.code === "too_long")).toBe(true);
  });
});

// ─── The child, inside a real runtime ────────────────────────────────────────

describe("menu-editor as a logic child", () => {
  it("declares its capability and requires nothing", () => {
    expect(menuEditorChild.id).toBe("admin.menu.menu-editor");
    expect(menuEditorChild.parentId).toBe("admin.menu");
    expect(menuEditorChild.provides).toEqual([MENU_EDITOR_ID]);
    expect(menuEditorChild.requires).toEqual([]);
  });

  it("publishes its capability and reports no failure", () => {
    const { editor, snapshot, dispose } = runtimeWith(mutableStore({}).port);
    expect(editor).toBeDefined();
    expect(snapshot.areas.find((entry) => entry.area === "menu")?.failedChildIds).toEqual([]);
    expect(snapshot.runtime.capabilities).toContain(MENU_EDITOR_ID);
    dispose();
  });

  it("fails every command with no store, and says so", async () => {
    const { editor, snapshot, dispose } = runtimeWith(undefined);

    const saved = await editor?.saveMenu({ menuId: null, values: values() });
    expect(saved?.status).toBe("failure");
    expect(saved?.status === "failure" && saved.reason).toBe("unsatisfied-dependency");
    expect(
      snapshot.diagnostics.some(
        (entry) => entry.code === "missing-dependency" && entry.source === "menuEditorChild",
      ),
    ).toBe(true);

    dispose();
  });

  it("starts a draft with defaults and only the selectable groups", async () => {
    const store = mutableStore({
      categories: [category({ id: "c1", name: "Food" })],
      variantGroups: [
        group({ id: "g1", name: "Spice" }),
        group({ id: "g2", name: "Hidden", visibility: "hidden" }),
      ],
    });
    const { editor, dispose } = runtimeWith(store.port);

    const draft = await editor?.startMenuDraft();
    expect(draft?.status).toBe("success");
    if (draft?.status !== "success") return;
    expect(draft.value.baseline).toBeNull();
    expect(draft.value.values.name).toBe("");
    expect(draft.value.categories).toHaveLength(1);
    expect(draft.value.selectableVariantGroups.map((entry) => entry.id)).toEqual(["g1"]);

    dispose();
  });

  it("loads an existing menu into a draft carrying its baseline", async () => {
    const store = mutableStore({ menus: [menu({ id: "m1", name: "Es Teh", price: IDR(5_000) })] });
    const { editor, dispose } = runtimeWith(store.port);

    const draft = await editor?.loadMenuDraft("m1");
    expect(draft?.status).toBe("success");
    if (draft?.status !== "success") return;
    expect(draft.value.baseline?.id).toBe("m1");
    expect(draft.value.values.priceAmount).toBe(5_000);

    dispose();
  });

  it("reports not-found for a menu that does not exist", async () => {
    const { editor, dispose } = runtimeWith(mutableStore({}).port);
    const draft = await editor?.loadMenuDraft("missing");
    expect(draft?.status === "failure" && draft.reason).toBe("not-found");
    dispose();
  });

  it("creates a menu and appends it at the next sort order", async () => {
    const store = mutableStore({
      menus: [menu({ id: "m1", name: "First", sortOrder: 4 })],
      categories: [category({ id: "cat-food", name: "Food" })],
    });
    const { editor, dispose } = runtimeWith(store.port);

    const saved = await editor?.saveMenu({ menuId: null, values: values({ name: "Second" }) });

    expect(saved?.status).toBe("success");
    expect(store.menus).toHaveLength(2);
    expect(store.menus[1]?.name).toBe("Second");
    expect(store.menus[1]?.sortOrder).toBe(5);

    dispose();
  });

  it("updates an existing menu in place, keeping its sort order", async () => {
    const store = mutableStore({
      menus: [menu({ id: "m1", name: "Old", sortOrder: 2 })],
      categories: [category({ id: "cat-food", name: "Food" })],
    });
    const { editor, dispose } = runtimeWith(store.port);

    const saved = await editor?.saveMenu({ menuId: "m1", values: values({ name: "New" }) });

    expect(saved?.status).toBe("success");
    expect(store.menus).toHaveLength(1);
    expect(store.menus[0]?.name).toBe("New");
    expect(store.menus[0]?.sortOrder).toBe(2);

    dispose();
  });

  it("writes nothing when validation fails", async () => {
    const store = mutableStore({});
    const { editor, dispose } = runtimeWith(store.port);

    const saved = await editor?.saveMenu({ menuId: null, values: values({ name: "" }) });

    expect(saved?.status === "failure" && saved.reason).toBe("invalid-input");
    expect(store.menus).toHaveLength(0);

    dispose();
  });

  it("refuses to save a menu whose category id is orphaned", async () => {
    const store = mutableStore({
      menus: [menu({ id: "m1", name: "Old", categoryId: "cat-deleted" })],
      categories: [category({ id: "cat-food", name: "Food" })],
    });
    const { editor, dispose } = runtimeWith(store.port);

    const saved = await editor?.saveMenu({
      menuId: "m1",
      values: values({ name: "New", categoryId: "cat-deleted" }),
    });

    expect(saved?.status === "failure" && saved.reason).toBe("invalid-input");
    expect(saved?.status === "failure" && saved.issues).toContainEqual(
      expect.objectContaining({ code: "category-not-found", subject: "categoryId" }),
    );
    expect(store.menus[0]?.name).toBe("Old");

    dispose();
  });

  it("re-reads the baseline at save time rather than trusting a stale one", async () => {
    // SOURCE held the baseline in screen state from mount, so a slug changed
    // elsewhere could be overwritten on save.
    const store = mutableStore({
      menus: [menu({ id: "m1", name: "A", slug: "a" })],
      categories: [category({ id: "cat-food", name: "Food" })],
    });
    const { editor, dispose } = runtimeWith(store.port);

    await editor?.loadMenuDraft("m1");
    await store.port.updateMenu("m1", { slug: "changed-elsewhere" });
    await editor?.saveMenu({ menuId: "m1", values: values({ name: "Renamed" }) });

    expect(store.menus[0]?.slug).toBe("changed-elsewhere");

    dispose();
  });

  it("reports not-found when saving a menu that vanished", async () => {
    const { editor, dispose } = runtimeWith(mutableStore({}).port);
    const saved = await editor?.saveMenu({ menuId: "ghost", values: values() });
    expect(saved?.status === "failure" && saved.reason).toBe("not-found");
    dispose();
  });

  it("deletes a menu so its group connection disappears with the owning row", async () => {
    const store = mutableStore({
      menus: [
        menu({ id: "m1", name: "A", variantGroupIds: ["g1"] }),
        menu({ id: "m2", name: "B", variantGroupIds: ["g1"] }),
      ],
      variantGroups: [group({ id: "g1", name: "Spice" })],
    });
    const { editor, dispose } = runtimeWith(store.port);

    expect((await editor?.deleteMenu("m1"))?.status).toBe("success");
    expect(store.menus.map((entry) => entry.id)).toEqual(["m2"]);
    expect(
      store.menus.filter((entry) => entry.variantGroupIds.includes("g1")).map((entry) => entry.id),
    ).toEqual(["m2"]);
    expect(store.variantGroups.map((entry) => entry.id)).toEqual(["g1"]);
    const again = await editor?.deleteMenu("m1");
    expect(again?.status === "failure" && again.reason).toBe("not-found");

    dispose();
  });

  it("toggles availability and visibility without touching other fields", async () => {
    const store = mutableStore({ menus: [menu({ id: "m1", name: "A", price: IDR(9_000) })] });
    const { editor, dispose } = runtimeWith(store.port);

    await editor?.setMenuAvailability("m1", false);
    expect(store.menus[0]?.availability).toEqual({
      status: "unavailable",
      unavailableUntil: null,
    });

    await editor?.setMenuVisibility("m1", false);
    expect(store.menus[0]?.visibility).toBe("hidden");
    expect(store.menus[0]?.price).toEqual(IDR(9_000));
    expect(store.menus[0]?.name).toBe("A");

    dispose();
  });

  it("reports not-found when toggling a menu that does not exist", async () => {
    const { editor, dispose } = runtimeWith(mutableStore({}).port);
    const toggled = await editor?.setMenuAvailability("ghost", true);
    expect(toggled?.status === "failure" && toggled.reason).toBe("not-found");
    dispose();
  });

  it("creates a category with a slug derived from its name", async () => {
    const store = mutableStore({});
    const { editor, dispose } = runtimeWith(store.port);

    const saved = await editor?.saveCategory({
      categoryId: null,
      values: { name: "Hot Drinks", visible: true },
    });

    expect(saved?.status).toBe("success");
    expect(store.categories[0]?.slug).toBe("hot-drinks");
    expect(store.categories[0]?.sortOrder).toBe(0);

    dispose();
  });

  it("recomputes a category slug on rename, unlike a menu slug", async () => {
    const store = mutableStore({ categories: [category({ id: "c1", name: "Old", slug: "old" })] });
    const { editor, dispose } = runtimeWith(store.port);

    await editor?.saveCategory({ categoryId: "c1", values: { name: "New Name", visible: true } });

    expect(store.categories[0]?.slug).toBe("new-name");

    dispose();
  });

  it("refuses to delete a category that still has menus, and says how many", async () => {
    const store = mutableStore({
      categories: [category({ id: "c1", name: "Food" })],
      menus: [
        menu({ id: "m1", name: "A", categoryId: "c1" }),
        menu({ id: "m2", name: "B", categoryId: "c1" }),
        menu({ id: "m3", name: "C", categoryId: "c2" }),
      ],
    });
    const { editor, dispose } = runtimeWith(store.port);

    const deleted = await editor?.deleteCategory("c1");

    expect(deleted?.status).toBe("failure");
    expect(deleted?.status === "failure" && deleted.reason).toBe("conflict");
    expect(deleted?.status === "failure" && deleted.issues[0]?.details?.menuCount).toBe(2);
    expect(store.categories).toHaveLength(1);

    dispose();
  });

  it("deletes a category once nothing points at it", async () => {
    const store = mutableStore({
      categories: [category({ id: "c1", name: "Food" })],
      menus: [menu({ id: "m1", name: "A", categoryId: "c2" })],
    });
    const { editor, dispose } = runtimeWith(store.port);

    expect((await editor?.deleteCategory("c1"))?.status).toBe("success");
    expect(store.categories).toHaveLength(0);

    dispose();
  });

  it("turns a thrown store error into a normalized failure carrying its message", async () => {
    const store = mutableStore({
      categories: [category({ id: "cat-food", name: "Food" })],
    });
    const { editor, dispose } = runtimeWith({
      ...store.port,
      createMenu: async () => {
        throw new Error("disk full");
      },
    });

    const saved = await editor?.saveMenu({ menuId: null, values: values() });

    expect(saved?.status === "failure" && saved.reason).toBe("failed");
    expect(saved?.status === "failure" && saved.issues[0]?.message).toBe("disk full");

    dispose();
  });
});
