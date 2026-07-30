# Roadmap — end-to-end porting sequence (durable; survives context loss)

Any session (human or agent) reads THIS file + `plan.json` + `CLAUDE.md` to know
exactly where we are and what comes next. `plan.json` is the authority for exact
file paths; this file is the authority for **order** and **progress**. If they ever
disagree on *where a file goes*, `plan.json` wins.

`plan/tech-debt.md` holds what we knowingly left imperfect and why. Add an entry
there when you preserve something you believe is wrong, or take a shortcut a later
phase must live with — it is what keeps "SOURCE did it this way" from turning into
nobody remembering we noticed.

**Rule for the working agent:** finish a slice → `npm run check` green → commit →
append to `porting-log.md` → tick the box below → STOP and report. One slice per go.

Phase order is locked and each phase is gated on the previous being `done`:
`P1-domain → P2-module-system → P3-admin-engine → P4-storefront-engine → P5-ui-core → P6-apps`

Legend: `[ ]` not started · `[~]` in progress · `[x]` done & checks green

---

## P0 — Guardrail harness  `[x]`
Committed. Baseline. No product code.

## P1 — packages/domain (pure logic, TS stdlib only)  `[x]`
Port from SOURCE domain/business logic. No React, no adapters, no I/O.
- [x] S1 `catalog.ts` — products/menu, pricing primitives
- [x] S2 `orders.ts` — order model + state transitions
- [x] S3 `inventory.ts` — stock consume/reverse (idempotent)
- [x] S4 `finance.ts` — money type, HPP/tax math
- [x] S5 `reporting.ts` — read-only aggregations
- [x] S6 `index.ts` barrel + `domainRules.test.ts` (protected-behavior tests)
- [ ] S7 (optional) domain tidy pass — reduce/clarify code with S6 tests green as the safety net. No behavior change; check must stay green. Skippable.
Gate to done: all P1 `exact` files exist, tests + `npm run check` green.

## P2 — packages/module-system (generic runtime, zero deps)  `[x]`
Engine host + capability wiring. No domain knowledge, no browser globals.
- [x] S1 `operationResult.ts` + `engineContracts.ts` (types first)
- [x] S2 `engineRegistry.ts` + `capabilityRegistry.ts`
- [x] S3 `dependencyGraph.ts` + `discovery.ts`
- [x] S4 `diagnostics.ts`
- [x] S5 `index.ts` + `moduleSystem.test.ts`

## P3 — packages/admin-engine (admin headless logic)  `[~]`
Depends on domain + module-system. MUST NOT import storefront-engine or React.
- [x] S1 contracts + snapshot + `shared/atomicOperationPort.ts`
- [x] S2 `createAdminEngine.ts` + `discoverAdminLogic.ts` + `index.ts`
- [x] S3 menu — `menuEngine.ts`, `menuContracts.ts`, catalog-read, menu-editor,
      variant-management (first real area; sets the pattern — see `p3-handoff.md`)
- [x] S4 inventory A — `inventoryEngine.ts`, `inventoryContracts.ts`,
      materials-read, stock-movements, stock-adjustment
- [ ] S5+ the remaining engines under `engines/*` (inventory B, finance, orders,
      pos, dashboard, settings), each with its `*Engine.ts`, `*Contracts.ts`, and
      `children/**` — port atomic ops (`cancelOrderAtomically`,
      `submitPosCheckoutAtomically`) as their own slices with tests
- [ ] Sn `adminEngineGraph.test.ts`

## P4 — packages/storefront-engine (storefront headless logic)  `[ ]`
Depends on domain + module-system. MUST NOT import admin-engine or React.
- [ ] S1 contracts + snapshot
- [ ] S2 `createStorefrontEngine.ts` + `discoverStorefrontLogic.ts`
- [ ] S3+ one slice per `engines/*` (checkout…), incl. `submitCheckoutSafely.ts`
- [ ] Sn `storefrontEngineGraph.test.ts`

## P5 — packages/ui-core (single shared UI source)  `[ ]`
Headless UI contract layer has NO React/AntD; React/AntD only in `renderer/` +
`layouts/` + `widgets/` + `theme/`. A gate/layout MUST NOT import a repository/engine
internal — only engine public entries.
- [ ] S1 headless: `createUiCore`, `uiContracts`, `uiCoreSnapshot`,
      `layoutRegistry`, `gateRegistry`, `presentationState` + `uiCore.test.ts`
- [ ] S2 7 global layouts (`layouts/*.tsx`) + `globalLayouts.test.tsx`
- [ ] S3 3 widget groups (`widgets/*.tsx`) + `globalWidgets.test.tsx`
- [ ] S4 renderer (`UiHost`, `AntdUiRenderer`, `SurfaceShell`,
      `NavigationRenderer`, `iconRegistry`) + `renderer.test.tsx`
