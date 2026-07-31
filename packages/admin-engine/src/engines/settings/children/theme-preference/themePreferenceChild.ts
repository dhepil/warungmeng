// packages/admin-engine/src/engines/settings/children/theme-preference/themePreferenceChild.ts
//
// Versioned Admin theme preference, separated from every rendering concern.
// SOURCE stored this in localStorage through a React provider; the target keeps
// the same values and migration behavior behind an injected persistence port.

import type { LogicChildContext, OperationResult } from "@warungmeng/module-system";
import {
  defineLogicChild,
  operationDegraded,
  operationFailure,
  operationIssue,
  operationSuccess,
  severityForCode,
} from "@warungmeng/module-system";
import type {
  AdminCustomThemePreference,
  AdminThemeDensity,
  AdminThemeFontSize,
  AdminThemeMode,
  AdminThemePreference,
  AdminThemeTextColorMode,
  ThemePreference,
  ThemePreferencePort,
} from "../../settingsContracts";
import {
  ADMIN_THEME_SCHEMA_VERSION,
  DEFAULT_ADMIN_THEME_PREFERENCE,
  THEME_PREFERENCE,
  THEME_PREFERENCE_ID,
  THEME_PREFERENCE_ISSUE,
  THEME_PREFERENCE_PORT,
} from "../../settingsContracts";
import { SETTINGS_ENGINE_ID } from "../../settingsEngine";

const LEGACY_THEME_SCHEMA_VERSION = 1;
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const FONT_SIZES: readonly AdminThemeFontSize[] = [14, 16, 18];
const DENSITIES: readonly AdminThemeDensity[] = ["normal", "compact"];
const MODES: readonly AdminThemeMode[] = ["default", "custom"];
const TEXT_COLOR_MODES: readonly AdminThemeTextColorMode[] = ["auto", "manual"];

