// packages/admin-engine/src/engines/menu/children/variant-management/variantManagement.test.ts
//
// Protected behavior for variant groups, their options, and their attachment to
// menus.
//
// The invariant tests here are the point of this file. SOURCE could produce a
// group demanding more selections than it had options, and a group with no
// options at all, because the inline option table wrote the array back without
// consulting the selection rule. Those two cases are asserted directly.
//
// No React, no DOM, no renderer (LOGIC §6).

import { describe, expect, it } from "vitest";
import type { MenuItem, MenuVariantGroup, Money } from "@warungmeng/domain";
import { defineLogicChild } from "@warungmeng/module-system";
import { createAdminEngine } from "../../../../createAdminEngine";
import type {
  CatalogCreateInput,
  MenuCatalogPort,
  VariantGroupValues,
  VariantManagement,
} from "../../menuContracts";
import {
  MENU_CATALOG_PORT,
  VARIANT_GROUP_NAME_MAX_LENGTH,
  VARIANT_MANAGEMENT,
  VARIANT_MANAGEMENT_ID,
} from "../../menuContracts";
import menuEngine from "../../menuEngine";
import variantManagementChild, {
  connectedMenuIds,
  connectionChanges,
  defaultVariantGroupValues,
  isQuickEditValid,
  isSelectionSatisfiable,
  normalizeSelectionFields,
  selectionFieldsForMode,
  validateVariantGroupDraft,
  valuesToVariantGroup,
  variantGroupToValues,
} from "./variantManagementChild";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const IDR = (amount: number): Money => ({ amount, currency: "IDR" });

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

function group(
  overrides: Partial<MenuVariantGroup> & Pick<MenuVariantGroup, "id" | "name">,
): MenuVariantGroup {
  return {
    description: "",
    visibility: "visible",
    selection: { minSelections: 0, maxSelections: null },
    options: [option({ id: "o1", name: "First" })],
    sortOrder: 0,
    ...overrides,
  };
}

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

function values(overrides: Partial<VariantGroupValues> = {}): VariantGroupValues {
  return {
    ...defaultVariantGroupValues("o1"),
    name: "Spice",
    options: [
      { id: "o1", name: "Mild", priceAmount: 0, available: true },
      { id: "o2", name: "Hot", priceAmount: 2_000, available: true },
    ],
    ...overrides,
  };
}

function mutableStore(seed: {
  menus?: readonly MenuItem[];
  variantGroups?: readonly MenuVariantGroup[];
}) {
  const menus = [...(seed.menus ?? [])];
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

  const unsupported = (): never => {
    throw new Error("category path not used by variant-management");
  };

  const port: MenuCatalogPort = {
    listMenus: async () => [...menus],
    getMenuById: async (id) => menus.find((row) => row.id === id) ?? null,
    createMenu: unsupported,
    updateMenu: async (id, changes) => patch(menus, id, changes),
    deleteMenu: async (id) => {
      const index = menus.findIndex((row) => row.id === id);
      if (index === -1) return false;
      menus.splice(index, 1);
      return true;
    },
    listCategories: async () => [],
    getCategoryById: async () => null,
    createCategory: unsupported,
    updateCategory: unsupported,
    deleteCategory: unsupported,
    listVariantGroups: async () => [...variantGroups],
    getVariantGroupById: async (id) => variantGroups.find((row) => row.id === id) ?? null,
    createVariantGroup: async (input: CatalogCreateInput<MenuVariantGroup>) => {
      const created = { ...input, id: port.newId("variant-group") } as MenuVariantGroup;
      variantGroups.push(created);
      return created;
    },
    updateVariantGroup: async (id, changes) => patch(variantGroups, id, changes),
    deleteVariantGroup: async (id) => {
      const index = variantGroups.findIndex((row) => row.id === id);
      if (index === -1) return false;
      variantGroups.splice(index, 1);
      return true;
    },
    newId: (kind) => {
      const next = (counters.get(kind) ?? 0) + 1;
      counters.set(kind, next);
      return `${kind}-${next}`;
    },
  };

  return { port, menus, variantGroups };
}

