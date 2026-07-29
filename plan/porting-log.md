# Porting Log

Plain-language audit trail of the AntD → new-target port. **One line per ported
file.** This is the human-readable history of what came from where, so drift is
traceable without reading code.

Format:

```
YYYY-MM-DD | <phase> | <slice> | AntD: <source path> → dest: <destination path> | check: green
```

- `check: green` is only written after `npm run check` passed AND the slice was
  committed. If a slice failed, do not write a green line — note the failure instead.
- The AntD source layout differs from new-target (see plan/plan.json forbiddenPaths),
  so "→ dest" almost always means the code was **reorganized**, not copied verbatim.

---

## Phase 0 — Guardrail harness (no product code)

2026-07-29 | P0 | harness | (no AntD source) → dest: plan/, package.json, CLAUDE.md | check: pending verification

## Phase 1+ — Port slices (append below as they happen)

2026-07-29 | P1-domain | S1 catalog | AntD: packages/domain/src/catalog/{types,validation,variantSelectionRule}.ts → dest: packages/domain/src/catalog.ts (+ package.json, tsconfig.json) | check: green
2026-07-29 | P1-domain | S2 orders | AntD: packages/domain/src/orders/{types,transitions}.ts → dest: packages/domain/src/orders.ts | check: green
2026-07-29 | P1-domain | S3 inventory | AntD: packages/domain/src/inventory/{types,units,stock}.ts → dest: packages/domain/src/inventory.ts (hpp.ts deferred to finance S4) | check: green
2026-07-29 | P1-domain | S4 finance | AntD: packages/domain/src/finance/{types,validation,ledger,calculations}.ts + inventory/hpp.ts → dest: packages/domain/src/finance.ts | check: green
2026-07-29 | P1-domain | S5 reporting | AntD: packages/domain/src/reporting/{types,dashboard,reports}.ts → dest: packages/domain/src/reporting.ts | check: green
2026-07-30 | P1-domain | S6 index+tests | AntD: catalog/orders/inventory/finance *.test.ts → dest: packages/domain/src/index.ts + domainRules.test.ts (17 tests) | check: green (structure+boundaries+typecheck+tests)
2026-07-30 | P1-domain | S6 fix | structuredClone → pure JSON deep clone in finance.ts (domain purity: no DOM lib) | check: green
2026-07-30 | P1-domain | PHASE DONE | all P1 exact files exist, 4/4 checks green, status flipped to done
2026-07-30 | P2-module-system | S1 foundation types | AntD: packages/module-system/src/contracts/{moduleSurface,moduleId,moduleDependency,moduleCapability,moduleManifest,moduleExtension,moduleContribution,moduleDiagnostic}.ts → dest: packages/module-system/src/{operationResult,engineContracts}.ts (+ package.json, tsconfig.json). Dropped surface vocabulary (admin/storefront) and UI vocabulary (navigation/route/label/icon) per new-target LOGIC §5/§11 — generic runtime must know neither. | check: green