- [ ] S5 theme (`themeContracts`, `createAntdTheme`, `ThemeProvider`) + `styles/uiCore.css`

## P6 — apps (admin + storefront shells; gates only)  `[ ]`
Thin app shells that mount ui-core + wire engines. 7 admin gates, 4 storefront gates.
- [ ] S1 apps/admin shell + gates (one gate per sidebar root)
- [ ] S2 apps/storefront shell + gates (one gate per flow)
Gate to done: apps build, all boundary + structure + tests green end to end.

---

## Progress notes
(latest at top — agent appends one line when a slice or phase changes state)
- P3 S4 done — inventory part one, in three green commits (9b9fad9 contracts + engine + materials-read, 69628a7 stock-movements, 0af1ccf stock-adjustment). The area-slice pattern held; the one structural decision worth carrying forward is where the shared write primitive lives. SOURCE's `recordMovement` was a single store method that computed the balance delta, mutated the balance, recomputed the ingredient's average cost and only then appended the ledger row — arithmetic in the adapter, three writes in an order the caller could not see. The target inverts that: `planStockMovement` validates and computes everything and touches nothing, and the store's `commitMovement` persists the finished plan. It sits in `inventoryContracts.ts` rather than in `stock-adjustment`, which is the one deliberate exception to "a contracts file holds no behavior" — LOGIC §8 shows neither S5 child requiring a sibling capability, so consumption cannot depend on the adjustment child, and leaving the invariants there would force S5 to reimplement them. That is exactly how SOURCE ended up with four copies of its low-stock rule. `plan.json` has no shared-helper slot inside an area and `packages/domain` is a closed phase, so the choice was between this and duplication; it is tech-debt D10 and the owner can decide whether a slot belongs in the plan before S5 builds on it. The headline defect fixed: SOURCE had four live low-stock implementations plus an unused one in the domain, disagreeing about an ingredient with no balance row — the table badged it low, the store's filter could not return it, the dashboard excluded it, the usage report included it — so ticking "low stock only" HID rows the same list had just badged. One rule now, resolved in favour of the badge, with `hasBalanceRecord` keeping "never counted" distinguishable from "empty". Second real fix: a refused movement now writes nothing, where SOURCE pushed a zero-quantity balance row for a new (ingredient, outlet) pair BEFORE applying the delta, so a movement rejected for insufficient stock permanently created a row that had not existed and thereby changed how that ingredient answered the low-stock filter afterwards — a failed write altering query results. Ordering moved out of the store into both read children, with tie-breaks added in both: ingredient names are not unique, and the automated paths stamp every row of one order with an identical timestamp, so the ledger had no total order and could present the same audit history differently on two machines. Form-only rules moved into logic per LOGIC §13: quantity minimum 0.01 (the domain accepts zero, so logic was writing no-op ledger rows), two-decimal rounding, unit-must-convert (SOURCE only pre-filtered the dropdown, so every non-UI caller skipped it), purchase-requires-cost (SOURCE coerced a missing cost to zero, dragging the weighted average down), no negative cost, no re-archiving. Rounding adopted the domain's EPSILON convention after a test caught 1.005 rounding down — two places in one runtime must not round one input differently. Typed results replace the single generic toast that made a negative-balance rejection and a dead backend indistinguishable. Dropped: the `outletId` that scoped nothing unless `lowStockOnly` was set, and the hooks' opaque boolean error flag. 8 mutations across the three children; 7 caught immediately, and the eighth exposed a test that asserted only half of a count relaxation — strengthened, then re-verified. Also corrected a claim in the handoff: the structure checker DOES catch a mis-suffixed child when the new name matches no allowed glob; what it is blind to is a rename whose new name matches a different allowed glob (`materialsReadHelper.test.ts` passes structure and typecheck while loading as nothing). The throwaway discovery test remains necessary, for a narrower reason than recorded. Checks green, 268 tests.
- P3 S3 done — menu, the FIRST real operational area, in three green commits (69b560d scaffold + catalog-read, d14ffb5 menu-editor, 8513852 variant-management). Landing an area as several commits is legal and now the pattern: `plan.json` lists `engines/*` as `allow` globs rather than `exact`, so a partial area passes all four checks, and completeness is slice 13's phase-gate test. Each commit was green before it landed, so each is a fallback point. Structure: `menuEngine.ts` (identity only, no child imports), `menuContracts.ts` (capability tokens, the ONE outbound catalog-store port, and the query/editor shapes that are admin concerns rather than domain vocabulary), three children each resolving the port themselves — forced, since LOGIC §8 shows no menu child requiring anything, so menu-editor cannot depend on catalog-read. Six deliberate departures from SOURCE, all recorded in p3-handoff: ordering (sortOrder, then name) moved out of the in-memory repository into the read child, because in SOURCE a different adapter would have silently changed menu order; the variant availability filter compares against the requested value instead of the literal "unavailable" SOURCE hardcoded; field limits that existed only as form `maxLength` attributes moved into logic per LOGIC §13, along with "a group keeps at least one option" which was only a disabled button; the save baseline is re-read at save time instead of captured at mount, closing the window where a slug or compareAtPrice changed elsewhere gets overwritten; the scheduled-menu interval id comes from the store's generator rather than the literal "sales-interval-default" that let two menus edited in one session collide; and a variant group's non-atomic two-phase save now attempts every menu and reports `degraded` naming the failed ones, where SOURCE threw on the first and left the rest unattempted behind one generic error. It stays non-atomic on purpose — LOGIC §10 scopes the atomic port to order cancellation and POS checkout. Fixed a real invariant hole: the inline option delete wrote the filtered array back without consulting the selection rule, so it could leave a group demanding more selections than it had options; turning an option OFF is guarded for the same reason, since the rule is judged against AVAILABLE options. Left alone deliberately and written down: deleting a menu or group strips no `variantGroupIds`, so dangling links survive and only POS notices at read time. Dropped: the dead `MenuListQuery` store-side search, the module-level repository Proxy singleton the port replaces, the React hooks' uncached state, and a never-reachable discount-price display branch. `DeleteMenuCategoryResult` folded into the one `OperationResult` shape (in-use is a conflict carrying the count). Tests reach each capability through a probe child that declares it in `requires`, the path a real consumer uses, so a capability published under the wrong id fails the suite. 18 mutations across the three children, all caught. Also verified on-disk discovery with a throwaway test — the structure checker catches a misplaced file but NOT a mis-suffixed one, and a renamed child file produced 3 failures before being restored and the check deleted. Checks green, 196 tests.
- P3 S2 done — createAdminEngine.ts (the LOGIC §7 startup sequence: discover → graph → register → initialize → expose; owns the two jobs the generic runtime leaves to a host, namely fan-in diagnostic de-duplication and republishing the injected atomic port as the capability LOGIC §8 requires) + discoverAdminLogic.ts (the two §7 globs, scoped to this package's own engines/ folder so "Admin never scans Storefront" is structurally true, plus a namespace filter as defence in depth) + index.ts (hand-picked public exports; discovery deliberately NOT exported — the legitimate form of that need is the typed `definitions` option). Settled two mechanics by experiment rather than assumption: `import.meta.glob` must be written out literally (aliasing it type-checks and then throws at runtime — the variant that passed tsc most easily would have shipped broken) and needs a narrow ImportMeta type augmentation to pass tsc; a pattern matching zero files returns {} rather than throwing, which is why an empty engines/ folder starts cleanly. Verified 19 behaviors with a temporary suite, then verified on-disk discovery end to end with a scratch area (removed — it is S3's work). Mutation round caught a real defect: the first de-duplication test was VACUOUS — a graph-excluded child is never initialized, so only one diagnostic ever existed and the assertion passed with dedupe switched off. Rewrote it around a genuinely reachable duplicate (a throwing provider, whose consumer does reach the registry) and it now fails when dedupe is disabled. The same investigation exposed a second defect: the missing-atomic-port diagnostic fired even when nothing required an atomic boundary, putting an error in a healthy runtime's report; it is now conditional on a child actually declaring the requirement. All five mutations caught. Checks green, committed d32dba3.
- P3 S1 done — admin-engine scaffold + adminEngineContracts.ts (runtime identity, ADMIN_AREAS expectation list, composition options, narrowed runtime handle that cannot register after startup) + adminEngineSnapshot.ts (pure projection of the generic snapshot into per-area state; disposed children counted as neither failed nor unavailable; unexpected areas appended, never dropped) + shared/atomicOperationPort.ts (both ends of the atomic seam in one file: the inbound outbound-port token composition supplies, and the outbound capability token children require per LOGIC §8). Resolves the open design question flagged before the phase: the atomic operation arrives as an injected port and the engine root republishes it as the capability — no module-system change needed, P2 stays closed. Phase 3 activated. Verified 14 behaviors with a temporary suite (deleted; permanent tests ship per-child from S3 on, plus the phase-gate test at Sn). Mutation-checked the two load-bearing tests (counting disposed as failed; dropping an unexpected area) — both caught. Checks green, committed 0e70323.
- **P2 DONE** — phase closed, status flipped in plan.json. All 11 planned module-system files exist; 51 permanent tests + 17 domain tests green.
- P2 S5 done — index.ts (hand-picked public exports, matching SOURCE's barrel style; capabilityRegistry deliberately NOT exported — it is the staging seam the engine registry owns, and a host publishing behind its back would break staged rollback) + moduleSystem.test.ts (51 permanent tests consolidated from SOURCE's 5 suites, written against the public barrel so a missing export fails the suite). Dropped SOURCE's moduleSurfaceBoundary suite: it re-implemented an import scanner inside a test, and `npm run check` already enforces that rule for every package — a second owner is drift. Finished the S4 severity correction: the leftover hardcoded "warning" in engineRegistry is gone and all three files now derive severity from the one map, so no report site can state its own. Mutation-checked the two load-bearing tests (softened a code to warning; leaked the snapshot array) — both caught. Typecheck also caught a readonly-cast the tests could not. Checks green, committed 677ae6f.
- P2 S4 done — diagnostics.ts (collector with grouping by child/engine, severity filter, summary with fatal signal, optional de-duplication). Ported SOURCE's collector plus the dedupe filter SOURCE had inlined in createModuleRegistry. Registry now collects through it (dedupe off — its report sites are already distinct; fan-in dedupe belongs to the P3 host). Corrected my own invention mid-slice: I had made missing-dependency a warning, but SOURCE marks every code an error and "may we continue" is already carried by the degraded status — two owners for one fact is drift, so severity stays uniform. Verified 17 behaviors with a temporary suite (deleted; permanent tests are S5). Checks green, committed 8f76975.
- P0 done — harness committed, all checks green on empty repo.
- P1 S1 done — catalog.ts ported (types + validation + variant rules consolidated), domain scaffold added, checks green, committed 0800e8f.
- P1 S2 done — orders.ts ported (types + status transitions consolidated), imports Money from ./catalog, checks green.
- P1 S3 done — inventory.ts ported (types + unit conversion + stock math). HPP *functions* deferred to finance.ts (S4) per roadmap; recipe/HPP types kept here. Domain stock primitives only; idempotent consume/reverse belongs to admin-engine (P3). Checks green.
- P1 S4 done — finance.ts ported (types + validation + ledger + calculations consolidated) plus HPP functions from inventory/hpp.ts. Imports Money/Order/inventory recipe types. Checks green.
- P1 S5 done — reporting.ts ported (types + dashboard + reports consolidated). Read-only aggregations over ReportingSnapshot; imports from catalog/finance/inventory/orders. Checks green.
- P2 S3 done — dependencyGraph.ts (startup order + duplicate/orphan/missing/cycle exclusion, deterministic) + discovery.ts (quarantines unknown candidates so nothing malformed reaches the registry). Edges derived from requires→provides since the target has no dependsOn. Dropped SOURCE's UI-field and surface validation. Verified 12 behaviors with a temporary suite (deleted; permanent tests are S5). Checks green, committed 4a02ae4.
- P2 S2 done — capabilityRegistry.ts (staged scopes: a child's capabilities stay pending until it is fully created) + engineRegistry.ts (register/resolve/list/initialize/dispose, snapshot, subscribe). Consolidated from SOURCE's 7 registry/capability files, reshaped from its async extension model to the target's synchronous parent/child creation. Verified 8 behaviors with a temporary suite (deleted; permanent tests are S5) — it caught a real defect where a child could not dispose its own capability, now fixed. Checks green, committed 778b197.
- P2 S1 done — module-system scaffold + operationResult.ts (one success/degraded/failure shape, replacing SOURCE's three near-identical result unions) + engineContracts.ts (identity brands, capability tokens, diagnostics, outbound ports, parent/child definitions, lifecycle + snapshot). Consolidated from SOURCE's 8 contracts/* files. Two deliberate departures per LOGIC §5/§11: dropped surface vocabulary (SOURCE hardcoded admin/storefront into the generic runtime) and dropped UI vocabulary (navigation/route/label/icon/component contributions). Phase 2 activated. Checks green, committed 60bd877.
- P1 S6 done — index.ts barrel + domainRules.test.ts (17 protected-behavior tests). Installed minimal test toolchain (vitest, typescript, @types/node) — first deps in repo. Replaced structuredClone (needs DOM lib, breaks domain purity) with a pure JSON deep clone in finance.ts; added a test asserting deep-clone identity. typecheck + tests now run inside npm run check. ALL FOUR checks green. **P1-domain DONE.**
