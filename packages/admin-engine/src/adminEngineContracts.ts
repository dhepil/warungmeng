// packages/admin-engine/src/adminEngineContracts.ts
//
// The Admin runtime's own public contracts (LOGIC §11: "admin-engine root →
// admin-engine internal public contracts").
//
// Scope discipline, because this file is the one most likely to become a dumping
// ground: what lives here is what the WHOLE runtime shares — its identity, how it
// is composed, and what it hands back. Anything owned by a single operational
// area belongs in that area's own `*Contracts.ts`, and anything a child computes
// belongs in the child. If a type here starts naming orders, stock, or money, it
// is in the wrong file.
//
// Nothing here carries UI vocabulary — no label, route, icon, or component
// (LOGIC §5/§11). The folder names under `engines/` follow the admin sidebar so
// ownership is easy to find, but that resemblance is organizational only; this
// runtime does not know a sidebar exists.

import type {
  ApplicationEngineSnapshot,
  Diagnostic,
  DiagnosticSink,
  LogicChildDefinition,
  OutboundPortRegistry,
  ParentEngineDefinition,
} from "@warungmeng/module-system";

/**
 * Every Admin id is namespaced under this prefix. Discovery uses it to reject a
 * definition that wandered in from another runtime — Admin discovery must never
 * scan Storefront (LOGIC §7 rule 9), and an id is the cheapest place to catch it.
 */
export const ADMIN_NAMESPACE = "admin";

/**
 * The operational areas of the Admin runtime, in the order LOGIC §4 lists them.
 *
 * This is NOT the hardcoded parent list rule 1 of LOGIC §7 forbids — nothing is
 * loaded from it and adding a folder without touching this list still works. It
 * is an expectation, used by the phase-gate test to answer "did an entire area
 * silently fail to load?" Discovery finds what exists; this says what should.
 */
export const ADMIN_AREAS = [
  "dashboard",
  "menu",
  "finance",
  "inventory",
  "pos",
  "orders",
  "settings",
] as const;

export type AdminArea = (typeof ADMIN_AREAS)[number];

/** The definitions discovered for this runtime, already validated and separated. */
export interface AdminLogicDefinitions {
  readonly engines: readonly ParentEngineDefinition[];
  readonly children: readonly LogicChildDefinition[];
  /**
   * What discovery threw away and why: a malformed file, an unsupported version,
   * or a definition belonging to another runtime. Carried rather than dropped
   * because a rejected file is invisible otherwise — it is not in `engines`, not
   * in `children`, and produces no failure. Silence would be the worst outcome.
   */
  readonly diagnostics?: readonly Diagnostic[];
}

/**
 * What the composition root supplies. Everything is optional on purpose: a
 * runtime composed with nothing at all must still start, discover its areas, and
 * report honestly which children could not run — a half-composed Admin is a
 * degraded Admin, never a crashed one (LOGIC §7 rules 4-6).
 */
export interface CreateAdminEngineOptions {
  /** Outbound ports, including the atomic operation seam. */
  readonly ports?: OutboundPortRegistry;
  /** Where startup diagnostics are forwarded, in addition to being collected. */
  readonly diagnostics?: DiagnosticSink;
  /**
   * Overrides discovery. Production leaves this unset and lets the runtime find
   * its own parents and children; tests pass an explicit set so a test never
   * depends on what happens to exist on disk.
   */
  readonly definitions?: AdminLogicDefinitions;
}

/**
 * The Admin runtime handed back to a composition root.
 *
 * Deliberately narrower than the module-system registry it wraps: a host may
 * read, resolve, subscribe, and dispose, but may NOT register. Registration is
 * over once `createAdminEngine` returns — allowing a late one would mean the
 * dependency graph computed at startup no longer describes the running system,
 * and the snapshot would be reporting on a runtime that had moved on.
 */
export interface AdminEngineRuntime {
  readonly getSnapshot: () => AdminEngineSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly dispose: () => void;
}

/**
 * The Admin view of runtime state. It wraps the generic snapshot rather than
 * replacing it: the generic half is the module system's honest account of what
 * started, and the Admin half adds only what the generic runtime cannot know —
 * which operational areas these children belong to.
 *
 * Read-only by construction, like the snapshot it wraps (LOGIC §3).
 */
export interface AdminEngineSnapshot {
  readonly runtime: ApplicationEngineSnapshot;
  readonly areas: readonly AdminAreaSnapshot[];
  /** Areas expected by ADMIN_AREAS that discovery did not produce at all. */
  readonly missingAreas: readonly AdminArea[];
  /**
   * Every startup problem from all three stages — discovery, graph, registry —
   * merged and de-duplicated.
   *
   * This exists because `runtime.diagnostics` only holds what the REGISTRY
   * reported; a file rejected during discovery or a child excluded by the graph
   * never reaches the registry and would be absent from the runtime's own
   * account. De-duplication belongs here and not in the registry because only
   * this layer sees all three stages: the same missing capability is legitimately
   * noticed by the graph and again by the registry, and reporting one problem
   * twice would make a healthy-but-degraded runtime look twice as broken.
   */
  readonly diagnostics: readonly Diagnostic[];
}

export interface AdminAreaSnapshot {
  readonly area: string;
  readonly engineId: string;
  readonly childCount: number;
  readonly activeChildCount: number;
  /** Children that declared a requirement nothing published (LOGIC §7 rule 4). */
  readonly unavailableChildIds: readonly string[];
  /** Children that threw or misdeclared their capabilities during creation. */
  readonly failedChildIds: readonly string[];
}
