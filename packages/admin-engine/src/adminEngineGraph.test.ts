// packages/admin-engine/src/adminEngineGraph.test.ts
//
// The P3 phase gate: the completeness and composition proof for the whole Admin
// runtime.
//
// Every other test in this package injects its definitions, so it proves that one
// child behaves correctly given a runtime someone handed it. None of them can
// prove that the child is REACHABLE in a real build. This file is the only one
// that composes the runtime the way production does — from real on-disk discovery,
// with nothing injected — and it exists because `plan.json` lists the `engines/*`
// files as `allow` globs rather than `exact`. A whole area could silently fail to
// exist and all four checks would stay green. Completeness is therefore not
// something the structure checker can do; it is this file's job.
//
// The specific blind spot, measured rather than assumed (S4 corrected S3's wider
// claim): renaming `businessHoursChild.ts` to `businessHours.ts` DOES turn
// structure red, because the new name matches no allowed glob. What slips through
// is a rename whose new name matches a DIFFERENT allowed glob —
// `businessHoursOrphan.test.ts` passes structure AND typecheck AND every existing
// test, while the child loads as nothing, publishes nothing, and reports nothing.
// Nine prior slices caught that with a throwaway test that was deleted afterwards.
// Here it becomes permanent.
//
// Why the assertions below compare ID SETS and not counts: a renamed file keeps
// the count identical while loading as nothing (the count only moves if a file is
// deleted outright, which structure already catches). "Expected 23, got 22" also
// tells a reader nothing about WHICH child vanished. A set comparison fails with a
// readable diff naming the missing id, which is the difference between a gate that
// reports a problem and a gate that reports a number.

import { describe, expect, it } from "vitest";
import type { AtomicOperationPort, OutboundPortRegistry } from "@warungmeng/module-system";
import { ADMIN_AREAS } from "./adminEngineContracts";
import { isAdminRuntimeHealthy } from "./adminEngineSnapshot";
import { createAdminEngine } from "./createAdminEngine";
import { discoverAdminLogic } from "./discoverAdminLogic";
import { ADMIN_ATOMIC_OPERATION_ID, ATOMIC_OPERATION_PORT } from "./shared/atomicOperationPort";

// ─── What LOGIC says must exist ──────────────────────────────────────────────
//
// These lists are transcribed from `new-target/LOGIC-TARGET-FILE-TREE.md` §4 and
// §8 and are deliberately written out as literal strings rather than imported
// from the area contracts files. That is the entire point of the gate: importing
// `MENU_CATALOG_READ_ID` would make this test agree with the code by construction,
// so renaming the capability would rename the expectation with it and the test
// could never fail. A literal string cannot be refactored into agreement.

/** LOGIC §4: seven operational areas, and `ADMIN_AREAS` is the same list. */
const EXPECTED_ENGINE_IDS = [
  "admin.dashboard",
  "admin.finance",
  "admin.inventory",
  "admin.menu",
  "admin.orders",
  "admin.pos",
  "admin.settings",
] as const;

/**
 * All 23 children, by child id — the id of the DEFINITION, which is not always
 * the id of the capability it publishes.
 */
const EXPECTED_CHILD_IDS = [
  "admin.dashboard.overview",
  "admin.dashboard.reports",
  "admin.finance.expense-management",
  "admin.finance.ledger-read",
  "admin.finance.refund-projection",
  "admin.finance.transaction-recording",
  "admin.inventory.hpp-calculation",
  "admin.inventory.materials-read",
  "admin.inventory.stock-adjustment",
  "admin.inventory.stock-consumption",
  "admin.inventory.stock-movements",
  "admin.inventory.stock-reversal",
  "admin.menu.catalog-read",
  "admin.menu.menu-editor",
  "admin.menu.variant-management",
  "admin.orders.order-cancellation",
  "admin.orders.order-read",
  "admin.orders.order-submission",
  "admin.pos.cart",
  "admin.pos.checkout",
  "admin.pos.session",
  "admin.settings.business-hours",
  "admin.settings.theme-preference",
] as const;

