// packages/domain/src/catalog.ts
//
// Ported from SOURCE packages/domain/src/catalog/{types,validation,variantSelectionRule}.ts,
// consolidated into a single catalog module per new-target LOGIC-TARGET-FILE-TREE.md §4.
// Pure TypeScript: types, catalog validation, and variant-selection rules. No I/O, no
// framework imports. Money/CurrencyCode live here because they are catalog primitives that
// the rest of the domain (orders, inventory, finance, reporting) imports from catalog.

// ─── Types ───────────────────────────────────────────────────────────────────

export type CurrencyCode = "IDR";

export interface Money {
  readonly amount: number;
  readonly currency: CurrencyCode;
}

export type MenuVisibility = "visible" | "hidden";

export type MenuAvailability =
  | {
      readonly status: "available";
    }
  | {
      readonly status: "unavailable";
      readonly unavailableUntil: string | null;
    };

export type InventoryPolicy =
  | {
      readonly mode: "untracked";
    }
  | {
      readonly mode: "tracked";
      readonly quantity: number;
    };

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export interface SalesInterval {
  readonly id: string;
  readonly start: string;
  readonly end: string;
}

export type SalesSchedule =
  | {
      readonly mode: "always";
    }
  | {
      readonly mode: "scheduled";
      readonly activeDays: readonly Weekday[];
      readonly allDay: boolean;
      readonly intervals: readonly SalesInterval[];
    };

export interface MenuImage {
  readonly url: string;
  readonly alt: string;
}

export interface MenuCategory {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly visibility: MenuVisibility;
  readonly sortOrder: number;
}

export interface MenuItem {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly categoryId: string;
  readonly description: string;
  readonly image: MenuImage | null;
  readonly price: Money;
  readonly compareAtPrice: Money | null;
  readonly availability: MenuAvailability;
  readonly inventory: InventoryPolicy;
  readonly visibility: MenuVisibility;
  readonly salesSchedule: SalesSchedule;
  readonly variantGroupIds: readonly string[];
  readonly sortOrder: number;
}

export interface VariantSelectionRule {
  readonly minSelections: number;
  readonly maxSelections: number | null;
}

export interface MenuVariantOption {
  readonly id: string;
  readonly name: string;
  readonly priceAdjustment: Money;
  readonly availability: MenuAvailability;
  readonly inventory: InventoryPolicy;
  readonly sortOrder: number;
}

export interface MenuVariantGroup {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly visibility: MenuVisibility;
  readonly selection: VariantSelectionRule;
  readonly options: readonly MenuVariantOption[];
  readonly sortOrder: number;
}

// ─── Catalog validation ──────────────────────────────────────────────────────

export type CatalogValidationCode =
  | "required"
  | "invalid_integer"
  | "invalid_money"
  | "invalid_datetime"
  | "invalid_time"
  | "invalid_range"
  | "duplicate"
  | "overlap"
  | "too_many";

