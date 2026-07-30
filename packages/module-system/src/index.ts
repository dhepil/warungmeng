// packages/module-system/src/index.ts
//
// Public entry for the generic module runtime.
//
// Exports are hand-picked rather than `export *`, matching SOURCE's own barrel:
// what appears here is what packages downstream (admin-engine, storefront-engine)
// are allowed to depend on, and everything absent is free to change without
// breaking them.
//
// Deliberately NOT exported: `capabilityRegistry.ts`. It is the seam the engine
// registry uses internally to stage a child's capabilities; a child receives the
// narrow `CapabilityRegistry` view through its context and never builds one. Making
// the controller public would invite a host to publish capabilities behind the
// registry's back, and staged rollback would stop being trustworthy.

// ─── Result contract ─────────────────────────────────────────────────────────

export type {
  OperationDegraded,
  OperationFailure,
  OperationFailureReason,
  OperationIssue,
  OperationResult,
  OperationSuccess,
} from "./operationResult";
export {
  isOperationFailure,
  isOperationSuccess,
  isOperationUsable,
  operationDegraded,
  operationFailure,
  operationIssue,
  operationIssues,
  operationSuccess,
  operationValue,
} from "./operationResult";

// ─── Identity + contracts ────────────────────────────────────────────────────

export type {
  ApplicationEngineRuntime,
  ApplicationEngineSnapshot,
  AtomicOperationPort,
  CapabilityId,
  CapabilityRegistration,
  CapabilityRegistry,
  CapabilityResolution,
  CapabilityToken,
  Diagnostic,
  DiagnosticCode,
  DiagnosticSeverity,
  DiagnosticSink,
  EngineId,
  EngineRuntimeStatus,
  LogicChildContext,
  LogicChildDefinition,
  LogicChildId,
  LogicChildSnapshot,
  LogicChildState,
  OutboundPortRegistry,
  OutboundPortToken,
  ParentEngineDefinition,
  ParentEngineSnapshot,
  PortId,
} from "./engineContracts";
export {
  capabilityId,
  createCapabilityToken,
  createOutboundPortToken,
  defineLogicChild,
  defineParentEngine,
  engineId,
  isNamespacedId,
  logicChildId,
  portId,
} from "./engineContracts";

// ─── Runtime ─────────────────────────────────────────────────────────────────

export type { EngineRegistry, EngineRegistryOptions } from "./engineRegistry";
export { createEngineRegistry } from "./engineRegistry";

// ─── Graph + discovery ───────────────────────────────────────────────────────

export type {
  DependencyGraphResult,
  ExcludedChild,
  ExclusionReason,
} from "./dependencyGraph";
export { resolveDependencyGraph } from "./dependencyGraph";

export type {
  DiscoveryCandidate,
  DiscoveryResult,
  RejectedCandidate,
} from "./discovery";
export { candidatesFromModules, discoverDefinitions } from "./discovery";

// ─── Diagnostics ─────────────────────────────────────────────────────────────

export type {
  DiagnosticCodeCount,
  DiagnosticCollector,
  DiagnosticCollectorOptions,
  DiagnosticSubject,
  DiagnosticSummary,
} from "./diagnostics";
export {
  createDiagnosticCollector,
  diagnostic,
  diagnosticFromIssue,
  NO_DIAGNOSTICS,
  severityForCode,
} from "./diagnostics";
