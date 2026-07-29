// packages/module-system/src/engineContracts.ts
//
// Stable parent, child, lifecycle, and snapshot API (LOGIC §5).
//
// Consolidated from the SOURCE's seven `contracts/*` files. Two deliberate
// departures from SOURCE, both required by the target contract (LOGIC §5, §11):
//
//   1. No surface vocabulary. SOURCE hardcoded `MODULE_SURFACES = ["admin",
//      "storefront"]` into the generic runtime; the target forbids the module
//      system from knowing Warung Meng, Admin, or Storefront at all. Each engine
//      now supplies its own id and child namespace instead.
//   2. No UI vocabulary. SOURCE contributions carried navigation, routes,
//      labels, icons, and component ids. The target keeps route, label, icon,
//      component, renderer, and CSS out of every logic contract; those belong to
//      the UI layer.
//
// Interfaces live here; the behavior that implements them lives in
// engineRegistry.ts, capabilityRegistry.ts, dependencyGraph.ts, discovery.ts,
// and diagnostics.ts.

import type { OperationResult } from "./operationResult";

// ─── Identity ────────────────────────────────────────────────────────────────
//
// Branded strings (LOGIC §3) so a child id can never be passed where an engine
// id is expected, even though both are strings at runtime.

declare const engineIdBrand: unique symbol;
declare const logicChildIdBrand: unique symbol;
declare const capabilityIdBrand: unique symbol;
declare const portIdBrand: unique symbol;

export type EngineId = string & { readonly [engineIdBrand]: "EngineId" };
export type LogicChildId = string & { readonly [logicChildIdBrand]: "LogicChildId" };
export type CapabilityId = string & { readonly [capabilityIdBrand]: "CapabilityId" };
export type PortId = string & { readonly [portIdBrand]: "PortId" };

/**
 * Namespaced identifier shape shared by every id: at least two dot-separated
 * segments of lowercase alphanumerics, e.g. `admin.orders` or
 * `admin.orders.order-cancellation`.
 */
const NAMESPACED_ID = /^[a-z0-9]+(?:[-][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-][a-z0-9]+)*)+$/;

export function isNamespacedId(value: unknown): value is string {
  return typeof value === "string" && NAMESPACED_ID.test(value);
}

export function engineId(value: string): EngineId {
  return value as EngineId;
}

export function logicChildId(value: string): LogicChildId {
  return value as LogicChildId;
}

export function capabilityId(value: string): CapabilityId {
  return value as CapabilityId;
}

export function portId(value: string): PortId {
  return value as PortId;
}

// ─── Capability tokens ───────────────────────────────────────────────────────

declare const capabilityContractType: unique symbol;

/**
 * A typed handle to a capability. The phantom contract member makes
 * `resolve(token)` return the right type without a cast at the call site.
 * Ported verbatim in spirit from SOURCE `capabilities/capabilityRegistry.ts`.
 */
export interface CapabilityToken<TContract> {
  readonly id: CapabilityId;
  readonly version: 1;
  readonly [capabilityContractType]?: (contract: TContract) => TContract;
}

export function createCapabilityToken<TContract>(id: string): CapabilityToken<TContract> {
  return { id: capabilityId(id), version: 1 };
}

export type CapabilityResolution<TContract> =
  | { readonly status: "available"; readonly ownerId: LogicChildId; readonly value: TContract }
  | { readonly status: "missing"; readonly capabilityId: CapabilityId };

export interface CapabilityRegistration {
  readonly capabilityId: CapabilityId;
  dispose(): void | Promise<void>;
}

/**
 * The capability view handed to one child. A child may resolve anything it
 * declared in `requires`, and provide anything it declared in `provides`.
 */
export interface CapabilityRegistry {
  resolve<TContract>(token: CapabilityToken<TContract>): CapabilityResolution<TContract>;
  provide<TContract>(
    token: CapabilityToken<TContract>,
    implementation: TContract,
  ): OperationResult<CapabilityRegistration>;
}

// ─── Diagnostics ─────────────────────────────────────────────────────────────

export type DiagnosticSeverity = "info" | "warning" | "error";

/**
 * Runtime-neutral diagnostic codes, ported from SOURCE
 * `contracts/moduleDiagnostic.ts` minus its surface-specific entries and
 * renamed from "module" to the target's engine/child vocabulary.
 */
export type DiagnosticCode =
  | "candidate-load-failed"
  | "definition-malformed"
  | "duplicate-engine-id"
  | "duplicate-child-id"
  | "orphan-child"
  | "unsupported-version"
  | "missing-dependency"
  | "dependency-cycle"
  | "missing-capability"
  | "duplicate-capability"
  | "initialization-failed"
  | "disposal-failed";

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly engineId?: EngineId;
  readonly childId?: LogicChildId;
  readonly source?: string;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface DiagnosticSink {
  report(diagnostic: Diagnostic): void;
}

