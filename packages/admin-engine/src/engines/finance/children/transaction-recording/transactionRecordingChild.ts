// packages/admin-engine/src/engines/finance/children/transaction-recording/transactionRecordingChild.ts
//
// Creating, editing and voiding manual finance rows (capability
// `admin.finance.transaction-recording`, required by POS checkout per LOGIC §8).
//
// Ported from SOURCE `useFinanceTransactionEditor.ts`, the conversion hidden in
// `FinanceTransactionEditorDialog.tsx`, and the writes in
// `InMemoryFinanceRepository.ts`. Validation happens completely before the store
// is called, and each store write is the authoritative judge of editability — no
// read-then-write race.

import type { FinanceCategory, FinanceTransaction } from "@warungmeng/domain";
import {
  FINANCE_CATEGORIES,
  validateManualFinanceTransaction,
} from "@warungmeng/domain";
import type { LogicChildContext, OperationIssue, OperationResult } from "@warungmeng/module-system";
import {
  defineLogicChild,
  operationFailure,
  operationIssue,
  operationSuccess,
  severityForCode,
} from "@warungmeng/module-system";
import { FINANCE_ENGINE_ID } from "../../financeEngine";
import type {
  FinanceStorePort,
  ManualTransactionRecord,
  RecordTransactionInput,
  TransactionRecording,
  VoidTransactionOutcome,
} from "../../financeContracts";
import {
  CUSTOM_CATEGORY_LABEL_MAX_LENGTH,
  CUSTOM_CATEGORY_PREFIX,
  CUSTOM_CATEGORY_SELECTION,
  FINANCE_STORE_PORT,
  TRANSACTION_DESCRIPTION_MAX_LENGTH,
  TRANSACTION_RECORDING,
  TRANSACTION_RECORDING_ID,
  TRANSACTION_REFERENCE_MAX_LENGTH,
  TRANSACTION_TYPE_FOR_DIRECTION,
} from "../../financeContracts";

const NO_STORE = "no-finance-store";
const STORE_FAILED = "finance-store-failed";

export const TRANSACTION_ISSUE = {
  invalid: "invalid-finance-transaction",
  unknownCategory: "unknown-finance-category",
  customCategoryRequired: "custom-category-required",
  customCategoryTooLong: "custom-category-too-long",
  descriptionTooLong: "finance-description-too-long",
  referenceTooLong: "finance-reference-too-long",
  notFound: "finance-transaction-not-found",
  automatic: "automatic-transaction-read-only",
  voided: "voided-transaction-read-only",
} as const;

