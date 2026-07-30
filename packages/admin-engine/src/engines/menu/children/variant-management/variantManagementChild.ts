// packages/admin-engine/src/engines/menu/children/variant-management/variantManagementChild.ts
//
// Variant groups, their options, and their attachment to menus
// (capability `admin.menu.variant-management`).
//
// Ported from SOURCE:
//   - application/variantCategoryEditorModel.ts (the group editor mapping and
//     the selection-rule derivation and normalization)
//   - application/variantOptionCommands.ts (the pure option transforms and the
//     quick-edit rule)
//   - application/variantGroupConnections.ts (reverse-side menu↔group linking)
//   - the inline mutation half of application/useVariantGroupList.ts
//   - the two-phase save in screens/VariantCategoryEditorScreen.tsx
//
// Why this child owns the menu↔group linking even though it writes MENU rows:
// attaching a group to a menu is the group editor's own workflow, and the
// alternative — having `menu-editor` own it — would mean this child requires
// that one, which LOGIC §8 rules out (no menu child requires anything). Both
// children write through the same injected store, so the store stays the single
// writer of record; there are just two callers, exactly as in SOURCE.
//
// The selection rule is the domain's, not this child's. `createVariantSelectionRule`,
// `normalizeVariantSelectionRule` and `validateVariantSelectionRule` all live in
// `@warungmeng/domain` and are called, never re-implemented — including their
// habit of throwing `RangeError` on impossible input, which is caught and
// degraded here rather than propagated.

import type {
  MenuItem,
  MenuVariantGroup,
  MenuVariantOption,
  VariantSelectionMode,
  VariantSelectionRule,
} from "@warungmeng/domain";
import {
  createVariantSelectionRule,
  deriveVariantSelectionMode,
  normalizeVariantSelectionRule,
  validateVariantSelectionRule,
} from "@warungmeng/domain";
import type { LogicChildContext, OperationIssue, OperationResult } from "@warungmeng/module-system";
import {
  defineLogicChild,
  operationDegraded,
  operationFailure,
  operationIssue,
  operationSuccess,
  severityForCode,
} from "@warungmeng/module-system";
import { MENU_ENGINE_ID } from "../../menuEngine";
import type {
  MenuCatalogPort,
  SaveVariantGroupInput,
  VariantGroupDraft,
  VariantGroupSaveResult,
  VariantGroupValues,
  VariantManagement,
  VariantOptionQuickEdit,
  VariantOptionValues,
} from "../../menuContracts";
import {
  MENU_CATALOG_PORT,
  VARIANT_GROUP_NAME_MAX_LENGTH,
  VARIANT_MANAGEMENT,
  VARIANT_MANAGEMENT_ID,
  VARIANT_OPTION_NAME_MAX_LENGTH,
} from "../../menuContracts";

// ─── Selection rule ──────────────────────────────────────────────────────────

/**
 * Editor values → the domain's rule. Throws exactly where the domain throws, so
 * every caller here goes through `selectionRuleOrNull`.
 */
export function selectionRuleFrom(
  values: Pick<VariantGroupValues, "selectionMode" | "selectionMinimum" | "selectionMaximum">,
): VariantSelectionRule {
  return createVariantSelectionRule({
    mode: values.selectionMode,
    minimum: values.selectionMinimum,
    maximum: values.selectionMaximum,
  });
}

/**
 * The rule, or null when the values cannot express one.
 *
 * SOURCE wrapped these calls in try/catch and treated "threw" and "invalid" as
 * the same outcome. That is kept: a `RangeError` from the domain is a statement
 * that the numbers are impossible, and a caller does not need to know whether
 * the objection arrived as a throw or a return.
 */
function selectionRuleOrNull(
  values: Pick<VariantGroupValues, "selectionMode" | "selectionMinimum" | "selectionMaximum">,
): VariantSelectionRule | null {
  try {
    return selectionRuleFrom(values);
  } catch {
    return null;
  }
}

