// packages/module-system/src/moduleSystem.test.ts
//
// Protected-behavior tests for the generic module runtime. Consolidated from the
// SOURCE's five per-area suites (capabilityRegistry, moduleDependencyGraph,
// moduleManifest, moduleRegistry, moduleSurfaceBoundary) into one file, dropping the
// cases that only existed for concepts the target removed: surface matching,
// module-to-module `dependsOn`, optional dependencies, and UI contribution fields.
//
// SOURCE's `moduleSurfaceBoundary` suite is not ported: it re-implemented an import
// scanner inside a test. This repo enforces the same rule for every package at once
// through `npm run check`, so duplicating it here would be a second owner for the
// same rule.
//
// Everything is imported from "./index" rather than the individual files — these
// tests are the contract the public barrel promises, so if an export is missing or
// renamed, this suite fails.

import { describe, expect, it } from "vitest";
import type {
  CapabilityToken,
  Diagnostic,
  DiagnosticCode,
  DiagnosticSink,
  LogicChildContext,
  LogicChildDefinition,
  ParentEngineDefinition,
} from "./index";
import {
  candidatesFromModules,
  createCapabilityToken,
  createDiagnosticCollector,
  createEngineRegistry,
  defineLogicChild,
  defineParentEngine,
  diagnostic,
  diagnosticFromIssue,
  discoverDefinitions,
  engineId,
  isNamespacedId,
  logicChildId,
  NO_DIAGNOSTICS,
  operationIssue,
  resolveDependencyGraph,
  severityForCode,
} from "./index";

// ─── Fixtures ────────────────────────────────────────────────────────────────
//
// Ids are deliberately generic (`alpha.core`, not `admin.orders`): the module system
// must not know Warung Meng, Admin, or Storefront, and a test using product
// vocabulary would quietly normalize the opposite.

interface Greeter {
  greet(): string;
}

const GREETER = createCapabilityToken<Greeter>("alpha.greeter");
const COUNTER = createCapabilityToken<{ next(): number }>("alpha.counter");

function createEngine(overrides: Partial<ParentEngineDefinition> = {}): ParentEngineDefinition {
  return { ...defineParentEngine({ id: "alpha.core", childNamespace: "alpha" }), ...overrides };
}

/**
 * A child that publishes `alpha.greeter` and nothing else. Publishing goes through
 * the injected context — returning the value is not publishing, and the registry
 * treats a declared-but-unpublished capability as a failure.
 */
function createGreeterChild(id = "alpha.core.greeter"): LogicChildDefinition<Greeter> {
  return defineLogicChild<Greeter>({
    id,
    parentId: "alpha.core",
    provides: ["alpha.greeter"],
    create: (context) => {
      const greeter: Greeter = { greet: () => `hello from ${context.childId}` };
      context.capabilities.provide(GREETER, greeter);
      return greeter;
    },
  });
}

/** A child that requires `alpha.greeter` and re-publishes nothing. */
function createConsumerChild(id = "alpha.core.consumer"): LogicChildDefinition<Greeter> {
  return defineLogicChild<Greeter>({
    id,
    parentId: "alpha.core",
    requires: ["alpha.greeter"],
    create: (context) => {
      const resolution = context.capabilities.resolve(GREETER);
      return {
        greet: () => (resolution.status === "available" ? resolution.value.greet() : "none"),
      };
    },
  });
}

function collectDiagnostics(): DiagnosticSink & { entries: Diagnostic[] } {
  const entries: Diagnostic[] = [];
  return {
    entries,
    report(entry) {
      entries.push(entry);
    },
  };
}

function codesOf(entries: readonly Diagnostic[]): readonly DiagnosticCode[] {
  return entries.map(({ code }) => code);
}

/** Registers engines + children and initializes in dependency-graph order. */
function startRuntime(
  engines: readonly ParentEngineDefinition[],
  children: readonly LogicChildDefinition[],
  sink?: DiagnosticSink,
) {
  const registry = createEngineRegistry(sink ? { diagnostics: sink } : {});
  for (const engine of engines) {
    registry.registerEngine(engine);
  }
  for (const child of children) {
    registry.registerChild(child);
  }
  const graph = resolveDependencyGraph(engines, children);
  const result = registry.initialize(graph.order);
  return { registry, graph, result };
}

