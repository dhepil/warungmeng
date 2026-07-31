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
| 4 | inventory A — materials-read, stock-movements, stock-adjustment | done — 9b9fad9, 69628a7, 0af1ccf |
| 5 | inventory B — stock-consumption, stock-reversal, hpp-calculation | done — 47ece49, 65a064f, ba49026, a19ba0a |
| 6 | finance — ledger-read, transaction-recording, expense-management, refund-projection | done — 6d603b5, 40d2308, 9b91302, 0dc6370, 77ffed8, 9f67f13 |
| 7 | orders — order-read, order-submission | next |
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
- **Verify on-disk discovery with a throwaway test, every area slice.** Vitest
  runs through Vite, so `import.meta.glob` resolves in a temporary test under
  `test/`: assert the engine and every child id come back from
  `discoverAdminLogic()`, and that a runtime composed with no options shows the
  area with all children active. The permanent child tests inject their
  definitions, so they can never catch this. Restored and deleted after each use.
  **Corrected in S4** — the S3 note said the structure checker cannot see a
  mis-suffixed child at all. Measured, it is narrower than that. Renaming
  `materialsReadChild.ts` → `materialsRead.ts` DOES turn structure red, because
  the new name matches no allowed glob. What slips through is a rename whose new
  name matches a *different* allowed glob: `materialsReadHelper.test.ts` passes
  structure AND typecheck AND the suite, while the child loads as nothing and
  reports nothing. That is the case the throwaway test exists for, so it is still
  required every area slice — just for a narrower reason than recorded.
- **Carried from P2:** no UI vocabulary anywhere in logic (no label, route, icon,
  component) per LOGIC §5/§11. Diagnostic severity always derives from the single
  map in `diagnostics.ts`, never stated at a report site. Fan-in diagnostic
  de-duplication is P3's job — the engine registry deliberately does not do it,
  so `createAdminEngine` (slice 2) is where it belongs. `capabilityRegistry` is
  not exported from module-system; children get capabilities through their
  injected context.

## Decisions locked during S4 (inventory part one)

- **A shared write primitive may live in the area contracts file.** This is the
  one exception to "a contracts file exports types, never behavior", and S5
  depends on it, so do not "tidy" it away. `planStockMovement` and its two
  helpers (`roundEntered`, `recomputeAverageUnitCost`) sit in
  `inventoryContracts.ts` because all three write paths — the manual adjustment
  in S4, and consumption and reversal in S5 — must share one set of invariants.
  LOGIC §8 shows neither S5 child requiring a sibling capability, so
  `stock-consumption` cannot depend on `stock-adjustment`; `plan.json` lists no
  shared-helper slot inside an area; `packages/domain` is a closed phase. The
  alternatives were cross-sibling imports (forbidden by the pattern) or three
  copies of the invariants (how SOURCE got four low-stock rules). It stays pure —
  no store, no I/O — and calls the domain for all arithmetic. **Tech-debt D10,
  DEFERRED to the end of P3 by the owner on 2026-07-31:** whether `plan.json`
  should gain a real slot for this. It blocks nothing, so S5 onward just import it.
  Raise it at the phase-gate slice (13), when all seven areas exist and we can see
  whether other areas hit the same need. Do not ask the owner again before then,
  and do not move it on your own — only the owner may widen `plan.json`.
- **Decide, then write. Never write, then validate.** `planStockMovement` returns
  a complete `StockMovementCommit` — ledger row, balance row, and cost row — and
  the store persists all three through one `commitMovement`. SOURCE's
  `recordMovement` did the opposite: it pushed a zero-quantity balance row for a
  new (ingredient, outlet) pair, THEN applied the delta, so a movement refused for
  insufficient stock permanently created a row that had not existed, which changed
  how that ingredient answered the low-stock filter afterwards. A failed write
  altered query results. Every S5 write goes through the same primitive and
  inherits this. Arithmetic is behavior and belongs in logic (LOGIC §3);
  atomicity is a storage property and belongs to whoever owns the storage.
- **One rule per question, chosen in favour of what the owner could see.** Four
  live low-stock implementations disagreed about an ingredient with no balance
  row. The badge said low, the filter hid it, the dashboard excluded it, the usage
  report included it. Consolidated into `isLowStockLevel`, resolved the way the
  badge behaved, because that was the visible behavior and keeping it means the
  list still looks the way it looked. `hasBalanceRecord` preserves the
  distinction the conflation destroyed — "never counted" is not "empty". Expect
  more of these: when a rule has several copies, find which one the owner can
  actually see before picking.
