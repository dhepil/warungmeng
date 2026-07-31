import { describe, expect, it } from "vitest";
import type { SalesSchedule, Weekday } from "@warungmeng/domain";
import { defineLogicChild } from "@warungmeng/module-system";
import type { AdminEngineSnapshot } from "../../../../adminEngineContracts";
import { createAdminEngine } from "../../../../createAdminEngine";
import type {
  BusinessDaySchedule,
  BusinessHours,
  BusinessHoursPort,
  BusinessTimeRange,
  OutletBusinessHours,
  SpecialBusinessSchedule,
} from "../../settingsContracts";
import {
  BUSINESS_HOURS,
  BUSINESS_HOURS_ID,
  BUSINESS_HOURS_ISSUE,
  BUSINESS_HOURS_PORT,
  BUSINESS_HOURS_TIME_ZONE,
  BUSINESS_HOURS_WEEKDAYS,
} from "../../settingsContracts";
import settingsEngine from "../../settingsEngine";
import businessHoursChild from "./businessHoursChild";

function range(id: string, start = "09:00", end = "17:00"): BusinessTimeRange {
  return { id, start, end };
}

function day(
  weekday: Weekday,
  open = true,
  ranges: readonly BusinessTimeRange[] = [range(`regular-${weekday}`)],
): BusinessDaySchedule {
  return { weekday, open, ranges };
}

function regularDays(): readonly BusinessDaySchedule[] {
  return BUSINESS_HOURS_WEEKDAYS.map((weekday) => day(weekday));
}

function outlet(overrides: Partial<OutletBusinessHours> = {}): OutletBusinessHours {
  return {
    id: "wm-1",
    name: "WARUNG MENG",
    regular: regularDays(),
    specials: [],
    ...overrides,
  };
}

function special(overrides: Partial<SpecialBusinessSchedule> = {}): SpecialBusinessSchedule {
  return {
    id: "special-1",
    name: "Holiday hours",
    enabled: true,
    startDate: "2026-08-03",
    endDate: "2026-08-03",
    days: BUSINESS_HOURS_WEEKDAYS.map((weekday) =>
      day(weekday, weekday === "mon", [range(`special-${weekday}`, "10:00", "14:00")]),
    ),
    ...overrides,
  };
}

interface MutableBusinessHoursPort extends BusinessHoursPort {
  readonly saved: () => readonly OutletBusinessHours[];
  readonly saveCount: () => number;
}

function portWith(seed: readonly OutletBusinessHours[] = [outlet()]): MutableBusinessHoursPort {
  let values = [...seed];
  let saves = 0;
  return {
    listOutlets: async () => values,
    saveOutlet: async (schedule) => {
      const index = values.findIndex((entry) => entry.id === schedule.id);
      if (index < 0) return null;
      saves += 1;
      values = values.map((entry) => (entry.id === schedule.id ? schedule : entry));
      return schedule;
    },
    saved: () => values,
    saveCount: () => saves,
  };
}

function runtimeWith(port?: BusinessHoursPort): {
  readonly hours: BusinessHours | undefined;
  readonly snapshot: AdminEngineSnapshot;
  readonly dispose: () => void;
} {
  let captured: BusinessHours | undefined;
  const probe = defineLogicChild({
    id: "admin.settings.business-hours-test-probe",
    parentId: settingsEngine.id,
    requires: [BUSINESS_HOURS_ID],
    create(context) {
      const resolution = context.capabilities.resolve(BUSINESS_HOURS);
      if (resolution.status === "available") captured = resolution.value;
      return undefined;
    },
  });
  const runtime = createAdminEngine({
    definitions: { engines: [settingsEngine], children: [businessHoursChild, probe] },
    ports: {
      resolve: (token) =>
        token.id === BUSINESS_HOURS_PORT.id && port !== undefined ? (port as never) : undefined,
    },
  });
  return { hours: captured, snapshot: runtime.getSnapshot(), dispose: runtime.dispose };
}

