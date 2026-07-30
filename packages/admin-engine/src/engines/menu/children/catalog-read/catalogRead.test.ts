// packages/admin-engine/src/engines/menu/children/catalog-read/catalogRead.test.ts
//
// Protected behavior for the Menu area's read side.
//
// Two layers are tested, and the split is deliberate. The pure projections are
// exercised directly, because that is where the ported rules live and a direct
// call names the rule it is checking. The child itself is exercised through a
// real Admin runtime — composed by `createAdminEngine` with an injected store —
// because the questions worth asking there are "does it load, publish, and
// survive a broken store", and those are only true if the wiring is real.
//
// No React, no DOM, no renderer (LOGIC §6).

import { describe, expect, it } from "vitest";
import type { MenuCategory, MenuItem, MenuVariantGroup, Money } from "@warungmeng/domain";
import { defineLogicChild } from "@warungmeng/module-system";
import type { AdminEngineSnapshot } from "../../../../adminEngineContracts";
import { createAdminEngine } from "../../../../createAdminEngine";
import type { CatalogRead, MenuCatalogPort } from "../../menuContracts";
import {
  DEFAULT_MENU_LIST_FILTERS,
  DEFAULT_VARIANT_OPTION_LIST_FILTERS,
  MENU_CATALOG_PORT,
  MENU_CATALOG_READ,
  MENU_CATALOG_READ_ID,
} from "../../menuContracts";
import menuEngine from "../../menuEngine";
import catalogReadChild, {
  countMenusByAvailability,
  countMenusByCategory,
  countVariantOptionsByGroup,
  filterMenus,
  filterVariantOptions,
  flattenVariantOptions,
  projectMenuCollection,
} from "./catalogReadChild";

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
  return {
    slug: overrides.id,
    visibility: "visible",
    sortOrder: 0,
    ...overrides,
  };
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

function option(
  overrides: Partial<MenuVariantGroup["options"][number]> &
    Pick<MenuVariantGroup["options"][number], "id" | "name">,
): MenuVariantGroup["options"][number] {
  return {
    priceAdjustment: IDR(0),
    availability: { status: "available" },
    inventory: { mode: "untracked" },
    sortOrder: 0,
    ...overrides,
  };
}

/** A store over in-memory arrays. Only the read half is exercised here. */
function storeOver(seed: {
  menus?: readonly MenuItem[];
  categories?: readonly MenuCategory[];
  variantGroups?: readonly MenuVariantGroup[];
}): MenuCatalogPort {
  const unsupported = (): never => {
    throw new Error("write path not used by catalog-read");
  };

  return {
    listMenus: async () => seed.menus ?? [],
    getMenuById: async (id) => (seed.menus ?? []).find((entry) => entry.id === id) ?? null,
    createMenu: unsupported,
    updateMenu: unsupported,
    deleteMenu: unsupported,
    listCategories: async () => seed.categories ?? [],
    getCategoryById: async (id) => (seed.categories ?? []).find((entry) => entry.id === id) ?? null,
    createCategory: unsupported,
    updateCategory: unsupported,
    deleteCategory: unsupported,
    listVariantGroups: async () => seed.variantGroups ?? [],
    getVariantGroupById: async (id) =>
      (seed.variantGroups ?? []).find((entry) => entry.id === id) ?? null,
    createVariantGroup: unsupported,
    updateVariantGroup: unsupported,
    deleteVariantGroup: unsupported,
    newId: (kind) => `${kind}-test`,
  };
}

/**
 * Composes a real Admin runtime holding the Menu area plus a probe child that
 * REQUIRES the read capability and captures it.
 *
 * The probe is how a test reaches the capability, and it is not a workaround: an
 * Admin runtime deliberately cannot resolve capabilities from outside (that is a
 * locked decision — registration and resolution end when composition returns).
 * A consumer gets a capability by declaring it in `requires` and resolving it
 * from its injected context, so the probe reaches it exactly the way inventory
 * HPP and POS checkout will. It also means these tests fail if the capability is
 * published under the wrong id, which a direct `create()` call could not catch.
 *
 * Definitions are injected rather than discovered so the test never depends on
 * which other areas happen to exist on disk yet.
 */
