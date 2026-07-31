// packages/admin-engine/src/engines/settings/children/business-hours/businessHoursChild.ts
//
// Outlet business-hours validation, persistence, and Jakarta-time evaluation.
// The evaluator also accepts a menu SalesSchedule so the policy deferred from
// POS S9 has one owner without creating a Settings→Menu dependency. POS wiring
// remains a later graph decision; this child itself has no requirements.

import {
  validateReportingPeriod,
  type SalesInterval,
  type SalesSchedule,
  type Weekday,
} from "@warungmeng/domain";
import type { LogicChildContext, OperationIssue, OperationResult } from "@warungmeng/module-system";
import {
  defineLogicChild,
  operationFailure,
  operationIssue,
  operationSuccess,
  severityForCode,
} from "@warungmeng/module-system";
import type {
  BusinessAvailability,
  BusinessDaySchedule,
  BusinessHours,
  BusinessHoursPort,
  BusinessTimeRange,
  EvaluateBusinessAvailabilityInput,
  OutletBusinessHours,
  SpecialBusinessSchedule,
} from "../../settingsContracts";
import {
  BUSINESS_HOURS,
  BUSINESS_HOURS_ID,
  BUSINESS_HOURS_ISSUE,
  BUSINESS_HOURS_MAX_SPECIAL_SCHEDULES,
  BUSINESS_HOURS_PORT,
  BUSINESS_HOURS_TIME_ZONE,
  BUSINESS_HOURS_WEEKDAYS,
} from "../../settingsContracts";
import { SETTINGS_ENGINE_ID } from "../../settingsEngine";

const START_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const END_TIME_PATTERN = /^(?:([01]\d|2[0-3]):([0-5]\d)|24:00)$/;

function validText(value: string): boolean {
  return value.trim().length > 0;
}

export function businessTimeToMinutes(value: string): number {
  if (value === "24:00") return 24 * 60;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}

function validDateKey(value: string): boolean {
  try {
    validateReportingPeriod({
      startDate: value,
      endDate: value,
      timeZone: BUSINESS_HOURS_TIME_ZONE,
    });
    return true;
  } catch {
    return false;
  }
}

function validateRanges(
  ranges: readonly BusinessTimeRange[],
  path: string,
  rangeIds: Set<string>,
): readonly OperationIssue[] {
  const issues: OperationIssue[] = [];
  const valid: Array<{ readonly range: BusinessTimeRange; readonly index: number }> = [];

  ranges.forEach((range, index) => {
    const subject = `${path}.${index}`;
    if (!validText(range.id)) {
      issues.push(
        operationIssue(
          BUSINESS_HOURS_ISSUE.invalidRangeId,
          "Every business-hours range requires an id.",
          `${subject}.id`,
        ),
      );
    } else if (rangeIds.has(range.id)) {
      issues.push(
        operationIssue(
          BUSINESS_HOURS_ISSUE.duplicateRangeId,
          "Business-hours range ids must be unique within an outlet.",
          `${subject}.id`,
        ),
      );
    } else {
      rangeIds.add(range.id);
    }

    const startValid = START_TIME_PATTERN.test(range.start);
    const endValid = END_TIME_PATTERN.test(range.end);
    if (!startValid) {
      issues.push(
        operationIssue(
          BUSINESS_HOURS_ISSUE.invalidTime,
          "Range start must use HH:MM from 00:00 through 23:59.",
          `${subject}.start`,
        ),
      );
    }
    if (!endValid) {
      issues.push(
        operationIssue(
          BUSINESS_HOURS_ISSUE.invalidTime,
          "Range end must use HH:MM from 00:00 through 24:00.",
          `${subject}.end`,
        ),
      );
    }

    if (startValid && endValid) {
      if (businessTimeToMinutes(range.start) >= businessTimeToMinutes(range.end)) {
        issues.push(
          operationIssue(
            BUSINESS_HOURS_ISSUE.invalidRangeOrder,
            "Range start must be before range end.",
            subject,
          ),
        );
      } else {
        valid.push({ range, index });
      }
    }
  });

  for (let left = 0; left < valid.length; left += 1) {
    for (let right = left + 1; right < valid.length; right += 1) {
      const first = valid[left]!;
      const second = valid[right]!;
      if (first.range.start === second.range.start && first.range.end === second.range.end) {
        issues.push(
          operationIssue(
            BUSINESS_HOURS_ISSUE.duplicateRange,
            "Two ranges on one day cannot be identical.",
            `${path}.${second.index}`,
          ),
        );
      }
    }
  }

  const sorted = [...valid].sort(
    (left, right) =>
      businessTimeToMinutes(left.range.start) - businessTimeToMinutes(right.range.start),
  );
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const current = sorted[index]!;
    const next = sorted[index + 1]!;
    if (businessTimeToMinutes(current.range.end) > businessTimeToMinutes(next.range.start)) {
      issues.push(
        operationIssue(
          BUSINESS_HOURS_ISSUE.overlappingRange,
          "Business-hours ranges on one day cannot overlap.",
          `${path}.${next.index}`,
        ),
      );
    }
  }

  return issues;
}