interface NormalizedThemePreference {
  readonly value: AdminThemePreference;
  readonly migrated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clonePreference(preference: AdminThemePreference): AdminThemePreference {
  return { ...preference, custom: { ...preference.custom } };
}

function normalizeColor(value: unknown): string | null {
  return typeof value === "string" && HEX_COLOR_PATTERN.test(value) ? value.toLowerCase() : null;
}

function normalizeCustom(value: unknown, legacy: boolean): AdminCustomThemePreference | null {
  if (!isRecord(value)) return null;

  const colorPrimary = normalizeColor(value.colorPrimary);
  const colorBgBase = normalizeColor(value.colorBgBase);
  const colorTextBase = legacy
    ? DEFAULT_ADMIN_THEME_PREFERENCE.custom.colorTextBase
    : normalizeColor(value.colorTextBase);
  const textColorMode = legacy
    ? DEFAULT_ADMIN_THEME_PREFERENCE.custom.textColorMode
    : TEXT_COLOR_MODES.includes(value.textColorMode as AdminThemeTextColorMode)
      ? (value.textColorMode as AdminThemeTextColorMode)
      : null;

  if (
    colorPrimary === null ||
    colorBgBase === null ||
    colorTextBase === null ||
    textColorMode === null ||
    !FONT_SIZES.includes(value.fontSize as AdminThemeFontSize) ||
    !DENSITIES.includes(value.density as AdminThemeDensity) ||
    typeof value.borderRadius !== "number" ||
    !Number.isInteger(value.borderRadius) ||
    value.borderRadius < 0 ||
    value.borderRadius > 16
  ) {
    return null;
  }

  return {
    colorPrimary,
    colorBgBase,
    textColorMode,
    colorTextBase,
    fontSize: value.fontSize as AdminThemeFontSize,
    density: value.density as AdminThemeDensity,
    borderRadius: value.borderRadius,
  };
}

/** Validates current data and migrates SOURCE schema v1 in memory. */
export function normalizeThemePreference(value: unknown): NormalizedThemePreference | null {
  if (!isRecord(value) || !MODES.includes(value.mode as AdminThemeMode)) return null;

  const legacy = value.schemaVersion === LEGACY_THEME_SCHEMA_VERSION;
  if (!legacy && value.schemaVersion !== ADMIN_THEME_SCHEMA_VERSION) return null;

  const custom = normalizeCustom(value.custom, legacy);
  if (custom === null) return null;

  return {
    migrated: legacy,
    value: {
      schemaVersion: ADMIN_THEME_SCHEMA_VERSION,
      mode: value.mode as AdminThemeMode,
      custom,
    },
  };
}

function noStore<TValue>(operation: string): OperationResult<TValue> {
  return operationFailure("unsatisfied-dependency", [
    operationIssue(
      THEME_PREFERENCE_ISSUE.noStore,
      "No theme-preference store is connected.",
      operation,
    ),
  ]);
}

function themePreferenceOverPort(port: ThemePreferencePort): ThemePreference {
  return {
    async loadPreference() {
      let persisted: unknown | null;
      try {
        persisted = await port.load();
      } catch (error) {
        return operationDegraded(clonePreference(DEFAULT_ADMIN_THEME_PREFERENCE), [
          operationIssue(
            THEME_PREFERENCE_ISSUE.storeFailed,
            error instanceof Error ? error.message : "The theme-preference store failed.",
            "loadPreference",
          ),
        ]);
      }

      if (persisted === null) {
        return operationSuccess(clonePreference(DEFAULT_ADMIN_THEME_PREFERENCE));
      }

      const normalized = normalizeThemePreference(persisted);
      if (normalized === null) {
        return operationDegraded(clonePreference(DEFAULT_ADMIN_THEME_PREFERENCE), [
          operationIssue(
            THEME_PREFERENCE_ISSUE.invalid,
            "Stored theme preference is invalid; the built-in preference is used.",
            "loadPreference",
          ),
        ]);
      }

      return normalized.migrated
        ? operationDegraded(normalized.value, [
            operationIssue(
              THEME_PREFERENCE_ISSUE.migrated,
              "Stored theme preference was migrated to schema version 2.",
              "loadPreference",
            ),
          ])
        : operationSuccess(normalized.value);
    },

    async savePreference(preference) {
      const normalized = normalizeThemePreference(preference);
      if (normalized === null) {
        return operationFailure("invalid-input", [
          operationIssue(
            THEME_PREFERENCE_ISSUE.invalid,
            "Theme preference does not satisfy the supported schema.",
            "savePreference",
          ),
        ]);
      }

      try {
        await port.save(normalized.value);
        return operationSuccess(normalized.value);
      } catch (error) {
        return operationFailure("failed", [
          operationIssue(
            THEME_PREFERENCE_ISSUE.storeFailed,
            error instanceof Error ? error.message : "The theme-preference store failed.",
            "savePreference",
          ),
        ]);
      }
    },
  };
}

function themePreferenceWithoutPort(): ThemePreference {
  return {
    loadPreference: async () => noStore("loadPreference"),
    savePreference: async () => noStore("savePreference"),
  };
}

export function createThemePreference(context: LogicChildContext): ThemePreference {
  const port = context.ports.resolve(THEME_PREFERENCE_PORT);

  if (port === undefined) {
    context.diagnostics.report({
      code: "missing-dependency",
      severity: severityForCode("missing-dependency"),
      message:
        "No theme-preference store was supplied, so preference operations return a normalized " +
        "failure. The capability remains published.",
      childId: context.childId,
      engineId: context.parentId,
      source: "themePreferenceChild",
    });
  }

  const capability =
    port === undefined ? themePreferenceWithoutPort() : themePreferenceOverPort(port);
  context.capabilities.provide(THEME_PREFERENCE, capability);
  return capability;
}

export default defineLogicChild<ThemePreference>({
  id: THEME_PREFERENCE_ID,
  parentId: SETTINGS_ENGINE_ID,
  provides: [THEME_PREFERENCE_ID],
  requires: [],
  create: createThemePreference,
});