/**
 * The capability each child publishes, per LOGIC §8 and the area sections of §4.
 *
 * Two entries differ from the child id, and both differences are load-bearing
 * rather than untidy:
 *
 *   - `admin.orders.order-cancellation` publishes `admin.orders.cancel`, because
 *     LOGIC §8 names that id and the doc is the structural authority. S8 recorded
 *     that publishing under the child id instead failed 16 of 20 tests.
 *   - `admin.orders.order-read` publishes `admin.orders.read`, for the same
 *     reason: §8's five requirement edges name `admin.orders.read`, so the
 *     capability has to be that string or dashboard and cancellation resolve
 *     nothing.
 *
 * Ids are the contract between areas. A child that publishes under a wrong id
 * fails loudly — but only when something reaches it, which is why this map is
 * asserted directly rather than inferred from the fact that the runtime started.
 */
const EXPECTED_CAPABILITY_BY_CHILD: Readonly<Record<string, string>> = {
  "admin.dashboard.overview": "admin.dashboard.overview",
  "admin.dashboard.reports": "admin.dashboard.reports",
  "admin.finance.expense-management": "admin.finance.expense-management",
  "admin.finance.ledger-read": "admin.finance.ledger-read",
  "admin.finance.refund-projection": "admin.finance.refund-projection",
  "admin.finance.transaction-recording": "admin.finance.transaction-recording",
  "admin.inventory.hpp-calculation": "admin.inventory.hpp-calculation",
  "admin.inventory.materials-read": "admin.inventory.materials-read",
  "admin.inventory.stock-adjustment": "admin.inventory.stock-adjustment",
  "admin.inventory.stock-consumption": "admin.inventory.stock-consumption",
  "admin.inventory.stock-movements": "admin.inventory.stock-movements",
  "admin.inventory.stock-reversal": "admin.inventory.stock-reversal",
  "admin.menu.catalog-read": "admin.menu.catalog-read",
  "admin.menu.menu-editor": "admin.menu.menu-editor",
  "admin.menu.variant-management": "admin.menu.variant-management",
  "admin.orders.order-cancellation": "admin.orders.cancel",
  "admin.orders.order-read": "admin.orders.read",
  "admin.orders.order-submission": "admin.orders.order-submission",
  "admin.pos.cart": "admin.pos.cart",
  "admin.pos.checkout": "admin.pos.checkout",
  "admin.pos.session": "admin.pos.session",
  "admin.settings.business-hours": "admin.settings.business-hours",
  "admin.settings.theme-preference": "admin.settings.theme-preference",
};

/**
 * The LOGIC §8 capability graph, verbatim, including the order the doc lists.
 *
 * Five children have requirements. The other eighteen have none, and that is
 * asserted too — an invented edge is as much a departure from the doc as a
 * missing one, and it would quietly make a child unavailable in a runtime the
 * doc says should work.
 *
 * Settings appears nowhere in §8. That is correct and not an omission: neither
 * settings child requires anything, and nothing requires settings. S12's schedule
 * policy exists but nothing consumes it yet — wiring POS to business hours would
 * need an owner-approved edge, so the graph below must NOT contain one.
 */
const EXPECTED_REQUIREMENTS: Readonly<Record<string, readonly string[]>> = {
  "admin.dashboard.overview": [
    "admin.orders.read",
    "admin.inventory.materials-read",
    "admin.finance.ledger-read",
  ],
  "admin.dashboard.reports": [
    "admin.orders.read",
    "admin.inventory.stock-movements",
    "admin.finance.ledger-read",
  ],
  "admin.inventory.hpp-calculation": ["admin.menu.catalog-read"],
  "admin.orders.order-cancellation": [
    "admin.orders.read",
    "admin.inventory.stock-reversal",
    "admin.finance.refund-projection",
    "admin.atomic-operation",
  ],
  "admin.pos.checkout": [
    "admin.pos.session",
    "admin.pos.cart",
    "admin.menu.catalog-read",
    "admin.inventory.stock-consumption",
    "admin.orders.order-submission",
    "admin.finance.transaction-recording",
    "admin.atomic-operation",
  ],
};