// ─── Identity ────────────────────────────────────────────────────────────────

describe("identity", () => {
  it("accepts namespaced ids and rejects unnamespaced or malformed ones", () => {
    expect(isNamespacedId("alpha.core")).toBe(true);
    expect(isNamespacedId("alpha.core.order-cancellation")).toBe(true);
    expect(isNamespacedId("alpha")).toBe(false);
    expect(isNamespacedId("Alpha.Core")).toBe(false);
    expect(isNamespacedId("alpha..core")).toBe(false);
    expect(isNamespacedId("alpha.core.")).toBe(false);
    expect(isNamespacedId(42)).toBe(false);
  });

  it("brands ids through the definition helpers", () => {
    const child = createGreeterChild();
    expect(child.id).toBe("alpha.core.greeter");
    expect(child.parentId).toBe("alpha.core");
    expect(child.version).toBe(1);
    // Absent declarations normalize to empty arrays, so callers never guard for
    // undefined before iterating.
    expect(child.requires).toEqual([]);
    expect(createEngine().childNamespace).toBe("alpha");
  });
});

// ─── Diagnostics ─────────────────────────────────────────────────────────────

describe("diagnostics", () => {
  const ALL_CODES: readonly DiagnosticCode[] = [
    "candidate-load-failed",
    "definition-malformed",
    "duplicate-engine-id",
    "duplicate-child-id",
    "orphan-child",
    "unsupported-version",
    "missing-dependency",
    "dependency-cycle",
    "missing-capability",
    "duplicate-capability",
    "initialization-failed",
    "disposal-failed",
  ];

  // The locked decision: severity answers "how bad is this event", never "may we
  // continue" — that is already carried by the degraded runtime status. If someone
  // later softens a code to a warning to express "startup survived this", this fails.
  it("maps every diagnostic code to error severity", () => {
    for (const code of ALL_CODES) {
      expect(severityForCode(code)).toBe("error");
    }
  });

  it("applies the code's default severity when building a diagnostic", () => {
    const entry = diagnostic("orphan-child", "No parent.", {
      engineId: engineId("alpha.core"),
      childId: logicChildId("alpha.core.greeter"),
    });
    expect(entry).toEqual({
      code: "orphan-child",
      severity: "error",
      message: "No parent.",
      engineId: "alpha.core",
      childId: "alpha.core.greeter",
      source: undefined,
      details: undefined,
    });
  });

  it("carries an operation issue's wording and details into a diagnostic", () => {
    const entry = diagnosticFromIssue(
      "duplicate-capability",
      operationIssue("duplicate-capability", "Already registered.", "alpha.greeter", {
        existingOwnerId: "alpha.core.greeter",
      }),
      { childId: logicChildId("alpha.core.other") },
    );
    expect(entry.message).toBe("Already registered.");
    expect(entry.details).toEqual({
      subject: "alpha.greeter",
      existingOwnerId: "alpha.core.greeter",
    });
  });

  it("collects in report order and forwards to a downstream sink", () => {
    const downstream = collectDiagnostics();
    const collector = createDiagnosticCollector({ forwardTo: downstream });
    collector.report(diagnostic("orphan-child", "first"));
    collector.report(diagnostic("dependency-cycle", "second"));
    expect(codesOf(collector.list())).toEqual(["orphan-child", "dependency-cycle"]);
    expect(codesOf(downstream.entries)).toEqual(["orphan-child", "dependency-cycle"]);
  });

  it("de-duplicates identical reports by default and keeps them when told not to", () => {
    const deduping = createDiagnosticCollector();
    deduping.report(diagnostic("orphan-child", "same"));
    deduping.report(diagnostic("orphan-child", "same"));
    expect(deduping.list()).toHaveLength(1);

    const keeping = createDiagnosticCollector({ deduplicate: false });
    keeping.report(diagnostic("orphan-child", "same"));
    keeping.report(diagnostic("orphan-child", "same"));
    expect(keeping.list()).toHaveLength(2);
  });

  it("treats the same code about different subjects as distinct problems", () => {
    const collector = createDiagnosticCollector();
    collector.report(
      diagnostic("orphan-child", "no parent", { childId: logicChildId("alpha.core.one") }),
    );
    collector.report(
      diagnostic("orphan-child", "no parent", { childId: logicChildId("alpha.core.two") }),
    );
    expect(collector.list()).toHaveLength(2);
  });

  it("groups by child and by engine, counting a child's diagnostics under its parent", () => {
    const collector = createDiagnosticCollector();
    const subject = {
      engineId: engineId("alpha.core"),
      childId: logicChildId("alpha.core.greeter"),
    };
    collector.report(diagnostic("orphan-child", "a", subject));
    collector.report(diagnostic("dependency-cycle", "b", { engineId: engineId("beta.core") }));

    expect(collector.forChild(logicChildId("alpha.core.greeter"))).toHaveLength(1);
    expect(collector.forEngine(engineId("alpha.core"))).toHaveLength(1);
    expect(collector.forEngine(engineId("beta.core"))).toHaveLength(1);
    expect(collector.forChild(logicChildId("alpha.core.absent"))).toEqual([]);
  });

  it("filters by severity at or above the requested seriousness", () => {
    const collector = createDiagnosticCollector();
    collector.report(
      diagnostic("orphan-child", "an error", { childId: logicChildId("alpha.core.one") }),
    );
    // Hand-built: no code currently maps to a warning, and this asserts the filter
    // itself rather than the severity table above. The distinct childId matters —
    // de-duplication keys on code and subject, not on severity or wording.
    collector.report({
      code: "orphan-child",
      severity: "warning",
      message: "a warning",
      childId: logicChildId("alpha.core.two"),
    });

    expect(collector.bySeverity("error")).toHaveLength(1);
    expect(collector.bySeverity("warning")).toHaveLength(2);
    expect(collector.bySeverity("info")).toHaveLength(2);
  });

  it("summarizes totals, codes, and affected subjects deterministically", () => {
    const collector = createDiagnosticCollector();
    collector.report(
      diagnostic("orphan-child", "a", {
        engineId: engineId("zeta.core"),
        childId: logicChildId("zeta.core.one"),
      }),
    );
    collector.report(
      diagnostic("dependency-cycle", "b", {
        engineId: engineId("alpha.core"),
        childId: logicChildId("alpha.core.two"),
      }),
    );

    expect(collector.summarize()).toEqual({
      total: 2,
      errors: 2,
      warnings: 0,
      infos: 0,
      hasErrors: true,
      byCode: [
        { code: "dependency-cycle", count: 1 },
        { code: "orphan-child", count: 1 },
      ],
      affectedChildren: ["alpha.core.two", "zeta.core.one"],
      affectedEngines: ["alpha.core", "zeta.core"],
    });
  });

  it("reports a clean summary when nothing was collected", () => {
    const summary = createDiagnosticCollector().summarize();
    expect(summary.total).toBe(0);
    expect(summary.hasErrors).toBe(false);
    expect(summary.byCode).toEqual([]);
  });

  it("clears collected entries and the de-duplication memory together", () => {
    const collector = createDiagnosticCollector();
    collector.report(diagnostic("orphan-child", "same"));
    collector.clear();
    expect(collector.list()).toEqual([]);
    // Without clearing the seen-set too, this second report would be swallowed as a
    // duplicate of one the caller already threw away.
    collector.report(diagnostic("orphan-child", "same"));
    expect(collector.list()).toHaveLength(1);
  });

  it("discards everything through the null sink without throwing", () => {
    expect(() => {
      NO_DIAGNOSTICS.report(diagnostic("orphan-child", "ignored"));
    }).not.toThrow();
  });
});

