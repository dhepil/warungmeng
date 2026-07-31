// packages/admin-engine/src/engines/finance/children/expense-management/expenseManagementChild.ts
//
// The expense-specific projection (capability `admin.finance.expense-management`).
//
// SOURCE's expense screen was the general transaction screen with the direction
// forced to outflow, the income action removed, and an expense breakdown added.
// That makes this the thinnest child in P3 so far — honestly. It accepts ledger
// rows a caller already obtained, rather than duplicating ledger-read's two-source
// loading, and it exposes no write, rather than duplicating transaction-recording's
// validation. LOGIC §8 gives it no sibling requirement, so importing or resolving
// either sibling would invent a graph edge the target did not name.

import type { FinanceTransaction } from "@warungmeng/domain";
import {
  getFinanceCategories,
  groupFinanceOutflowsByCategory,
  sortFinanceTransactionsNewestFirst,
  summarizeFinanceTransactions,
} from "@warungmeng/domain";
import type { LogicChildContext } from "@warungmeng/module-system";
import { defineLogicChild, operationSuccess } from "@warungmeng/module-system";
import { FINANCE_ENGINE_ID } from "../../financeEngine";
import type { ExpenseManagement, ExpenseView } from "../../financeContracts";
import { EXPENSE_MANAGEMENT, EXPENSE_MANAGEMENT_ID } from "../../financeContracts";

/**
 * Projects posted outflows and their category breakdown from a ledger collection.
 *
 * The caller performs any free-form/date/category filtering through ledger-read
 * first; this child then enforces the two dimensions that make the result an
 * expense view. It re-sorts its result because a port promises no input order.
 *
 * SOURCE's expense screen forced only direction; its breakdown helper ignored
 * pending and voided rows but its table still displayed them, so the total did not
 * reconcile against the visible rows. This consolidates on one interpretation:
 * an expense view means money that actually left, and every row in it contributes
 * to the total. Pending/voided rows remain available from ledger-read.
 */
export function projectExpenseView(
  transactions: readonly FinanceTransaction[],
): ExpenseView {
  const expenses = sortFinanceTransactionsNewestFirst(
    transactions.filter(
      (transaction) => transaction.direction === "outflow" && transaction.status === "posted",
    ),
  );
  const summary = summarizeFinanceTransactions(expenses);

  return {
    transactions: expenses,
    categories: groupFinanceOutflowsByCategory(expenses),
    total: summary.totalOutflow,
    transactionCount: expenses.length,
  };
}

export function createExpenseManagement(context: LogicChildContext): ExpenseManagement {
  const capability: ExpenseManagement = {
    projectExpenses: (transactions) => operationSuccess(projectExpenseView(transactions)),
    listExpenseCategories: () => getFinanceCategories("outflow"),
  };

  context.capabilities.provide(EXPENSE_MANAGEMENT, capability);
  return capability;
}

export default defineLogicChild<ExpenseManagement>({
  id: EXPENSE_MANAGEMENT_ID,
  parentId: FINANCE_ENGINE_ID,
  provides: [EXPENSE_MANAGEMENT_ID],
  create: createExpenseManagement,
});