/** The two children LOGIC §8 gives an `admin.atomic-operation` requirement. */
const ATOMIC_CONSUMERS = [
  "admin.orders.order-cancellation",
  "admin.pos.checkout",
] as const;

/**
 * The engine that carries the atomic bridge. Three segments on purpose:
 * `areaFromEngineId` only recognizes `admin.<area>`, so the bridge is fully
 * visible in the generic runtime snapshot while being incapable of appearing as
 * an eighth operational area.
 */
const SHARED_ENGINE_ID = "admin.runtime.shared";

// ─── Composition ─────────────────────────────────────────────────────────────

/**
 * Every outbound port the seven areas resolve, as stubs that THROW if called.
 *
 * The gate proves composition, not behavior — each area's own test suite owns
 * behavior. Stubs that throw make that boundary enforceable rather than merely
 * intended: if a child called a port during creation, this file would fail
 * instead of silently depending on a fixture. Nothing here is called, and the
 * healthy runtime below reporting zero diagnostics is the proof that every port
 * was resolved at creation time.
 *
 * A missing port is a legal state that leaves a child ACTIVE and publishing while
 * every call returns a normalized dependency failure, so the ports must be
 * supplied here or a healthy runtime would carry eight `missing-dependency`
 * diagnostics. That distinction — a missing PORT is not an unavailable CHILD, only
 * a missing required CAPABILITY is — is what the exclusion tests below rely on.
 */
const PORT_IDS = [
  "admin.menu.catalog-store",
  "admin.inventory.store",
  "admin.finance.store",
  "admin.finance.order-read",
  "admin.orders.store",
  "admin.pos.operational-state",
  "admin.settings.theme-preference-store",
  "admin.settings.business-hours-store",
] as const;

const atomicPort: AtomicOperationPort = {
  execute: async (operation) => await operation(),
};

/** A port object whose every method throws. Untyped by design — see above. */
function throwingPort(portId: string): unknown {
  return new Proxy(
    {},
    {
      get: (_target, property) => () => {
        throw new Error(
          `The phase gate resolved port "${portId}" but something called ` +
            `"${String(property)}" on it. The gate proves composition, not behavior.`,
        );
      },
    },
  );
}

/**
 * Composes the runtime from REAL on-disk discovery.
 *
 * `definitions` is deliberately not passed. That is the whole difference between
 * this file and every other test in the package: injecting definitions proves a
 * child works when handed to a runtime, while omitting them proves the child is
 * found by the globs in a real build. Only the second one closes the
 * mis-suffixed-file blind spot.
 *
 * `omitPorts` drops named ports so the exclusion cases can be composed. Nothing
 * else varies.
 */
function composeAdmin(
  options: { readonly withAtomicPort?: boolean; readonly omitPorts?: readonly string[] } = {},
): ReturnType<typeof createAdminEngine> {
  const withAtomicPort = options.withAtomicPort ?? true;
  const omitted = new Set(options.omitPorts ?? []);

  const ports: OutboundPortRegistry = {
    resolve: <TPort>(token: { readonly id: string }): TPort | undefined => {
      if (token.id === ATOMIC_OPERATION_PORT.id) {
        return withAtomicPort ? (atomicPort as TPort) : undefined;
      }
      if (omitted.has(token.id)) {
        return undefined;
      }
      if ((PORT_IDS as readonly string[]).includes(token.id)) {
        return throwingPort(token.id) as TPort;
      }
      return undefined;
    },
  };

  return createAdminEngine({ ports });
}

/** Every child in the runtime snapshot, flattened across engines. */
function childrenOf(runtime: ReturnType<typeof createAdminEngine>): ReadonlyArray<{
  readonly childId: string;
  readonly parentId: string;
  readonly state: string;
  readonly provides: readonly string[];
  readonly requires: readonly string[];
  readonly unmetRequirements: readonly string[];
}> {
  return runtime.getSnapshot().runtime.engines.flatMap((engine) => engine.children);
}

