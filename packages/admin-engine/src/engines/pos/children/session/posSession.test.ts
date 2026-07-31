// Protected cashier session lifecycle through the real capability graph.

import { describe, expect, it } from "vitest";
import { defineLogicChild } from "@warungmeng/module-system";
import type { AdminEngineSnapshot } from "../../../../adminEngineContracts";
import { createAdminEngine } from "../../../../createAdminEngine";
import type {
  PosOperationalState,
  PosOperationalStatePort,
  PosSession,
} from "../../posContracts";
import {
  POS_ISSUE,
  POS_OPERATIONAL_STATE_PORT,
  POS_SESSION,
  POS_SESSION_ID,
} from "../../posContracts";
import posEngine from "../../posEngine";
import posSessionChild, { expectedPosCash } from "./posSessionChild";

const outlet = { id: "wm-1", name: "WARUNG MENG" };
const IDR = (amount: number) => ({ amount, currency: "IDR" as const });

function initial(overrides: Partial<PosOperationalState> = {}): PosOperationalState {
  return {
    revision: 0,
    session: { status: "closed", outlet, openingBalance: IDR(0), openedAt: null },
    cartItems: [],
    cashSales: 0,
    checkoutSequence: 1,
    checkoutKey: null,
    lastCloseRecord: null,
    ...overrides,
  };
}

function statePort(seed = initial()): PosOperationalStatePort & {
  read(): PosOperationalState;
  rejectNext(): void;
} {
  let state = seed;
  let reject = false;
  return {
    load: async () => state,
    commit: async (expectedRevision, next) => {
      if (reject || expectedRevision !== state.revision) {
        reject = false;
        return false;
      }
      state = next;
      return true;
    },
    read: () => state,
    rejectNext: () => {
      reject = true;
    },
  };
}

function runtimeWith(port?: PosOperationalStatePort): {
  readonly session: PosSession | undefined;
  readonly snapshot: AdminEngineSnapshot;
  readonly dispose: () => void;
} {
  let captured: PosSession | undefined;
  const probe = defineLogicChild({
    id: "admin.pos.test-session-probe",
    parentId: posEngine.id,
    requires: [POS_SESSION_ID],
    create(context) {
      const result = context.capabilities.resolve(POS_SESSION);
      if (result.status === "available") captured = result.value;
      return undefined;
    },
  });
  const runtime = createAdminEngine({
    definitions: { engines: [posEngine], children: [posSessionChild, probe] },
    ports: {
      resolve: (token) =>
        token.id === POS_OPERATIONAL_STATE_PORT.id && port !== undefined
          ? (port as never)
          : undefined,
    },
  });
  return { session: captured, snapshot: runtime.getSnapshot(), dispose: runtime.dispose };
}