function runtimeWith(store?: MenuCatalogPort): {
  readonly variants: VariantManagement | undefined;
  readonly snapshot: ReturnType<ReturnType<typeof createAdminEngine>["getSnapshot"]>;
  readonly dispose: () => void;
} {
  let captured: VariantManagement | undefined;

  const probe = defineLogicChild({
    id: "admin.menu.test-probe",
    parentId: menuEngine.id,
    requires: [VARIANT_MANAGEMENT_ID],
    create(context) {
      const resolution = context.capabilities.resolve(VARIANT_MANAGEMENT);
      if (resolution.status === "available") captured = resolution.value;
      return undefined;
    },
  });

  const engine = createAdminEngine({
    definitions: { engines: [menuEngine], children: [variantManagementChild, probe] },
    ports: {
      resolve: (token) =>
        token.id === MENU_CATALOG_PORT.id && store !== undefined ? (store as never) : undefined,
    },
  });

  return { variants: captured, snapshot: engine.getSnapshot(), dispose: engine.dispose };
}

// ─── Selection rules ─────────────────────────────────────────────────────────

describe("selection rules", () => {
  it("round-trips each mode through the domain and back", () => {
    const cases: readonly { rule: MenuVariantGroup["selection"]; mode: string }[] = [
      { rule: { minSelections: 0, maxSelections: null }, mode: "optional-unlimited" },
      { rule: { minSelections: 0, maxSelections: 2 }, mode: "optional-maximum" },
      { rule: { minSelections: 2, maxSelections: 2 }, mode: "exact" },
      { rule: { minSelections: 2, maxSelections: null }, mode: "minimum" },
      { rule: { minSelections: 1, maxSelections: 3 }, mode: "range" },
    ];

    for (const { rule, mode } of cases) {
      expect(variantGroupToValues(group({ id: "g", name: "G", selection: rule })).selectionMode).toBe(
        mode,
      );
    }
  });

  it("carries only the bounds the mode actually uses", () => {
    const unlimited = variantGroupToValues(
      group({ id: "g", name: "G", selection: { minSelections: 0, maxSelections: null } }),
    );
    expect(unlimited.selectionMinimum).toBeUndefined();
    expect(unlimited.selectionMaximum).toBeUndefined();

    const range = variantGroupToValues(
      group({ id: "g", name: "G", selection: { minSelections: 1, maxSelections: 3 } }),
    );
    expect(range.selectionMinimum).toBe(1);
    expect(range.selectionMaximum).toBe(3);
  });

  it("treats impossible numbers as invalid rather than letting the domain throw", () => {
    // The domain raises RangeError for these; "threw" and "invalid" are the same
    // answer to a caller.
    expect(
      isSelectionSatisfiable(values({ selectionMode: "exact", selectionMinimum: undefined })),
    ).toBe(false);
    expect(
      isSelectionSatisfiable(
        values({ selectionMode: "range", selectionMinimum: 3, selectionMaximum: 1 }),
      ),
    ).toBe(false);
  });

  it("rejects a rule needing more selections than there are options", () => {
    expect(
      isSelectionSatisfiable(values({ selectionMode: "exact", selectionMinimum: 5 })),
    ).toBe(false);
  });

  it("counts only AVAILABLE options when judging a rule", () => {
    // The strict reading, and SOURCE's: a rule needing two selections cannot be
    // satisfied when only one option is orderable.
    const oneAvailable = values({
      selectionMode: "exact",
      selectionMinimum: 2,
      options: [
        { id: "o1", name: "Mild", priceAmount: 0, available: true },
        { id: "o2", name: "Hot", priceAmount: 0, available: false },
      ],
    });
    expect(isSelectionSatisfiable(oneAvailable)).toBe(false);
  });

  it("rejects a group with no options at all", () => {
    expect(isSelectionSatisfiable(values({ options: [] }))).toBe(false);
  });

  it("offers sensible starting bounds per mode", () => {
    expect(selectionFieldsForMode("optional-unlimited", 3)).toEqual({});
    expect(selectionFieldsForMode("optional-maximum", 3)).toEqual({ selectionMaximum: 1 });
    expect(selectionFieldsForMode("exact", 3)).toEqual({ selectionMinimum: 1 });
    expect(selectionFieldsForMode("range", 3)).toEqual({
      selectionMinimum: 1,
      selectionMaximum: 3,
    });
  });

  it("leaves bounds undefined when there are no options to bound", () => {
    expect(selectionFieldsForMode("exact", 0)).toEqual({ selectionMinimum: undefined });
    expect(normalizeSelectionFields(values({ selectionMode: "exact" }), 0)).toEqual({});
  });

  it("clamps bounds down to the number of options", () => {
    const clamped = normalizeSelectionFields(
      { selectionMode: "range", selectionMinimum: 1, selectionMaximum: 9 },
      2,
    );
    expect(clamped.selectionMaximum).toBe(2);
  });

  it("falls back to the mode's defaults when bounds cannot be clamped", () => {
    const fallback = normalizeSelectionFields(
      { selectionMode: "exact", selectionMinimum: undefined },
      3,
    );
    expect(fallback).toEqual({ selectionMinimum: 1 });
  });
});