/** The bounds a mode starts with when it is first chosen (SOURCE's defaults). */
export function selectionFieldsForMode(
  mode: VariantSelectionMode,
  totalOptions: number,
): { readonly selectionMinimum?: number; readonly selectionMaximum?: number } {
  if (mode === "optional-unlimited") return {};
  if (mode === "optional-maximum") {
    return { selectionMaximum: totalOptions > 0 ? 1 : undefined };
  }
  if (mode === "exact" || mode === "minimum") {
    return { selectionMinimum: totalOptions > 0 ? 1 : undefined };
  }

  return {
    selectionMinimum: totalOptions > 0 ? 1 : undefined,
    selectionMaximum: totalOptions > 0 ? totalOptions : undefined,
  };
}

/**
 * Clamps the bounds to the number of options that exist, falling back to the
 * mode's defaults when they cannot be clamped at all.
 *
 * Only the bounds the current mode actually uses are returned — an
 * "optional-unlimited" group carries neither, and returning a stale minimum
 * would let it reappear when the mode changed back.
 */
export function normalizeSelectionFields(
  values: Pick<VariantGroupValues, "selectionMode" | "selectionMinimum" | "selectionMaximum">,
  totalOptions: number,
): { readonly selectionMinimum?: number; readonly selectionMaximum?: number } {
  if (totalOptions < 1) return {};

  const rule = selectionRuleOrNull(values);
  if (rule === null) {
    return selectionFieldsForMode(values.selectionMode, totalOptions);
  }

  const normalized = normalizeVariantSelectionRule(rule, totalOptions);
  const { selectionMode: mode } = values;

  return {
    selectionMinimum:
      mode === "exact" || mode === "minimum" || mode === "range"
        ? normalized.minSelections
        : undefined,
    selectionMaximum:
      mode === "optional-maximum"
        ? (normalized.maxSelections ?? undefined)
        : mode === "range"
          ? (normalized.maxSelections ?? normalized.minSelections)
          : undefined,
  };
}

/**
 * True when the group's options and selection rule can coexist.
 *
 * The rule is validated against the count of AVAILABLE options, not the total —
 * SOURCE's choice, and the strict one: a group demanding three selections when
 * only two options are orderable cannot be satisfied at the till.
 */
export function isSelectionSatisfiable(values: VariantGroupValues): boolean {
  if (values.options.length < 1) return false;

  const rule = selectionRuleOrNull(values);
  if (rule === null) return false;

  const available = values.options.filter((option) => option.available).length;
  return validateVariantSelectionRule(rule, values.options.length, available).valid;
}

// ─── Mapping ─────────────────────────────────────────────────────────────────

export function defaultVariantOptionValues(optionId: string): VariantOptionValues {
  return { id: optionId, name: "", priceAmount: 0, available: true };
}

export function defaultVariantGroupValues(optionId: string): VariantGroupValues {
  return {
    name: "",
    description: "",
    visible: true,
    connectedMenuIds: [],
    options: [defaultVariantOptionValues(optionId)],
    selectionMode: "optional-unlimited",
  };
}

export function variantGroupToValues(
  group: MenuVariantGroup,
  connectedMenuIds: readonly string[] = [],
): VariantGroupValues {
  const mode = deriveVariantSelectionMode(group.selection);

  return {
    name: group.name,
    description: group.description,
    visible: group.visibility === "visible",
    connectedMenuIds,
    options: group.options.map((option) => ({
      id: option.id,
      name: option.name,
      priceAmount: option.priceAdjustment.amount,
      available: option.availability.status === "available",
    })),
    selectionMode: mode,
    selectionMinimum:
      mode === "exact" || mode === "minimum" || mode === "range"
        ? group.selection.minSelections
        : undefined,
    selectionMaximum:
      mode === "optional-maximum" || mode === "range"
        ? (group.selection.maxSelections ?? undefined)
        : undefined,
  };
}