function runtimeWith(store?: MenuCatalogPort): {
  readonly catalog: CatalogRead | undefined;
  readonly snapshot: AdminEngineSnapshot;
  readonly dispose: () => void;
} {
  let captured: CatalogRead | undefined;

  const probe = defineLogicChild({
    id: "admin.menu.test-probe",
    parentId: menuEngine.id,
    requires: [MENU_CATALOG_READ_ID],
    create(context) {
      const resolution = context.capabilities.resolve(MENU_CATALOG_READ);
      if (resolution.status === "available") {
        captured = resolution.value;
      }
      return undefined;
    },
  });

  const engine = createAdminEngine({
    definitions: { engines: [menuEngine], children: [catalogReadChild, probe] },
    ports: {
      resolve: (token) =>
        token.id === MENU_CATALOG_PORT.id && store !== undefined
          ? (store as never)
          : undefined,
    },
  });

  return { catalog: captured, snapshot: engine.getSnapshot(), dispose: engine.dispose };
}

// ─── Filtering ───────────────────────────────────────────────────────────────

describe("menu filtering", () => {
  const menus = [
    menu({ id: "m1", name: "Nasi Goreng", description: "with egg" }),
    menu({ id: "m2", name: "Es Teh", description: "sweet tea", categoryId: "cat-drink" }),
    menu({
      id: "m3",
      name: "Ayam Bakar",
      description: "grilled",
      availability: { status: "unavailable", unavailableUntil: null },
    }),
  ];

  it("matches search against the name", () => {
    const found = filterMenus(menus, { ...DEFAULT_MENU_LIST_FILTERS, search: "nasi" });
    expect(found.map((entry) => entry.id)).toEqual(["m1"]);
  });

  it("matches search against the description too", () => {
    const found = filterMenus(menus, { ...DEFAULT_MENU_LIST_FILTERS, search: "grilled" });
    expect(found.map((entry) => entry.id)).toEqual(["m3"]);
  });

  it("ignores case and surrounding whitespace in the search", () => {
    const found = filterMenus(menus, { ...DEFAULT_MENU_LIST_FILTERS, search: "  ES teh " });
    expect(found.map((entry) => entry.id)).toEqual(["m2"]);
  });

  it("treats an empty search as matching everything", () => {
    expect(filterMenus(menus, DEFAULT_MENU_LIST_FILTERS)).toHaveLength(3);
  });

  it("filters by category, and a null category means every category", () => {
    expect(
      filterMenus(menus, { ...DEFAULT_MENU_LIST_FILTERS, categoryId: "cat-drink" }).map(
        (entry) => entry.id,
      ),
    ).toEqual(["m2"]);
    expect(filterMenus(menus, { ...DEFAULT_MENU_LIST_FILTERS, categoryId: null })).toHaveLength(3);
  });

  it("filters by availability status", () => {
    expect(
      filterMenus(menus, { ...DEFAULT_MENU_LIST_FILTERS, availability: "unavailable" }).map(
        (entry) => entry.id,
      ),
    ).toEqual(["m3"]);
  });

  it("combines the three filters as AND", () => {
    const found = filterMenus(menus, {
      search: "a",
      categoryId: "cat-food",
      availability: "unavailable",
    });
    expect(found.map((entry) => entry.id)).toEqual(["m3"]);
  });

  it("still reports a menu as unavailable after its unavailable window elapsed", () => {
    // The stricter, time-aware question is the domain's `isMenuAvailable`. The
    // list filter answers the plain status question, as SOURCE did.
    const elapsed = [
      menu({
        id: "m4",
        name: "Sate",
        availability: { status: "unavailable", unavailableUntil: "2000-01-01T00:00:00.000Z" },
      }),
    ];
    expect(
      filterMenus(elapsed, { ...DEFAULT_MENU_LIST_FILTERS, availability: "unavailable" }),
    ).toHaveLength(1);
  });
});

// ─── Counts ──────────────────────────────────────────────────────────────────