function validateDays(
  days: readonly BusinessDaySchedule[],
  path: string,
  rangeIds: Set<string>,
): readonly OperationIssue[] {
  const issues: OperationIssue[] = [];
  const seen = new Set<Weekday>();

  days.forEach((day, index) => {
    const subject = `${path}.${index}`;
    if (!BUSINESS_HOURS_WEEKDAYS.includes(day.weekday)) {
      issues.push(
        operationIssue(
          BUSINESS_HOURS_ISSUE.invalidWeekday,
          "Business-hours weekday is unsupported.",
          `${subject}.weekday`,
        ),
      );
    } else if (seen.has(day.weekday)) {
      issues.push(
        operationIssue(
          BUSINESS_HOURS_ISSUE.duplicateWeekday,
          "A schedule may contain each weekday only once.",
          `${subject}.weekday`,
        ),
      );
    } else {
      seen.add(day.weekday);
    }

    if (day.open && day.ranges.length === 0) {
      issues.push(
        operationIssue(
          BUSINESS_HOURS_ISSUE.openWithoutRange,
          "An open day requires at least one time range.",
          subject,
        ),
      );
    }
    issues.push(...validateRanges(day.ranges, `${subject}.ranges`, rangeIds));
  });

  for (const weekday of BUSINESS_HOURS_WEEKDAYS) {
    if (!seen.has(weekday)) {
      issues.push(
        operationIssue(
          BUSINESS_HOURS_ISSUE.invalidWeekday,
          "A complete schedule requires every weekday exactly once.",
          path,
          { weekday },
        ),
      );
    }
  }

  return issues;
}

function specialHasValidDates(special: SpecialBusinessSchedule): boolean {
  return validDateKey(special.startDate) && validDateKey(special.endDate);
}

/** Validates every rule SOURCE kept in its form/model before an authoritative write. */
export function validateOutletBusinessHours(
  schedule: OutletBusinessHours,
): readonly OperationIssue[] {
  const issues: OperationIssue[] = [];
  const rangeIds = new Set<string>();
  const specialIds = new Set<string>();

  if (!validText(schedule.id) || !validText(schedule.name)) {
    issues.push(
      operationIssue(
        BUSINESS_HOURS_ISSUE.invalidOutlet,
        "Outlet id and name are required for business hours.",
        "outlet",
      ),
    );
  }

  issues.push(...validateDays(schedule.regular, "regular", rangeIds));

  if (schedule.specials.length > BUSINESS_HOURS_MAX_SPECIAL_SCHEDULES) {
    issues.push(
      operationIssue(
        BUSINESS_HOURS_ISSUE.tooManySpecials,
        `At most ${BUSINESS_HOURS_MAX_SPECIAL_SCHEDULES} special schedules are allowed.`,
        "specials",
      ),
    );
  }

  schedule.specials.forEach((special, index) => {
    const subject = `specials.${index}`;
    if (!validText(special.id)) {
      issues.push(
        operationIssue(
          BUSINESS_HOURS_ISSUE.invalidSpecial,
          "Every special schedule requires an id.",
          `${subject}.id`,
        ),
      );
    } else if (specialIds.has(special.id)) {
      issues.push(
        operationIssue(
          BUSINESS_HOURS_ISSUE.duplicateSpecialId,
          "Special schedule ids must be unique within an outlet.",
          `${subject}.id`,
        ),
      );
    } else {
      specialIds.add(special.id);
    }

    if (!validText(special.name)) {
      issues.push(
        operationIssue(
          BUSINESS_HOURS_ISSUE.invalidSpecial,
          "Special schedule name is required.",
          `${subject}.name`,
        ),
      );
    }
    if (!validDateKey(special.startDate)) {
      issues.push(
        operationIssue(
          BUSINESS_HOURS_ISSUE.invalidDate,
          "Special schedule startDate must be a real YYYY-MM-DD date.",
          `${subject}.startDate`,
        ),
      );
    }
    if (!validDateKey(special.endDate)) {
      issues.push(
        operationIssue(
          BUSINESS_HOURS_ISSUE.invalidDate,
          "Special schedule endDate must be a real YYYY-MM-DD date.",
          `${subject}.endDate`,
        ),
      );
    }
    if (specialHasValidDates(special) && special.startDate > special.endDate) {
      issues.push(
        operationIssue(
          BUSINESS_HOURS_ISSUE.invalidDate,
          "Special schedule startDate must not be after endDate.",
          `${subject}.startDate`,
        ),
      );
    }

    issues.push(...validateDays(special.days, `${subject}.days`, rangeIds));
  });

  for (let left = 0; left < schedule.specials.length; left += 1) {
    const first = schedule.specials[left]!;
    if (!first.enabled || !specialHasValidDates(first)) continue;
    for (let right = left + 1; right < schedule.specials.length; right += 1) {
      const second = schedule.specials[right]!;
      if (!second.enabled || !specialHasValidDates(second)) continue;
      if (first.startDate <= second.endDate && first.endDate >= second.startDate) {
        issues.push(
          operationIssue(
            BUSINESS_HOURS_ISSUE.overlappingSpecial,
            "Enabled special schedules cannot overlap.",
            `specials.${right}.startDate`,
          ),
        );
      }
    }
  }

  return issues;
}