- **Add a tie-break to every ordering.** Both read children sort, and both needed
  one. Ingredient names are not unique (tech-debt D3), and the automated write
  paths stamp every row of one order with an identical `occurredAt`, so the
  ledger had no total order at all — the same audit history could present
  differently on two machines. `localeCompare` on the id is arbitrary but stable.
- **A read child re-applies the filters it asked the store for.** The port
  promises nothing about honouring its query. `stock-movements` filters again
  after reading, so a partially implemented adapter cannot make the ledger appear
  to contain movements the caller excluded. Its test fixture deliberately ignores
  the query to prove this.
- **One rounding convention per runtime.** `roundEntered` uses the same
  `Number.EPSILON` nudge as the domain's `roundMoney`. A test caught the naive
  version rounding 1.005 down, which would have meant two places in one runtime
  rounding one input differently — the same "two owners for one fact" failure as
  a report site stating its own severity.
- **`allowNegativeStock` stays unexposed.** The domain parameter exists and
  defaults to false. No SOURCE caller ever set it, not even a test. Threading a
  flag nobody uses would be inventing a feature, not porting one.

## Decisions locked during S5 (inventory part two)

- **One primitive, with the difference NAMED — do not fork a shared rule.** S4's
  `planStockMovement` carried two rules lifted from the manual entry form: a 0.01
  minimum and two-decimal rounding. A consumption quantity is computed from recipe
  arithmetic and can legitimately be 0.001 or carry many decimals, so those two
  rules had to not apply. The wrong fix was a second planning function; the right
  one was `QuantitySource` (`"entered"` | `"derived"`) with ONLY those two rules
  branching on it. Everything else — ingredient exists and is active, unit
  converts, purchase carries a cost, balance may not go negative — applies to
  both, which is the entire reason one primitive exists. When a shared rule
  genuinely differs between callers, name the difference in the input rather than
  duplicating the judge.
- **A plan must validate exactly what the write validates.** SOURCE's consumption
  ran a "projected balances" dry run so an under-stocked order failed before any
  write, but the projection checked only that each ingredient EXISTED while the
  real write also refused archived ones. An order naming an archived ingredient
  therefore passed the dry run and threw partway through the write loop, leaving
  some components consumed and the rest not. Any time you see a pre-check and a
  write in the same flow, they must be the same judge, or they will drift and the
  drift will be a partial write.
- **An idempotent operation must say whether it did anything.** SOURCE's guard
  returned the existing rows and said nothing, so the POS retry treated a
  non-throwing call as success and cleared its pending-sync flag for an order it
  had never finished consuming. `StockLedgerOutcome.replayed` exists for this.
  Applies to every retryable path in P3, notably slices 8 and 9.
- **A no-op that leaves no trace can never become idempotent.** An order whose
  items all lack recipes wrote zero rows; because the guard keys on rows existing,
  it never latched, so every retry re-ran the whole thing. It is now a named
  failure. Watch for this shape anywhere a guard keys on the side effect it guards.
- **Invert a stored effect, never re-derive it.** The reversal negates the recorded
  `baseQuantityDelta`. SOURCE rebuilt the quantity from the consumed row's entered
  value and unit and re-ran the conversion against the ingredient's CURRENT
  definition, so a `g`→`kg` edit between consuming and cancelling restored 1000×,
  and a `g`→`ml` edit threw — which, through cancellation's rollback, left the
  order permanently un-cancellable behind a "retryable" failure that could never
  succeed. If you are undoing a recorded effect, use the number that was recorded.
- **Batch what is one event.** `commitMovements` takes the whole set, because a
  half-consumed order is worse than a refused one and because the atomic port
  (LOGIC §10) should wrap one call rather than N. The child does not claim
  atomicity — only an adapter can promise that — it makes the batch expressible.
- **A `requires` is enforced, and worth testing both ways.** `hpp-calculation` is
  the first child with one. Its test composes BOTH areas, and also composes the
  runtime WITHOUT the Menu area to prove the dependency graph excludes the child
  rather than letting it publish a capability that cannot work. Note the
  asymmetry: a missing required *capability* means the child is never created; a
  missing injected *port* is a legal state where the child still publishes and
  answers honestly. Do not conflate them.