// ─── Discovery ───────────────────────────────────────────────────────────────

describe("discovery", () => {
  it("sorts valid candidates into parent engines and logic children", () => {
    const result = discoverDefinitions([
      { source: "./alpha.ts", value: createEngine() },
      { source: "./greeter.ts", value: createGreeterChild() },
    ]);
    expect(result.engines.map(({ id }) => id)).toEqual(["alpha.core"]);
    expect(result.children.map(({ id }) => id)).toEqual(["alpha.core.greeter"]);
    expect(result.rejected).toEqual([]);
  });

  it("rejects malformed candidates with a stable diagnostic naming their source", () => {
    const result = discoverDefinitions([
      { source: "./empty.ts", value: null },
      { source: "./junk.ts", value: { id: "not-namespaced" } },
      { source: "./primitive.ts", value: 7 },
    ]);
    expect(result.engines).toEqual([]);
    expect(result.children).toEqual([]);
    expect(result.rejected.map(({ source }) => source)).toEqual([
      "./empty.ts",
      "./junk.ts",
      "./primitive.ts",
    ]);
    expect(codesOf(result.diagnostics)).toEqual([
      "definition-malformed",
      "definition-malformed",
      "definition-malformed",
    ]);
  });

  it("rejects nested malformed fields without throwing", () => {
    const result = discoverDefinitions([
      {
        source: "./bad-provides.ts",
        value: {
          id: "alpha.core.broken",
          parentId: "alpha.core",
          version: 1,
          provides: ["NOT VALID"],
          requires: [],
          create: () => ({}),
        },
      },
    ]);
    expect(result.children).toEqual([]);
    expect(codesOf(result.diagnostics)).toEqual(["definition-malformed"]);
  });

  it("rejects unsupported versions for both parents and children", () => {
    const result = discoverDefinitions([
      { source: "./old-engine.ts", value: { ...createEngine(), version: 2 } },
      { source: "./old-child.ts", value: { ...createGreeterChild(), version: 2 } },
    ]);
    expect(result.engines).toEqual([]);
    expect(result.children).toEqual([]);
    expect(codesOf(result.diagnostics)).toEqual([
      "unsupported-version",
      "unsupported-version",
    ]);
  });

  // The quarantine guarantee: one bad file must not cost us the good ones.
  it("isolates an invalid candidate without dropping the valid ones", () => {
    const result = discoverDefinitions([
      { source: "./alpha.ts", value: createEngine() },
      { source: "./broken.ts", value: { nonsense: true } },
      { source: "./greeter.ts", value: createGreeterChild() },
    ]);
    expect(result.engines).toHaveLength(1);
    expect(result.children).toHaveLength(1);
    expect(result.rejected.map(({ source }) => source)).toEqual(["./broken.ts"]);
  });

  it("reads eager glob modules in stable path order, preferring the default export", () => {
    const candidates = candidatesFromModules({
      "./z-child.ts": { default: createGreeterChild() },
      "./a-engine.ts": { alphaEngine: createEngine() },
    });
    expect(candidates.map(({ source }) => source)).toEqual(["./a-engine.ts", "./z-child.ts"]);
    const discovered = discoverDefinitions(candidates);
    expect(discovered.engines).toHaveLength(1);
    expect(discovered.children).toHaveLength(1);
  });

  it("rejects an ambiguous module exporting more than one definition", () => {
    const candidates = candidatesFromModules({
      "./two.ts": { engine: createEngine(), child: createGreeterChild() },
    });
    const discovered = discoverDefinitions(candidates);
    expect(discovered.engines).toEqual([]);
    expect(discovered.children).toEqual([]);
    expect(codesOf(discovered.diagnostics)).toEqual(["definition-malformed"]);
  });
});