describe("menu counts", () => {
  const menus = [
    menu({ id: "m1", name: "A", categoryId: "cat-food" }),
    menu({ id: "m2", name: "B", categoryId: "cat-food" }),
    menu({ id: "m3", name: "C", categoryId: "cat-drink" }),
  ];

  it("counts per category and omits categories with no matches", () => {
    const counts = countMenusByCategory(menus, DEFAULT_MENU_LIST_FILTERS);
    expect(counts.get("cat-food")).toBe(2);
    expect(counts.get("cat-drink")).toBe(1);
    expect(counts.has("cat-empty")).toBe(false);
  });

  it("keeps every category's count while one category is selected", () => {
    // The load-bearing rule: relaxing the category dimension is what stops the
    // other categories from showing zero as soon as one is picked.
    const counts = countMenusByCategory(menus, {
      ...DEFAULT_MENU_LIST_FILTERS,
      categoryId: "cat-drink",
    });
    expect(counts.get("cat-food")).toBe(2);
    expect(counts.get("cat-drink")).toBe(1);
  });

  it("keeps the search applied while relaxing the category", () => {
    const counts = countMenusByCategory(menus, {
      ...DEFAULT_MENU_LIST_FILTERS,
      search: "a",
      categoryId: "cat-drink",
    });
    expect(counts.get("cat-food")).toBe(1);
    expect(counts.has("cat-drink")).toBe(false);
  });

  it("counts an availability value while preserving search and category", () => {
    const mixed = [
      menu({ id: "m1", name: "Ayam", categoryId: "cat-food" }),
      menu({
        id: "m2",
        name: "Ayam Bakar",
        categoryId: "cat-food",
        availability: { status: "unavailable", unavailableUntil: null },
      }),
      menu({ id: "m3", name: "Ayam Es", categoryId: "cat-drink" }),
    ];
    const filters = {
      search: "ayam",
      categoryId: "cat-food",
      availability: "available" as const,
    };
    expect(countMenusByAvailability(mixed, filters, "all")).toBe(2);
    expect(countMenusByAvailability(mixed, filters, "unavailable")).toBe(1);
  });

  it("projects the collection with its filtered rows and both counts", () => {
    const projected = projectMenuCollection(menus, {
      ...DEFAULT_MENU_LIST_FILTERS,
      categoryId: "cat-drink",
    });
    expect(projected.menus.map((entry) => entry.id)).toEqual(["m3"]);
    // Only the availability dimension is relaxed for these two, so the selected
    // category still applies: 1 menu in cat-drink, not 3 overall. The category
    // counts below are the ones that ignore the selected category.
    expect(projected.totalCount).toBe(1);
    expect(projected.unavailableCount).toBe(0);
    expect(projected.countsByCategory.get("cat-food")).toBe(2);
  });
});

// ─── Variant option rows ─────────────────────────────────────────────────────

