# P3-admin-engine — live handoff

**Purpose.** Read this at the start of every P3 session, together with
`plan/roadmap.md`, `plan/plan.json`, `CLAUDE.md`, and memory
`warungmeng-port-plan.md`. This file holds the P3-specific decisions that would
otherwise be lost when context is compacted. It is notes, not authority:
`plan.json` still decides where files go, `roadmap.md` still tracks order and
progress. Keep it current — update the slice table and append to the decisions
list as part of each slice, before committing.

**Where a decision goes.** A decision that shapes how the code is built belongs
here. Something we knowingly left imperfect belongs in `plan/tech-debt.md` — if
you preserve behavior you believe is wrong, or take a shortcut a later phase must
live with, write it there in the same slice. S3 opened D1-D9; D1 (stale variant
links after a delete) and D2 (unchecked `categoryId`) are the two the owner still
has to decide, and they should be answered together.

---

## Slice plan (owner-approved, 13 slices)

Order is forced by the capability graph in `new-target/LOGIC-TARGET-FILE-TREE.md`
§8, not chosen freely: nothing can be built before what it requires.

| # | Slice | State |
|---|---|---|
| 1 | scaffold + `adminEngineContracts` + `adminEngineSnapshot` + `shared/atomicOperationPort` | done — 0e70323 |
| 2 | `createAdminEngine` + `discoverAdminLogic` + `index` | done — d32dba3 |
| 3 | menu — catalog-read, menu-editor, variant-management | done — 69b560d, d14ffb5, 8513852 |
| 4 | inventory A — materials-read, stock-movements, stock-adjustment | next |
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
- **An area slice may land as several green commits.** S3 shipped as three
  (scaffold+read, editor, variants). The plan decides where files go and in what
  order areas are built; it does not fix how many commits a slice takes, and
  `plan.json` permits a partial area — the `engines/*` entries are `allow` globs,
  not `exact`, so a menu area with one child passes all four checks. Completeness
  is slice 13's job. Each commit was green before it landed, so each is a
  fallback point; the log, roadmap and handoff are still updated once, at the end
  of the slice. Later area slices should do the same — one child per commit.
- **Every child gets its store from the injected port, not from a sibling.** All
  three menu children resolve `MENU_CATALOG_PORT` themselves. That is forced:
  LOGIC §8 shows no menu child requiring anything, so `menu-editor` cannot depend
  on `catalog-read`. Consequence to expect in every later area — the store is the
  single writer of record with several callers, exactly as in SOURCE.
- **A missing port is not an unavailable child.** With no store supplied, the
  children still load, still publish, and answer every call with a normalized
  failure carrying a `no-catalog-store` issue, plus ONE `missing-dependency`
  diagnostic reported at creation rather than per call. `unavailable` is reserved
  for its real meaning: a required capability nobody published. A child that
  vanished because its adapter was absent would be indistinguishable from one
  never written.
- **Ordering belongs to the read child, not the store.** SOURCE sorted inside its
  in-memory repository (`sortOrder`, then `name.localeCompare`), so a different
  adapter would have silently changed the order menus appear in. Ordering is a
  promise the engine makes, so `catalog-read` sorts its own results and the port
  promises no order at all.
- **Count projections relax exactly one filter dimension.** Category counts ignore
  the selected category; availability counts ignore the selected availability;
  both keep every other dimension applied. Selecting one value must not zero out
  the others' counts. Absent key means zero. Mutation-tested — and note the
  matching consequence, that `totalCount` is the total *within* the selected
  category, not the catalog.
- **Capability id = child id, except where LOGIC names one.** `admin.menu.catalog-read`
  is written in LOGIC §8 and used verbatim. Nothing in the doc names the other
  two, so they take their child ids (`admin.menu.menu-editor`,
  `admin.menu.variant-management`). Slightly repetitive, but it invents nothing
  and a reader can always predict the id. LOGIC does name `admin.orders.cancel`
  for the cancellation child, so orders will not follow this default — use the
  doc's id wherever the doc states one.
- **Rules that lived only in a form move into logic.** Menu name ≤120,
  description ≤500, category and variant-group names ≤80, variant option name
  ≤80, "a group keeps at least one option". SOURCE enforced these as `maxLength`
  attributes and a disabled button, so anything not going through that one form
  skipped them, and the P5 UI rebuild would have had to rediscover them. LOGIC
  §13 puts validation below the screen. **Expect more of these in every area —
  look for `rules={[...]}`, `maxLength`, `min=`, and `disabled=` in SOURCE
  components before declaring an area ported.**