// ─── Dependency graph ────────────────────────────────────────────────────────

describe("dependency graph", () => {
  function reasonsFor(result: ReturnType<typeof resolveDependencyGraph>, id: string) {
    return result.excluded.filter((entry) => entry.childId === id).map(({ reason }) => reason);
  }

  it("orders capability providers before the children that consume them", () => {
    // Registered consumer-first, so a passing result cannot be input order leaking
    // through as output order.
    const result = resolveDependencyGraph(
      [createEngine()],
      [createConsumerChild(), createGreeterChild()],
    );
    expect(result.order).toEqual(["alpha.core.greeter", "alpha.core.consumer"]);
    expect(result.excluded).toEqual([]);
  });

  it("breaks ties on id so the same input always yields the same order", () => {
    const engines = [createEngine()];
    const children = [
      defineLogicChild({ id: "alpha.core.zulu", parentId: "alpha.core", create: () => ({}) }),
      defineLogicChild({ id: "alpha.core.alfa", parentId: "alpha.core", create: () => ({}) }),
      defineLogicChild({ id: "alpha.core.mike", parentId: "alpha.core", create: () => ({}) }),
    ];
    const forward = resolveDependencyGraph(engines, children);
    const reversed = resolveDependencyGraph(engines, [...children].reverse());
    expect(forward.order).toEqual(["alpha.core.alfa", "alpha.core.mike", "alpha.core.zulu"]);
    expect(reversed.order).toEqual(forward.order);
  });

  it("excludes a duplicate child id and keeps the first declaration", () => {
    const result = resolveDependencyGraph(
      [createEngine()],
      [createGreeterChild(), createGreeterChild()],
    );
    expect(result.order).toEqual(["alpha.core.greeter"]);
    expect(reasonsFor(result, "alpha.core.greeter")).toEqual(["duplicate-child-id"]);
    expect(codesOf(result.diagnostics)).toContain("duplicate-child-id");
  });

  it("excludes a child whose parent engine was never registered", () => {
    const orphan = defineLogicChild({
      id: "ghost.core.child",
      parentId: "ghost.core",
      create: () => ({}),
    });
    const result = resolveDependencyGraph([createEngine()], [createGreeterChild(), orphan]);
    expect(result.order).toEqual(["alpha.core.greeter"]);
    expect(reasonsFor(result, "ghost.core.child")).toEqual(["orphan-child"]);
  });

  // Ambiguity is resolved by excluding BOTH claimants, never by letting declaration
  // order silently pick a winner.
  it("excludes every claimant when two children declare the same capability", () => {
    const result = resolveDependencyGraph(
      [createEngine()],
      [createGreeterChild("alpha.core.one"), createGreeterChild("alpha.core.two")],
    );
    expect(result.order).toEqual([]);
    expect(reasonsFor(result, "alpha.core.one")).toEqual(["duplicate-capability"]);
    expect(reasonsFor(result, "alpha.core.two")).toEqual(["duplicate-capability"]);
  });

  it("excludes a child whose required capability has no provider", () => {
    const result = resolveDependencyGraph([createEngine()], [createConsumerChild()]);
    expect(result.order).toEqual([]);
    expect(reasonsFor(result, "alpha.core.consumer")).toEqual(["missing-dependency"]);
    expect(result.excluded[0]?.details).toEqual(["alpha.greeter"]);
  });

  // LOGIC §7 rule 6: exclusion propagates along real edges only.
  it("propagates exclusion transitively to downstream consumers", () => {
    const middle = defineLogicChild({
      id: "alpha.core.middle",
      parentId: "alpha.core",
      provides: ["alpha.counter"],
      requires: ["alpha.missing"],
      create: () => ({ next: () => 1 }),
    });
    const downstream = defineLogicChild({
      id: "alpha.core.downstream",
      parentId: "alpha.core",
      requires: ["alpha.counter"],
      create: () => ({}),
    });
    const independent = defineLogicChild({
      id: "alpha.core.independent",
      parentId: "alpha.core",
      create: () => ({}),
    });

    const result = resolveDependencyGraph(
      [createEngine()],
      [middle, downstream, independent],
    );
    // The independent sibling survives — a broken branch must not take the tree down.
    expect(result.order).toEqual(["alpha.core.independent"]);
    expect(reasonsFor(result, "alpha.core.middle")).toEqual(["missing-dependency"]);
    expect(reasonsFor(result, "alpha.core.downstream")).toEqual(["missing-dependency"]);
  });

  it("detects a capability cycle and excludes everyone caught in it", () => {
    const first = defineLogicChild({
      id: "alpha.core.first",
      parentId: "alpha.core",
      provides: ["alpha.greeter"],
      requires: ["alpha.counter"],
      create: () => ({ greet: () => "" }),
    });
    const second = defineLogicChild({
      id: "alpha.core.second",
      parentId: "alpha.core",
      provides: ["alpha.counter"],
      requires: ["alpha.greeter"],
      create: () => ({ next: () => 1 }),
    });
    const result = resolveDependencyGraph([createEngine()], [first, second]);
    expect(result.order).toEqual([]);
    expect(reasonsFor(result, "alpha.core.first")).toEqual(["dependency-cycle"]);
    expect(reasonsFor(result, "alpha.core.second")).toEqual(["dependency-cycle"]);
  });

  it("returns an empty order for no children without reporting a problem", () => {
    const result = resolveDependencyGraph([createEngine()], []);
    expect(result).toEqual({ order: [], excluded: [], diagnostics: [] });
  });
});