describe("variant option rows", () => {
  const groups = [
    group({
      id: "g1",
      name: "Spice",
      options: [option({ id: "o1", name: "Mild" }), option({ id: "o2", name: "Hot" })],
    }),
    group({
      id: "g2",
      name: "Size",
      options: [
        option({
          id: "o1",
          name: "Large",
          availability: { status: "unavailable", unavailableUntil: null },
        }),
      ],
    }),
  ];

  it("flattens in group order then option order", () => {
    expect(flattenVariantOptions(groups).map((row) => row.option.name)).toEqual([
      "Mild",
      "Hot",
      "Large",
    ]);
  });

  it("keys a row by group and option, since option ids repeat across groups", () => {
    const rows = flattenVariantOptions(groups);
    expect(rows.map((row) => row.id)).toEqual(["g1:o1", "g1:o2", "g2:o1"]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(3);
  });

  it("carries the owning group's name on every row", () => {
    expect(flattenVariantOptions(groups)[2]?.groupName).toBe("Size");
  });

  it("does not re-sort options inside a group", () => {
    // SOURCE only rewrites sortOrder on a full editor save, so array order is
    // what the editor shows and what this must show.
    const unsorted = [
      group({
        id: "g3",
        name: "Ice",
        options: [
          option({ id: "o1", name: "Later", sortOrder: 9 }),
          option({ id: "o2", name: "Earlier", sortOrder: 1 }),
        ],
      }),
    ];
    expect(flattenVariantOptions(unsorted).map((row) => row.option.name)).toEqual([
      "Later",
      "Earlier",
    ]);
  });

  it("matches search against the group name or the option name", () => {
    expect(
      filterVariantOptions(groups, {
        ...DEFAULT_VARIANT_OPTION_LIST_FILTERS,
        search: "size",
      }).map((row) => row.id),
    ).toEqual(["g2:o1"]);
    expect(
      filterVariantOptions(groups, {
        ...DEFAULT_VARIANT_OPTION_LIST_FILTERS,
        search: "hot",
      }).map((row) => row.id),
    ).toEqual(["g1:o2"]);
  });

  it("filters rows by group", () => {
    expect(
      filterVariantOptions(groups, {
        ...DEFAULT_VARIANT_OPTION_LIST_FILTERS,
        groupId: "g1",
      }),
    ).toHaveLength(2);
  });

  it("filters rows by the requested availability value, not a hardcoded one", () => {
    // SOURCE compared against the literal "unavailable" here. Same answers for
    // every value the filter can currently hold, but this asks the argument.
    expect(
      filterVariantOptions(groups, {
        ...DEFAULT_VARIANT_OPTION_LIST_FILTERS,
        availability: "unavailable",
      }).map((row) => row.id),
    ).toEqual(["g2:o1"]);
    expect(
      filterVariantOptions(groups, {
        ...DEFAULT_VARIANT_OPTION_LIST_FILTERS,
        availability: "all",
      }),
    ).toHaveLength(3);
  });

  it("counts per group with the group dimension relaxed", () => {
    const counts = countVariantOptionsByGroup(groups, {
      ...DEFAULT_VARIANT_OPTION_LIST_FILTERS,
      groupId: "g2",
    });
    expect(counts.get("g1")).toBe(2);
    expect(counts.get("g2")).toBe(1);
  });
});

// ─── The child, inside a real runtime ────────────────────────────────────────

describe("catalog-read as a logic child", () => {
  it("declares the capability LOGIC §8 has other areas requiring", () => {
    expect(catalogReadChild.id).toBe("admin.menu.catalog-read");
    expect(catalogReadChild.parentId).toBe("admin.menu");
    expect(catalogReadChild.provides).toEqual([MENU_CATALOG_READ_ID]);
    expect(catalogReadChild.requires).toEqual([]);
  });

  it("becomes an active child of the menu area and publishes its capability", () => {
    const { catalog, snapshot, dispose } = runtimeWith(storeOver({}));

    const area = snapshot.areas.find((entry) => entry.area === "menu");
    expect(area).toBeDefined();
    expect(area?.failedChildIds).toEqual([]);
    expect(area?.unavailableChildIds).toEqual([]);
    expect(snapshot.runtime.capabilities).toContain(MENU_CATALOG_READ_ID);
    // Resolved by a child that declared the requirement — so the id it is
    // published under is the id LOGIC §8 says consumers depend on.
    expect(catalog).toBeDefined();

    dispose();
  });

  it("initializes before a child that requires it", () => {
    const { snapshot, dispose } = runtimeWith(storeOver({}));

    const order = snapshot.runtime.initializationOrder;
    expect(order.indexOf(catalogReadChild.id)).toBeLessThan(
      order.indexOf("admin.menu.test-probe" as never),
    );

    dispose();
  });

  it("starts with no store connected, publishing anyway and reporting why", () => {
    const { catalog, snapshot, dispose } = runtimeWith(undefined);

    const area = snapshot.areas.find((entry) => entry.area === "menu");
    expect(area?.failedChildIds).toEqual([]);
    expect(snapshot.runtime.capabilities).toContain(MENU_CATALOG_READ_ID);
    expect(catalog).toBeDefined();
    expect(
      snapshot.diagnostics.some(
        (entry) => entry.code === "missing-dependency" && entry.source === "catalogReadChild",
      ),
    ).toBe(true);

    dispose();
  });

  it("answers every read with a normalized failure when no store is connected", async () => {
    const { catalog, dispose } = runtimeWith(undefined);

    const listed = await catalog?.listMenus();
    expect(listed?.status).toBe("failure");
    expect(listed?.status === "failure" && listed.reason).toBe("unsatisfied-dependency");
    expect(listed?.status === "failure" && listed.issues[0]?.code).toBe("no-catalog-store");

    const queried = await catalog?.queryMenus();
    expect(queried?.status).toBe("failure");

    dispose();
  });

  it("sorts menus by sort order, then by name for ties", async () => {
    // Ordering moved out of the store into this child, so it has to happen here
    // no matter what order the store returns rows in.
    const { catalog, dispose } = runtimeWith(
      storeOver({
        menus: [
          menu({ id: "m1", name: "Zebra", sortOrder: 2 }),
          menu({ id: "m2", name: "Banana", sortOrder: 1 }),
          menu({ id: "m3", name: "Apple", sortOrder: 1 }),
        ],
      }),
    );

    const listed = await catalog?.listMenus();
    expect(listed?.status).toBe("success");
    expect(
      listed?.status === "success" ? listed.value.map((entry) => entry.name) : undefined,
    ).toEqual(["Apple", "Banana", "Zebra"]);

    dispose();
  });

  it("sorts categories and variant groups the same way", async () => {
    const { catalog, dispose } = runtimeWith(
      storeOver({
        categories: [
          category({ id: "c1", name: "Drinks", sortOrder: 1 }),
          category({ id: "c2", name: "Desserts", sortOrder: 1 }),
          category({ id: "c3", name: "Food", sortOrder: 0 }),
        ],
        variantGroups: [
          group({ id: "g1", name: "Spice", sortOrder: 5 }),
          group({ id: "g2", name: "Ice", sortOrder: 1 }),
        ],
      }),
    );

    const categories = await catalog?.listCategories();
    expect(
      categories?.status === "success" ? categories.value.map((entry) => entry.name) : undefined,
    ).toEqual(["Food", "Desserts", "Drinks"]);

    const groups = await catalog?.listVariantGroups();
    expect(
      groups?.status === "success" ? groups.value.map((entry) => entry.name) : undefined,
    ).toEqual(["Ice", "Spice"]);

    dispose();
  });

  it("returns the store's own message when a read throws", async () => {
    const failing = storeOver({});
    const { catalog, dispose } = runtimeWith({
      ...failing,
      listMenus: async () => {
        throw new Error("connection refused");
      },
    });

    const listed = await catalog?.listMenus();
    expect(listed?.status).toBe("failure");
    expect(listed?.status === "failure" && listed.reason).toBe("failed");
    expect(listed?.status === "failure" && listed.issues[0]?.message).toBe("connection refused");

    dispose();
  });

  it("does not let a failing store take down the sibling reads", async () => {
    const working = storeOver({ categories: [category({ id: "c1", name: "Food" })] });
    const { catalog, dispose } = runtimeWith({
      ...working,
      listMenus: async () => {
        throw new Error("menus unavailable");
      },
    });

    expect((await catalog?.listMenus())?.status).toBe("failure");
    expect((await catalog?.listCategories())?.status).toBe("success");

    dispose();
  });

  it("queries the collection through the store, sorted and filtered together", async () => {
    const { catalog, dispose } = runtimeWith(
      storeOver({
        menus: [
          menu({ id: "m1", name: "Zebra", categoryId: "cat-food", sortOrder: 2 }),
          menu({ id: "m2", name: "Apple", categoryId: "cat-food", sortOrder: 1 }),
          menu({ id: "m3", name: "Es Teh", categoryId: "cat-drink", sortOrder: 0 }),
        ],
      }),
    );

    const queried = await catalog?.queryMenus({
      ...DEFAULT_MENU_LIST_FILTERS,
      categoryId: "cat-food",
    });

    expect(queried?.status).toBe("success");
    if (queried?.status !== "success") return;
    expect(queried.value.menus.map((entry) => entry.name)).toEqual(["Apple", "Zebra"]);
    expect(queried.value.totalCount).toBe(2);
    expect(queried.value.countsByCategory.get("cat-drink")).toBe(1);

    dispose();
  });

  it("defaults to unfiltered when no filters are passed", async () => {
    const { catalog, dispose } = runtimeWith(
      storeOver({ menus: [menu({ id: "m1", name: "A" }), menu({ id: "m2", name: "B" })] }),
    );

    const queried = await catalog?.queryMenus();
    expect(queried?.status === "success" ? queried.value.menus : undefined).toHaveLength(2);

    dispose();
  });

  it("queries flattened variant option rows through the store", async () => {
    const { catalog, dispose } = runtimeWith(
      storeOver({
        variantGroups: [
          group({
            id: "g1",
            name: "Spice",
            options: [option({ id: "o1", name: "Mild" }), option({ id: "o2", name: "Hot" })],
          }),
        ],
      }),
    );

    const queried = await catalog?.queryVariantOptions();
    expect(queried?.status).toBe("success");
    if (queried?.status !== "success") return;
    expect(queried.value.options.map((row) => row.id)).toEqual(["g1:o1", "g1:o2"]);
    expect(queried.value.countsByGroup.get("g1")).toBe(2);

    dispose();
  });
});
