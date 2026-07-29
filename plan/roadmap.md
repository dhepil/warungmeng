# Roadmap — end-to-end porting sequence (durable; survives context loss)

Any session (human or agent) reads THIS file + `plan.json` + `CLAUDE.md` to know
exactly where we are and what comes next. `plan.json` is the authority for exact
file paths; this file is the authority for **order** and **progress**. If they ever
disagree on *where a file goes*, `plan.json` wins.

**Rule for the working agent:** finish a slice → `npm run check` green → commit →
append to `porting-log.md` → tick the box below → STOP and report. One slice per go.

Phase order is locked and each phase is gated on the previous being `done`:
`P1-domain → P2-module-system → P3-admin-engine → P4-storefront-engine → P5-ui-core → P6-apps`

Legend: `[ ]` not started · `[~]` in progress · `[x]` done & checks green

---

## P0 — Guardrail harness  `[x]`
Committed. Baseline. No product code.

## P1 — packages/domain (pure logic, TS stdlib only)  `[~]`
Port from SOURCE domain/business logic. No React, no adapters, no I/O.
- [x] S1 `catalog.ts` — products/menu, pricing primitives
- [x] S2 `orders.ts` — order model + state transitions
- [x] S3 `inventory.ts` — stock consume/reverse (idempotent)
- [x] S4 `finance.ts` — money type, HPP/tax math
- [ ] S5 `reporting.ts` — read-only aggregations
- [ ] S6 `index.ts` barrel + `domainRules.test.ts` (protected-behavior tests)
- [ ] S7 (optional) domain tidy pass — reduce/clarify code with S6 tests green as the safety net. No behavior change; check must stay green. Skippable.
Gate to done: all P1 `exact` files exist, tests + `npm run check` green.

## P2 — packages/module-system (generic runtime, zero deps)  `[ ]`
Engine host + capability wiring. No domain knowledge, no browser globals.
- [ ] S1 `operationResult.ts` + `engineContracts.ts` (types first)
- [ ] S2 `engineRegistry.ts` + `capabilityRegistry.ts`
- [ ] S3 `dependencyGraph.ts` + `discovery.ts`
- [ ] S4 `diagnostics.ts`
- [ ] S5 `index.ts` + `moduleSystem.test.ts`

## P3 — packages/admin-engine (admin headless logic)  `[ ]`
Depends on domain + module-system. MUST NOT import storefront-engine or React.
- [ ] S1 contracts + snapshot + `shared/atomicOperationPort.ts`
- [ ] S2 `createAdminEngine.ts` + `discoverAdminLogic.ts`
- [ ] S3+ one slice PER engine under `engines/*` (orders, pos, inventory, finance,
      catalog, reporting…), each with its `*Engine.ts`, `*Contracts.ts`, and
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
- P0 done — harness committed, all checks green on empty repo.
- P1 S1 done — catalog.ts ported (types + validation + variant rules consolidated), domain scaffold added, checks green, committed 0800e8f.
- P1 S2 done — orders.ts ported (types + status transitions consolidated), imports Money from ./catalog, checks green.
- P1 S3 done — inventory.ts ported (types + unit conversion + stock math). HPP *functions* deferred to finance.ts (S4) per roadmap; recipe/HPP types kept here. Domain stock primitives only; idempotent consume/reverse belongs to admin-engine (P3). Checks green.
- P1 S4 done — finance.ts ported (types + validation + ledger + calculations consolidated) plus HPP functions from inventory/hpp.ts. Imports Money/Order/inventory recipe types. Checks green.