/**
 * One option back into storable form.
 *
 * `sortOrder` is the array index, so reordering in the editor is what defines
 * order. `inventory` is looked up from the baseline and preserved: the editor
 * has no field for per-option stock, and rebuilding without it would silently
 * reset a tracked option to untracked.
 */
function toStoredOption(
  value: VariantOptionValues,
  index: number,
  baseline: MenuVariantGroup | null,
): MenuVariantOption {
  const existing = baseline?.options.find((option) => option.id === value.id);

  return {
    id: value.id,
    name: value.name.trim(),
    priceAdjustment: { amount: value.priceAmount, currency: "IDR" },
    availability: value.available
      ? { status: "available" }
      : { status: "unavailable", unavailableUntil: null },
    inventory: existing?.inventory ?? { mode: "untracked" },
    sortOrder: index,
  };
}

export function valuesToVariantGroup(
  values: VariantGroupValues,
  baseline: MenuVariantGroup | null,
  sortOrder: number,
): Omit<MenuVariantGroup, "id"> {
  return {
    name: values.name.trim(),
    description: values.description.trim(),
    visibility: values.visible ? "visible" : "hidden",
    selection: selectionRuleFrom(values),
    options: values.options.map((option, index) => toStoredOption(option, index, baseline)),
    sortOrder,
  };
}

// ─── Connections ─────────────────────────────────────────────────────────────

export function connectedMenuIds(
  menus: readonly MenuItem[],
  variantGroupId: string,
): readonly string[] {
  return menus
    .filter((menu) => menu.variantGroupIds.includes(variantGroupId))
    .map((menu) => menu.id);
}

/**
 * The minimum set of menu updates that makes the attachment list true.
 *
 * Only menus whose state actually differs are returned, so saving a group
 * without touching its attachments writes no menus at all.
 */
export function connectionChanges(
  menus: readonly MenuItem[],
  variantGroupId: string,
  selectedMenuIds: readonly string[],
): readonly { readonly menuId: string; readonly variantGroupIds: readonly string[] }[] {
  const selected = new Set(selectedMenuIds);

  return menus.flatMap((menu) => {
    const isConnected = menu.variantGroupIds.includes(variantGroupId);
    const shouldConnect = selected.has(menu.id);
    if (isConnected === shouldConnect) return [];

    return [
      {
        menuId: menu.id,
        variantGroupIds: shouldConnect
          ? [...menu.variantGroupIds, variantGroupId]
          : menu.variantGroupIds.filter((id) => id !== variantGroupId),
      },
    ];
  });
}

// ─── Validation ──────────────────────────────────────────────────────────────

const TOO_LONG = "too_long";
const UNSATISFIABLE = "selection-unsatisfiable";
const LAST_OPTION = "last-option";

function tooLong(path: string, limit: number): OperationIssue {
  return operationIssue(TOO_LONG, `${path} must be at most ${limit} characters`, path, { limit });
}

/** True for a trimmed, non-empty name and a non-negative whole price. */
export function isQuickEditValid(edit: VariantOptionQuickEdit): boolean {
  return (
    edit.name.trim().length > 0 &&
    Number.isInteger(edit.priceAmount) &&
    edit.priceAmount >= 0
  );
}