function sortRanges(ranges: readonly BusinessTimeRange[]): readonly BusinessTimeRange[] {
  return [...ranges].sort(
    (left, right) => businessTimeToMinutes(left.start) - businessTimeToMinutes(right.start),
  );
}

/** SOURCE sorts open-day ranges only when the operator saves. */
export function normalizeOutletBusinessHours(schedule: OutletBusinessHours): OutletBusinessHours {
  const normalizeDays = (days: readonly BusinessDaySchedule[]) =>
    days.map((day) => ({
      ...day,
      ranges: day.open ? sortRanges(day.ranges) : day.ranges.map((range) => ({ ...range })),
    }));

  return {
    ...schedule,
    regular: normalizeDays(schedule.regular),
    specials: schedule.specials.map((special) => ({
      ...special,
      days: normalizeDays(special.days),
    })),
  };
}

interface JakartaClock {
  readonly date: string;
  readonly weekday: Weekday;
  readonly minuteOfDay: number;
}

const WEEKDAY_FROM_SHORT: Readonly<Record<string, Weekday>> = {
  Mon: "mon",
  Tue: "tue",
  Wed: "wed",
  Thu: "thu",
  Fri: "fri",
  Sat: "sat",
  Sun: "sun",
};

function jakartaClock(timestamp: string): JakartaClock | null {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_HOURS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(parsed);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value;
  const weekday = WEEKDAY_FROM_SHORT[part("weekday") ?? ""];
  const year = part("year");
  const month = part("month");
  const day = part("day");
  const hour = Number(part("hour"));
  const minute = Number(part("minute"));

  return weekday && year && month && day && Number.isFinite(hour) && Number.isFinite(minute)
    ? { date: `${year}-${month}-${day}`, weekday, minuteOfDay: hour * 60 + minute }
    : null;
}

function rangeContainsMinute(
  range: Pick<BusinessTimeRange | SalesInterval, "start" | "end">,
  minute: number,
): boolean {
  return minute >= businessTimeToMinutes(range.start) && minute < businessTimeToMinutes(range.end);
}

function effectiveDay(
  outlet: OutletBusinessHours,
  clock: JakartaClock,
): {
  readonly day: BusinessDaySchedule;
  readonly scheduleSource: "regular" | "special";
  readonly specialScheduleId: string | null;
} {
  const special = outlet.specials.find(
    (entry) => entry.enabled && entry.startDate <= clock.date && entry.endDate >= clock.date,
  );
  if (special !== undefined) {
    return {
      day: special.days.find((entry) => entry.weekday === clock.weekday) ?? {
        weekday: clock.weekday,
        open: false,
        ranges: [],
      },
      scheduleSource: "special",
      specialScheduleId: special.id,
    };
  }

  return {
    day: outlet.regular.find((entry) => entry.weekday === clock.weekday) ?? {
      weekday: clock.weekday,
      open: false,
      ranges: [],
    },
    scheduleSource: "regular",
    specialScheduleId: null,
  };
}

export function isSalesScheduleActive(
  schedule: SalesSchedule | undefined,
  clock: JakartaClock,
): boolean {
  if (schedule === undefined || schedule.mode === "always") return true;
  if (!schedule.activeDays.includes(clock.weekday)) return false;
  return (
    schedule.allDay ||
    schedule.intervals.some((range) => rangeContainsMinute(range, clock.minuteOfDay))
  );
}

export function projectBusinessAvailability(
  outlet: OutletBusinessHours,
  input: EvaluateBusinessAvailabilityInput,
): BusinessAvailability | null {
  const clock = jakartaClock(input.occurredAt);
  if (clock === null) return null;
  const effective = effectiveDay(outlet, clock);
  const outletOpen =
    effective.day.open &&
    effective.day.ranges.some((range) => rangeContainsMinute(range, clock.minuteOfDay));
  const salesScheduleActive = isSalesScheduleActive(input.salesSchedule, clock);

  return {
    outletId: outlet.id,
    occurredAt: input.occurredAt,
    timeZone: BUSINESS_HOURS_TIME_ZONE,
    date: clock.date,
    weekday: clock.weekday,
    minuteOfDay: clock.minuteOfDay,
    scheduleSource: effective.scheduleSource,
    specialScheduleId: effective.specialScheduleId,
    outletOpen,
    salesScheduleActive,
    available: outletOpen && salesScheduleActive,
  };
}