function customCategoryId(label: string): string {
  const slug = label
    .trim()
    .toLocaleLowerCase("id-ID")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${CUSTOM_CATEGORY_PREFIX}${slug || "other"}`;
}

interface PlannedTransaction {
  readonly record: ManualTransactionRecord;
  readonly issues: readonly OperationIssue[];
}

/**
 * Converts and validates exactly what the store will receive, without writing.
 *
 * SOURCE's dialog made the invalid built-in-category case unreachable by offering
 * only categories matching the selected direction and clearing the choice when
 * direction changed. The domain validator alone is not enough: it checks direction
 * only if it recognizes the id, so an unknown id silently passes. This planner
 * closes both gaps before any adapter sees the input.
 */
export function planManualTransaction(input: RecordTransactionInput): PlannedTransaction {
  const issues: OperationIssue[] = [];
  const description = input.description.trim();
  const referenceNumber = input.referenceNumber.trim();
  const customLabel = input.customCategoryLabel?.trim() ?? "";

  let categoryId = input.categoryId;
  let categoryLabel = "";

  if (input.categoryId === CUSTOM_CATEGORY_SELECTION) {
    if (customLabel === "") {
      issues.push(
        operationIssue(
          TRANSACTION_ISSUE.customCategoryRequired,
          "A custom category needs a name.",
          "customCategoryLabel",
        ),
      );
    } else if (customLabel.length > CUSTOM_CATEGORY_LABEL_MAX_LENGTH) {
      issues.push(
        operationIssue(
          TRANSACTION_ISSUE.customCategoryTooLong,
          `A custom category name may contain at most ${CUSTOM_CATEGORY_LABEL_MAX_LENGTH} characters.`,
          "customCategoryLabel",
          { maximum: CUSTOM_CATEGORY_LABEL_MAX_LENGTH, actual: customLabel.length },
        ),
      );
    }
    categoryId = customCategoryId(customLabel);
    categoryLabel = customLabel;
  } else {
    const category: FinanceCategory | undefined = FINANCE_CATEGORIES.find(
      (entry) => entry.id === input.categoryId,
    );
    if (category === undefined) {
      issues.push(
        operationIssue(
          TRANSACTION_ISSUE.unknownCategory,
          `Finance category ${input.categoryId || "(blank)"} was not found.`,
          "categoryId",
        ),
      );
    } else {
      categoryLabel = category.label;
      if (category.direction !== input.direction) {
        issues.push(
          operationIssue(
            TRANSACTION_ISSUE.invalid,
            "The finance category does not match the transaction direction.",
            "categoryId",
          ),
        );
      }
    }
  }

  if (description.length > TRANSACTION_DESCRIPTION_MAX_LENGTH) {
    issues.push(
      operationIssue(
        TRANSACTION_ISSUE.descriptionTooLong,
        `A description may contain at most ${TRANSACTION_DESCRIPTION_MAX_LENGTH} characters.`,
        "description",
        { maximum: TRANSACTION_DESCRIPTION_MAX_LENGTH, actual: description.length },
      ),
    );
  }
  if (referenceNumber.length > TRANSACTION_REFERENCE_MAX_LENGTH) {
    issues.push(
      operationIssue(
        TRANSACTION_ISSUE.referenceTooLong,
        `A reference number may contain at most ${TRANSACTION_REFERENCE_MAX_LENGTH} characters.`,
        "referenceNumber",
        { maximum: TRANSACTION_REFERENCE_MAX_LENGTH, actual: referenceNumber.length },
      ),
    );
  }

  const record: ManualTransactionRecord = {
    occurredAt: input.occurredAt,
    direction: input.direction,
    type: TRANSACTION_TYPE_FOR_DIRECTION[input.direction],
    status: input.status,
    categoryId,
    categoryLabel,
    amount: { ...input.amount },
    paymentMethod: input.paymentMethod,
    description,
    referenceNumber,
    attachment: input.attachment ? { ...input.attachment } : null,
  };

  const domainErrors = validateManualFinanceTransaction(record);
  for (const [subject, message] of Object.entries(domainErrors)) {
    issues.push(operationIssue(TRANSACTION_ISSUE.invalid, message, subject));
  }

  return { record, issues };
}

function noStore<TValue>(operation: string): OperationResult<TValue> {
  return operationFailure("unsatisfied-dependency", [
    operationIssue(NO_STORE, "No finance store is connected.", operation),
  ]);
}

function storeFailed<TValue>(operation: string, error: unknown): OperationResult<TValue> {
  return operationFailure("failed", [
    operationIssue(
      STORE_FAILED,
      error instanceof Error ? error.message : "The finance store failed.",
      operation,
    ),
  ]);
}

function invalidPlan<TValue>(plan: PlannedTransaction): OperationResult<TValue> | null {
  return plan.issues.length > 0 ? operationFailure("invalid-input", plan.issues) : null;
}

function transactionRecordingOverStore(store: FinanceStorePort): TransactionRecording {
  return {
    async recordTransaction(input): Promise<OperationResult<FinanceTransaction>> {
      const plan = planManualTransaction(input);
      const invalid = invalidPlan<FinanceTransaction>(plan);
      if (invalid) return invalid;

      try {
        return operationSuccess(await store.createManualTransaction(plan.record));
      } catch (error) {
        return storeFailed("recordTransaction", error);
      }
    },

    async updateTransaction(transactionId, input): Promise<OperationResult<FinanceTransaction>> {
      const plan = planManualTransaction(input);
      const invalid = invalidPlan<FinanceTransaction>(plan);
      if (invalid) return invalid;

      try {
        const commit = await store.updateManualTransaction(transactionId, plan.record);
        if (commit.status === "updated") return operationSuccess(commit.transaction);
        if (commit.status === "not-found") {
          return operationFailure("not-found", [
            operationIssue(
              TRANSACTION_ISSUE.notFound,
              `Finance transaction ${transactionId} was not found.`,
              transactionId,
            ),
          ]);
        }
        return operationFailure("conflict", [
          operationIssue(
            commit.reason === "automatic"
              ? TRANSACTION_ISSUE.automatic
              : TRANSACTION_ISSUE.voided,
            commit.reason === "automatic"
              ? "An automatic transaction is derived from its order and cannot be edited."
              : "A voided transaction cannot be edited.",
            transactionId,
          ),
        ]);
      } catch (error) {
        return storeFailed("updateTransaction", error);
      }
    },

    async voidTransaction(transactionId): Promise<OperationResult<VoidTransactionOutcome>> {
      try {
        const commit = await store.voidManualTransaction(transactionId);
        if (commit.status === "not-found") {
          return operationFailure("not-found", [
            operationIssue(
              TRANSACTION_ISSUE.notFound,
              `Finance transaction ${transactionId} was not found.`,
              transactionId,
            ),
          ]);
        }
        if (commit.status === "not-voidable") {
          return operationFailure("conflict", [
            operationIssue(
              TRANSACTION_ISSUE.automatic,
              "An automatic transaction is derived from its order and cannot be voided.",
              transactionId,
            ),
          ]);
        }
        return operationSuccess({
          transaction: commit.transaction,
          alreadyVoided: commit.status === "already-voided",
        });
      } catch (error) {
        return storeFailed("voidTransaction", error);
      }
    },
  };
}

function transactionRecordingWithoutStore(): TransactionRecording {
  return {
    recordTransaction: async () => noStore("recordTransaction"),
    updateTransaction: async () => noStore("updateTransaction"),
    voidTransaction: async () => noStore("voidTransaction"),
  };
}

export function createTransactionRecording(context: LogicChildContext): TransactionRecording {
  const store = context.ports.resolve(FINANCE_STORE_PORT);
  if (store === undefined) {
    context.diagnostics.report({
      code: "missing-dependency",
      severity: severityForCode("missing-dependency"),
      message:
        "No finance store was supplied, so transaction writes return normalized failures. " +
        "The capability remains published and callers stay working.",
      childId: context.childId,
      engineId: context.parentId,
      source: "transactionRecordingChild",
    });
  }

  const capability =
    store === undefined ? transactionRecordingWithoutStore() : transactionRecordingOverStore(store);
  context.capabilities.provide(TRANSACTION_RECORDING, capability);
  return capability;
}

export default defineLogicChild<TransactionRecording>({
  id: TRANSACTION_RECORDING_ID,
  parentId: FINANCE_ENGINE_ID,
  provides: [TRANSACTION_RECORDING_ID],
  create: createTransactionRecording,
});