export function validateVariantGroupDraft(
  values: VariantGroupValues,
): readonly OperationIssue[] {
  const issues: OperationIssue[] = [];
  const name = values.name.trim();

  if (name.length === 0) {
    issues.push(operationIssue("required", "name is required", "name"));
  }
  if (name.length > VARIANT_GROUP_NAME_MAX_LENGTH) {
    issues.push(tooLong("name", VARIANT_GROUP_NAME_MAX_LENGTH));
  }

  if (values.options.length === 0) {
    issues.push(operationIssue("required", "a group needs at least one option", "options"));
  }

  values.options.forEach((option, index) => {
    const optionName = option.name.trim();
    if (optionName.length === 0) {
      issues.push(operationIssue("required", "name is required", `options.${index}.name`));
    }
    if (optionName.length > VARIANT_OPTION_NAME_MAX_LENGTH) {
      issues.push(tooLong(`options.${index}.name`, VARIANT_OPTION_NAME_MAX_LENGTH));
    }
    if (!Number.isInteger(option.priceAmount) || option.priceAmount < 0) {
      issues.push(
        operationIssue(
          "invalid_money",
          "price adjustment must be a whole amount of at least zero",
          `options.${index}.priceAmount`,
        ),
      );
    }
  });

  if (values.options.length > 0 && !isSelectionSatisfiable(values)) {
    issues.push(
      operationIssue(
        UNSATISFIABLE,
        "the selection rule cannot be satisfied by the available options",
        "selection",
      ),
    );
  }

  return issues;
}

// ─── Store access ────────────────────────────────────────────────────────────

const NO_STORE = "no-catalog-store";
const STORE_FAILED = "catalog-store-failed";
const NOT_FOUND = "not-found";
const CONNECTION_FAILED = "connection-failed";