describe("POS session", () => {
  it("publishes admin.pos.session through a requiring probe", () => {
    const { session, dispose } = runtimeWith(statePort());
    expect(session).toBeDefined();
    expect(POS_SESSION_ID).toBe("admin.pos.session");
    dispose();
  });

  it("opens once with a whole non-negative balance and resets till counters", async () => {
    const port = statePort(initial({ cashSales: 50_000, checkoutKey: "stale" }));
    const { session, dispose } = runtimeWith(port);

    const result = await session!.openSession({
      outlet,
      openingBalance: 100_000,
      openedAt: "2026-08-01T02:00:00.000Z",
    });

    expect(result).toMatchObject({
      status: "success",
      value: {
        revision: 1,
        session: { status: "open", openingBalance: { amount: 100_000 } },
        cashSales: { amount: 0 },
        expectedCash: { amount: 100_000 },
      },
    });
    expect(port.read()).toMatchObject({ cashSales: 0, checkoutKey: null });
    dispose();
  });

  it("rejects double-open instead of resetting an active till", async () => {
    const port = statePort(
      initial({
        revision: 4,
        session: {
          status: "open",
          outlet,
          openingBalance: IDR(25_000),
          openedAt: "2026-08-01T02:00:00.000Z",
        },
        cashSales: 7_000,
      }),
    );
    const { session, dispose } = runtimeWith(port);

    const result = await session!.openSession({
      outlet,
      openingBalance: 0,
      openedAt: "2026-08-01T03:00:00.000Z",
    });

    expect(result).toMatchObject({
      status: "failure",
      reason: "conflict",
      issues: [{ code: POS_ISSUE.sessionAlreadyOpen }],
    });
    expect(port.read()).toMatchObject({ revision: 4, cashSales: 7_000 });
    dispose();
  });

  it("validates money, outlet and timestamps before persistence", async () => {
    const port = statePort();
    const { session, dispose } = runtimeWith(port);

    const result = await session!.openSession({
      outlet: { id: " ", name: "" },
      openingBalance: 1.5,
      openedAt: "not-a-date",
    });

    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining([
          POS_ISSUE.invalidOutlet,
          POS_ISSUE.invalidAmount,
          POS_ISSUE.invalidTimestamp,
        ]),
      );
    }
    expect(port.read().revision).toBe(0);
    dispose();
  });

  it("closes with exact expected cash and signed variance, while leaving cart ownership alone", async () => {
    const port = statePort(
      initial({
        revision: 8,
        session: {
          status: "open",
          outlet,
          openingBalance: IDR(100_000),
          openedAt: "2026-08-01T02:00:00.000Z",
        },
        cartItems: [
          {
            id: "line-1",
            menuItemId: "menu-1",
            name: "Tea",
            unitPrice: IDR(5_000),
            variantSelections: [],
            quantity: 1,
            note: "",
          },
        ],
        cashSales: 55_000,
        checkoutKey: "session:1",
      }),
    );
    const { session, dispose } = runtimeWith(port);

    const result = await session!.closeSession({
      actualCash: 150_000,
      closedAt: "2026-08-01T10:00:00.000Z",
    });

    expect(result).toMatchObject({
      status: "success",
      value: {
        revision: 9,
        session: { status: "closed" },
        cartItemCount: 1,
        record: {
          cashSales: { amount: 55_000 },
          expectedCash: { amount: 155_000 },
          actualCash: { amount: 150_000 },
          variance: { amount: -5_000 },
        },
      },
    });
    expect(port.read().cartItems).toHaveLength(1);
    expect(port.read()).toMatchObject({ cashSales: 0, checkoutKey: null });
    dispose();
  });

  it("rejects closing twice and rejects stale compare-and-set commits", async () => {
    const closedPort = statePort();
    const closedRuntime = runtimeWith(closedPort);
    expect(
      await closedRuntime.session!.closeSession({
        actualCash: 0,
        closedAt: "2026-08-01T10:00:00.000Z",
      }),
    ).toMatchObject({
      status: "failure",
      issues: [{ code: POS_ISSUE.sessionAlreadyClosed }],
    });
    closedRuntime.dispose();

    const stalePort = statePort();
    stalePort.rejectNext();
    const staleRuntime = runtimeWith(stalePort);
    expect(
      await staleRuntime.session!.openSession({
        outlet,
        openingBalance: 0,
        openedAt: "2026-08-01T02:00:00.000Z",
      }),
    ).toMatchObject({ status: "failure", issues: [{ code: POS_ISSUE.staleState }] });
    expect(stalePort.read().session.status).toBe("closed");
    staleRuntime.dispose();
  });

  it("still publishes without a port and reports that missing port once", async () => {
    const { session, snapshot, dispose } = runtimeWith();
    expect(await session!.getSession()).toMatchObject({
      status: "failure",
      reason: "unsatisfied-dependency",
    });
    const area = snapshot.areas.find((entry) => entry.engineId === posEngine.id);
    expect(area?.unavailableChildIds).not.toContain(POS_SESSION_ID);
    expect(
      snapshot.diagnostics.filter(
        (entry) => entry.source === "posSessionChild" && entry.code === "missing-dependency",
      ),
    ).toHaveLength(1);
    dispose();
  });

  it("calculates expected cash as opening balance plus cash sales", () => {
    expect(expectedPosCash(100_000, 55_000)).toBe(155_000);
  });
});
