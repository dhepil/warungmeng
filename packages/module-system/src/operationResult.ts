// packages/module-system/src/operationResult.ts
//
// Generic success / failure / degraded result contract (LOGIC §5).
//
// This is the ONE shape every operation in the runtime — and later every engine
// child — returns instead of throwing. It carries no Warung Meng vocabulary: no
// menus, no orders, no surfaces. Ported from the SOURCE's per-module discriminated
// result unions (ModuleRegistrationResult, CapabilityRegistrationResult,
// ModuleGraphValidationResult), which all repeated the same
// `{ status: ... } | { status: ..., diagnostics }` pattern; here it is expressed
// once and reused.

/** Why an operation could not complete, in runtime-neutral terms. */
export type OperationFailureReason =
  | "invalid-input"
  | "conflict"
  | "not-found"
  | "unsatisfied-dependency"
  | "failed";

/** An operation that fully succeeded. */
export interface OperationSuccess<TValue> {
  readonly status: "success";
  readonly value: TValue;
}

/**
 * An operation that produced a usable value while something was still wrong —
 * e.g. a registry that started with some members rejected. `issues` explains what
 * was lost. Callers may proceed, but must not treat this as a clean success.
 */
export interface OperationDegraded<TValue> {
  readonly status: "degraded";
  readonly value: TValue;
  readonly issues: readonly OperationIssue[];
}

/** An operation that produced no usable value. */
export interface OperationFailure {
  readonly status: "failure";
  readonly reason: OperationFailureReason;
  readonly issues: readonly OperationIssue[];
}

/**
 * A single machine-readable problem. Deliberately not the diagnostic type from
 * `diagnostics.ts`: an issue explains ONE result, a diagnostic is an event
 * collected across the whole runtime. `diagnostics.ts` maps between them.
 */
export interface OperationIssue {
  readonly code: string;
  readonly message: string;
  readonly subject?: string;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
}

export type OperationResult<TValue> =
  | OperationSuccess<TValue>
  | OperationDegraded<TValue>
  | OperationFailure;

// ─── Constructors ────────────────────────────────────────────────────────────

export function operationSuccess<TValue>(value: TValue): OperationSuccess<TValue> {
  return { status: "success", value };
}

/**
 * Degrades to a plain success when there is nothing to report, so callers never
 * have to special-case an empty issue list.
 */
export function operationDegraded<TValue>(
  value: TValue,
  issues: readonly OperationIssue[],
): OperationSuccess<TValue> | OperationDegraded<TValue> {
  if (issues.length === 0) {
    return operationSuccess(value);
  }

  return { status: "degraded", value, issues };
}

export function operationFailure(
  reason: OperationFailureReason,
  issues: readonly OperationIssue[],
): OperationFailure {
  return { status: "failure", reason, issues };
}

export function operationIssue(
  code: string,
  message: string,
  subject?: string,
  details?: OperationIssue["details"],
): OperationIssue {
  return { code, message, subject, details };
}

// ─── Narrowing helpers ───────────────────────────────────────────────────────

/** True for both clean and degraded results — i.e. a value is present. */
export function isOperationUsable<TValue>(
  result: OperationResult<TValue>,
): result is OperationSuccess<TValue> | OperationDegraded<TValue> {
  return result.status === "success" || result.status === "degraded";
}

export function isOperationSuccess<TValue>(
  result: OperationResult<TValue>,
): result is OperationSuccess<TValue> {
  return result.status === "success";
}

export function isOperationFailure<TValue>(
  result: OperationResult<TValue>,
): result is OperationFailure {
  return result.status === "failure";
}

/** The issues attached to any result; a clean success has none. */
export function operationIssues<TValue>(
  result: OperationResult<TValue>,
): readonly OperationIssue[] {
  return result.status === "success" ? [] : result.issues;
}

/** The value if one exists, otherwise `undefined`. */
export function operationValue<TValue>(result: OperationResult<TValue>): TValue | undefined {
  return isOperationUsable(result) ? result.value : undefined;
}
