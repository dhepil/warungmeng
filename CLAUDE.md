# CLAUDE.md — Build Agent Contract (READ FIRST, EVERY SESSION)

You are porting the Warung Meng codebase from the old repo at
`C:\VSCODE\AntD\warungmeng` (the **SOURCE**) into this repo (the **DESTINATION**),
reorganized to match the target design. The owner is **non-technical and cannot
read code** — they rely entirely on the automated checks below. Your job is to keep
those checks green and never let the build drift from the plan.

If you do nothing else, obey these rules.

## The 8 hard rules

1. **`new-target/*.md` is the ONLY structural authority.** Where a file goes is
   decided by `new-target/` and its machine-readable form `plan/plan.json`. The
   SOURCE repo's own docs (`document contexts/01..07`, migration ledger) are
   IGNORED wherever they conflict. Use SOURCE only for *behavior* (how the logic
   works), never for *structure* (where it lives).

2. **Run `npm run check` at the START and END of every session.** Never edit
   product code while the check is red. If it is red at the start, fix that first
   or report it — do not build on top of drift.

3. **One active phase at a time.** `plan/plan.json` has a `phases` list and an
   `activePhase` field. Work ONLY on the active phase's package. Phase order is
   locked: `P1-domain → P2-module-system → P3-admin-engine → P4-storefront-engine
   → P5-ui-core → P6-apps`. Do not start a phase whose predecessors aren't `done`.

4. **One slice, then STOP.** A slice = one small, cohesive unit (a value object, a
   single logic child, one gate) that fits comfortably in one session before context
   is compacted. After a slice: run `npm run check`, and if green, commit, append a
   line to `plan/porting-log.md`, then **STOP and report to the owner in plain
   language.** Do NOT begin the next slice. Wait for the owner to say "go."

5. **Never create a file that isn't in `plan/plan.json`.** If the code you're
   porting seems to need a file the plan doesn't list, STOP and ask the owner — do
   not invent it. The structure checker will catch invented files anyway.

6. **Reorganize, don't copy.** The SOURCE layout is different from the target
   (SOURCE keeps logic in `apps/*/src/features/*`, `packages/ui-admin`,
   `packages/ui-storefront`, `packages/data`; the target uses
   `packages/{admin,storefront}-engine`, one `packages/ui-core`, and
   `packages/domain`). `plan/plan.json` lists these SOURCE shapes under
   `forbiddenPaths`. If the checker reports `FORBIDDEN LAYOUT`, you copied instead
   of reorganizing — move the behavior into the target location.

7. **Never edit `new-target/` or `plan/` to make a check pass.** If code and plan
   disagree, the plan wins and the code is wrong. Changing the plan to match drifted
   code is the exact failure mode we are preventing. If you genuinely believe the
   plan is wrong, STOP and ask the owner.

8. **Report honestly and in plain language.** No code in the report. Say what you
   ported, that checks are green (or red and why), and that you stopped. Never claim
   "done/verified/passing" without a green `npm run check` in the same session.

## What `npm run check` does (owner-readable)

- **structure** — is every file where the plan says? Flags invented files, files in
  the old SOURCE layout, and (for finished phases) missing planned files.
- **boundaries** — does any file import something forbidden? (e.g. Admin importing
  Storefront, domain importing React, a UI gate importing a repository).
- **typecheck / tests** — added automatically once dependencies are installed and
  product code exists.

One green summary = safe. Any red = stop, do not commit.

## Starting a phase (owner + agent together)

1. Owner confirms the previous phase is `done`.
2. Set the phase's `status` to `active` and `activePhase` to its id in
   `plan/plan.json`. (This is the one allowed plan edit — a status flip, never a
   structure change.)
3. Port slices per rule 4 until the phase's planned files exist and checks are green.
4. Set the phase `status` to `done`, report, and stop.

## Slice workflow (the loop)

```
npm run check            # must be green to start
→ read the matching SOURCE file(s) for THIS slice only
→ write behavior into the target location from plan/plan.json
→ npm run check          # must be green
→ commit                 # only if green
→ append one line to plan/porting-log.md
→ report in plain language, then STOP
```

A slice that can't go green is never committed. The last green commit is always the
safe fallback point.