// ─── Engine registry ─────────────────────────────────────────────────────────

describe("engine registry", () => {
  it("registers a parent and its child, then resolves the published capability", () => {
    const { registry, result } = startRuntime([createEngine()], [createGreeterChild()]);
    expect(result.status).toBe("success");
    expect(registry.resolve(GREETER)?.greet()).toBe("hello from alpha.core.greeter");
    expect(registry.getSnapshot().status).toBe("ready");
  });

  it("rejects a duplicate engine id and keeps the original registration", () => {
    const registry = createEngineRegistry();
    expect(registry.registerEngine(createEngine()).status).toBe("success");
    const duplicate = registry.registerEngine(createEngine({ childNamespace: "hijacked" }));
    expect(duplicate.status).toBe("failure");
    expect(registry.listEngines()).toHaveLength(1);
    expect(registry.resolveEngine(engineId("alpha.core"))?.childNamespace).toBe("alpha");
  });

  it("rejects a duplicate child id without creating the second child", () => {
    const registry = createEngineRegistry();
    registry.registerEngine(createEngine());
    let creations = 0;
    const counted = (): LogicChildDefinition =>
      defineLogicChild({
        id: "alpha.core.greeter",
        parentId: "alpha.core",
        create: () => {
          creations += 1;
          return {};
        },
      });

    expect(registry.registerChild(counted()).status).toBe("success");
    expect(registry.registerChild(counted()).status).toBe("failure");
    registry.initialize();
    expect(registry.listChildren()).toHaveLength(1);
    expect(creations).toBe(1);
  });

  it("forwards runtime diagnostics to the host sink as they happen", () => {
    const sink = collectDiagnostics();
    const registry = createEngineRegistry({ diagnostics: sink });
    registry.registerEngine(createEngine());
    registry.registerEngine(createEngine());
    expect(codesOf(sink.entries)).toEqual(["duplicate-engine-id"]);
  });

  it("leaves a child unavailable, not failed, when its requirement is absent", () => {
    const sink = collectDiagnostics();
    const registry = createEngineRegistry({ diagnostics: sink });
    registry.registerEngine(createEngine());
    registry.registerChild(createConsumerChild());
    const result = registry.initialize();

    expect(result.status).toBe("degraded");
    const snapshot = registry.getSnapshot();
    expect(snapshot.status).toBe("degraded");
    const child = snapshot.engines[0]?.children[0];
    expect(child?.state).toBe("unavailable");
    expect(child?.unmetRequirements).toEqual(["alpha.greeter"]);
    expect(codesOf(sink.entries)).toEqual(["missing-dependency"]);
  });

  // LOGIC §7 rule 5: one child's failure must not cost us its independent siblings.
  it("initializes independent siblings when one child throws", () => {
    const thrower = defineLogicChild({
      id: "alpha.core.thrower",
      parentId: "alpha.core",
      create: () => {
        throw new Error("boom");
      },
    });
    const sink = collectDiagnostics();
    const { registry, result } = startRuntime(
      [createEngine()],
      [thrower, createGreeterChild()],
      sink,
    );

    expect(result.status).toBe("degraded");
    expect(registry.resolve(GREETER)?.greet()).toBe("hello from alpha.core.greeter");
    expect(codesOf(sink.entries)).toEqual(["initialization-failed"]);
    // The raw Error never escapes: the host sees a diagnostic, not a thrown object.
    expect(sink.entries[0]?.message).toBe("Child threw while being created.");
  });

  it("rolls back everything a child published when it throws after providing", () => {
    const halfway = defineLogicChild({
      id: "alpha.core.halfway",
      parentId: "alpha.core",
      provides: ["alpha.greeter"],
      create: (context: LogicChildContext) => {
        context.capabilities.provide(GREETER, { greet: () => "leaked" });
        throw new Error("after providing");
      },
    });
    const { registry } = startRuntime([createEngine()], [halfway]);

    // Nothing the failed child published may stay visible to its siblings.
    expect(registry.resolve(GREETER)).toBeUndefined();
    expect(registry.getSnapshot().capabilities).toEqual([]);
  });

  it("rejects a child that publishes a capability it never declared", () => {
    const undeclared = defineLogicChild({
      id: "alpha.core.undeclared",
      parentId: "alpha.core",
      create: (context: LogicChildContext) => {
        context.capabilities.provide(GREETER, { greet: () => "sneaky" });
        return {};
      },
    });
    const sink = collectDiagnostics();
    const { registry } = startRuntime([createEngine()], [undeclared], sink);

    expect(registry.resolve(GREETER)).toBeUndefined();
    expect(codesOf(sink.entries)).toEqual(["initialization-failed"]);
    expect(sink.entries[0]?.message).toBe("Child published an undeclared capability.");
  });

  it("rejects a child that declares a capability it never publishes", () => {
    const silent = defineLogicChild({
      id: "alpha.core.silent",
      parentId: "alpha.core",
      provides: ["alpha.greeter"],
      create: () => ({}),
    });
    const sink = collectDiagnostics();
    const { registry } = startRuntime([createEngine()], [silent], sink);

    expect(registry.resolve(GREETER)).toBeUndefined();
    expect(sink.entries[0]?.message).toBe("Child did not publish a declared capability.");
    expect(registry.getSnapshot().engines[0]?.children[0]?.state).toBe("failed");
  });

  it("lets a child read back its own pending capability during creation", () => {
    const pair = defineLogicChild({
      id: "alpha.core.pair",
      parentId: "alpha.core",
      provides: ["alpha.greeter", "alpha.counter"],
      create: (context: LogicChildContext) => {
        context.capabilities.provide(GREETER, { greet: () => "first" });
        const own = context.capabilities.resolve(GREETER);
        context.capabilities.provide(COUNTER, {
          next: () => (own.status === "available" ? own.value.greet().length : -1),
        });
        return {};
      },
    });
    const { registry } = startRuntime([createEngine()], [pair]);
    expect(registry.resolve(COUNTER)?.next()).toBe(5);
  });

  it("is idempotent: a second initialize creates nothing new", () => {
    const registry = createEngineRegistry();
    registry.registerEngine(createEngine());
    let creations = 0;
    registry.registerChild(
      defineLogicChild({
        id: "alpha.core.once",
        parentId: "alpha.core",
        create: () => {
          creations += 1;
          return {};
        },
      }),
    );

    registry.initialize();
    registry.initialize();
    expect(creations).toBe(1);
    expect(registry.getSnapshot().initializationOrder).toEqual(["alpha.core.once"]);
  });

  it("initializes a child that became satisfiable on a later pass", () => {
    const registry = createEngineRegistry();
    registry.registerEngine(createEngine());
    registry.registerChild(createConsumerChild());
    expect(registry.initialize().status).toBe("degraded");

    registry.registerChild(createGreeterChild());
    registry.initialize([logicChildId("alpha.core.greeter")]);
    const satisfied = registry.initialize([logicChildId("alpha.core.consumer")]);
    expect(satisfied.status).toBe("success");
    expect(registry.getSnapshot().status).toBe("ready");
  });

  it("disposes children in reverse initialization order", () => {
    const order: string[] = [];
    const provider = defineLogicChild({
      id: "alpha.core.provider",
      parentId: "alpha.core",
      provides: ["alpha.greeter"],
      create: (context: LogicChildContext) => {
        const handle = context.capabilities.provide(GREETER, { greet: () => "up" });
        if (handle.status === "success") {
          const registration = handle.value;
          const original = registration.dispose.bind(registration);
          Object.assign(registration, {
            dispose: () => {
              order.push("provider");
              original();
            },
          });
        }
        return {};
      },
    });
    const consumer = defineLogicChild({
      id: "alpha.core.consumer",
      parentId: "alpha.core",
      provides: ["alpha.counter"],
      requires: ["alpha.greeter"],
      create: (context: LogicChildContext) => {
        const handle = context.capabilities.provide(COUNTER, { next: () => 1 });
        if (handle.status === "success") {
          const registration = handle.value;
          const original = registration.dispose.bind(registration);
          Object.assign(registration, {
            dispose: () => {
              order.push("consumer");
              original();
            },
          });
        }
        return {};
      },
    });

    const { registry } = startRuntime([createEngine()], [provider, consumer]);
    registry.dispose();
    // A provider must outlive its consumer, so teardown runs consumer-first.
    expect(order).toEqual(["consumer", "provider"]);
    expect(registry.getSnapshot().status).toBe("disposed");
  });

  it("reports a disposal failure without letting the error escape", () => {
    const brittle = defineLogicChild({
      id: "alpha.core.brittle",
      parentId: "alpha.core",
      provides: ["alpha.greeter"],
      create: (context: LogicChildContext) => {
        const handle = context.capabilities.provide(GREETER, { greet: () => "bye" });
        if (handle.status === "success") {
          Object.assign(handle.value, {
            dispose: () => {
              throw new Error("teardown exploded");
            },
          });
        }
        return {};
      },
    });
    const sink = collectDiagnostics();
    const { registry } = startRuntime([createEngine()], [brittle], sink);

    expect(() => {
      registry.dispose();
    }).not.toThrow();
    expect(codesOf(sink.entries)).toEqual(["disposal-failed"]);
  });

  it("releases a single child's capability when only that child is disposed", () => {
    const { registry } = startRuntime([createEngine()], [createGreeterChild()]);
    registry.disposeChild(logicChildId("alpha.core.greeter"));
    expect(registry.resolve(GREETER)).toBeUndefined();
    expect(registry.getSnapshot().engines[0]?.children[0]?.state).toBe("disposed");
  });

  it("is idempotent on dispose and refuses to initialize afterwards", () => {
    const { registry } = startRuntime([createEngine()], [createGreeterChild()]);
    registry.dispose();
    expect(() => {
      registry.dispose();
    }).not.toThrow();
    expect(registry.initialize().status).toBe("failure");
  });

  it("notifies subscribers on lifecycle changes until they unsubscribe", () => {
    const registry = createEngineRegistry();
    registry.registerEngine(createEngine());
    registry.registerChild(createGreeterChild());

    let notifications = 0;
    const unsubscribe = registry.subscribe(() => {
      notifications += 1;
    });
    registry.initialize();
    expect(notifications).toBe(1);

    unsubscribe();
    registry.dispose();
    expect(notifications).toBe(1);
  });

  it("hands out a snapshot that cannot be used to mutate the runtime", () => {
    const { registry } = startRuntime([createEngine()], [createGreeterChild()]);
    const snapshot = registry.getSnapshot();
    // Cast through `unknown` on purpose: the readonly types already forbid this at
    // compile time, and this asserts the runtime copy holds even if a JavaScript
    // caller ignores them.
    (snapshot.initializationOrder as unknown as string[]).push("alpha.core.intruder");
    (snapshot.capabilities as unknown as string[]).length = 0;

    const fresh = registry.getSnapshot();
    expect(fresh.initializationOrder).toEqual(["alpha.core.greeter"]);
    expect(fresh.capabilities).toEqual(["alpha.greeter"]);
  });

  it("reports idle before anything is registered", () => {
    expect(createEngineRegistry().getSnapshot()).toEqual({
      status: "idle",
      engines: [],
      capabilities: [],
      diagnostics: [],
      initializationOrder: [],
    });
  });

  it("keeps every occurrence of a repeated diagnostic across lifecycle cycles", () => {
    // The registry deliberately does not de-duplicate: the same child failing
    // teardown twice is two events, and fan-in dedupe belongs to the P3 host.
    const registry = createEngineRegistry();
    registry.registerEngine(createEngine());
    registry.registerEngine(createEngine());
    registry.registerEngine(createEngine());
    expect(codesOf(registry.getSnapshot().diagnostics)).toEqual([
      "duplicate-engine-id",
      "duplicate-engine-id",
    ]);
  });

  it("resolves a typed capability without a cast at the call site", () => {
    const { registry } = startRuntime([createEngine()], [createGreeterChild()]);
    const token: CapabilityToken<Greeter> = GREETER;
    const greeter = registry.resolve(token);
    // The phantom contract type is what makes this compile — `greet` is known here.
    expect(greeter?.greet()).toContain("hello");
    expect(registry.resolve(COUNTER)).toBeUndefined();
  });
});