// ─── Outbound ports ──────────────────────────────────────────────────────────

/**
 * Ports are how a child reaches the outside world (storage, network, clock)
 * without importing a concrete adapter (LOGIC §11). The runtime only carries
 * them; it never implements one.
 */
export interface OutboundPortToken<TPort> {
  readonly id: PortId;
  readonly [capabilityContractType]?: (port: TPort) => TPort;
}

export function createOutboundPortToken<TPort>(id: string): OutboundPortToken<TPort> {
  return { id: portId(id) };
}

export interface OutboundPortRegistry {
  resolve<TPort>(token: OutboundPortToken<TPort>): TPort | undefined;
}

/**
 * Atomic multi-owner workflow boundary (LOGIC §10). The transaction mechanism is
 * deliberately unspecified here — only the shape is locked.
 */
export interface AtomicOperationPort {
  execute<TValue>(operation: () => Promise<TValue> | TValue): Promise<TValue>;
}

// ─── Parent engine + logic child definitions ─────────────────────────────────

/**
 * A parent engine: identity and child namespace only. Per LOGIC §3 it must NOT
 * hold queries, commands, calculations, state transitions, or any child
 * implementation — hence no `create` here, unlike a child.
 */
export interface ParentEngineDefinition {
  readonly id: EngineId;
  readonly version: 1;
  readonly childNamespace: string;
}

/** The context injected into a child at creation time (LOGIC §3). */
export interface LogicChildContext {
  readonly childId: LogicChildId;
  readonly parentId: EngineId;
  readonly capabilities: CapabilityRegistry;
  readonly diagnostics: DiagnosticSink;
  readonly ports: OutboundPortRegistry;
}

/**
 * A logic child: the actual plug-and-play unit. It declares what it provides and
 * requires explicitly, so the dependency graph can be resolved without a central
 * hardcoded list (LOGIC §7).
 */
export interface LogicChildDefinition<TCapability = unknown> {
  readonly id: LogicChildId;
  readonly parentId: EngineId;
  readonly version: 1;
  readonly provides: readonly CapabilityId[];
  readonly requires: readonly CapabilityId[];
  create(context: LogicChildContext): TCapability;
}

/** Identity helper for parent definitions; keeps branding at one place. */
export function defineParentEngine(definition: {
  readonly id: string;
  readonly childNamespace: string;
}): ParentEngineDefinition {
  return {
    id: engineId(definition.id),
    version: 1,
    childNamespace: definition.childNamespace,
  };
}

/** Identity helper for child definitions (matches the LOGIC §6 example call). */
export function defineLogicChild<TCapability>(definition: {
  readonly id: string;
  readonly parentId: string;
  readonly provides?: readonly string[];
  readonly requires?: readonly string[];
  create(context: LogicChildContext): TCapability;
}): LogicChildDefinition<TCapability> {
  return {
    id: logicChildId(definition.id),
    parentId: engineId(definition.parentId),
    version: 1,
    provides: (definition.provides ?? []).map(capabilityId),
    requires: (definition.requires ?? []).map(capabilityId),
    create: definition.create,
  };
}

// ─── Lifecycle + snapshot ────────────────────────────────────────────────────

/**
 * Why a child is not running. `unavailable` is the LOGIC §7 rule-4 case (a
 * required dependency is missing) and must NOT take siblings down with it.
 */
export type LogicChildState = "active" | "unavailable" | "failed" | "disposed";

export interface LogicChildSnapshot {
  readonly childId: LogicChildId;
  readonly parentId: EngineId;
  readonly state: LogicChildState;
  readonly provides: readonly CapabilityId[];
  readonly requires: readonly CapabilityId[];
  readonly unmetRequirements: readonly CapabilityId[];
}

export interface ParentEngineSnapshot {
  readonly engineId: EngineId;
  readonly childNamespace: string;
  readonly children: readonly LogicChildSnapshot[];
}

/** Whole-runtime health: `degraded` means it runs with some child missing. */
export type EngineRuntimeStatus = "idle" | "ready" | "degraded" | "disposed";

/** Read-only view of the runtime (LOGIC §3). Never a mutable handle. */
export interface ApplicationEngineSnapshot {
  readonly status: EngineRuntimeStatus;
  readonly engines: readonly ParentEngineSnapshot[];
  readonly capabilities: readonly CapabilityId[];
  readonly diagnostics: readonly Diagnostic[];
  readonly initializationOrder: readonly LogicChildId[];
}

/**
 * The runtime handle an application engine exposes. `initialize()` and
 * `dispose()` are required to be idempotent (LOGIC §7 rule 7).
 */
export interface ApplicationEngineRuntime {
  initialize(): void;
  getSnapshot(): ApplicationEngineSnapshot;
  resolve<TContract>(token: CapabilityToken<TContract>): TContract | undefined;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