- **The baseline is re-read at save time.** SOURCE captured it in screen state at
  mount, so a slug or `compareAtPrice` changed elsewhere could be overwritten on
  save. One extra read removes the class of problem; do the same in every editor.
- **Two real defects fixed, one left alone deliberately.** Fixed: the inline
  option delete never consulted the selection rule, so it could leave a group
  demanding more selections than it had options (and turning an option OFF can
  break the same rule, because the rule is judged against AVAILABLE options —
  guarded too). Fixed: the variant filter compared against the literal
  `"unavailable"` instead of the requested value. Left alone: deleting a menu or
  a group strips no `variantGroupIds`, so dangling links survive and only POS
  notices at read time — cleanup would be a new rule and a second writer over
  menus. That one is `tech-debt.md` **D1**, still open and awaiting the owner;
  decide it together with **D2** (nothing checks a `categoryId` exists), since
  both ask the same question about referential rules.
- **A non-atomic multi-step write reports its partial outcome.** Saving a variant
  group writes the group, then N menus. It stays non-atomic — LOGIC §10 scopes
  the atomic port to order cancellation and POS checkout, and promoting this
  would widen a deliberately narrow guarantee. But every menu is attempted even
  after one fails, and the result is `degraded` naming the failed menu ids;
  SOURCE threw on the first, leaving the rest unattempted behind one generic
  error. Use `operationDegraded` for this shape, not a bespoke union.
- **Bespoke result unions fold into `OperationResult`.** SOURCE's
  `DeleteMenuCategoryResult` (`deleted` | `in-use` | `not-found`) became
  success / `conflict` carrying the count in `issues[0].details` / `not-found`.
  One result shape for the whole runtime (LOGIC §5); a second vocabulary per area
  is drift.
- **Tests reach a capability through a probe child, never `create()` directly.**
  Each child test composes a real runtime and adds a throwaway child that declares
  the capability in `requires` and captures it from its context — the same path
  inventory HPP and POS checkout will use. A direct `create()` call would pass
  even if the capability were published under the wrong id. Copy this helper.
- **Verify on-disk discovery with a throwaway test, every area slice.** The
  structure checker catches a misplaced file but NOT a mis-suffixed one in an
  allowed folder — `catalogRead.ts` beside its siblings loads as nothing and
  reports nothing. Vitest runs through Vite, so `import.meta.glob` resolves in a
  temporary test under `test/`: assert the engine and every child id come back
  from `discoverAdminLogic()`, and that a runtime composed with no options shows
  the area with all children active. Confirmed it fails as intended by renaming
  one child file (3 failures), then restored and deleted the check. The permanent
  child tests inject their definitions, so they can never catch this.
- **Carried from P2:** no UI vocabulary anywhere in logic (no label, route, icon,
  component) per LOGIC §5/§11. Diagnostic severity always derives from the single
  map in `diagnostics.ts`, never stated at a report site. Fan-in diagnostic
  de-duplication is P3's job — the engine registry deliberately does not do it,
  so `createAdminEngine` (slice 2) is where it belongs. `capabilityRegistry` is
  not exported from module-system; children get capabilities through their
  injected context.

## The area-slice pattern (established by slice 3 — copy it)

Slice 3 built the first real area, so its shape is the template. In order:

1. Extend `<area>Contracts.ts` with the capability token(s), the outbound port
   the area needs, and the area's own input/output shapes. Domain types are
   imported, never redefined.
2. Write `<area>Engine.ts` — identity only, no child imports, default export.
3. One child per commit: `<feature>Child.ts` + `<feature>.test.ts`, each child
   resolving the port itself and publishing exactly what it declares in
   `provides`. `npm run check` green before each commit.
4. Mutation-check the load-bearing tests: break the behavior, confirm the test
   fails, restore, `diff` against the backup. S3 ran 18 mutations across three
   children, all caught.
5. Verify on-disk discovery with a throwaway test under `test/`, confirm it fails
   when a child file is mis-suffixed, then delete it.
6. Update roadmap + porting-log + this file, then STOP and report.

Notes below were written before slice 3 and are kept because they still describe
the mechanics every area slice faces.

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
