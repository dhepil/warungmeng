// packages/admin-engine/src/engines/pos/children/session/posSessionChild.ts
//
// Cashier session lifecycle and reconciliation. SOURCE's pure open/close behavior
// is preserved, but double-open becomes an explicit conflict instead of resetting
// an active till because one button happened to disappear.

import type { LogicChildContext, OperationIssue, OperationResult } from "@warungmeng/module-system";
import {
  defineLogicChild,
  operationFailure,
  operationIssue,
  operationSuccess,
  severityForCode,
} from "@warungmeng/module-system";
import type {
  ClosePosSessionInput,
  OpenPosSessionInput,
  PosOperationalState,
  PosOperationalStatePort,
  PosSession,
  PosSessionClosingOutcome,
  PosSessionSnapshot,
} from "../../posContracts";
import {
  POS_ISSUE,
  POS_OPERATIONAL_STATE_PORT,
  POS_SESSION,
  POS_SESSION_ID,
} from "../../posContracts";
import { POS_ENGINE_ID } from "../../posEngine";

const IDR = (amount: number) => ({ amount, currency: "IDR" as const });

function validText(value: string): boolean {
  return value.trim().length > 0;
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function validAmount(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

export function expectedPosCash(openingBalance: number, cashSales: number): number {
  return openingBalance + cashSales;
}

export function projectPosSession(state: PosOperationalState): PosSessionSnapshot {
  const expected =
    state.session.status === "open"
      ? expectedPosCash(state.session.openingBalance.amount, state.cashSales)
      : 0;

  return {
    revision: state.revision,
    session: state.session,
    cashSales: IDR(state.cashSales),
    expectedCash: IDR(expected),
    checkoutSequence: state.checkoutSequence,
    checkoutKey: state.checkoutKey,
    lastCloseRecord: state.lastCloseRecord,
  };
}

function invalidOpenInput(input: OpenPosSessionInput): readonly OperationIssue[] {
  const issues: OperationIssue[] = [];
  if (!validText(input.outlet.id) || !validText(input.outlet.name)) {
    issues.push(
      operationIssue(
        POS_ISSUE.invalidOutlet,
        "POS outlet id and name are required.",
        "outlet",
      ),
    );
  }
  if (!validAmount(input.openingBalance)) {
    issues.push(
      operationIssue(
        POS_ISSUE.invalidAmount,
        "Opening balance must be a non-negative whole IDR amount.",
        "openingBalance",
      ),
    );
  }
  if (!validTimestamp(input.openedAt)) {
    issues.push(
      operationIssue(
        POS_ISSUE.invalidTimestamp,
        "openedAt must be an ISO timestamp.",
        "openedAt",
      ),
    );
  }
  return issues;
}

function invalidCloseInput(input: ClosePosSessionInput): readonly OperationIssue[] {
  const issues: OperationIssue[] = [];
  if (!validAmount(input.actualCash)) {
    issues.push(
      operationIssue(
        POS_ISSUE.invalidAmount,
        "Actual cash must be a non-negative whole IDR amount.",
        "actualCash",
      ),
    );
  }
  if (!validTimestamp(input.closedAt)) {
    issues.push(
      operationIssue(
        POS_ISSUE.invalidTimestamp,
        "closedAt must be an ISO timestamp.",
        "closedAt",
      ),
    );
  }
  return issues;
}

function noState<TValue>(): OperationResult<TValue> {
  return operationFailure("unsatisfied-dependency", [
    operationIssue(
      POS_ISSUE.noState,
      "No POS operational-state store is connected.",
      "posSession",
    ),
  ]);
}

function stateFailed<TValue>(operation: string, error: unknown): OperationResult<TValue> {
  return operationFailure("failed", [
    operationIssue(
      POS_ISSUE.stateFailed,
      error instanceof Error ? error.message : "The POS operational-state store failed.",
      operation,
    ),
  ]);
}

function staleState<TValue>(operation: string): OperationResult<TValue> {
  return operationFailure("conflict", [
    operationIssue(
      POS_ISSUE.staleState,
      "POS state changed while this command was running; reload and retry.",
      operation,
    ),
  ]);
}

function checkoutKeyFor(state: PosOperationalState): string | null {
  return state.session.status === "open"
    ? `pos:${state.session.outlet.id}:${state.session.openedAt}:${state.checkoutSequence}`
    : null;
}

function sessionOverState(port: PosOperationalStatePort): PosSession {
  return {
    async getSession() {
      try {
        return operationSuccess(projectPosSession(await port.load()));
      } catch (error) {
        return stateFailed("getSession", error);
      }
    },

    async beginCheckout() {
      let current: PosOperationalState;
      try {
        current = await port.load();
      } catch (error) {
        return stateFailed("beginCheckout", error);
      }
      const key = current.checkoutKey ?? checkoutKeyFor(current);
      if (key === null) {
        return operationFailure("conflict", [
          operationIssue(POS_ISSUE.sessionAlreadyClosed, "Open a POS session before checkout."),
        ]);
      }
      if (current.checkoutKey === key) {
        return operationSuccess({
          key,
          sequence: current.checkoutSequence,
          stateRevision: current.revision,
        });
      }
      const next = { ...current, revision: current.revision + 1, checkoutKey: key };
      try {
        return (await port.commit(current.revision, next))
          ? operationSuccess({
              key,
              sequence: current.checkoutSequence,
              stateRevision: next.revision,
            })
          : staleState("beginCheckout");
      } catch (error) {
        return stateFailed("beginCheckout", error);
      }
    },

    async openSession(input) {
      const issues = invalidOpenInput(input);
      if (issues.length > 0) return operationFailure("invalid-input", issues);

      let current: PosOperationalState;
      try {
        current = await port.load();
      } catch (error) {
        return stateFailed("openSession", error);
      }

      if (current.session.status === "open") {
        return operationFailure("conflict", [
          operationIssue(
            POS_ISSUE.sessionAlreadyOpen,
            `The POS session for ${current.session.outlet.name} is already open.`,
            current.session.outlet.id,
          ),
        ]);
      }

      const next: PosOperationalState = {
        ...current,
        revision: current.revision + 1,
        session: {
          status: "open",
          outlet: { id: input.outlet.id.trim(), name: input.outlet.name.trim() },
          openingBalance: IDR(input.openingBalance),
          openedAt: input.openedAt,
        },
        cashSales: 0,
        checkoutKey: null,
        lastCloseRecord: null,
      };

      try {
        return (await port.commit(current.revision, next))
          ? operationSuccess(projectPosSession(next))
          : staleState("openSession");
      } catch (error) {
        return stateFailed("openSession", error);
      }
    },

    async closeSession(input) {
      const issues = invalidCloseInput(input);
      if (issues.length > 0) return operationFailure("invalid-input", issues);

      let current: PosOperationalState;
      try {
        current = await port.load();
      } catch (error) {
        return stateFailed("closeSession", error);
      }

      if (current.session.status === "closed") {
        return operationFailure("conflict", [
          operationIssue(
            POS_ISSUE.sessionAlreadyClosed,
            "The POS session is already closed.",
            current.session.outlet.id,
          ),
        ]);
      }

      const expectedCash = expectedPosCash(
        current.session.openingBalance.amount,
        current.cashSales,
      );
      const record = {
        outlet: current.session.outlet,
        openedAt: current.session.openedAt,
        closedAt: input.closedAt,
        openingBalance: current.session.openingBalance,
        cashSales: IDR(current.cashSales),
        expectedCash: IDR(expectedCash),
        actualCash: IDR(input.actualCash),
        variance: IDR(input.actualCash - expectedCash),
      };
      const closed = {
        status: "closed" as const,
        outlet: current.session.outlet,
        openingBalance: IDR(0),
        openedAt: null,
      };
      const next: PosOperationalState = {
        ...current,
        revision: current.revision + 1,
        session: closed,
        cashSales: 0,
        checkoutKey: null,
        lastCloseRecord: record,
      };
      const outcome: PosSessionClosingOutcome = {
        revision: next.revision,
        session: closed,
        record,
        cartItemCount: current.cartItems.length,
      };

      try {
        return (await port.commit(current.revision, next))
          ? operationSuccess(outcome)
          : staleState("closeSession");
      } catch (error) {
        return stateFailed("closeSession", error);
      }
    },
  };
}

function sessionWithoutState(): PosSession {
  return {
    getSession: async () => noState(),
    beginCheckout: async () => noState(),
    openSession: async () => noState(),
    closeSession: async () => noState(),
  };
}

export function createPosSession(context: LogicChildContext): PosSession {
  const port = context.ports.resolve(POS_OPERATIONAL_STATE_PORT);

  if (port === undefined) {
    context.diagnostics.report({
      code: "missing-dependency",
      severity: severityForCode("missing-dependency"),
      message:
        "No POS operational-state store was supplied, so session commands return a normalized " +
        "failure. The capability is published and callers stay working.",
      childId: context.childId,
      engineId: context.parentId,
      source: "posSessionChild",
    });
  }

  const capability = port === undefined ? sessionWithoutState() : sessionOverState(port);
  context.capabilities.provide(POS_SESSION, capability);
  return capability;
}

export default defineLogicChild<PosSession>({
  id: POS_SESSION_ID,
  parentId: POS_ENGINE_ID,
  provides: [POS_SESSION_ID],
  requires: [],
  create: createPosSession,
});
