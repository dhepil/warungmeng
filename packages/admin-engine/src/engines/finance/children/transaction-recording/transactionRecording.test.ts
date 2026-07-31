// packages/admin-engine/src/engines/finance/children/transaction-recording/transactionRecording.test.ts
//
// Protected behavior for manual finance writes. Load-bearing: every invalid input
// is rejected before the store sees it; edit/void outcomes come from the write's
// own authoritative decision; a replayed void says it did no new work.

import { describe, expect, it, vi } from "vitest";
import type { FinanceTransaction, Money } from "@warungmeng/domain";
import { defineLogicChild } from "@warungmeng/module-system";
import { createAdminEngine } from "../../../../createAdminEngine";
import type {
  FinanceStorePort,
  FinanceUpdateCommit,
  FinanceVoidCommit,
  ManualTransactionRecord,
  RecordTransactionInput,
  TransactionRecording,
} from "../../financeContracts";
import {
  CUSTOM_CATEGORY_SELECTION,
  FINANCE_STORE_PORT,
  TRANSACTION_RECORDING,
  TRANSACTION_RECORDING_ID,
} from "../../financeContracts";
import financeEngine from "../../financeEngine";
import transactionRecordingChild, {
  planManualTransaction,
  TRANSACTION_ISSUE,
} from "./transactionRecordingChild";

const IDR = (amount: number): Money => ({ amount, currency: "IDR" });

function input(overrides: Partial<RecordTransactionInput> = {}): RecordTransactionInput {
  return {
    occurredAt: "2026-03-01T03:00:00.000Z",
    direction: "outflow",
    status: "posted",
    categoryId: "ingredients",
    amount: IDR(10_000),
    paymentMethod: "cash",
    description: "Buy rice",
    referenceNumber: "EXP-1",
    attachment: null,
    ...overrides,
  };
}

function stored(
  record: ManualTransactionRecord,
  overrides: Partial<FinanceTransaction> = {},
): FinanceTransaction {
  return {
    ...record,
    id: "finance-1",
    source: "manual",
    sourceReference: null,
    createdAt: "2026-03-01T04:00:00.000Z",
    updatedAt: "2026-03-01T04:00:00.000Z",
    ...overrides,
  };
}

interface StoreControls {
  readonly store: FinanceStorePort;
  readonly create: ReturnType<typeof vi.fn>;
  readonly update: ReturnType<typeof vi.fn>;
  readonly void: ReturnType<typeof vi.fn>;
}

function storeOver(options: {
  update?: FinanceUpdateCommit;
  void?: FinanceVoidCommit;
  fail?: "create" | "update" | "void";
} = {}): StoreControls {
  const create = vi.fn(async (record: ManualTransactionRecord) => {
    if (options.fail === "create") throw new Error("create unavailable");
    return stored(record);
  });
  const update = vi.fn(async (_id: string, record: ManualTransactionRecord) => {
    if (options.fail === "update") throw new Error("update unavailable");
    return options.update ?? ({ status: "updated", transaction: stored(record) } as const);
  });
  const voidTransaction = vi.fn(async (_id: string): Promise<FinanceVoidCommit> => {
    if (options.fail === "void") throw new Error("void unavailable");
    return (
      options.void ?? {
        status: "voided",
        transaction: stored(planManualTransaction(input()).record, { status: "voided" }),
      }
    );
  });

  return {
    store: {
      listManualTransactions: async () => [],
      createManualTransaction: create,
      updateManualTransaction: update,
      voidManualTransaction: voidTransaction,
    },
    create,
    update,
    void: voidTransaction,
  };
}

function runtimeWith(store?: FinanceStorePort): {
  readonly recording: TransactionRecording | undefined;
  readonly dispose: () => void;
} {
  let captured: TransactionRecording | undefined;
  const probe = defineLogicChild({
    id: "admin.finance.test-probe",
    parentId: financeEngine.id,
    requires: [TRANSACTION_RECORDING_ID],
    create(context) {
      const resolution = context.capabilities.resolve(TRANSACTION_RECORDING);
      if (resolution.status === "available") captured = resolution.value;
      return undefined;
    },
  });
  const engine = createAdminEngine({
    definitions: { engines: [financeEngine], children: [transactionRecordingChild, probe] },
    ports: { resolve: (token) => (token.id === FINANCE_STORE_PORT.id ? (store as never) : undefined) },
  });
  return { recording: captured, dispose: engine.dispose };
}

