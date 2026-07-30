// packages/module-system/src/diagnostics.ts
//
// Diagnostic event dan collector (LOGIC §4 table, §3 "diagnostics dan read-only
// snapshot").
//
// Every other file in this package REPORTS problems; this is the one place that
// collects them and turns a scattered pile of events into something a caller can
// act on. Ported from SOURCE `diagnostics/createModuleDiagnosticCollector.ts` plus
// the de-duplication filter that SOURCE had inlined in
// `registry/createModuleRegistry.ts` — the same diagnostic reached that collector
// from shape validation, graph validation, and capability checks, so the dedupe
// belongs to the collector, not to one caller.
//
// The event type itself (`Diagnostic`, `DiagnosticSink`, `DiagnosticCode`) lives in
// engineContracts.ts, because children receive a sink through their context and must
// not import the collector implementation to do so.
//
// Nothing here decides whether the application should start. It reports scope and
// severity; the host decides policy.

import type {
  Diagnostic,
  DiagnosticCode,
  DiagnosticSeverity,
  DiagnosticSink,
  EngineId,
  LogicChildId,
} from "./engineContracts";
import type { OperationIssue } from "./operationResult";

// ─── Severity ────────────────────────────────────────────────────────────────

const SEVERITY_RANK: Readonly<Record<DiagnosticSeverity, number>> = {
  error: 0,
  warning: 1,
  info: 2,
};

/**
 * Default severity per code, so callers need not restate it at every report site.
 *
 * Every code is an error, matching SOURCE. It is tempting to soften
 * `missing-dependency` to a warning because a blocked child does not stop startup
 * (LOGIC §7 rule 6) — but "the application still runs" is already expressed by the
 * runtime's `degraded` status and by `OperationDegraded`. Encoding it a second time
 * in severity would give the same fact two owners that can drift apart. Severity
 * answers "how bad is this event", not "may we continue".
 */
const SEVERITY_BY_CODE: Readonly<Record<DiagnosticCode, DiagnosticSeverity>> = {
  "candidate-load-failed": "error",
  "definition-malformed": "error",
  "duplicate-engine-id": "error",
  "duplicate-child-id": "error",
  "orphan-child": "error",
  "unsupported-version": "error",
  "missing-dependency": "error",
  "dependency-cycle": "error",
  "missing-capability": "error",
  "duplicate-capability": "error",
  "initialization-failed": "error",
  "disposal-failed": "error",
};

export function severityForCode(code: DiagnosticCode): DiagnosticSeverity {
  return SEVERITY_BY_CODE[code];
}

// ─── Construction ────────────────────────────────────────────────────────────

/** What a diagnostic is about, so a caller can group without re-reading fields. */
export interface DiagnosticSubject {
  readonly engineId?: EngineId;
  readonly childId?: LogicChildId;
  readonly source?: string;
}

/** Builds a diagnostic with the code's default severity already applied. */
export function diagnostic(
  code: DiagnosticCode,
  message: string,
  subject: DiagnosticSubject = {},
  details?: Diagnostic["details"],
): Diagnostic {
  return {
    code,
    severity: severityForCode(code),
    message,
    engineId: subject.engineId,
    childId: subject.childId,
    source: subject.source,
    details,
  };
}

/**
 * Turns a result issue into a diagnostic event. Issues explain ONE operation and
 * carry a free-form `code`; diagnostics are runtime-wide and their codes are a fixed
 * union, so the caller supplies the code and the issue supplies the wording.
 */
export function diagnosticFromIssue(
  code: DiagnosticCode,
  issue: OperationIssue,
  subject: DiagnosticSubject = {},
): Diagnostic {
  return diagnostic(code, issue.message, subject, {
    ...(issue.subject === undefined ? {} : { subject: issue.subject }),
    ...(issue.details ?? {}),
  });
}

// ─── Collector ───────────────────────────────────────────────────────────────

