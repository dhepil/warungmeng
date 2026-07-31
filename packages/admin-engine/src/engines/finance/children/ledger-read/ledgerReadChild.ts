// packages/admin-engine/src/engines/finance/children/ledger-read/ledgerReadChild.ts
//
// Reading the merged finance ledger (capability `admin.finance.ledger-read`,
// required by both dashboard children per LOGIC §8).
//
// Ported from SOURCE:
//   - application/useFinanceLedger.ts (load orders + manual rows, merge, sort)
//   - application/useFinanceTransactions.ts (query filtering)
//   - application/useFinanceOverview.ts (summary + breakdown projections)
//   - application/financeDateRange.ts (the four date presets)
//
// The arithmetic and ledger projection are the domain's. This child owns the
// application behavior around them: where the two datasets come from, how one
// failed source degrades, what a calendar day means, and which projections travel
// together so their totals reconcile.

import type { FinanceTransaction, FinanceTransactionQuery, Order } from "@warungmeng/domain";
import {
  buildFinanceLedger,
  filterFinanceTransactions,
  getReportingDateKey,
  groupFinanceOutflowsByCategory,
  groupFinanceTransactionsByPaymentMethod,
  sortFinanceTransactionsNewestFirst,
  summarizeFinanceTransactions,
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
import { FINANCE_ENGINE_ID } from "../../financeEngine";
import type {
  FinanceDatePreset,
  FinanceDateRange,
  FinanceDateSelection,
  FinanceLedgerView,
  FinanceOrderReadPort,
  FinanceStorePort,
  LedgerRead,
} from "../../financeContracts";
import {
  DEFAULT_FINANCE_OUTLET_ID,
  FINANCE_DATE_PRESETS,
  FINANCE_ORDER_READ_PORT,
  FINANCE_STORE_PORT,
  FINANCE_TIME_ZONE,
  LEDGER_READ,
  LEDGER_READ_ID,
  RECENT_TRANSACTION_COUNT,
} from "../../financeContracts";

const NO_FINANCE_STORE = "no-finance-store";
const NO_ORDER_READ = "no-finance-order-read";
const FINANCE_STORE_FAILED = "finance-store-failed";
const ORDER_READ_FAILED = "finance-order-read-failed";
const INVALID_FINANCE_QUERY = "invalid-finance-query";

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// ─── Date presets and calendar-day filtering ─────────────────────────────────

function assertDateKey(value: string): void {
  if (!DATE_KEY_PATTERN.test(value)) {
    throw new RangeError(`Invalid finance date: ${value}`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new RangeError(`Invalid finance date: ${value}`);
  }
}

function shiftDateKey(value: string, days: number): string {
  assertDateKey(value);
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Resolves a preset against an explicit instant, in the one zone Finance owns.
 *
 * SOURCE used `dayjs()` in the machine's local zone here, then its domain filter
 * expanded the resulting date keys as UTC. Near midnight those were different
 * days. We reuse the domain's reporting-date projection so Finance and reporting
 * now agree on what "today" means. `now` defaults only at the capability edge;
 * every test and every comparison can supply it explicitly.
 */
export function resolveFinanceDatePreset(
  preset: FinanceDatePreset,
  now: Date = new Date(),
): FinanceDateRange {
  const dateTo = getReportingDateKey(now.toISOString(), FINANCE_TIME_ZONE);
  if (dateTo === null) {
    throw new RangeError("Finance preset reference date must be valid");
  }

  const dateFrom =
    preset === "today"
      ? dateTo
      : preset === "last7"
        ? shiftDateKey(dateTo, -6)
        : preset === "last30"
          ? shiftDateKey(dateTo, -29)
          : `${dateTo.slice(0, 8)}01`;

  return { dateFrom, dateTo };
}

export function identifyFinanceDateRange(
  range: FinanceDateRange,
  now: Date = new Date(),
): FinanceDateSelection {
  assertDateKey(range.dateFrom);
  assertDateKey(range.dateTo);
  if (range.dateFrom > range.dateTo) {
    throw new RangeError("Finance dateFrom must not be after dateTo");
  }

  return (
    FINANCE_DATE_PRESETS.find((preset) => {
      const candidate = resolveFinanceDatePreset(preset, now);
      return candidate.dateFrom === range.dateFrom && candidate.dateTo === range.dateTo;
    }) ?? "custom"
  );
}

/**
 * Applies the date dimensions in Jakarta calendar time, then delegates every
 * other filter and the total ordering to the domain.
 *
 * We deliberately strip `dateFrom`/`dateTo` before calling the domain filter:
 * its date-only convention is UTC and calling it as well would apply TWO windows,
 * recreating the disagreement this child exists to remove.
 */
export function queryFinanceTransactions(
  transactions: readonly FinanceTransaction[],
  query: FinanceTransactionQuery = {},
): readonly FinanceTransaction[] {
  if (query.dateFrom) assertDateKey(query.dateFrom);
  if (query.dateTo) assertDateKey(query.dateTo);
  if (query.dateFrom && query.dateTo && query.dateFrom > query.dateTo) {
    throw new RangeError("Finance dateFrom must not be after dateTo");
  }

  const { dateFrom, dateTo, ...otherFilters } = query;
  const inCalendarWindow = transactions.filter((transaction) => {
    const key = getReportingDateKey(transaction.occurredAt, FINANCE_TIME_ZONE);
    return (
      key !== null &&
      (dateFrom === undefined || key >= dateFrom) &&
      (dateTo === undefined || key <= dateTo)
    );
  });

  return filterFinanceTransactions(inCalendarWindow, otherFilters);
}

// ─── Loading the two independent sources ─────────────────────────────────────

interface LedgerLoad {
  readonly transactions: readonly FinanceTransaction[];
  readonly issues: readonly OperationIssue[];
}

/**
 * Loads both sources independently, so one bad dataset cannot erase the other.
 *
 * SOURCE used one `Promise.all` and one catch, so an unavailable manual store
 * blanked every sale derived from perfectly healthy orders, and an unavailable
 * order reader hid every manual expense. S5's general rule applies: when one
 * dataset has an all-or-nothing policy and a degrading policy, the degrading one
 * wins. A partial ledger names what is absent; an empty error screen names nothing.
 */
async function loadLedger(
  store: FinanceStorePort | undefined,
  orders: FinanceOrderReadPort | undefined,
  outletId: string,
): Promise<OperationResult<LedgerLoad>> {
  if (store === undefined && orders === undefined) {
    return operationFailure("unsatisfied-dependency", [
      operationIssue(NO_FINANCE_STORE, "No finance store is connected.", "listTransactions"),
      operationIssue(NO_ORDER_READ, "No order reader is connected.", "listTransactions"),
    ]);
  }

  const issues: OperationIssue[] = [];
  let manualTransactions: readonly FinanceTransaction[] = [];
  let orderRecords: readonly Order[] = [];
  let successfulSourceCount = 0;

  const [manualResult, orderResult] = await Promise.allSettled([
    store?.listManualTransactions() ?? Promise.resolve(undefined),
    orders?.listOrders({ outletId }) ?? Promise.resolve(undefined),
  ]);

  if (store === undefined) {
    issues.push(
      operationIssue(
        NO_FINANCE_STORE,
        "Manual transactions are absent because no finance store is connected.",
        outletId,
      ),
    );
  } else if (manualResult.status === "rejected") {
    issues.push(
      operationIssue(
        FINANCE_STORE_FAILED,
        manualResult.reason instanceof Error
          ? manualResult.reason.message
          : "The finance store failed.",
        outletId,
      ),
    );
  } else {
    manualTransactions = manualResult.value ?? [];
    successfulSourceCount += 1;
  }

  if (orders === undefined) {
    issues.push(
      operationIssue(
        NO_ORDER_READ,
        "Sales and refunds are absent because no order reader is connected.",
        outletId,
      ),
    );
  } else if (orderResult.status === "rejected") {
    issues.push(
      operationIssue(
        ORDER_READ_FAILED,
        orderResult.reason instanceof Error ? orderResult.reason.message : "The order reader failed.",
        outletId,
      ),
    );
  } else {
    orderRecords = orderResult.value ?? [];
    successfulSourceCount += 1;
  }

  if (successfulSourceCount === 0) {
    // An empty value is usable only when at least one source successfully said
    // "there are no rows". When every configured source failed, [] is fabricated
    // by the fallback assignments above and must not masquerade as a partial
    // ledger. A degraded result without any trustworthy value is just a failure.
    return operationFailure("failed", issues);
  }

  const transactions = sortFinanceTransactionsNewestFirst(
    buildFinanceLedger(orderRecords, manualTransactions),
  );

  return operationDegraded({ transactions, issues }, issues);
}

// ─── Capability ──────────────────────────────────────────────────────────────

function ledgerReadOverPorts(
  store: FinanceStorePort | undefined,
  orders: FinanceOrderReadPort | undefined,
): LedgerRead {
  async function listTransactions(
    outletId = DEFAULT_FINANCE_OUTLET_ID,
  ): Promise<OperationResult<readonly FinanceTransaction[]>> {
    const loaded = await loadLedger(store, orders, outletId);
    if (loaded.status === "failure") return loaded;
    return operationDegraded(loaded.value.transactions, loaded.value.issues);
  }

  return {
    listTransactions,

    async queryLedger(
      query: FinanceTransactionQuery = {},
      outletId = DEFAULT_FINANCE_OUTLET_ID,
    ): Promise<OperationResult<FinanceLedgerView>> {
      const loaded = await listTransactions(outletId);
      if (loaded.status === "failure") return loaded;

      let filtered: readonly FinanceTransaction[];
      try {
        filtered = queryFinanceTransactions(loaded.value, query);
      } catch (error) {
        return operationFailure("invalid-input", [
          operationIssue(
            INVALID_FINANCE_QUERY,
            error instanceof Error ? error.message : "The finance query is invalid.",
            "queryLedger",
          ),
        ]);
      }

      const value: FinanceLedgerView = {
        transactions: filtered,
        recentTransactions: filtered.slice(0, RECENT_TRANSACTION_COUNT),
        summary: summarizeFinanceTransactions(filtered),
        paymentMethods: groupFinanceTransactionsByPaymentMethod(filtered),
        expenseCategories: groupFinanceOutflowsByCategory(filtered),
      };

      return loaded.status === "degraded"
        ? operationDegraded(value, loaded.issues)
        : operationSuccess(value);
    },

    resolveDatePreset: resolveFinanceDatePreset,
    identifyDateRange: identifyFinanceDateRange,
  };
}

function ledgerReadWithoutPorts(): LedgerRead {
  const failure = <TValue>(): OperationResult<TValue> =>
    operationFailure("unsatisfied-dependency", [
      operationIssue(NO_FINANCE_STORE, "No finance store is connected.", LEDGER_READ_ID),
      operationIssue(NO_ORDER_READ, "No order reader is connected.", LEDGER_READ_ID),
    ]);

  return {
    listTransactions: async () => failure(),
    queryLedger: async () => failure(),
    resolveDatePreset: resolveFinanceDatePreset,
    identifyDateRange: identifyFinanceDateRange,
  };
}

export function createLedgerRead(context: LogicChildContext): LedgerRead {
  const store = context.ports.resolve(FINANCE_STORE_PORT);
  const orders = context.ports.resolve(FINANCE_ORDER_READ_PORT);

  if (store === undefined || orders === undefined) {
    const missing = [
      store === undefined ? "the manual-transaction store" : null,
      orders === undefined ? "the order reader" : null,
    ].filter((entry): entry is string => entry !== null);

    // One report, even when both ports are absent. The Admin host deliberately
    // de-duplicates same-code events from one child, so emitting one event per port
    // would silently discard the second message. Name the full missing set in the
    // event that can actually survive.
    context.diagnostics.report({
      code: "missing-dependency",
      severity: severityForCode("missing-dependency"),
      message:
        `Finance ledger reads are missing ${missing.join(" and ")}. ` +
        "Available sources still produce a degraded ledger; with neither source, calls fail " +
        "honestly. The capability stays published.",
      childId: context.childId,
      engineId: context.parentId,
      source: "ledgerReadChild",
    });
  }

  const capability =
    store === undefined && orders === undefined
      ? ledgerReadWithoutPorts()
      : ledgerReadOverPorts(store, orders);

  context.capabilities.provide(LEDGER_READ, capability);
  return capability;
}

export default defineLogicChild<LedgerRead>({
  id: LEDGER_READ_ID,
  parentId: FINANCE_ENGINE_ID,
  provides: [LEDGER_READ_ID],
  create: createLedgerRead,
});