// ─── Mapping ─────────────────────────────────────────────────────────────────

describe("variant group mapping", () => {
  it("numbers options by their position, so order comes from the array", () => {
    const built = valuesToVariantGroup(values(), null, 0);
    expect(built.options.map((entry) => entry.sortOrder)).toEqual([0, 1]);
  });

  it("preserves per-option inventory, which the editor has no field for", () => {
    const baseline = group({
      id: "g1",
      name: "Spice",
      options: [option({ id: "o1", name: "Mild", inventory: { mode: "tracked", quantity: 4 } })],
    });
    const built = valuesToVariantGroup(values(), baseline, 0);
    expect(built.options[0]?.inventory).toEqual({ mode: "tracked", quantity: 4 });
    // A newly added option has no baseline to inherit from.
    expect(built.options[1]?.inventory).toEqual({ mode: "untracked" });
  });

  it("trims names and converts prices to money", () => {
    const built = valuesToVariantGroup(
      values({ options: [{ id: "o1", name: "  Hot  ", priceAmount: 2_500, available: true }] }),
      null,
      0,
    );
    expect(built.options[0]?.name).toBe("Hot");
    expect(built.options[0]?.priceAdjustment).toEqual(IDR(2_500));
  });

  it("maps an unavailable option to the stored availability shape", () => {
    const built = valuesToVariantGroup(
      values({ options: [{ id: "o1", name: "Hot", priceAmount: 0, available: false }] }),
      null,
      0,
    );
    expect(built.options[0]?.availability).toEqual({
      status: "unavailable",
      unavailableUntil: null,
    });
  });
});

// ─── Connections ─────────────────────────────────────────────────────────────

describe("menu attachment", () => {
  const menus = [
    menu({ id: "m1", name: "A", variantGroupIds: ["g1"] }),
    menu({ id: "m2", name: "B", variantGroupIds: [] }),
    menu({ id: "m3", name: "C", variantGroupIds: ["g1", "g2"] }),
  ];

  it("finds which menus a group is attached to", () => {
    expect(connectedMenuIds(menus, "g1")).toEqual(["m1", "m3"]);
    expect(connectedMenuIds(menus, "g2")).toEqual(["m3"]);
    expect(connectedMenuIds(menus, "absent")).toEqual([]);
  });

  it("writes nothing when the attachment list already matches", () => {
    expect(connectionChanges(menus, "g1", ["m1", "m3"])).toEqual([]);
  });

  it("attaches and detaches only the menus that differ", () => {
    const changes = connectionChanges(menus, "g1", ["m2", "m3"]);
    expect(changes).toHaveLength(2);
    expect(changes.find((change) => change.menuId === "m1")?.variantGroupIds).toEqual([]);
    expect(changes.find((change) => change.menuId === "m2")?.variantGroupIds).toEqual(["g1"]);
  });

  it("leaves a menu's other groups alone when detaching one", () => {
    const changes = connectionChanges(menus, "g1", []);
    expect(changes.find((change) => change.menuId === "m3")?.variantGroupIds).toEqual(["g2"]);
  });
});

// ─── Validation ──────────────────────────────────────────────────────────────