function noStore<TValue>(operation: string): OperationResult<TValue> {
  return operationFailure("unsatisfied-dependency", [
    operationIssue(
      NO_STORE,
      "No catalog store is connected, so variant groups cannot be managed.",
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

function nextSortOrder(entities: readonly { readonly sortOrder: number }[]): number {
  return entities.reduce((highest, entity) => Math.max(highest, entity.sortOrder), -1) + 1;
}

function variantManagementOverStore(store: MenuCatalogPort): VariantManagement {
  /**
   * Applies a transform to a group's options and writes the result.
   *
   * Read-modify-write, as SOURCE did — the port exposes no partial-option
   * update, so the whole array goes back. Every caller passes through
   * `guard` first, which is where the group's invariant is enforced.
   */
  async function mutateOptions(
    operation: string,
    groupId: string,
    optionId: string,
    transform: (group: MenuVariantGroup) => readonly MenuVariantOption[],
    guard?: (group: MenuVariantGroup) => OperationIssue | undefined,
  ): Promise<OperationResult<MenuVariantGroup>> {
    try {
      const group = await store.getVariantGroupById(groupId);
      if (group === null) {
        return notFound(operation, groupId);
      }
      if (!group.options.some((option) => option.id === optionId)) {
        return notFound(operation, optionId);
      }

      const objection = guard?.(group);
      if (objection !== undefined) {
        return operationFailure("conflict", [objection]);
      }

      const updated = await store.updateVariantGroup(groupId, { options: transform(group) });
      return updated === null ? notFound(operation, groupId) : operationSuccess(updated);
    } catch (error) {
      return storeFailed(operation, error);
    }
  }

  function replaceOption(
    group: MenuVariantGroup,
    optionId: string,
    patch: Partial<MenuVariantOption>,
  ): readonly MenuVariantOption[] {
    return group.options.map((option) =>
      option.id === optionId ? { ...option, ...patch } : option,
    );
  }

  return {
    async startVariantGroupDraft(): Promise<OperationResult<VariantGroupDraft>> {
      try {
        return operationSuccess({
          baseline: null,
          values: defaultVariantGroupValues(store.newId("variant-option")),
          menus: await store.listMenus(),
        });
      } catch (error) {
        return storeFailed("startVariantGroupDraft", error);
      }
    },

    async loadVariantGroupDraft(
      variantGroupId: string,
    ): Promise<OperationResult<VariantGroupDraft>> {
      try {
        const [group, menus] = await Promise.all([
          store.getVariantGroupById(variantGroupId),
          store.listMenus(),
        ]);
        if (group === null) {
          return notFound("loadVariantGroupDraft", variantGroupId);
        }

        return operationSuccess({
          baseline: group,
          values: variantGroupToValues(group, connectedMenuIds(menus, variantGroupId)),
          menus,
        });
      } catch (error) {
        return storeFailed("loadVariantGroupDraft", error);
      }
    },

    /**
     * Writes the group, then reconciles its menu attachments.
     *
     * The two phases are not atomic, and this reports what SOURCE hid: if some
     * menu updates fail, the group IS saved and the result is `degraded` naming
     * the menus left out of sync. SOURCE threw on the first failure, so the
     * remaining menus were never even attempted and the caller learned only
     * that "something" went wrong.
     */
    async saveVariantGroup({
      variantGroupId,
      values,
    }: SaveVariantGroupInput): Promise<OperationResult<VariantGroupSaveResult>> {
      try {
        const issues = validateVariantGroupDraft(values);
        if (issues.length > 0) {
          return operationFailure("invalid-input", issues);
        }

        const baseline =
          variantGroupId === null ? null : await store.getVariantGroupById(variantGroupId);
        if (variantGroupId !== null && baseline === null) {
          return notFound("saveVariantGroup", variantGroupId);
        }

        const sortOrder =
          baseline?.sortOrder ?? nextSortOrder(await store.listVariantGroups());
        const input = valuesToVariantGroup(values, baseline, sortOrder);

        const group =
          variantGroupId === null
            ? await store.createVariantGroup(input)
            : await store.updateVariantGroup(variantGroupId, input);
        if (group === null) {
          return notFound("saveVariantGroup", variantGroupId ?? "");
        }

        // Phase two. Each menu is attempted even if an earlier one failed, so a
        // single missing menu cannot strand the rest.
        const menus = await store.listMenus();
        const changes = connectionChanges(menus, group.id, values.connectedMenuIds);
        const failedMenuIds: string[] = [];

        for (const change of changes) {
          try {
            const updated = await store.updateMenu(change.menuId, {
              variantGroupIds: change.variantGroupIds,
            });
            if (updated === null) {
              failedMenuIds.push(change.menuId);
            }
          } catch {
            failedMenuIds.push(change.menuId);
          }
        }

        return operationDegraded(
          { group, failedMenuIds },
          failedMenuIds.map((menuId) =>
            operationIssue(
              CONNECTION_FAILED,
              `The group was saved, but menu ${menuId} could not be updated, so its ` +
                "variant attachment is out of sync.",
              menuId,
            ),
          ),
        );
      } catch (error) {
        return storeFailed("saveVariantGroup", error);
      }
    },

    /**
     * Deletes the group without stripping its id from any menu, as SOURCE did.
     *
     * Menus keep a dangling `variantGroupIds` entry, which POS notices at read
     * time. Cleaning up here would be a new rule rather than a ported one, and
     * it would also make this child the owner of a second write path over menus.
     */
    async deleteVariantGroup(variantGroupId: string): Promise<OperationResult<string>> {
      try {
        const deleted = await store.deleteVariantGroup(variantGroupId);
        return deleted
          ? operationSuccess(variantGroupId)
          : notFound("deleteVariantGroup", variantGroupId);
      } catch (error) {
        return storeFailed("deleteVariantGroup", error);
      }
    },

    async updateVariantOption(
      variantGroupId: string,
      optionId: string,
      edit: VariantOptionQuickEdit,
    ): Promise<OperationResult<MenuVariantGroup>> {
      if (!isQuickEditValid(edit)) {
        return operationFailure("invalid-input", [
          operationIssue(
            "invalid-input",
            "an option needs a name and a whole price of at least zero",
            optionId,
          ),
        ]);
      }

      return mutateOptions("updateVariantOption", variantGroupId, optionId, (group) =>
        replaceOption(group, optionId, {
          name: edit.name.trim(),
          priceAdjustment: { amount: edit.priceAmount, currency: "IDR" },
        }),
      );
    },

    /**
     * Turning an option off can make the rule unsatisfiable just as deleting it
     * can, because the rule is validated against AVAILABLE options — so this is
     * guarded too, not only the delete.
     */
    async setVariantOptionAvailability(
      variantGroupId: string,
      optionId: string,
      available: boolean,
    ): Promise<OperationResult<MenuVariantGroup>> {
      return mutateOptions(
        "setVariantOptionAvailability",
        variantGroupId,
        optionId,
        (group) =>
          replaceOption(group, optionId, {
            availability: available
              ? { status: "available" }
              : { status: "unavailable", unavailableUntil: null },
          }),
        (group) => {
          if (available) return undefined;
          const after = variantGroupToValues({
            ...group,
            options: replaceOption(group, optionId, {
              availability: { status: "unavailable", unavailableUntil: null },
            }),
          });
          return isSelectionSatisfiable(after)
            ? undefined
            : operationIssue(
                UNSATISFIABLE,
                "Turning this option off would leave the group's selection rule " +
                  "impossible to satisfy.",
                optionId,
              );
        },
      );
    },

    /**
     * The fix flagged before this slice.
     *
     * SOURCE filtered the option out and wrote the array straight back, never
     * consulting the selection rule — so deleting an option could leave a group
     * demanding more selections than it had options, or no options at all. The
     * "at least one option" rule existed, but only as a disabled button in the
     * form, which is not where a rule can live (LOGIC §13). Both cases are now
     * refused as conflicts, using the same satisfiability check the editor uses.
     */
    async deleteVariantOption(
      variantGroupId: string,
      optionId: string,
    ): Promise<OperationResult<MenuVariantGroup>> {
      return mutateOptions(
        "deleteVariantOption",
        variantGroupId,
        optionId,
        (group) => group.options.filter((option) => option.id !== optionId),
        (group) => {
          const remaining = group.options.filter((option) => option.id !== optionId);
          if (remaining.length === 0) {
            return operationIssue(
              LAST_OPTION,
              "A variant group must keep at least one option; delete the group instead.",
              optionId,
            );
          }

          const after = variantGroupToValues({ ...group, options: remaining });
          return isSelectionSatisfiable(after)
            ? undefined
            : operationIssue(
                UNSATISFIABLE,
                "Deleting this option would leave the group's selection rule impossible " +
                  "to satisfy. Lower the required number of selections first.",
                optionId,
              );
        },
      );
    },
  };
}

function variantManagementWithoutStore(): VariantManagement {
  return {
    startVariantGroupDraft: async () => noStore("startVariantGroupDraft"),
    loadVariantGroupDraft: async () => noStore("loadVariantGroupDraft"),
    saveVariantGroup: async () => noStore("saveVariantGroup"),
    deleteVariantGroup: async () => noStore("deleteVariantGroup"),
    updateVariantOption: async () => noStore("updateVariantOption"),
    setVariantOptionAvailability: async () => noStore("setVariantOptionAvailability"),
    deleteVariantOption: async () => noStore("deleteVariantOption"),
  };
}

export function createVariantManagement(context: LogicChildContext): VariantManagement {
  const store = context.ports.resolve(MENU_CATALOG_PORT);

  if (store === undefined) {
    context.diagnostics.report({
      code: "missing-dependency",
      severity: severityForCode("missing-dependency"),
      message:
        "No catalog store was supplied to the Menu area, so variant management returns a " +
        "normalized failure. The capability is published and callers stay working.",
      childId: context.childId,
      engineId: context.parentId,
      source: "variantManagementChild",
    });
  }

  const capability =
    store === undefined ? variantManagementWithoutStore() : variantManagementOverStore(store);

  context.capabilities.provide(VARIANT_MANAGEMENT, capability);

  return capability;
}

export default defineLogicChild<VariantManagement>({
  id: VARIANT_MANAGEMENT_ID,
  parentId: MENU_ENGINE_ID,
  provides: [VARIANT_MANAGEMENT_ID],
  requires: [],
  create: createVariantManagement,
});