function issueCodes(result: Awaited<ReturnType<TransactionRecording["recordTransaction"]>>): string[] {
  return result.status === "success" ? [] : result.issues.map((issue) => issue.code);
}

// ─── Decide before writing ───────────────────────────────────────────────────

describe("decide before writing", () => {
  it("derives the type and category label rather than trusting a caller", async () => {
    const controlled = storeOver();
    const { recording, dispose } = runtimeWith(controlled.store);

    const result = await recording!.recordTransaction(
      input({ direction: "inflow", categoryId: "other-income", description: "  Catering  " }),
    );

    expect(result.status).toBe("success");
    expect(controlled.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "manual-income",
        categoryLabel: "Pemasukan Lain",
        description: "Catering",
      }),
    );
    dispose();
  });

  it("rejects a built-in category from the opposite direction before writing", async () => {
    const controlled = storeOver();
    const { recording, dispose } = runtimeWith(controlled.store);

    const result = await recording!.recordTransaction(
      input({ direction: "inflow", categoryId: "ingredients" }),
    );

    expect(result).toMatchObject({ status: "failure", reason: "invalid-input" });
    expect(controlled.create).not.toHaveBeenCalled();
    dispose();
  });

  it("rejects an unknown category that the domain validator alone would accept", async () => {
    const controlled = storeOver();
    const { recording, dispose } = runtimeWith(controlled.store);

    const result = await recording!.recordTransaction(input({ categoryId: "invented" }));

    expect(issueCodes(result)).toContain(TRANSACTION_ISSUE.unknownCategory);
    expect(controlled.create).not.toHaveBeenCalled();
    dispose();
  });

  it("creates a stable custom id from a required label", async () => {
    const controlled = storeOver();
    const { recording, dispose } = runtimeWith(controlled.store);

    await recording!.recordTransaction(
      input({
        categoryId: CUSTOM_CATEGORY_SELECTION,
        customCategoryLabel: "  Sewa Kios & Acara  ",
      }),
    );

    expect(controlled.create).toHaveBeenCalledWith(
      expect.objectContaining({
        categoryId: "custom:sewa-kios-acara",
        categoryLabel: "Sewa Kios & Acara",
      }),
    );
    dispose();
  });

  it("rejects a custom category with no label before writing", async () => {
    const controlled = storeOver();
    const { recording, dispose } = runtimeWith(controlled.store);

    const result = await recording!.recordTransaction(
      input({ categoryId: CUSTOM_CATEGORY_SELECTION, customCategoryLabel: "   " }),
    );

    expect(issueCodes(result)).toContain(TRANSACTION_ISSUE.customCategoryRequired);
    expect(controlled.create).not.toHaveBeenCalled();
    dispose();
  });

  it("moves the three form-only length limits into logic", async () => {
    const controlled = storeOver();
    const { recording, dispose } = runtimeWith(controlled.store);

    const longDescription = await recording!.recordTransaction(input({ description: "x".repeat(301) }));
    const longReference = await recording!.recordTransaction(input({ referenceNumber: "x".repeat(81) }));
    const longCategory = await recording!.recordTransaction(
      input({ categoryId: CUSTOM_CATEGORY_SELECTION, customCategoryLabel: "x".repeat(81) }),
    );

    expect(issueCodes(longDescription)).toContain(TRANSACTION_ISSUE.descriptionTooLong);
    expect(issueCodes(longReference)).toContain(TRANSACTION_ISSUE.referenceTooLong);
    expect(issueCodes(longCategory)).toContain(TRANSACTION_ISSUE.customCategoryTooLong);
    expect(controlled.create).not.toHaveBeenCalled();
    dispose();
  });

  it("enforces the form's whole non-negative rupiah and attachment rules", async () => {
    const controlled = storeOver();
    const { recording, dispose } = runtimeWith(controlled.store);

    for (const invalid of [
      input({ amount: IDR(-1) }),
      input({ amount: IDR(1.5) }),
      input({
        attachment: {
          id: "a1",
          name: "script.exe",
          mimeType: "application/octet-stream",
          size: 10,
        },
      }),
      input({
        attachment: {
          id: "a2",
          name: "large.pdf",
          mimeType: "application/pdf",
          size: 5 * 1024 * 1024 + 1,
        },
      }),
    ]) {
      const result = await recording!.recordTransaction(invalid);
      expect(result).toMatchObject({ status: "failure", reason: "invalid-input" });
    }
    expect(controlled.create).not.toHaveBeenCalled();
    dispose();
  });
});