describe("business-hours as a logic child", () => {
  it("publishes the Settings gate capability with no requirements", () => {
    expect(businessHoursChild.id).toBe("admin.settings.business-hours");
    expect(businessHoursChild.parentId).toBe("admin.settings");
    expect(businessHoursChild.provides).toEqual([BUSINESS_HOURS_ID]);
    expect(businessHoursChild.requires).toEqual([]);
  });

  it("is active and reachable through a requiring probe", () => {
    const { hours, snapshot, dispose } = runtimeWith(portWith());
    const area = snapshot.areas.find((entry) => entry.area === "settings");

    expect(area?.failedChildIds).toEqual([]);
    expect(area?.unavailableChildIds).toEqual([]);
    expect(snapshot.runtime.capabilities).toContain(BUSINESS_HOURS_ID);
    expect(hours).toBeDefined();
    dispose();
  });

  it("stays active without a port, reports once, and normalizes every call", async () => {
    const { hours, snapshot, dispose } = runtimeWith();
    const reports = snapshot.diagnostics.filter(
      (entry) => entry.code === "missing-dependency" && entry.source === "businessHoursChild",
    );
    const input = { outletId: "wm-1", occurredAt: "2026-08-03T02:00:00.000Z" };

    expect(reports).toHaveLength(1);
    expect((await hours?.listOutlets())?.status).toBe("failure");
    expect((await hours?.getOutlet("wm-1"))?.status).toBe("failure");
    expect((await hours?.saveOutlet(outlet()))?.status).toBe("failure");
    const evaluated = await hours?.evaluateAvailability(input);
    expect(evaluated?.status).toBe("failure");
    expect(evaluated?.status === "failure" && evaluated.issues[0]?.code).toBe(
      BUSINESS_HOURS_ISSUE.noStore,
    );
    dispose();
  });

  it("lists and finds the persisted outlet while naming a miss", async () => {
    const { hours, dispose } = runtimeWith(portWith());

    expect((await hours?.listOutlets())?.status).toBe("success");
    expect((await hours?.getOutlet("wm-1"))?.status).toBe("success");
    const missing = await hours?.getOutlet("wm-2");
    expect(missing?.status).toBe("failure");
    expect(missing?.status === "failure" && missing.reason).toBe("not-found");
    dispose();
  });

  it("rejects invalid ranges before persistence", async () => {
    const port = portWith();
    const invalid = outlet({
      regular: regularDays().map((entry) =>
        entry.weekday === "mon" ? day("mon", true, [range("bad", "18:00", "09:00")]) : entry,
      ),
    });
    const { hours, dispose } = runtimeWith(port);
    const saved = await hours?.saveOutlet(invalid);

    expect(saved?.status).toBe("failure");
    expect(saved?.status === "failure" && saved.issues[0]?.code).toBe(
      BUSINESS_HOURS_ISSUE.invalidRangeOrder,
    );
    expect(port.saveCount()).toBe(0);
    dispose();
  });

  it("allows adjacent ranges, accepts 24:00 as an end, and sorts on save", async () => {
    const port = portWith();
    const unsorted = outlet({
      regular: regularDays().map((entry) =>
        entry.weekday === "mon"
          ? day("mon", true, [range("late", "12:00", "24:00"), range("early", "09:00", "12:00")])
          : entry,
      ),
    });
    const { hours, dispose } = runtimeWith(port);
    const saved = await hours?.saveOutlet(unsorted);

    expect(saved?.status).toBe("success");
    expect(
      port
        .saved()[0]
        ?.regular.find((entry) => entry.weekday === "mon")
        ?.ranges.map((entry) => entry.id),
    ).toEqual(["early", "late"]);
    dispose();
  });

  it("rejects duplicate, overlapping, and empty open-day ranges", async () => {
    const cases = [
      {
        code: BUSINESS_HOURS_ISSUE.duplicateRange,
        ranges: [range("one", "09:00", "12:00"), range("two", "09:00", "12:00")],
      },
      {
        code: BUSINESS_HOURS_ISSUE.overlappingRange,
        ranges: [range("one", "09:00", "13:00"), range("two", "12:00", "17:00")],
      },
      { code: BUSINESS_HOURS_ISSUE.openWithoutRange, ranges: [] },
    ];

    for (const candidate of cases) {
      const schedule = outlet({
        regular: regularDays().map((entry) =>
          entry.weekday === "mon" ? day("mon", true, candidate.ranges) : entry,
        ),
      });
      const { hours, dispose } = runtimeWith(portWith());
      const saved = await hours?.saveOutlet(schedule);
      expect(
        saved?.status === "failure" && saved.issues.some((issue) => issue.code === candidate.code),
      ).toBe(true);
      dispose();
    }
  });

  it("validates special names, real dates, limits, and enabled overlap", async () => {
    const candidates: Array<{ readonly schedule: OutletBusinessHours; readonly code: string }> = [
      {
        schedule: outlet({ specials: [special({ name: "" })] }),
        code: BUSINESS_HOURS_ISSUE.invalidSpecial,
      },
      {
        schedule: outlet({ specials: [special({ startDate: "2026-02-30" })] }),
        code: BUSINESS_HOURS_ISSUE.invalidDate,
      },
      {
        schedule: outlet({
          specials: [
            special(),
            special({ id: "special-2", startDate: "2026-08-03", endDate: "2026-08-04" }),
          ],
        }),
        code: BUSINESS_HOURS_ISSUE.overlappingSpecial,
      },
      {
        schedule: outlet({
          specials: Array.from({ length: 6 }, (_, index) =>
            special({
              id: `special-${index}`,
              name: `Special ${index}`,
              enabled: false,
              startDate: `2026-0${index + 1}-01`,
              endDate: `2026-0${index + 1}-02`,
              days: BUSINESS_HOURS_WEEKDAYS.map((weekday) => day(weekday, false, [])),
            }),
          ),
        }),
        code: BUSINESS_HOURS_ISSUE.tooManySpecials,
      },
    ];

    for (const candidate of candidates) {
      const { hours, dispose } = runtimeWith(portWith());
      const saved = await hours?.saveOutlet(candidate.schedule);
      expect(
        saved?.status === "failure" && saved.issues.some((issue) => issue.code === candidate.code),
      ).toBe(true);
      dispose();
    }
  });

  it("evaluates time in Jakarta and treats range end as exclusive", async () => {
    const { hours, dispose } = runtimeWith(portWith());
    const justAfterMidnight = await hours?.evaluateAvailability({
      outletId: "wm-1",
      occurredAt: "2026-08-02T17:30:00.000Z",
    });
    const opening = await hours?.evaluateAvailability({
      outletId: "wm-1",
      occurredAt: "2026-08-03T02:00:00.000Z",
    });
    const closing = await hours?.evaluateAvailability({
      outletId: "wm-1",
      occurredAt: "2026-08-03T10:00:00.000Z",
    });

    expect(justAfterMidnight?.status === "success" && justAfterMidnight.value).toMatchObject({
      timeZone: BUSINESS_HOURS_TIME_ZONE,
      date: "2026-08-03",
      weekday: "mon",
      minuteOfDay: 30,
      outletOpen: false,
    });
    expect(opening?.status === "success" && opening.value.available).toBe(true);
    expect(closing?.status === "success" && closing.value.available).toBe(false);
    dispose();
  });

  it("uses an enabled special as an override and regular hours otherwise", async () => {
    const schedule = outlet({
      regular: regularDays().map((entry) =>
        entry.weekday === "mon" ? day("mon", false, entry.ranges) : entry,
      ),
      specials: [special()],
    });
    const { hours, dispose } = runtimeWith(portWith([schedule]));
    const inSpecial = await hours?.evaluateAvailability({
      outletId: "wm-1",
      occurredAt: "2026-08-03T04:00:00.000Z",
    });
    const nextDay = await hours?.evaluateAvailability({
      outletId: "wm-1",
      occurredAt: "2026-08-04T04:00:00.000Z",
    });

    expect(inSpecial?.status === "success" && inSpecial.value).toMatchObject({
      scheduleSource: "special",
      specialScheduleId: "special-1",
      available: true,
    });
    expect(nextDay?.status === "success" && nextDay.value).toMatchObject({
      scheduleSource: "regular",
      specialScheduleId: null,
      available: true,
    });
    dispose();
  });

  it("combines outlet hours with a menu sales schedule", async () => {
    const salesSchedule: SalesSchedule = {
      mode: "scheduled",
      activeDays: ["mon"],
      allDay: false,
      intervals: [{ id: "lunch", start: "12:00", end: "13:00" }],
    };
    const { hours, dispose } = runtimeWith(portWith());
    const morning = await hours?.evaluateAvailability({
      outletId: "wm-1",
      occurredAt: "2026-08-03T03:00:00.000Z",
      salesSchedule,
    });
    const lunch = await hours?.evaluateAvailability({
      outletId: "wm-1",
      occurredAt: "2026-08-03T05:00:00.000Z",
      salesSchedule,
    });

    expect(morning?.status === "success" && morning.value).toMatchObject({
      outletOpen: true,
      salesScheduleActive: false,
      available: false,
    });
    expect(lunch?.status === "success" && lunch.value).toMatchObject({
      outletOpen: true,
      salesScheduleActive: true,
      available: true,
    });
    dispose();
  });

  it("rejects an invalid timestamp before reading persistence", async () => {
    let reads = 0;
    const port: BusinessHoursPort = {
      listOutlets: async () => {
        reads += 1;
        return [outlet()];
      },
      saveOutlet: async (schedule) => schedule,
    };
    const { hours, dispose } = runtimeWith(port);
    const evaluated = await hours?.evaluateAvailability({ outletId: "wm-1", occurredAt: "bad" });

    expect(evaluated?.status).toBe("failure");
    expect(evaluated?.status === "failure" && evaluated.reason).toBe("invalid-input");
    expect(reads).toBe(0);
    dispose();
  });

  it("normalizes store failures and an authoritative missing save", async () => {
    const failing: BusinessHoursPort = {
      listOutlets: async () => {
        throw new Error("backend offline");
      },
      saveOutlet: async () => null,
    };
    const { hours, dispose } = runtimeWith(failing);
    const listed = await hours?.listOutlets();
    const saved = await hours?.saveOutlet(outlet());

    expect(listed?.status).toBe("failure");
    expect(listed?.status === "failure" && listed.issues[0]?.message).toBe("backend offline");
    expect(saved?.status).toBe("failure");
    expect(saved?.status === "failure" && saved.reason).toBe("not-found");
    dispose();
  });
});
