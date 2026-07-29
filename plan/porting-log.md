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