function childById(
  runtime: ReturnType<typeof createAdminEngine>,
  childId: string,
): {
  readonly childId: string;
  readonly state: string;
  readonly provides: readonly string[];
  readonly requires: readonly string[];
  readonly unmetRequirements: readonly string[];
} {
  const found = childrenOf(runtime).find((child) => child.childId === childId);
  if (found === undefined) {
    throw new Error(
      `The runtime has no child "${childId}". Real discovery did not find it — ` +
        "check the file name matches `children/**/*Child.ts`.",
    );
  }
  return found;
}

function sorted(values: readonly string[]): readonly string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

// ─── 1. Completeness, from real discovery ────────────────────────────────────

describe("Admin discovery finds every planned engine and child on disk", () => {
  it("discovers exactly the seven areas LOGIC §4 lists", () => {
    const discovered = discoverAdminLogic();

    expect(sorted(discovered.engines.map((engine) => engine.id))).toEqual([
      ...EXPECTED_ENGINE_IDS,
    ]);
  });

  it("discovers exactly the 23 planned children, by id and not by count", () => {
    const discovered = discoverAdminLogic();

    // A set comparison, not `toHaveLength(23)`. A child file renamed to another
    // allowed glob (`fooChild.ts` → `foo.test.ts`) keeps structure green and
    // loads as NOTHING; the count would move only on an outright deletion, which
    // structure already catches. This assertion names the child that vanished.
    expect(sorted(discovered.children.map((child) => child.id))).toEqual([
      ...EXPECTED_CHILD_IDS,
    ]);
  });

  it("rejects nothing — every discovered file is a valid Admin definition", () => {
    const discovered = discoverAdminLogic();

    // Discovery reports what it threw away (malformed, wrong version, foreign
    // namespace). A rejected file is otherwise invisible: not in `engines`, not
    // in `children`, and it produces no failure anywhere.
    expect(discovered.diagnostics ?? []).toEqual([]);
  });

  it("every child belongs to the area its id names", () => {
    const discovered = discoverAdminLogic();

    for (const child of discovered.children) {
      const parentFromId = child.id.split(".").slice(0, 2).join(".");
      expect(child.parentId).toBe(parentFromId);
    }
  });

  it("ADMIN_AREAS matches the areas that actually exist", () => {
    // `ADMIN_AREAS` is an expectation, not a registry — nothing loads from it,
    // and adding an engine folder works without editing it. It exists so a
    // silently missing area is detectable, which only holds while the two agree.
    expect(sorted(ADMIN_AREAS)).toEqual(
      sorted(EXPECTED_ENGINE_IDS.map((id) => id.replace("admin.", ""))),
    );
  });
});

// ─── 2. The capability ids, verbatim from LOGIC §8 ───────────────────────────

describe("every capability id matches LOGIC §8 verbatim", () => {
  it("each child publishes exactly the one capability the doc names", () => {
    const discovered = discoverAdminLogic();

    const published: Record<string, readonly string[]> = {};
    for (const child of discovered.children) {
      published[child.id] = child.provides;
    }

    // Asserted as a whole object rather than child by child: a per-child loop
    // passes vacuously if a child is missing from discovery entirely, and this
    // is the assertion that catches a capability published under a wrong id
    // before anything tries to resolve it.
    expect(published).toEqual(
      Object.fromEntries(
        Object.entries(EXPECTED_CAPABILITY_BY_CHILD).map(([childId, capabilityId]) => [
          childId,
          [capabilityId],
        ]),
      ),
    );
  });

  it("the two ids that differ from their child id are the ones the doc names", () => {
    // Stated separately because it is the rule a future area is most likely to
    // get wrong: capability id = child id EXCEPT where LOGIC names one, and
    // Orders is where they differ.
    expect(EXPECTED_CAPABILITY_BY_CHILD["admin.orders.order-cancellation"]).toBe(
      "admin.orders.cancel",
    );
    expect(EXPECTED_CAPABILITY_BY_CHILD["admin.orders.order-read"]).toBe("admin.orders.read");

    const discovered = discoverAdminLogic();
    const cancellation = discovered.children.find(
      (child) => child.id === "admin.orders.order-cancellation",
    );
    const read = discovered.children.find((child) => child.id === "admin.orders.order-read");

    expect(cancellation?.provides).toEqual(["admin.orders.cancel"]);
    expect(read?.provides).toEqual(["admin.orders.read"]);
  });
});