/** A readable roll-up of everything collected so far. */
export interface DiagnosticSummary {
  readonly total: number;
  readonly errors: number;
  readonly warnings: number;
  readonly infos: number;
  /** True when at least one error was reported — the host's fatal signal. */
  readonly hasErrors: boolean;
  /** Codes seen, each with how many times, sorted by code. */
  readonly byCode: readonly DiagnosticCodeCount[];
  /** Children that reported at least one diagnostic, sorted by id. */
  readonly affectedChildren: readonly LogicChildId[];
  /** Engines that reported at least one diagnostic, sorted by id. */
  readonly affectedEngines: readonly EngineId[];
}

export interface DiagnosticCodeCount {
  readonly code: DiagnosticCode;
  readonly count: number;
}

export interface DiagnosticCollector extends DiagnosticSink {
  /** Everything collected, in report order. */
  list(): readonly Diagnostic[];
  /** Only the diagnostics at or above `severity` in seriousness. */
  bySeverity(severity: DiagnosticSeverity): readonly Diagnostic[];
  /** Diagnostics naming this child, in report order. */
  forChild(childId: LogicChildId): readonly Diagnostic[];
  /** Diagnostics naming this engine — including those from its children. */
  forEngine(engineId: EngineId): readonly Diagnostic[];
  summarize(): DiagnosticSummary;
  clear(): void;
}

/**
 * Identity of a diagnostic for de-duplication purposes: the same problem about the
 * same subject with the same details is ONE problem, however many validators found
 * it. Ported from the filter SOURCE inlined in `createModuleRegistry`.
 */
function fingerprint(entry: Diagnostic): string {
  return JSON.stringify([
    entry.code,
    entry.engineId ?? null,
    entry.childId ?? null,
    entry.source ?? null,
    entry.details ?? null,
  ]);
}

export interface DiagnosticCollectorOptions {
  /**
   * Forwards every accepted diagnostic onward (a log, a dev overlay). Kept optional
   * so the collector stays usable in a pure test.
   */
  readonly forwardTo?: DiagnosticSink;
  /** Set false to keep repeated identical reports. Defaults to de-duplicating. */
  readonly deduplicate?: boolean;
}

export function createDiagnosticCollector(
  options: DiagnosticCollectorOptions = {},
): DiagnosticCollector {
  const entries: Diagnostic[] = [];
  const seen = new Set<string>();
  const deduplicate = options.deduplicate ?? true;

  function byIdList<TId extends string>(ids: Iterable<TId>): readonly TId[] {
    return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
  }

  return {
    report(entry) {
      if (deduplicate) {
        const key = fingerprint(entry);
        if (seen.has(key)) {
          return;
        }
        seen.add(key);
      }
      entries.push(entry);
      options.forwardTo?.report(entry);
    },

    list: () => [...entries],

    bySeverity: (severity) =>
      entries.filter((entry) => SEVERITY_RANK[entry.severity] <= SEVERITY_RANK[severity]),

    forChild: (childId) => entries.filter((entry) => entry.childId === childId),

    // An engine's diagnostics include its children's: a child names its parent in
    // `engineId`, so asking about an engine answers "what is wrong under here?"
    forEngine: (engineId) => entries.filter((entry) => entry.engineId === engineId),

    summarize() {
      const counts = new Map<DiagnosticCode, number>();
      let errors = 0;
      let warnings = 0;
      let infos = 0;

      for (const entry of entries) {
        counts.set(entry.code, (counts.get(entry.code) ?? 0) + 1);
        if (entry.severity === "error") {
          errors += 1;
        } else if (entry.severity === "warning") {
          warnings += 1;
        } else {
          infos += 1;
        }
      }

      return {
        total: entries.length,
        errors,
        warnings,
        infos,
        hasErrors: errors > 0,
        byCode: [...counts.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([code, count]) => ({ code, count })),
        affectedChildren: byIdList(
          entries
            .map(({ childId }) => childId)
            .filter((childId): childId is LogicChildId => childId !== undefined),
        ),
        affectedEngines: byIdList(
          entries
            .map(({ engineId }) => engineId)
            .filter((engineId): engineId is EngineId => engineId !== undefined),
        ),
      };
    },

    clear() {
      entries.length = 0;
      seen.clear();
    },
  };
}

/** A sink that discards everything — for callers that do not want diagnostics. */
export const NO_DIAGNOSTICS: DiagnosticSink = { report() {} };
