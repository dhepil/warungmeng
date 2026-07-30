# P3-admin-engine — live handoff

**Purpose.** Read this at the start of every P3 session, together with
`plan/roadmap.md`, `plan/plan.json`, `CLAUDE.md`, and memory
`warungmeng-port-plan.md`. This file holds the P3-specific decisions that would
otherwise be lost when context is compacted. It is notes, not authority:
`plan.json` still decides where files go, `roadmap.md` still tracks order and
progress. Keep it current — update the slice table and append to the decisions
list as part of each slice, before committing.

---

## Slice plan (owner-approved, 13 slices)

Order is forced by the capability graph in `new-target/LOGIC-TARGET-FILE-TREE.md`
§8, not chosen freely: nothing can be built before what it requires.

| # | Slice | State |
|---|---|---|
| 1 | scaffold + `adminEngineContracts` + `adminEngineSnapshot` + `shared/atomicOperationPort` | done — 0e70323 |
| 2 | `createAdminEngine` + `discoverAdminLogic` + `index` | next |
| 3 | menu — catalog-read, menu-editor, variant-management | |
| 4 | inventory A — materials-read, stock-movements, stock-adjustment | |
| 5 | inventory B — stock-consumption, stock-reversal, hpp-calculation | |
| 6 | finance — ledger-read, transaction-recording, expense-management, refund-projection | |
| 7 | orders — order-read, order-submission | |
| 8 | orders — order-cancellation + `cancelOrderAtomically` | |
| 9 | pos — session, cart | |
| 10 | pos — checkout + `submitPosCheckoutAtomically` | |
| 11 | dashboard — overview, reports | |
| 12 | settings — theme-preference, business-hours | |
| 13 | `adminEngineGraph.test.ts` — phase gate | |

Menu is first because several areas require `admin.menu.catalog-read`. Dashboard
is late because it reads orders + inventory + finance. Settings is independent.
Inventory is split in two because six children in one sitting does not fit
reliably before context runs out. The two atomic operations are their own slices,
as `roadmap.md` requires.

## Two structural facts about P3 that differ from P1/P2

1. **Most of P3 is matched by pattern, not by an exact file list.** `plan.json`
   `allowedFiles["P3-admin-engine"]` has an `exact` list (9 root files) plus an
   `allow` list of globs for `engines/*`. The structure checker still catches
   invented and misplaced files, but it will NOT notice a whole area that never
   got built. Completeness is therefore the job of slice 13's phase-gate test —
   that is why it exists and why it comes last.
2. **Tests ship per child, not in one final slice.** The tree puts a `*.test.ts`
   next to every child. So unlike P2, each area slice ends with permanent tests.
   The throwaway-suite habit still applies to root files that have no planned
   test file of their own (slices 1 and 2).

## Decisions locked during P3 (do not re-litigate)

- **The atomic operation seam.** SOURCE threaded an `atomicTransaction` from its
  composition root into `cancelOrderAtomically` and the POS checkout command by
  hand. The target delivers the same guarantee the way every other cross-child
  dependency is delivered: as a capability children declare in `requires`, per
  LOGIC §8. The mechanism enters as an **outbound port**
  (`ATOMIC_OPERATION_PORT`) that the composition root supplies, and the engine
  root republishes it as the **capability** (`ADMIN_ATOMIC_OPERATION`). Both
  tokens live in `shared/atomicOperationPort.ts` on purpose — split them and a
  child could declare the requirement and still resolve nothing. Slice 2 must
  actually perform the republish; until it does, the two atomic children will be
  correctly reported unavailable. **This resolved without touching
  module-system, so P2 stays closed.**
- **`ADMIN_AREAS` is an expectation, not a registry.** Nothing loads from it.
  Adding an engine folder works without editing it. It exists so the phase-gate
  test can detect a silently missing area. If it is ever used to construct the
  runtime, that is LOGIC §7 rule 1 violated.
- **The runtime handle cannot register.** `AdminEngineRuntime` exposes
  getSnapshot/subscribe/dispose only. Registration ends when
  `createAdminEngine` returns; a late registration would mean the dependency
  graph computed at startup no longer describes the running system.
- **`disposed` is not a failure.** In the snapshot projection a disposed child is
  counted in neither `failedChildIds` nor `unavailableChildIds` — an orderly
  shutdown must not read as an outage. Mutation-tested.
- **An unexpected area is appended, never dropped.** An area we did not expect is
  information; hiding it would make the snapshot a worse witness than the
  runtime. Mutation-tested.
- **Carried from P2:** no UI vocabulary anywhere in logic (no label, route, icon,
  component) per LOGIC §5/§11. Diagnostic severity always derives from the single
  map in `diagnostics.ts`, never stated at a report site. Fan-in diagnostic
  de-duplication is P3's job — the engine registry deliberately does not do it,
  so `createAdminEngine` (slice 2) is where it belongs. `capabilityRegistry` is
  not exported from module-system; children get capabilities through their
  injected context.

## Notes for slice 2 specifically

- `discoverAdminLogic` uses the module system's `candidatesFromModules` +
  `discoverDefinitions`. The glob shape is in LOGIC §7
  (`./engines/*/*Engine.ts`, `./engines/*/children/**/*Child.ts`). `import.meta.glob`
  is a bundler feature — it must not break `tsc` or a plain vitest run, and the
  `definitions` override in `CreateAdminEngineOptions` exists so tests never
  depend on what is on disk. Check how this behaves before committing to it.
- Admin discovery must never scan Storefront (LOGIC §7 rule 9). `ADMIN_NAMESPACE`
  is the cheap enforcement point — reject any id not under `admin.`.
- `createAdminEngine` owns the startup sequence in LOGIC §7: discover → validate
  → reject duplicates/orphans → resolve graph → initialize → expose snapshot. It
  also owns the fan-in diagnostic de-duplication noted above, and republishing
  the atomic port as a capability.
- At this point `engines/` is still empty, so slice 2's own verification has to
  run on injected definitions. That is fine and is what the override is for.