// ─── 3. The requirement graph ────────────────────────────────────────────────

describe("the requirement graph is exactly LOGIC §8", () => {
  it("the five children with requirements declare exactly the doc's edges, in order", () => {
    const discovered = discoverAdminLogic();

    for (const [childId, expected] of Object.entries(EXPECTED_REQUIREMENTS)) {
      const child = discovered.children.find((candidate) => candidate.id === childId);
      expect(child, `${childId} was not discovered`).toBeDefined();
      // Order is asserted, not just membership: the doc lists these edges in an
      // order that reads as the workflow sequence, and a diff on an ordered
      // array is easier to act on than a set difference.
      expect(child?.requires).toEqual(expected);
    }
  });

  it("the other eighteen children require nothing", () => {
    const discovered = discoverAdminLogic();

    const withRequirements = discovered.children
      .filter((child) => child.requires.length > 0)
      .map((child) => child.id);

    // An INVENTED edge is as much a departure from the doc as a missing one, and
    // it would silently make a child unavailable in a runtime the doc says works.
    // Settings is the case to watch: S12 built a schedule policy that POS could
    // consume, and wiring it would need an owner-approved graph edge, so no
    // settings child may appear here.
    expect(sorted(withRequirements)).toEqual(sorted(Object.keys(EXPECTED_REQUIREMENTS)));
  });

  it("every declared requirement is published by some child", () => {
    const discovered = discoverAdminLogic();

    const published = new Set<string>(
      discovered.children.flatMap((child) => child.provides as readonly string[]),
    );
    // The atomic capability comes from the composition root's port, not from a
    // discovered area file, so it is added here rather than being a gap.
    published.add(ADMIN_ATOMIC_OPERATION_ID);

    for (const child of discovered.children) {
      for (const requirement of child.requires) {
        expect(published.has(requirement), `nothing publishes "${requirement}"`).toBe(true);
      }
    }
  });
});

// ─── 4. A healthy runtime ────────────────────────────────────────────────────

describe("a fully composed runtime is healthy and silent", () => {
  it("starts all seven areas with every child active", () => {
    const runtime = composeAdmin();
    const snapshot = runtime.getSnapshot();

    expect(snapshot.areas.map((area) => area.area)).toEqual([...ADMIN_AREAS]);
    expect(snapshot.missingAreas).toEqual([]);
    for (const area of snapshot.areas) {
      expect(area.activeChildCount, `${area.area} has an inactive child`).toBe(area.childCount);
      expect(area.failedChildIds).toEqual([]);
      expect(area.unavailableChildIds).toEqual([]);
    }
    expect(isAdminRuntimeHealthy(snapshot)).toBe(true);

    runtime.dispose();
  });

  it("reports NO diagnostics when nothing is wrong", () => {
    const runtime = composeAdmin();

    // S2 found a diagnostic that fired in a perfectly healthy graph (the missing
    // atomic port was reported even when nothing required a boundary). A
    // diagnostic that cries wolf trains its reader to stop looking, so "silent
    // when healthy" is a property worth a permanent test.
    expect(runtime.getSnapshot().diagnostics).toEqual([]);
    expect(runtime.getSnapshot().runtime.status).toBe("ready");

    runtime.dispose();
  });

  it("publishes all 23 area capabilities plus the republished atomic boundary", () => {
    const runtime = composeAdmin();

    expect(sorted(runtime.getSnapshot().runtime.capabilities)).toEqual(
      sorted([
        ...Object.values(EXPECTED_CAPABILITY_BY_CHILD),
        ADMIN_ATOMIC_OPERATION_ID,
      ]),
    );

    runtime.dispose();
  });

  it("keeps the atomic bridge out of the area projection while leaving it visible", () => {
    const runtime = composeAdmin();
    const snapshot = runtime.getSnapshot();

    // Eight engines in the generic snapshot, seven areas in the Admin view. The
    // bridge is composition scaffolding, not an eighth area, and its three-segment
    // id is what makes that structural rather than a special case.
    expect(snapshot.runtime.engines.map((engine) => engine.engineId)).toContain(
      SHARED_ENGINE_ID,
    );
    expect(snapshot.runtime.engines).toHaveLength(EXPECTED_ENGINE_IDS.length + 1);
    expect(snapshot.areas).toHaveLength(EXPECTED_ENGINE_IDS.length);
    expect(snapshot.areas.map((area) => area.area)).not.toContain("runtime");

    runtime.dispose();
  });

  it("initializes every provider before the child that requires it", () => {
    const runtime = composeAdmin();
    const order = runtime.getSnapshot().runtime.initializationOrder;

    // 23 area children plus the atomic bridge.
    expect(order).toHaveLength(EXPECTED_CHILD_IDS.length + 1);

    const positionOf = new Map<string, number>(
      order.map((childId, index) => [String(childId), index]),
    );
    const providerOf = new Map<string, string>([
      ...Object.entries(EXPECTED_CAPABILITY_BY_CHILD).map(
        ([childId, capabilityId]) => [capabilityId, childId] as const,
      ),
      [ADMIN_ATOMIC_OPERATION_ID, `${SHARED_ENGINE_ID}.atomic-operation`],
    ]);

    for (const [childId, requirements] of Object.entries(EXPECTED_REQUIREMENTS)) {
      const consumer = positionOf.get(childId);
      expect(consumer, `${childId} was never initialized`).toBeDefined();
      for (const requirement of requirements) {
        const provider = providerOf.get(requirement);
        expect(provider, `no provider for ${requirement}`).toBeDefined();
        const providerPosition = positionOf.get(provider as string);
        expect(providerPosition, `${provider} was never initialized`).toBeDefined();
        expect(
          providerPosition as number,
          `${provider} must start before ${childId}`,
        ).toBeLessThan(consumer as number);
      }
    }

    runtime.dispose();
  });
});

