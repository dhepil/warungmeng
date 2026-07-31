import { describe, expect, it } from "vitest";
import { defineLogicChild } from "@warungmeng/module-system";
import type { AdminEngineSnapshot } from "../../../../adminEngineContracts";
import { createAdminEngine } from "../../../../createAdminEngine";
import type {
  AdminThemePreference,
  ThemePreference,
  ThemePreferencePort,
} from "../../settingsContracts";
import {
  DEFAULT_ADMIN_THEME_PREFERENCE,
  THEME_PREFERENCE,
  THEME_PREFERENCE_ID,
  THEME_PREFERENCE_ISSUE,
  THEME_PREFERENCE_PORT,
} from "../../settingsContracts";
import settingsEngine from "../../settingsEngine";
import themePreferenceChild from "./themePreferenceChild";

const CUSTOM_THEME: AdminThemePreference = {
  schemaVersion: 2,
  mode: "custom",
  custom: {
    colorPrimary: "#2F9E8F",
    colorBgBase: "#101820",
    textColorMode: "manual",
    colorTextBase: "#F2EADF",
    fontSize: 18,
    density: "compact",
    borderRadius: 8,
  },
};

interface MutableThemePort extends ThemePreferencePort {
  readonly saved: () => unknown | null;
  readonly saveCount: () => number;
}

function portWith(seed: unknown | null = null): MutableThemePort {
  let value = seed;
  let saves = 0;
  return {
    load: async () => value,
    save: async (preference) => {
      saves += 1;
      value = preference;
    },
    saved: () => value,
    saveCount: () => saves,
  };
}

function runtimeWith(port?: ThemePreferencePort): {
  readonly preference: ThemePreference | undefined;
  readonly snapshot: AdminEngineSnapshot;
  readonly dispose: () => void;
} {
  let captured: ThemePreference | undefined;

  const probe = defineLogicChild({
    id: "admin.settings.theme-test-probe",
    parentId: settingsEngine.id,
    requires: [THEME_PREFERENCE_ID],
    create(context) {
      const resolution = context.capabilities.resolve(THEME_PREFERENCE);
      if (resolution.status === "available") captured = resolution.value;
      return undefined;
    },
  });

  const runtime = createAdminEngine({
    definitions: { engines: [settingsEngine], children: [themePreferenceChild, probe] },
    ports: {
      resolve: (token) =>
        token.id === THEME_PREFERENCE_PORT.id && port !== undefined ? (port as never) : undefined,
    },
  });

  return {
    preference: captured,
    snapshot: runtime.getSnapshot(),
    dispose: runtime.dispose,
  };
}