function noStore<TValue>(operation: string): OperationResult<TValue> {
  return operationFailure("unsatisfied-dependency", [
    operationIssue(
      BUSINESS_HOURS_ISSUE.noStore,
      "No business-hours store is connected.",
      operation,
    ),
  ]);
}

function storeFailed<TValue>(operation: string, error: unknown): OperationResult<TValue> {
  return operationFailure("failed", [
    operationIssue(
      BUSINESS_HOURS_ISSUE.storeFailed,
      error instanceof Error ? error.message : "The business-hours store failed.",
      operation,
    ),
  ]);
}

function outletNotFound<TValue>(outletId: string): OperationResult<TValue> {
  return operationFailure("not-found", [
    operationIssue(
      BUSINESS_HOURS_ISSUE.outletNotFound,
      `Business hours for outlet "${outletId}" were not found.`,
      outletId,
    ),
  ]);
}

function businessHoursOverPort(port: BusinessHoursPort): BusinessHours {
  async function listOutlets(): Promise<OperationResult<readonly OutletBusinessHours[]>> {
    try {
      return operationSuccess(await port.listOutlets());
    } catch (error) {
      return storeFailed("listOutlets", error);
    }
  }

  async function getOutlet(outletId: string): Promise<OperationResult<OutletBusinessHours>> {
    if (!validText(outletId)) {
      return operationFailure("invalid-input", [
        operationIssue(BUSINESS_HOURS_ISSUE.invalidOutlet, "outletId is required.", "outletId"),
      ]);
    }
    const listed = await listOutlets();
    if (listed.status === "failure") return listed;
    const outlet = listed.value.find((entry) => entry.id === outletId);
    return outlet === undefined ? outletNotFound(outletId) : operationSuccess(outlet);
  }

  return {
    listOutlets,
    getOutlet,

    async saveOutlet(schedule) {
      const issues = validateOutletBusinessHours(schedule);
      if (issues.length > 0) return operationFailure("invalid-input", issues);
      const normalized = normalizeOutletBusinessHours(schedule);
      try {
        const saved = await port.saveOutlet(normalized);
        return saved === null ? outletNotFound(schedule.id) : operationSuccess(saved);
      } catch (error) {
        return storeFailed("saveOutlet", error);
      }
    },

    async evaluateAvailability(input) {
      if (jakartaClock(input.occurredAt) === null) {
        return operationFailure("invalid-input", [
          operationIssue(
            BUSINESS_HOURS_ISSUE.invalidTimestamp,
            "occurredAt must be a valid timestamp.",
            "occurredAt",
          ),
        ]);
      }
      const loaded = await getOutlet(input.outletId);
      if (loaded.status === "failure") return loaded;
      const scheduleIssues = validateOutletBusinessHours(loaded.value);
      if (scheduleIssues.length > 0) return operationFailure("failed", scheduleIssues);
      const availability = projectBusinessAvailability(loaded.value, input);
      return availability === null
        ? operationFailure("invalid-input", [
            operationIssue(
              BUSINESS_HOURS_ISSUE.invalidTimestamp,
              "occurredAt must be a valid timestamp.",
              "occurredAt",
            ),
          ])
        : operationSuccess(availability);
    },
  };
}

function businessHoursWithoutPort(): BusinessHours {
  return {
    listOutlets: async () => noStore("listOutlets"),
    getOutlet: async () => noStore("getOutlet"),
    saveOutlet: async () => noStore("saveOutlet"),
    evaluateAvailability: async () => noStore("evaluateAvailability"),
  };
}

export function createBusinessHours(context: LogicChildContext): BusinessHours {
  const port = context.ports.resolve(BUSINESS_HOURS_PORT);

  if (port === undefined) {
    context.diagnostics.report({
      code: "missing-dependency",
      severity: severityForCode("missing-dependency"),
      message:
        "No business-hours store was supplied, so schedule operations return a normalized " +
        "failure. The capability remains published.",
      childId: context.childId,
      engineId: context.parentId,
      source: "businessHoursChild",
    });
  }

  const capability = port === undefined ? businessHoursWithoutPort() : businessHoursOverPort(port);
  context.capabilities.provide(BUSINESS_HOURS, capability);
  return capability;
}

export default defineLogicChild<BusinessHours>({
  id: BUSINESS_HOURS_ID,
  parentId: SETTINGS_ENGINE_ID,
  provides: [BUSINESS_HOURS_ID],
  requires: [],
  create: createBusinessHours,
});