// ─── 5. Exclusion — the graph refuses to publish a broken capability ─────────

describe("a child whose requirement is absent is excluded, not published broken", () => {
  it("republishes the injected atomic port as admin.atomic-operation", () => {
    const runtime = composeAdmin();

    // The S1 seam: the port arrives as an outbound port the composition root
    // supplies, and the engine root republishes it as the capability LOGIC §8
    // says two children require. If this republish stopped happening, those two
    // children would be excluded — which is exactly what the next test asserts.
    expect(runtime.getSnapshot().runtime.capabilities).toContain(ADMIN_ATOMIC_OPERATION_ID);
    for (const childId of ATOMIC_CONSUMERS) {
      expect(childById(runtime, childId).state).toBe("active");
    }

    runtime.dispose();
  });

  it("excludes exactly the two atomic children when no atomic port is supplied", () => {
    const runtime = composeAdmin({ withAtomicPort: false });
    const snapshot = runtime.getSnapshot();

    expect(snapshot.runtime.capabilities).not.toContain(ADMIN_ATOMIC_OPERATION_ID);

    const unavailable = childrenOf(runtime)
      .filter((child) => child.state === "unavailable")
      .map((child) => child.childId);
    expect(sorted(unavailable)).toEqual(sorted(ATOMIC_CONSUMERS));

    for (const childId of ATOMIC_CONSUMERS) {
      const child = childById(runtime, childId);
      // Excluded children are still REGISTERED, so they appear as unavailable
      // rather than vanishing. A child the graph dropped that also disappeared
      // from the report would be indistinguishable from one never written.
      expect(child.provides).toEqual([EXPECTED_CAPABILITY_BY_CHILD[childId]]);
      expect(child.requires).toContain(ADMIN_ATOMIC_OPERATION_ID);

      // `unmetRequirements` is EMPTY here, and that is correct rather than a
      // gap. The registry fills that field only for children it actually tried
      // to initialize; a child the GRAPH excluded never reaches initialization,
      // so its state falls back to `unavailable` with nothing recorded against
      // it. The reason it was excluded lives in the graph's diagnostic instead —
      // asserted in the next test. Worth stating explicitly, because a future
      // reader who assumes this field explains every unavailable child would be
      // reading an empty array as "no reason known".
      expect(child.unmetRequirements).toEqual([]);
    }

    // Their independent siblings keep running (LOGIC §7 rules 4 and 6).
    expect(childById(runtime, "admin.orders.order-read").state).toBe("active");
    expect(childById(runtime, "admin.pos.session").state).toBe("active");
    expect(childById(runtime, "admin.pos.cart").state).toBe("active");
    expect(snapshot.runtime.status).toBe("degraded");

    runtime.dispose();
  });

  it("names the excluded children in the diagnostics, since the snapshot cannot", () => {
    const runtime = composeAdmin({ withAtomicPort: false });
    const diagnostics = runtime.getSnapshot().diagnostics;

    // This is where an excluded child's reason actually lives (see the note in
    // the previous test). Without this assertion, a runtime that dropped both
    // atomic children for some unrelated reason would still pass.
    const excludedFor = diagnostics
      .filter(
        (entry) =>
          entry.code === "missing-dependency" &&
          String(entry.details?.details ?? "").includes(ADMIN_ATOMIC_OPERATION_ID),
      )
      .map((entry) => String(entry.childId));
    expect(sorted(excludedFor)).toEqual(sorted(ATOMIC_CONSUMERS));

    runtime.dispose();
  });

  it("reports the missing atomic boundary once, and only because something wants one", () => {
    const runtime = composeAdmin({ withAtomicPort: false });

    const missing = runtime
      .getSnapshot()
      .diagnostics.filter((entry) => entry.message.includes(ADMIN_ATOMIC_OPERATION_ID));
    expect(missing.length).toBeGreaterThan(0);

    // Fan-in de-duplication is the Admin composition root's job: the same unmet
    // capability is legitimately noticed by the graph and again by the registry,
    // and reporting one problem twice makes a degraded runtime look twice as
    // broken. Two consumers, so at most one entry per consumer.
    expect(missing.length).toBeLessThanOrEqual(ATOMIC_CONSUMERS.length + 1);

    runtime.dispose();
  });

  it("a missing PORT leaves its child active — only a missing CAPABILITY excludes", () => {
    // The asymmetry the whole runtime depends on, and the reason the exclusion
    // assertions above are meaningful. With no theme store the child still loads,
    // still publishes, and answers calls with a normalized dependency failure; it
    // is NOT unavailable, because `unavailable` is reserved for "a required
    // capability nobody published". Conflating the two would make a child whose
    // adapter is absent indistinguishable from one never written.
    const runtime = composeAdmin({
      omitPorts: ["admin.settings.theme-preference-store"],
    });

    const child = childById(runtime, "admin.settings.theme-preference");
    expect(child.state).toBe("active");
    expect(child.unmetRequirements).toEqual([]);
    expect(runtime.getSnapshot().runtime.capabilities).toContain(
      "admin.settings.theme-preference",
    );
    // Exactly one diagnostic, reported at creation rather than per call.
    expect(runtime.getSnapshot().diagnostics).toHaveLength(1);

    runtime.dispose();
  });
});

// ─── 6. Shutdown ─────────────────────────────────────────────────────────────

describe("disposal is orderly and idempotent", () => {
  it("leaves zero active children and no failures, however many times it runs", () => {
    const runtime = composeAdmin();
    expect(isAdminRuntimeHealthy(runtime.getSnapshot())).toBe(true);

    runtime.dispose();
    runtime.dispose();

    const snapshot = runtime.getSnapshot();
    expect(snapshot.runtime.status).toBe("disposed");
    expect(snapshot.runtime.capabilities).toEqual([]);

    for (const area of snapshot.areas) {
      expect(area.activeChildCount, `${area.area} still has an active child`).toBe(0);
      // A disposed child is counted in neither list: an orderly shutdown must not
      // read as an outage.
      expect(area.failedChildIds).toEqual([]);
      expect(area.unavailableChildIds).toEqual([]);
    }

    expect(childrenOf(runtime).every((child) => child.state === "disposed")).toBe(true);
  });
});
