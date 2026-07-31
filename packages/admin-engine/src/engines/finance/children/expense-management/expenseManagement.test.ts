// packages/admin-engine/src/engines/finance/children/expense-management/expenseManagement.test.ts
//
// Protected behavior for the deliberately thin expense projection. It has no
// ports and no sibling imports: a caller composes it with ledger-read and
// transaction-recording rather than this child secretly duplicating either.

import { describe, expect, it } from "vitest";
import type { FinanceTransaction, Money } from "@warungmeng/domain";
import { defineLogicChild } from "@warungmeng/module-system";
import { createAdminEngine } from "../../../../createAdminEngine";
import type { ExpenseManagement } from "../../financeContracts";
import {
  EXPENSE_MANAGEMENT,
  EXPENSE_MANAGEMENT_ID,
} from "../../financeContracts";
import financeEngine from "../../financeEngine";
import expenseManagementChild, { projectExpenseView } from "./expenseManagementChild";

const IDR = (amount: number): Money => ({ amount, currency: "IDR" });

function transaction(
  overrides: Partial<FinanceTransaction> & Pick<FinanceTransaction, "id">,
): FinanceTransaction {
  return {
    occurredAt: "2026-03-01T03:00:00.000Z",
    direction: "outflow",
    type: "expense",
    source: "manual",
    status: "posted",
    categoryId: "ingredients",
    categoryLabel: "Bahan Baku",
    amount: IDR(10_000),
    paymentMethod: "cash",
    description: "Buy rice",
    referenceNumber: "EXP-1",
    sourceReference: null,
    attachment: null,
    createdAt: "2026-03-01T03:00:00.000Z",
    updatedAt: "2026-03-01T03:00:00.000Z",
    ...overrides,
  };
}

function runtimeCapability(): {
  readonly expenses: ExpenseManagement | undefined;
  readonly dispose: () => void;
} {
  let captured: ExpenseManagement | undefined;
  const probe = defineLogicChild({
    id: "admin.finance.test-probe",
    parentId: financeEngine.id,
    requires: [EXPENSE_MANAGEMENT_ID],
    create(context) {
      const resolution = context.capabilities.resolve(EXPENSE_MANAGEMENT);
      if (resolution.status === "available") captured = resolution.value;
      return undefined;
    },
  });
  const engine = createAdminEngine({
    definitions: { engines: [financeEngine], children: [expenseManagementChild, probe] },
  });
  return { expenses: captured, dispose: engine.dispose };
}

describe("the expense projection", () => {
  it("includes only posted outflows, so every visible row reconciles to the total", () => {
    const view = projectExpenseView([
      transaction({ id: "posted", amount: IDR(10_000) }),
      transaction({ id: "pending", status: "pending", amount: IDR(20_000) }),
      transaction({ id: "voided", status: "voided", amount: IDR(30_000) }),
      transaction({
        id: "income",
        direction: "inflow",
        type: "manual-income",
        categoryId: "other-income",
        categoryLabel: "Pemasukan Lain",
        amount: IDR(40_000),
      }),
    ]);

    expect(view.transactions.map((row) => row.id)).toEqual(["posted"]);
    expect(view.total).toEqual(IDR(10_000));
    expect(view.transactionCount).toBe(1);
  });

  it("groups posted expenses by category", () => {
    const view = projectExpenseView([
      transaction({ id: "rice", amount: IDR(10_000) }),
      transaction({ id: "flour", amount: IDR(15_000) }),
      transaction({
        id: "power",
        categoryId: "utilities",
        categoryLabel: "Listrik dan Utilitas",
        amount: IDR(5_000),
      }),
    ]);

    expect(view.categories).toMatchObject([
      { categoryId: "ingredients", total: IDR(25_000), transactionCount: 2 },
      { categoryId: "utilities", total: IDR(5_000), transactionCount: 1 },
    ]);
  });

  it("sorts newest first with id as a tie-break, regardless of input order", () => {
    const sameTime = "2026-03-02T03:00:00.000Z";
    const view = projectExpenseView([
      transaction({ id: "b", occurredAt: sameTime }),
      transaction({ id: "old", occurredAt: "2026-03-01T03:00:00.000Z" }),
      transaction({ id: "a", occurredAt: sameTime }),
    ]);

    expect(view.transactions.map((row) => row.id)).toEqual(["a", "b", "old"]);
  });

  it("returns an empty, zero-valued view when no posted outflow exists", () => {
    expect(projectExpenseView([])).toEqual({
      transactions: [],
      categories: [],
      total: IDR(0),
      transactionCount: 0,
    });
  });
});

describe("expense categories", () => {
  it("offers only outflow categories", () => {
    const { expenses, dispose } = runtimeCapability();
    const categories = expenses!.listExpenseCategories();

    expect(categories.length).toBeGreaterThan(0);
    expect(categories.every((category) => category.direction === "outflow")).toBe(true);
    expect(categories.map((category) => category.id)).toContain("ingredients");
    expect(categories.map((category) => category.id)).not.toContain("sales");
    dispose();
  });
});

describe("the child in a runtime", () => {
  it("publishes the capability under its declared id with no port", () => {
    const { expenses, dispose } = runtimeCapability();

    expect(expenses).toBeDefined();
    expect(expenses!.projectExpenses([transaction({ id: "e1" })])).toMatchObject({
      status: "success",
      value: { transactionCount: 1, total: IDR(10_000) },
    });
    dispose();
  });
});