describe("variant group validation", () => {
  it("accepts a valid group", () => {
    expect(validateVariantGroupDraft(values())).toEqual([]);
  });

  it("rejects a blank group name", () => {
    expect(
      validateVariantGroupDraft(values({ name: "  " })).some((issue) => issue.subject === "name"),
    ).toBe(true);
  });

  it("enforces the group name limit", () => {
    const issues = validateVariantGroupDraft(
      values({ name: "x".repeat(VARIANT_GROUP_NAME_MAX_LENGTH + 1) }),
    );
    expect(issues.some((issue) => issue.code === "too_long")).toBe(true);
  });

  it("requires at least one option", () => {
    expect(
      validateVariantGroupDraft(values({ options: [] })).some(
        (issue) => issue.subject === "options",
      ),
    ).toBe(true);
  });

  it("rejects a blank option name, naming which option", () => {
    const issues = validateVariantGroupDraft(
      values({
        options: [
          { id: "o1", name: "Mild", priceAmount: 0, available: true },
          { id: "o2", name: "  ", priceAmount: 0, available: true },
        ],
      }),
    );
    expect(issues.some((issue) => issue.subject === "options.1.name")).toBe(true);
  });

  it("rejects a negative or fractional price adjustment", () => {
    for (const priceAmount of [-1, 1.5]) {
      const issues = validateVariantGroupDraft(
        values({ options: [{ id: "o1", name: "Mild", priceAmount, available: true }] }),
      );
      expect(issues.some((issue) => issue.code === "invalid_money")).toBe(true);
    }
  });

  it("rejects a selection rule the options cannot satisfy", () => {
    const issues = validateVariantGroupDraft(
      values({ selectionMode: "exact", selectionMinimum: 5 }),
    );
    expect(issues.some((issue) => issue.code === "selection-unsatisfiable")).toBe(true);
  });

  it("accepts a quick edit with a name and a whole non-negative price", () => {
    expect(isQuickEditValid({ name: "Hot", priceAmount: 0 })).toBe(true);
    expect(isQuickEditValid({ name: "  ", priceAmount: 0 })).toBe(false);
    expect(isQuickEditValid({ name: "Hot", priceAmount: -1 })).toBe(false);
    expect(isQuickEditValid({ name: "Hot", priceAmount: 1.5 })).toBe(false);
  });
});

// ─── The child, inside a real runtime ────────────────────────────────────────