// ─── The write is the judge ──────────────────────────────────────────────────

describe("the write is the judge", () => {
  it("maps an authoritative not-found edit distinctly", async () => {
    const controlled = storeOver({ update: { status: "not-found" } });
    const { recording, dispose } = runtimeWith(controlled.store);

    const result = await recording!.updateTransaction("gone", input());

    expect(result).toMatchObject({ status: "failure", reason: "not-found" });
    expect(controlled.update).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("distinguishes automatic and voided edit conflicts", async () => {
    for (const reason of ["automatic", "voided"] as const) {
      const row = stored(planManualTransaction(input()).record, {
        source: reason === "automatic" ? "automatic" : "manual",
        status: reason === "voided" ? "voided" : "posted",
      });
      const controlled = storeOver({
        update: { status: "not-editable", reason, transaction: row },
      });
      const { recording, dispose } = runtimeWith(controlled.store);

      const result = await recording!.updateTransaction("finance-1", input());
      expect(result).toMatchObject({ status: "failure", reason: "conflict" });
      expect(result.status === "failure" ? result.issues[0]?.code : null).toBe(
        reason === "automatic" ? TRANSACTION_ISSUE.automatic : TRANSACTION_ISSUE.voided,
      );
      dispose();
    }
  });

  it("reports whether an idempotent void actually changed anything", async () => {
    const row = stored(planManualTransaction(input()).record, { status: "voided" });
    for (const [commitStatus, alreadyVoided] of [
      ["voided", false],
      ["already-voided", true],
    ] as const) {
      const controlled = storeOver({
        void: { status: commitStatus, transaction: row },
      });
      const { recording, dispose } = runtimeWith(controlled.store);

      const result = await recording!.voidTransaction("finance-1");
      expect(result).toMatchObject({
        status: "success",
        value: { alreadyVoided, transaction: { id: "finance-1", status: "voided" } },
      });
      dispose();
    }
  });

  it("refuses to void an automatic transaction", async () => {
    const row = stored(planManualTransaction(input()).record, { source: "automatic" });
    const controlled = storeOver({ void: { status: "not-voidable", transaction: row } });
    const { recording, dispose } = runtimeWith(controlled.store);

    await expect(recording!.voidTransaction("finance-1")).resolves.toMatchObject({
      status: "failure",
      reason: "conflict",
    });
    dispose();
  });
});

// ─── Honest infrastructure failures ──────────────────────────────────────────

describe("infrastructure failures", () => {
  it("publishes a capability without a store and every call fails honestly", async () => {
    const { recording, dispose } = runtimeWith();
    expect(recording).toBeDefined();
    await expect(recording!.recordTransaction(input())).resolves.toMatchObject({
      status: "failure",
      reason: "unsatisfied-dependency",
    });
    dispose();
  });

  it("keeps store failures distinct from invalid input and not-found", async () => {
    const controlled = storeOver({ fail: "create" });
    const { recording, dispose } = runtimeWith(controlled.store);

    const result = await recording!.recordTransaction(input());
    expect(result).toMatchObject({ status: "failure", reason: "failed" });
    expect(result.status === "failure" ? result.issues[0]?.message : null).toBe(
      "create unavailable",
    );
    dispose();
  });
});
