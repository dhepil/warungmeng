// packages/admin-engine/src/engines/settings/settingsContracts.ts
//
// Transport-neutral Settings contracts. Values may describe presentation
// preferences, but no contract names a component, route, icon, CSS class, or
// browser API. Concrete persistence belongs to composition-supplied ports.

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