describe("variant-management as a logic child", () => {
  it("declares its capability and requires nothing", () => {
    expect(variantManagementChild.id).toBe("admin.menu.variant-management");
    expect(variantManagementChild.parentId).toBe("admin.menu");
    expect(variantManagementChild.provides).toEqual([VARIANT_MANAGEMENT_ID]);
    expect(variantManagementChild.requires).toEqual([]);
  });

  it("publishes its capability", () => {
    const { variants, snapshot, dispose } = runtimeWith(mutableStore({}).port);
    expect(variants).toBeDefined();
    expect(snapshot.runtime.capabilities).toContain(VARIANT_MANAGEMENT_ID);
    expect(snapshot.areas.find((entry) => entry.area === "menu")?.failedChildIds).toEqual([]);
    dispose();
  });

  it("fails every command with no store, and says so", async () => {
    const { variants, snapshot, dispose } = runtimeWith(undefined);
    const saved = await variants?.saveVariantGroup({ variantGroupId: null, values: values() });
    expect(saved?.status === "failure" && saved.reason).toBe("unsatisfied-dependency");
    expect(
      snapshot.diagnostics.some(
        (entry) => entry.code === "missing-dependency" && entry.source === "variantManagementChild",
      ),
    ).toBe(true);
    dispose();
  });

  it("loads a group with the menus it is attached to", async () => {
    const store = mutableStore({
      variantGroups: [group({ id: "g1", name: "Spice" })],
      menus: [
        menu({ id: "m1", name: "A", variantGroupIds: ["g1"] }),
        menu({ id: "m2", name: "B" }),
      ],
    });
    const { variants, dispose } = runtimeWith(store.port);

    const draft = await variants?.loadVariantGroupDraft("g1");
    expect(draft?.status).toBe("success");
    if (draft?.status !== "success") return;
    expect(draft.value.values.connectedMenuIds).toEqual(["m1"]);
    expect(draft.value.menus).toHaveLength(2);

    dispose();
  });

  it("starts a draft with one blank option", async () => {
    const { variants, dispose } = runtimeWith(mutableStore({}).port);
    const draft = await variants?.startVariantGroupDraft();
    expect(draft?.status === "success" ? draft.value.values.options : []).toHaveLength(1);
    dispose();
  });

  it("creates a group and attaches it to the chosen menus in one call", async () => {
    const store = mutableStore({ menus: [menu({ id: "m1", name: "A" }), menu({ id: "m2", name: "B" })] });
    const { variants, dispose } = runtimeWith(store.port);

    const saved = await variants?.saveVariantGroup({
      variantGroupId: null,
      values: values({ connectedMenuIds: ["m2"] }),
    });

    expect(saved?.status).toBe("success");
    expect(store.variantGroups).toHaveLength(1);
    const groupId = store.variantGroups[0]?.id;
    expect(store.menus.find((entry) => entry.id === "m2")?.variantGroupIds).toEqual([groupId]);
    expect(store.menus.find((entry) => entry.id === "m1")?.variantGroupIds).toEqual([]);

    dispose();
  });

  it("detaches a group from a menu that was deselected", async () => {
    const store = mutableStore({
      variantGroups: [group({ id: "g1", name: "Spice" })],
      menus: [menu({ id: "m1", name: "A", variantGroupIds: ["g1"] })],
    });
    const { variants, dispose } = runtimeWith(store.port);

    await variants?.saveVariantGroup({
      variantGroupId: "g1",
      values: values({ connectedMenuIds: [] }),
    });

    expect(store.menus[0]?.variantGroupIds).toEqual([]);

    dispose();
  });

  it("writes nothing when validation fails", async () => {
    const store = mutableStore({});
    const { variants, dispose } = runtimeWith(store.port);

    const saved = await variants?.saveVariantGroup({
      variantGroupId: null,
      values: values({ name: "" }),
    });

    expect(saved?.status === "failure" && saved.reason).toBe("invalid-input");
    expect(store.variantGroups).toHaveLength(0);

    dispose();
  });

  it("reports which menus are out of sync when the group saved but a link did not", async () => {
    // SOURCE threw on the first failing menu, so later menus were never
    // attempted and the caller learned only that something failed.
    const store = mutableStore({
      menus: [menu({ id: "m1", name: "A" }), menu({ id: "m2", name: "B" })],
    });
    const { variants, dispose } = runtimeWith({
      ...store.port,
      updateMenu: async (id, changes) =>
        id === "m1" ? null : store.port.updateMenu(id, changes),
    });

    const saved = await variants?.saveVariantGroup({
      variantGroupId: null,
      values: values({ connectedMenuIds: ["m1", "m2"] }),
    });

    expect(saved?.status).toBe("degraded");
    if (saved?.status !== "degraded") return;
    expect(saved.value.failedMenuIds).toEqual(["m1"]);
    // The group is saved, and the menu that COULD be linked still was.
    expect(store.variantGroups).toHaveLength(1);
    expect(store.menus.find((entry) => entry.id === "m2")?.variantGroupIds).toHaveLength(1);

    dispose();
  });

  it("edits an option's name and price in place", async () => {
    const store = mutableStore({
      variantGroups: [
        group({
          id: "g1",
          name: "Spice",
          options: [option({ id: "o1", name: "Mild" }), option({ id: "o2", name: "Hot" })],
        }),
      ],
    });
    const { variants, dispose } = runtimeWith(store.port);

    const updated = await variants?.updateVariantOption("g1", "o2", {
      name: "  Extra Hot  ",
      priceAmount: 3_000,
    });

    expect(updated?.status).toBe("success");
    expect(store.variantGroups[0]?.options[1]?.name).toBe("Extra Hot");
    expect(store.variantGroups[0]?.options[1]?.priceAdjustment).toEqual(IDR(3_000));
    expect(store.variantGroups[0]?.options[0]?.name).toBe("Mild");

    dispose();
  });

  it("rejects an invalid quick edit without touching the store", async () => {
    const store = mutableStore({ variantGroups: [group({ id: "g1", name: "Spice" })] });
    const { variants, dispose } = runtimeWith(store.port);

    const updated = await variants?.updateVariantOption("g1", "o1", { name: " ", priceAmount: 0 });

    expect(updated?.status === "failure" && updated.reason).toBe("invalid-input");
    expect(store.variantGroups[0]?.options[0]?.name).toBe("First");

    dispose();
  });

  it("reports not-found for an unknown group or option", async () => {
    const store = mutableStore({ variantGroups: [group({ id: "g1", name: "Spice" })] });
    const { variants, dispose } = runtimeWith(store.port);

    const noGroup = await variants?.updateVariantOption("ghost", "o1", {
      name: "X",
      priceAmount: 0,
    });
    expect(noGroup?.status === "failure" && noGroup.reason).toBe("not-found");

    const noOption = await variants?.updateVariantOption("g1", "ghost", {
      name: "X",
      priceAmount: 0,
    });
    expect(noOption?.status === "failure" && noOption.reason).toBe("not-found");

    dispose();
  });

  it("deletes an option when the group can spare it", async () => {
    const store = mutableStore({
      variantGroups: [
        group({
          id: "g1",
          name: "Spice",
          options: [option({ id: "o1", name: "Mild" }), option({ id: "o2", name: "Hot" })],
        }),
      ],
    });
    const { variants, dispose } = runtimeWith(store.port);

    expect((await variants?.deleteVariantOption("g1", "o2"))?.status).toBe("success");
    expect(store.variantGroups[0]?.options.map((entry) => entry.id)).toEqual(["o1"]);

    dispose();
  });

  it("refuses to delete the last option, which was only a disabled button before", async () => {
    const store = mutableStore({
      variantGroups: [
        group({ id: "g1", name: "Spice", options: [option({ id: "o1", name: "Only" })] }),
      ],
    });
    const { variants, dispose } = runtimeWith(store.port);

    const deleted = await variants?.deleteVariantOption("g1", "o1");

    expect(deleted?.status).toBe("failure");
    expect(deleted?.status === "failure" && deleted.reason).toBe("conflict");
    expect(deleted?.status === "failure" && deleted.issues[0]?.code).toBe("last-option");
    expect(store.variantGroups[0]?.options).toHaveLength(1);

    dispose();
  });

  it("refuses a delete that would make the selection rule impossible", async () => {
    // The bug this slice fixes: SOURCE wrote the filtered array straight back,
    // leaving a group demanding two selections with only one option left.
    const store = mutableStore({
      variantGroups: [
        group({
          id: "g1",
          name: "Spice",
          selection: { minSelections: 2, maxSelections: 2 },
          options: [option({ id: "o1", name: "Mild" }), option({ id: "o2", name: "Hot" })],
        }),
      ],
    });
    const { variants, dispose } = runtimeWith(store.port);

    const deleted = await variants?.deleteVariantOption("g1", "o2");

    expect(deleted?.status).toBe("failure");
    expect(deleted?.status === "failure" && deleted.issues[0]?.code).toBe(
      "selection-unsatisfiable",
    );
    expect(store.variantGroups[0]?.options).toHaveLength(2);
    expect(store.variantGroups[0]?.selection.minSelections).toBe(2);

    dispose();
  });

  it("turns an option off when the rule still holds", async () => {
    const store = mutableStore({
      variantGroups: [
        group({
          id: "g1",
          name: "Spice",
          options: [option({ id: "o1", name: "Mild" }), option({ id: "o2", name: "Hot" })],
        }),
      ],
    });
    const { variants, dispose } = runtimeWith(store.port);

    expect((await variants?.setVariantOptionAvailability("g1", "o2", false))?.status).toBe(
      "success",
    );
    expect(store.variantGroups[0]?.options[1]?.availability.status).toBe("unavailable");

    dispose();
  });

  it("refuses to turn off an option the rule still needs", async () => {
    // Availability is guarded for the same reason delete is: the rule is judged
    // against AVAILABLE options, so switching one off can break it too.
    const store = mutableStore({
      variantGroups: [
        group({
          id: "g1",
          name: "Spice",
          selection: { minSelections: 2, maxSelections: 2 },
          options: [option({ id: "o1", name: "Mild" }), option({ id: "o2", name: "Hot" })],
        }),
      ],
    });
    const { variants, dispose } = runtimeWith(store.port);

    const toggled = await variants?.setVariantOptionAvailability("g1", "o2", false);

    expect(toggled?.status).toBe("failure");
    expect(toggled?.status === "failure" && toggled.issues[0]?.code).toBe(
      "selection-unsatisfiable",
    );
    expect(store.variantGroups[0]?.options[1]?.availability.status).toBe("available");

    dispose();
  });

  it("always allows turning an option back on", async () => {
    const store = mutableStore({
      variantGroups: [
        group({
          id: "g1",
          name: "Spice",
          selection: { minSelections: 2, maxSelections: 2 },
          options: [
            option({ id: "o1", name: "Mild" }),
            option({
              id: "o2",
              name: "Hot",
              availability: { status: "unavailable", unavailableUntil: null },
            }),
          ],
        }),
      ],
    });
    const { variants, dispose } = runtimeWith(store.port);

    expect((await variants?.setVariantOptionAvailability("g1", "o2", true))?.status).toBe("success");

    dispose();
  });

  it("deletes a group and strips its id from every surviving menu", async () => {
    const store = mutableStore({
      variantGroups: [group({ id: "g1", name: "Spice" })],
      menus: [
        menu({ id: "m1", name: "A", variantGroupIds: ["g1", "g2"] }),
        menu({ id: "m2", name: "B", variantGroupIds: ["g1"] }),
        menu({ id: "m3", name: "C", variantGroupIds: ["g2"] }),
      ],
    });
    const { variants, dispose } = runtimeWith(store.port);

    expect((await variants?.deleteVariantGroup("g1"))?.status).toBe("success");
    expect(store.variantGroups).toHaveLength(0);
    expect(store.menus.map((entry) => entry.variantGroupIds)).toEqual([["g2"], [], ["g2"]]);

    dispose();
  });

  it("tries every group-reference cleanup and degrades with the failed menu ids", async () => {
    const store = mutableStore({
      variantGroups: [group({ id: "g1", name: "Spice" })],
      menus: [
        menu({ id: "m1", name: "A", variantGroupIds: ["g1"] }),
        menu({ id: "m2", name: "B", variantGroupIds: ["g1"] }),
        menu({ id: "m3", name: "C", variantGroupIds: ["g1", "g2"] }),
      ],
    });
    const attemptedMenuIds: string[] = [];
    const { variants, dispose } = runtimeWith({
      ...store.port,
      updateMenu: async (id, changes) => {
        attemptedMenuIds.push(id);
        if (id === "m1") throw new Error("row locked");
        if (id === "m2") return null;
        return store.port.updateMenu(id, changes);
      },
    });

    const deleted = await variants?.deleteVariantGroup("g1");

    expect(deleted?.status).toBe("degraded");
    if (deleted?.status !== "degraded") return;
    expect(deleted.value).toBe("g1");
    expect(attemptedMenuIds).toEqual(["m1", "m2", "m3"]);
    expect(deleted.issues.map((issue) => issue.subject)).toEqual(["m1", "m2"]);
    expect(deleted.issues.every((issue) => issue.code === "connection-cleanup-failed")).toBe(true);
    expect(store.variantGroups).toHaveLength(0);
    expect(store.menus.find((entry) => entry.id === "m1")?.variantGroupIds).toEqual(["g1"]);
    expect(store.menus.find((entry) => entry.id === "m2")?.variantGroupIds).toEqual(["g1"]);
    expect(store.menus.find((entry) => entry.id === "m3")?.variantGroupIds).toEqual(["g2"]);

    dispose();
  });

  it("turns a thrown store error into a normalized failure", async () => {
    const store = mutableStore({});
    const { variants, dispose } = runtimeWith({
      ...store.port,
      createVariantGroup: async () => {
        throw new Error("write rejected");
      },
    });

    const saved = await variants?.saveVariantGroup({ variantGroupId: null, values: values() });

    expect(saved?.status === "failure" && saved.reason).toBe("failed");
    expect(saved?.status === "failure" && saved.issues[0]?.message).toBe("write rejected");

    dispose();
  });
});