export interface CatalogValidationIssue {
  readonly path: string;
  readonly code: CatalogValidationCode;
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_SALES_INTERVALS = 3;

function required(value: string, path: string, issues: CatalogValidationIssue[]): void {
  if (value.trim().length === 0) {
    issues.push({ path, code: "required" });
  }
}

function validateSortOrder(value: number, path: string, issues: CatalogValidationIssue[]): void {
  if (!Number.isInteger(value) || value < 0) {
    issues.push({ path, code: "invalid_integer" });
  }
}

function validateMoney(value: Money, path: string, issues: CatalogValidationIssue[]): void {
  if (!Number.isInteger(value.amount) || value.amount < 0 || value.currency !== "IDR") {
    issues.push({ path, code: "invalid_money" });
  }
}

function validateInventory(
  value: InventoryPolicy,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  if (value.mode === "tracked" && (!Number.isInteger(value.quantity) || value.quantity < 0)) {
    issues.push({ path: `${path}.quantity`, code: "invalid_integer" });
  }
}

function validateAvailability(
  value: MenuAvailability,
  path: string,
  issues: CatalogValidationIssue[],
): void {
  if (
    value.status === "unavailable" &&
    value.unavailableUntil !== null &&
    Number.isNaN(Date.parse(value.unavailableUntil))
  ) {
    issues.push({ path: `${path}.unavailableUntil`, code: "invalid_datetime" });
  }
}

function validateUniqueStrings(
  values: readonly string[],
  path: string,
  issues: CatalogValidationIssue[],
): void {
  const seen = new Set<string>();

  values.forEach((value, index) => {
    required(value, `${path}.${index}`, issues);
    if (seen.has(value)) {
      issues.push({ path: `${path}.${index}`, code: "duplicate" });
    }
    seen.add(value);
  });
}

function toMinutes(value: string): number | null {
  const match = TIME_PATTERN.exec(value);
  if (!match) return null;

  return Number(match[1]) * 60 + Number(match[2]);
}

function validateIntervals(
  intervals: readonly SalesInterval[],
  path: string,
  issues: CatalogValidationIssue[],
): void {
  if (intervals.length === 0) {
    issues.push({ path, code: "required" });
    return;
  }

  if (intervals.length > MAX_SALES_INTERVALS) {
    issues.push({ path, code: "too_many" });
  }

  validateUniqueStrings(
    intervals.map((interval) => interval.id),
    `${path}.id`,
    issues,
  );

  const ranges: Array<{ index: number; start: number; end: number }> = [];
  intervals.forEach((interval, index) => {
    const start = toMinutes(interval.start);
    const end = toMinutes(interval.end);

    if (start === null) {
      issues.push({ path: `${path}.${index}.start`, code: "invalid_time" });
    }
    if (end === null) {
      issues.push({ path: `${path}.${index}.end`, code: "invalid_time" });
    }
    if (start !== null && end !== null) {
      if (start >= end) {
        issues.push({ path: `${path}.${index}`, code: "invalid_range" });
      } else {
        ranges.push({ index, start, end });
      }
    }
  });

  ranges
    .sort((left, right) => left.start - right.start)
    .forEach((range, index, sortedRanges) => {
      const previous = sortedRanges[index - 1];
      if (previous && range.start < previous.end) {
        issues.push({ path: `${path}.${range.index}`, code: "overlap" });
      }
    });
}

export function validateMenuCategory(category: MenuCategory): CatalogValidationIssue[] {
  const issues: CatalogValidationIssue[] = [];
  required(category.id, "id", issues);
  required(category.name, "name", issues);
  required(category.slug, "slug", issues);
  validateSortOrder(category.sortOrder, "sortOrder", issues);
  return issues;
}

export function validateMenuItem(menu: MenuItem): CatalogValidationIssue[] {
  const issues: CatalogValidationIssue[] = [];
  required(menu.id, "id", issues);
  required(menu.name, "name", issues);
  required(menu.slug, "slug", issues);
  required(menu.categoryId, "categoryId", issues);
  validateMoney(menu.price, "price", issues);

  if (menu.compareAtPrice) {
    validateMoney(menu.compareAtPrice, "compareAtPrice", issues);
    if (menu.compareAtPrice.amount <= menu.price.amount) {
      issues.push({ path: "compareAtPrice.amount", code: "invalid_range" });
    }
  }

  validateAvailability(menu.availability, "availability", issues);
  validateInventory(menu.inventory, "inventory", issues);
  validateUniqueStrings(menu.variantGroupIds, "variantGroupIds", issues);
  validateSortOrder(menu.sortOrder, "sortOrder", issues);

  if (menu.salesSchedule.mode === "scheduled") {
    validateUniqueStrings(menu.salesSchedule.activeDays, "salesSchedule.activeDays", issues);
    if (menu.salesSchedule.activeDays.length === 0) {
      issues.push({ path: "salesSchedule.activeDays", code: "required" });
    }
    if (!menu.salesSchedule.allDay) {
      validateIntervals(menu.salesSchedule.intervals, "salesSchedule.intervals", issues);
    }
  }

  return issues;
}

export function validateMenuVariantGroup(group: MenuVariantGroup): CatalogValidationIssue[] {
  const issues: CatalogValidationIssue[] = [];
  required(group.id, "id", issues);
  required(group.name, "name", issues);
  validateSortOrder(group.sortOrder, "sortOrder", issues);

  const { minSelections, maxSelections } = group.selection;
  if (!Number.isInteger(minSelections) || minSelections < 0) {
    issues.push({ path: "selection.minSelections", code: "invalid_integer" });
  }
  if (
    maxSelections !== null &&
    (!Number.isInteger(maxSelections) || maxSelections < 0 || maxSelections < minSelections)
  ) {
    issues.push({ path: "selection.maxSelections", code: "invalid_range" });
  }

  if (group.options.length === 0) {
    issues.push({ path: "options", code: "required" });
  }
  if (maxSelections !== null && maxSelections > group.options.length) {
    issues.push({ path: "selection.maxSelections", code: "invalid_range" });
  }

  validateUniqueStrings(
    group.options.map((option) => option.id),
    "options.id",
    issues,
  );
  group.options.forEach((option, index) => {
    required(option.name, `options.${index}.name`, issues);
    validateMoney(option.priceAdjustment, `options.${index}.priceAdjustment`, issues);
    validateAvailability(option.availability, `options.${index}.availability`, issues);
    validateInventory(option.inventory, `options.${index}.inventory`, issues);
    validateSortOrder(option.sortOrder, `options.${index}.sortOrder`, issues);
  });

  return issues;
}

export function isMenuAvailable(menu: MenuItem, now: Date = new Date()): boolean {
  if (menu.inventory.mode === "tracked" && menu.inventory.quantity === 0) return false;
  if (menu.availability.status === "available") return true;
  if (menu.availability.unavailableUntil === null) return false;

  const unavailableUntil = Date.parse(menu.availability.unavailableUntil);
  return !Number.isNaN(unavailableUntil) && unavailableUntil <= now.getTime();
}

// ─── Variant selection rules ─────────────────────────────────────────────────

export type VariantSelectionMode =
  | "optional-unlimited"
  | "optional-maximum"
  | "exact"
  | "minimum"
  | "range";

export interface CreateVariantSelectionRuleInput {
  readonly mode: VariantSelectionMode;
  readonly minimum?: number;
  readonly maximum?: number;
}

export type VariantSelectionValidationCode =
  | "invalid_total_variants"
  | "invalid_available_variants"
  | "available_exceeds_total"
  | "invalid_minimum"
  | "invalid_maximum"
  | "minimum_exceeds_maximum"
  | "minimum_exceeds_total"
  | "maximum_exceeds_total"
  | "minimum_exceeds_available";

export interface VariantSelectionValidationResult {
  readonly valid: boolean;
  readonly issues: readonly VariantSelectionValidationCode[];
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function requirePositiveInteger(value: number | undefined, field: string): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive integer`);
  }

  return value;
}

function createIntegerOptions(start: number, end: number): number[] {
  if (start > end) return [];
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function deriveVariantSelectionMode(rule: VariantSelectionRule): VariantSelectionMode {
  if (rule.minSelections === 0) {
    return rule.maxSelections === null ? "optional-unlimited" : "optional-maximum";
  }

  if (rule.maxSelections === null) return "minimum";
  return rule.minSelections === rule.maxSelections ? "exact" : "range";
}

export function createVariantSelectionRule({
  mode,
  minimum,
  maximum,
}: CreateVariantSelectionRuleInput): VariantSelectionRule {
  if (mode === "optional-unlimited") {
    return { minSelections: 0, maxSelections: null };
  }

  if (mode === "optional-maximum") {
    return {
      minSelections: 0,
      maxSelections: requirePositiveInteger(maximum, "maximum"),
    };
  }

  const requiredMinimum = requirePositiveInteger(minimum, "minimum");

  if (mode === "minimum") {
    return { minSelections: requiredMinimum, maxSelections: null };
  }

  if (mode === "exact") {
    return { minSelections: requiredMinimum, maxSelections: requiredMinimum };
  }

  const requiredMaximum = requirePositiveInteger(maximum, "maximum");
  if (requiredMinimum > requiredMaximum) {
    throw new RangeError("minimum cannot exceed maximum");
  }

  return {
    minSelections: requiredMinimum,
    maxSelections: requiredMaximum,
  };
}

export function getVariantMinimumOptions(
  totalVariants: number,
  maximum: number | null = null,
): readonly number[] {
  if (!Number.isInteger(totalVariants) || totalVariants < 1) return [];
  if (maximum !== null && (!Number.isInteger(maximum) || maximum < 1)) return [];

  const upperBound = maximum === null ? totalVariants : Math.min(maximum, totalVariants);
  return createIntegerOptions(1, upperBound);
}

export function getVariantMaximumOptions(
  totalVariants: number,
  minimum: number | null = null,
): readonly number[] {
  if (!Number.isInteger(totalVariants) || totalVariants < 1) return [];
  if (minimum !== null && (!Number.isInteger(minimum) || minimum < 1)) return [];

  const lowerBound = minimum === null ? 1 : Math.min(minimum, totalVariants);
  return createIntegerOptions(lowerBound, totalVariants);
}

export function normalizeVariantSelectionRule(
  rule: VariantSelectionRule,
  totalVariants: number,
): VariantSelectionRule {
  if (!Number.isInteger(totalVariants) || totalVariants < 0) {
    throw new RangeError("totalVariants must be a non-negative integer");
  }

  if (
    totalVariants === 0 ||
    !isNonNegativeInteger(rule.minSelections) ||
    (rule.maxSelections !== null && !isNonNegativeInteger(rule.maxSelections))
  ) {
    return { ...rule };
  }

  const mode = deriveVariantSelectionMode(rule);
  if (mode === "optional-unlimited") return { minSelections: 0, maxSelections: null };

  if (mode === "optional-maximum") {
    return {
      minSelections: 0,
      maxSelections: Math.min(rule.maxSelections ?? totalVariants, totalVariants),
    };
  }

  const minimum = clamp(rule.minSelections, 1, totalVariants);
  if (mode === "minimum") {
    return { minSelections: minimum, maxSelections: null };
  }

  if (mode === "exact") {
    return { minSelections: minimum, maxSelections: minimum };
  }

  const maximum = clamp(rule.maxSelections ?? minimum, minimum, totalVariants);
  return { minSelections: minimum, maxSelections: maximum };
}

export function validateVariantSelectionRule(
  rule: VariantSelectionRule,
  totalVariants: number,
  availableVariants: number = totalVariants,
): VariantSelectionValidationResult {
  const issues: VariantSelectionValidationCode[] = [];
  const totalIsValid = isNonNegativeInteger(totalVariants);
  const availableIsValid = isNonNegativeInteger(availableVariants);
  const minimumIsValid = isNonNegativeInteger(rule.minSelections);
  const maximumIsValid = rule.maxSelections === null || isNonNegativeInteger(rule.maxSelections);

  if (!totalIsValid) issues.push("invalid_total_variants");
  if (!availableIsValid) issues.push("invalid_available_variants");
  if (!minimumIsValid) issues.push("invalid_minimum");
  if (!maximumIsValid) issues.push("invalid_maximum");

  if (totalIsValid && availableIsValid && availableVariants > totalVariants) {
    issues.push("available_exceeds_total");
  }

  if (
    minimumIsValid &&
    maximumIsValid &&
    rule.maxSelections !== null &&
    rule.minSelections > rule.maxSelections
  ) {
    issues.push("minimum_exceeds_maximum");
  }

  if (totalIsValid && minimumIsValid && rule.minSelections > totalVariants) {
    issues.push("minimum_exceeds_total");
  }

  if (
    totalIsValid &&
    maximumIsValid &&
    rule.maxSelections !== null &&
    rule.maxSelections > totalVariants
  ) {
    issues.push("maximum_exceeds_total");
  }

  if (availableIsValid && minimumIsValid && rule.minSelections > availableVariants) {
    issues.push("minimum_exceeds_available");
  }

  return { valid: issues.length === 0, issues };
}
