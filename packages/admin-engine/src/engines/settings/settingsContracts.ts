// packages/admin-engine/src/engines/settings/settingsContracts.ts
//
// Transport-neutral Settings contracts. Values may describe presentation
// preferences, but no contract names a component, route, icon, CSS class, or
// browser API. Concrete persistence belongs to composition-supplied ports.

import { DEFAULT_REPORTING_TIME_ZONE, type SalesSchedule, type Weekday } from "@warungmeng/domain";
import type { OperationResult } from "@warungmeng/module-system";
import { createCapabilityToken, createOutboundPortToken } from "@warungmeng/module-system";

// ─── Theme preference ───────────────────────────────────────────────────────

export const ADMIN_THEME_SCHEMA_VERSION = 2 as const;

export type AdminThemeMode = "default" | "custom";
export type AdminThemeDensity = "normal" | "compact";
export type AdminThemeFontSize = 14 | 16 | 18;
export type AdminThemeTextColorMode = "auto" | "manual";

export interface AdminCustomThemePreference {
  readonly colorPrimary: string;
  readonly colorBgBase: string;
  readonly textColorMode: AdminThemeTextColorMode;
  readonly colorTextBase: string;
  readonly fontSize: AdminThemeFontSize;
  readonly density: AdminThemeDensity;
  readonly borderRadius: number;
}

export interface AdminThemePreference {
  readonly schemaVersion: typeof ADMIN_THEME_SCHEMA_VERSION;
  readonly mode: AdminThemeMode;
  readonly custom: AdminCustomThemePreference;
}

export const DEFAULT_ADMIN_CUSTOM_THEME_PREFERENCE: AdminCustomThemePreference = {
  colorPrimary: "#d99a27",
  colorBgBase: "#181a1b",
  textColorMode: "auto",
  colorTextBase: "#f0ede7",
  fontSize: 16,
  density: "normal",
  borderRadius: 4,
};

export const DEFAULT_ADMIN_THEME_PREFERENCE: AdminThemePreference = {
  schemaVersion: ADMIN_THEME_SCHEMA_VERSION,
  mode: "default",
  custom: DEFAULT_ADMIN_CUSTOM_THEME_PREFERENCE,
};

/**
 * The adapter returns unknown persisted data so validation and schema migration
 * cannot be bypassed by a concrete storage implementation.
 */
export interface ThemePreferencePort {
  load(): Promise<unknown | null>;
  save(preference: AdminThemePreference): Promise<void>;
}

export const THEME_PREFERENCE_PORT = createOutboundPortToken<ThemePreferencePort>(
  "admin.settings.theme-preference-store",
);

export interface ThemePreference {
  loadPreference(): Promise<OperationResult<AdminThemePreference>>;
  savePreference(preference: AdminThemePreference): Promise<OperationResult<AdminThemePreference>>;
}

export const THEME_PREFERENCE_ID = "admin.settings.theme-preference";
export const THEME_PREFERENCE = createCapabilityToken<ThemePreference>(THEME_PREFERENCE_ID);

export const THEME_PREFERENCE_ISSUE = {
  noStore: "no-theme-preference-store",
  storeFailed: "theme-preference-store-failed",
  invalid: "invalid-theme-preference",
  migrated: "theme-preference-migrated",
} as const;

// ─── Business hours ─────────────────────────────────────────────────────────

export const BUSINESS_HOURS_TIME_ZONE = DEFAULT_REPORTING_TIME_ZONE;
export const BUSINESS_HOURS_WEEKDAYS: readonly Weekday[] = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
];
export const BUSINESS_HOURS_DEFAULT_RANGE = { start: "09:00", end: "17:00" } as const;
export const BUSINESS_HOURS_MAX_SPECIAL_SCHEDULES = 5;

export interface BusinessTimeRange {
  readonly id: string;
  readonly start: string;
  readonly end: string;
}

export interface BusinessDaySchedule {
  readonly weekday: Weekday;
  readonly open: boolean;
  readonly ranges: readonly BusinessTimeRange[];
}

export interface SpecialBusinessSchedule {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly startDate: string;
  readonly endDate: string;
  readonly days: readonly BusinessDaySchedule[];
}

export interface OutletBusinessHours {
  readonly id: string;
  readonly name: string;
  readonly regular: readonly BusinessDaySchedule[];
  readonly specials: readonly SpecialBusinessSchedule[];
}

/** Backend-owned outlet schedule persistence; outlet creation is out of scope. */
export interface BusinessHoursPort {
  listOutlets(): Promise<readonly OutletBusinessHours[]>;
  /** Null means the outlet did not exist at the authoritative write. */
  saveOutlet(schedule: OutletBusinessHours): Promise<OutletBusinessHours | null>;
}

export const BUSINESS_HOURS_PORT = createOutboundPortToken<BusinessHoursPort>(
  "admin.settings.business-hours-store",
);

export interface EvaluateBusinessAvailabilityInput {
  readonly outletId: string;
  readonly occurredAt: string;
  /** Optional because the Settings view can ask only whether the outlet is open. */
  readonly salesSchedule?: SalesSchedule;
}

export interface BusinessAvailability {
  readonly outletId: string;
  readonly occurredAt: string;
  readonly timeZone: typeof BUSINESS_HOURS_TIME_ZONE;
  readonly date: string;
  readonly weekday: Weekday;
  readonly minuteOfDay: number;
  readonly scheduleSource: "regular" | "special";
  readonly specialScheduleId: string | null;
  readonly outletOpen: boolean;
  readonly salesScheduleActive: boolean;
  readonly available: boolean;
}

export interface BusinessHours {
  listOutlets(): Promise<OperationResult<readonly OutletBusinessHours[]>>;
  getOutlet(outletId: string): Promise<OperationResult<OutletBusinessHours>>;
  saveOutlet(schedule: OutletBusinessHours): Promise<OperationResult<OutletBusinessHours>>;
  evaluateAvailability(
    input: EvaluateBusinessAvailabilityInput,
  ): Promise<OperationResult<BusinessAvailability>>;
}

export const BUSINESS_HOURS_ID = "admin.settings.business-hours";
export const BUSINESS_HOURS = createCapabilityToken<BusinessHours>(BUSINESS_HOURS_ID);

export const BUSINESS_HOURS_ISSUE = {
  noStore: "no-business-hours-store",
  storeFailed: "business-hours-store-failed",
  outletNotFound: "business-hours-outlet-not-found",
  invalidOutlet: "invalid-business-hours-outlet",
  invalidWeekday: "invalid-business-hours-weekday",
  duplicateWeekday: "duplicate-business-hours-weekday",
  invalidRangeId: "invalid-business-hours-range-id",
  duplicateRangeId: "duplicate-business-hours-range-id",
  invalidTime: "invalid-business-hours-time",
  invalidRangeOrder: "invalid-business-hours-range-order",
  duplicateRange: "duplicate-business-hours-range",
  overlappingRange: "overlapping-business-hours-range",
  openWithoutRange: "business-hours-open-without-range",
  tooManySpecials: "too-many-special-business-schedules",
  invalidSpecial: "invalid-special-business-schedule",
  duplicateSpecialId: "duplicate-special-business-schedule-id",
  invalidDate: "invalid-special-business-date",
  overlappingSpecial: "overlapping-special-business-schedule",
  invalidTimestamp: "invalid-business-hours-timestamp",
} as const;
