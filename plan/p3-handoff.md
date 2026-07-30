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
| 2 | `createAdminEngine` + `discoverAdminLogic` + `index` | done — <hash> |
| 3 | menu — catalog-read, menu-editor, variant-management | next |
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
- **`import.meta.glob` must be written out LITERALLY.** Verified by experiment,
  not assumed. Vite replaces the expression during transformation by matching it
  as text, so assigning it to a variable first type-checks and then throws at
  runtime (`"import.meta.glob" is statically replaced during file
  transformation`). It also needs the narrow `ImportMeta` augmentation in
  `discoverAdminLogic.ts` to pass `tsc`, because it is a bundler feature
  TypeScript does not know. A pattern matching zero files returns `{}` rather
  than throwing — which is why an empty `engines/` folder starts cleanly. Do not
  "tidy" either glob call into a helper variable.
- **The atomic bridge is a child under `admin.runtime.shared`, not an area.** The
  registry has no door for publishing a capability directly — capabilities come
  from children, through the staged scope that makes rollback trustworthy.
  Widening that door would let a host publish behind the registry's back, so the
  port instead enters as a child that provides it. Its engine id has three
  segments on purpose: `areaFromEngineId` only recognizes `admin.<area>`, so the
  bridge cannot be mistaken for an eighth operational area while staying fully
  visible in the generic snapshot. Consequence worth knowing: when no port is
  supplied, nothing publishes the capability, and the dependency graph excludes
  exactly the children that require it — no special-casing anywhere.
- **Excluded children are still registered.** They are left out of the
  initialization order but registered anyway, so they appear in the snapshot as
  unavailable. A child the graph dropped that also vanished from the report would
  be indistinguishable from one that was never written.
- **A missing atomic port is only reported when something requires it.** Fixed
  during S2's mutation round: it previously fired unconditionally, putting an
  error in the snapshot of a healthy runtime with no multi-owner workflow. A
  diagnostic that cries wolf trains its reader to stop looking.
- **Test the de-duplication through a REACHABLE duplicate.** S2's first dedupe
  test was vacuous and the mutation round caught it: a graph-excluded child is
  never initialized, so the registry says nothing about it and only one
  diagnostic ever exists — the assertion passed with dedupe switched off. The
  reachable path is a provider that THROWS: it stays in the graph order, so its
  consumer really is initialized and the registry reports the unmet requirement
  once per `requires` entry. If a future test asserts "reported once", first
  assert the raw duplicate exists upstream.
- **Carried from P2:** no UI vocabulary anywhere in logic (no label, route, icon,
  component) per LOGIC §5/§11. Diagnostic severity always derives from the single
  map in `diagnostics.ts`, never stated at a report site. Fan-in diagnostic
  de-duplication is P3's job — the engine registry deliberately does not do it,
  so `createAdminEngine` (slice 2) is where it belongs. `capabilityRegistry` is
  not exported from module-system; children get capabilities through their
  injected context.

## Notes for slice 3 specifically

Slice 3 is the FIRST real area, so it sets the pattern every later area slice
copies. Getting the shape right matters more than getting it done fast.

- **The engine room is finished and verified end to end.** Discovery already
  finds a real area from disk with nothing injected (proved with a scratch area,
  then removed — building it for real is exactly S3's job). So S3 writes only
  area files: `engines/menu/menuEngine.ts`, `engines/menu/menuContracts.ts`, and
  `engines/menu/children/**/*Child.ts` with a `*.test.ts` beside each child.
  Nothing at the package root should need to change.
- **Files must be named to match the globs** or they are invisible:
  `*Engine.ts` directly under `engines/menu/`, and `*Child.ts` somewhere under
  `engines/menu/children/`. A correct child in a wrongly-named file loads
  nothing and reports nothing. The structure checker will catch a misplaced
  file, but not a mis-suffixed one that still sits in an allowed folder.
- **Each definition file exports ONE definition**, as `default` or a single
  named export — `candidatesFromModules` takes the default if present, otherwise
  the sole export, and anything ambiguous is left to fail validation.
- **The three menu children are `catalog-read`, `menu-editor`, and
  `variant-management`.** Per LOGIC §8 none of them requires anything, which is
  why menu is first: several other areas require `admin.menu.catalog-read`, so
  everything downstream stays blocked until this exists.
- **A child publishes what it declares — exactly.** The registry rolls a child
  back if it publishes an undeclared capability or fails to publish a declared
  one, so `provides` and the `provide()` calls have to agree.
- **Tests are permanent from here on** (one beside each child), not throwaway.
  Still mutation-check them: break the behavior, confirm the test fails, restore.
  S2 proved this is not ceremony — it caught a test that could not fail and a
  diagnostic that cried wolf.
- Behavior comes from SOURCE `apps/admin/src/features/menu/*` (46 files — use a
  scout agent to read it, port in the main thread). Structure comes from
  `plan.json`, never from SOURCE's layout.