- **Resolve a sibling area's capability from context; import only its contract
  types.** `hpp-calculation` imports `MENU_CATALOG_READ` and `CatalogRead` from
  `engines/menu/menuContracts` and nothing else. No child imports another child.
- **When one dataset has two resilience policies, the degrading one wins.** SOURCE
  costed menus all-or-nothing on the HPP screen and per-item on the dashboard. One
  bad recipe blanked the entire table in the first and one tile in the second.
  Per-item is now the only policy.
- **Name a policy that is hiding in default arguments.** "60% target margin, round
  up to 500" was the product's pricing rule expressed as the domain's default
  parameters at a single call site. It is `HPP_TARGET_MARGIN_PERCENTAGE` and
  `HPP_PRICE_ROUNDING_STEP` now. Same class of problem as rules in form props.

## Decisions locked during S6 (finance)

- **Finance's automatic ledger is derived, not stored.** The store owns only rows a
  person entered. Sales and refunds are projected from orders at read time with
  deterministic ids, so the same sale cannot be recorded twice and there is no
  persisted refund write. Do not add automatic rows to `FinanceStorePort`; that
  would create two writers for one fact. This is why the store and order reader
  are separate ports and why refund-projection is pure.
- **A source is allowed to fail only when another source produced a trustworthy
  dataset.** SOURCE loaded orders and manual rows in one `Promise.all`, so either
  failure blanked the whole ledger. The target degrades and keeps the healthy side.
  But if EVERY configured source fails, it returns failure — an empty array made by
  fallback initialization is not a usable ledger. Mutation-tested.
- **One calendar-day rule: Jakarta.** SOURCE made date presets in the machine's
  local zone, expanded date-only filters as UTC, and reporting used Jakarta. A
  transaction near midnight could fall outside the preset that selected its day.
  Both preset and filtering now use the domain's Jakarta date-key projection.
- **The write is the judge; do not pre-read editability.** Update and void store
  methods return tagged authoritative outcomes. SOURCE's `null` conflated missing,
  automatic and voided edits, and its void returned the row alone so fresh versus
  replayed was unknowable. A pre-read would be a second judge plus a race. The
  write decides and commits, and a void reports `alreadyVoided`.
- **Unknown categories are invalid; custom categories are explicit.** The domain
  checks direction only when it recognizes a category id, so an invented id skipped
  the rule entirely. SOURCE relied on its dropdown clearing selection — a screen
  preventing a mistake, not a rule. `CUSTOM_CATEGORY_SELECTION` is the sole door
  into custom labels; built-in ids must exist and match direction.
- **Rules hidden in the finance form moved into logic.** Whole non-negative IDR,
  attachment image/PDF ≤5 MB, description ≤300, reference ≤80, custom category
  name ≤80, and direction→transaction-type mapping. Three domain types remain
  unreachable by design; tech-debt D24 says when to revisit.
- **Expense-management is deliberately thin and has no sibling edge.** SOURCE's
  expense screen was the general transaction screen with outflow forced and a
  breakdown added. LOGIC §8 gives the child no requirement, so it neither imports
  nor resolves ledger-read/transaction-recording. It projects posted outflows from
  rows a caller already read. This also fixes SOURCE's mismatch where pending and
  voided rows appeared in the table but were excluded from its total.
- **Refundable means money, never stock.** Refund-projection answers whether a paid
  order settled as refunded and carries the deterministic refund rows. It cannot
  know whether stock was consumed. Slice 8 must act on D18 explicitly and must not
  reuse `refundable` as the stock-reversal gate.
- **POS's finance requirement is unresolved behavior, not a missing method to
  invent.** LOGIC §8 requires transaction-recording; SOURCE checkout never called
  Finance because its sale was derived. Tech-debt D23 belongs to slice 10. Do not
  persist a duplicate sale to satisfy the graph mechanically.
- **A contracts pass must remove dead adapter surface.** S6's first scaffold copied
  SOURCE's production-unused `getManualTransactionById`, an unnecessary exposed id
  generator, and a store-side query. All were removed before slice close. It also
  caught `ManualTransactionRecord` restating a domain type and replaced it with an
  alias. Extend this discipline to every later area: a repository method is not a
  port method merely because SOURCE had it.

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