describe("theme-preference as a logic child", () => {
  it("publishes the Settings gate capability with no requirements", () => {
    expect(themePreferenceChild.id).toBe("admin.settings.theme-preference");
    expect(themePreferenceChild.parentId).toBe("admin.settings");
    expect(themePreferenceChild.provides).toEqual([THEME_PREFERENCE_ID]);
    expect(themePreferenceChild.requires).toEqual([]);
  });

  it("is active and reachable through a requiring probe", () => {
    const { preference, snapshot, dispose } = runtimeWith(portWith());
    const area = snapshot.areas.find((entry) => entry.area === "settings");

    expect(area?.failedChildIds).toEqual([]);
    expect(area?.unavailableChildIds).toEqual([]);
    expect(snapshot.runtime.capabilities).toContain(THEME_PREFERENCE_ID);
    expect(preference).toBeDefined();
    dispose();
  });

  it("stays active without a port, reports once, and normalizes every call", async () => {
    const { preference, snapshot, dispose } = runtimeWith();
    const reports = snapshot.diagnostics.filter(
      (entry) => entry.code === "missing-dependency" && entry.source === "themePreferenceChild",
    );
    const loaded = await preference?.loadPreference();
    const saved = await preference?.savePreference(CUSTOM_THEME);

    expect(reports).toHaveLength(1);
    expect(loaded?.status).toBe("failure");
    expect(saved?.status).toBe("failure");
    expect(saved?.status === "failure" && saved.issues[0]?.code).toBe(
      THEME_PREFERENCE_ISSUE.noStore,
    );
    dispose();
  });

  it("loads the built-in preference when persistence is empty", async () => {
    const { preference, dispose } = runtimeWith(portWith());
    const loaded = await preference?.loadPreference();

    expect(loaded).toEqual({ status: "success", value: DEFAULT_ADMIN_THEME_PREFERENCE });
    dispose();
  });

  it("normalizes valid persisted colors", async () => {
    const { preference, dispose } = runtimeWith(portWith(CUSTOM_THEME));
    const loaded = await preference?.loadPreference();

    expect(loaded?.status).toBe("success");
    expect(loaded?.status === "success" && loaded.value.custom.colorPrimary).toBe("#2f9e8f");
    expect(loaded?.status === "success" && loaded.value.custom.colorTextBase).toBe("#f2eadf");
    dispose();
  });

  it("migrates schema version 1 without discarding its custom values", async () => {
    const legacy = {
      schemaVersion: 1,
      mode: "custom",
      custom: {
        colorPrimary: "#2F9E8F",
        colorBgBase: "#101820",
        fontSize: 18,
        density: "compact",
        borderRadius: 8,
      },
    };
    const { preference, dispose } = runtimeWith(portWith(legacy));
    const loaded = await preference?.loadPreference();

    expect(loaded?.status).toBe("degraded");
    expect(loaded?.status === "degraded" && loaded.issues[0]?.code).toBe(
      THEME_PREFERENCE_ISSUE.migrated,
    );
    expect(loaded?.status === "degraded" && loaded.value).toMatchObject({
      schemaVersion: 2,
      mode: "custom",
      custom: { colorPrimary: "#2f9e8f", textColorMode: "auto" },
    });
    dispose();
  });

  it("degrades to the built-in preference for malformed persisted data", async () => {
    const malformed = { ...CUSTOM_THEME, custom: { ...CUSTOM_THEME.custom, borderRadius: 40 } };
    const { preference, dispose } = runtimeWith(portWith(malformed));
    const loaded = await preference?.loadPreference();

    expect(loaded?.status).toBe("degraded");
    expect(loaded?.status === "degraded" && loaded.issues[0]?.code).toBe(
      THEME_PREFERENCE_ISSUE.invalid,
    );
    expect(loaded?.status === "degraded" && loaded.value).toEqual(DEFAULT_ADMIN_THEME_PREFERENCE);
    dispose();
  });

  it("validates and normalizes before one persistence write", async () => {
    const port = portWith();
    const { preference, dispose } = runtimeWith(port);
    const saved = await preference?.savePreference(CUSTOM_THEME);

    expect(saved?.status).toBe("success");
    expect(saved?.status === "success" && saved.value.custom.colorPrimary).toBe("#2f9e8f");
    expect(port.saveCount()).toBe(1);
    expect(port.saved()).toEqual(saved?.status === "success" ? saved.value : undefined);
    dispose();
  });

  it("rejects an invalid save without touching persistence", async () => {
    const port = portWith();
    const { preference, dispose } = runtimeWith(port);
    const invalid = {
      ...CUSTOM_THEME,
      custom: { ...CUSTOM_THEME.custom, borderRadius: 40 },
    } as AdminThemePreference;
    const saved = await preference?.savePreference(invalid);

    expect(saved?.status).toBe("failure");
    expect(saved?.status === "failure" && saved.reason).toBe("invalid-input");
    expect(port.saveCount()).toBe(0);
    dispose();
  });

  it("keeps the built-in preference usable when loading persistence fails", async () => {
    const failing: ThemePreferencePort = {
      load: async () => {
        throw new Error("storage denied");
      },
      save: async () => undefined,
    };
    const { preference, dispose } = runtimeWith(failing);
    const loaded = await preference?.loadPreference();

    expect(loaded?.status).toBe("degraded");
    expect(loaded?.status === "degraded" && loaded.value).toEqual(DEFAULT_ADMIN_THEME_PREFERENCE);
    expect(loaded?.status === "degraded" && loaded.issues[0]?.message).toBe("storage denied");
    dispose();
  });

  it("returns a normalized failure when persistence rejects a save", async () => {
    const failing: ThemePreferencePort = {
      load: async () => null,
      save: async () => {
        throw new Error("quota exceeded");
      },
    };
    const { preference, dispose } = runtimeWith(failing);
    const saved = await preference?.savePreference(CUSTOM_THEME);

    expect(saved?.status).toBe("failure");
    expect(saved?.status === "failure" && saved.issues[0]?.message).toBe("quota exceeded");
    dispose();
  });
});
