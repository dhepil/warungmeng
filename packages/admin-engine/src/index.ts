// packages/admin-engine/src/index.ts
//
// Public entry for the Admin headless runtime.
//
// Hand-picked exports, matching the module system's barrel style: what appears
// here is what a composition root or the UI layer may depend on, and everything
// absent is free to change without breaking them.
//
// Deliberately NOT exported: `adminDefinitionsFromModules` and the glob-backed
// `discoverAdminLogic`. Discovery is how this runtime finds its own areas, not a
// service for others — a host that could hand in its own definition set would be
// building an Admin runtime out of parts the Admin package never validated. The
// legitimate version of that need is the `definitions` option, which is typed,
// documented, and goes through the same graph resolution as a real build.
//
// Nothing here carries UI vocabulary — no label, route, icon, or component
// (LOGIC §5/§11). This package renders nothing and knows about no renderer.

// ─── Composition ─────────────────────────────────────────────────────────────

export { createAdminEngine } from "./createAdminEngine";

// ─── Contracts ───────────────────────────────────────────────────────────────

export type {
  AdminArea,
  AdminAreaSnapshot,
  AdminEngineRuntime,
  AdminEngineSnapshot,
  AdminLogicDefinitions,
  CreateAdminEngineOptions,
} from "./adminEngineContracts";
export { ADMIN_AREAS, ADMIN_NAMESPACE } from "./adminEngineContracts";

// ─── Snapshot reading ────────────────────────────────────────────────────────

export { areaFromEngineId, isAdminRuntimeHealthy } from "./adminEngineSnapshot";

// ─── The atomic workflow seam (LOGIC §10) ────────────────────────────────────
//
// `ATOMIC_OPERATION_PORT` is exported because supplying it is the composition
// root's job. `ADMIN_ATOMIC_OPERATION` is exported because children resolve it,
// and the id string because they list it in `requires`.

export type { AtomicOperationPort } from "./shared/atomicOperationPort";
export {
  ADMIN_ATOMIC_OPERATION,
  ADMIN_ATOMIC_OPERATION_ID,
  ATOMIC_OPERATION_PORT,
} from "./shared/atomicOperationPort";
