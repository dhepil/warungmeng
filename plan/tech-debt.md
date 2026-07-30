# Tech debt register

Things we know are imperfect and chose not to fix yet, with the reason and what
fixing would cost. This is NOT a plan authority — `plan.json` decides structure and
`roadmap.md` decides order. Nothing here is scheduled until the owner says so.

**Why a register at all.** In a PORT, "the old app did it this way" is the right
default, and this file is what stops that default from becoming amnesia. An entry
here means: we saw it, we decided deliberately, and we did not silently inherit it.

**How to use it.** Add an entry when you preserve something you believe is wrong,
or take a shortcut a later phase will have to live with. Say what it costs to fix
and what breaks if we don't. Delete the entry when it is fixed — a resolved item
belongs in `porting-log.md`, not here.

Status: `open` — live, undecided · `accepted` — deliberate, not planned to change ·
`scheduled` — owner approved a slice for it · `resolved` — delete on the way out.

---

## D1 — Deleting a menu or variant group leaves stale links · `open`

**Found:** P3 S3 (menu area). **Owner asked to decide.**

Deleting a variant group does not remove its id from any menu's `variantGroupIds`,
and deleting a menu does not touch any group. The stale link survives. Nothing in
the admin engine notices; the till (POS) is the only reader that does, and only when
it loads a cart, where it raises a `missing-group` issue.

**Why it was left:** SOURCE behaved exactly this way in both directions. Cleaning up
would be a new rule rather than a ported one, and it would make
`variant-management` the second writer over menu rows for a reason unrelated to its
own workflow.

**What it costs to fix:** one guarded pass at delete time in each direction. The
awkward part is not the loop, it is ownership — menu deletion lives in
`menu-editor`, group deletion in `variant-management`, and neither may depend on the
other (LOGIC §8: no menu child requires anything). Likely shape: each child cleans
up the links it is responsible for, through the store port it already holds.

**What it costs to leave:** every reader of `variantGroupIds` must tolerate ids that
resolve to nothing, forever. POS already does. Anything built later that assumes a
listed group exists will be wrong, and the failure will surface far from the delete
that caused it.

---

## D2 — Nothing checks that a `categoryId` points at a real category · `open`

**Found:** P3 S3, reading the domain validator.

`validateMenuItem` only requires `categoryId` to be non-blank. A menu can carry a
category id that no category has. Same shape of problem as D1 and worth deciding
together with it.

**Why it was left:** SOURCE never checked it either — the editor happened to offer
only real categories, so the invalid case was unreachable through the one screen.
That is not a rule, it is a screen that never allowed the mistake.

**What it costs to fix:** one existence check in `menu-editor.saveMenu`, which
already reads categories for the draft. Cheap. The reason it is not done is that it
changes what a valid write is, and the same question applies to `variantGroupIds`
(D1), so both should be answered at once rather than one per slice.

---

## D3 — No uniqueness rule on any name or slug · `accepted`

**Found:** P3 S3.

Two menus may share a name and a slug. Two categories may. Two options inside one
group may share a name (only their **ids** are checked for uniqueness). Nothing
anywhere enforces otherwise.

**Why it is accepted:** SOURCE had no such rule, and enforcing uniqueness needs a
decision we cannot make inside the engine — unique across what scope, and what
happens to the existing rows that already collide. Slugs will matter more once the
storefront addresses menus by slug (P4), which is the natural moment to decide it.

**Revisit at:** P4, or sooner if the owner wants menu URLs to be stable.

---

## D4 — Variant group save is two writes, not one · `accepted`

**Found:** P3 S3.

Saving a variant group writes the group, then updates each attached menu. The two
phases are not atomic, so a failure partway leaves the group saved and some menus
out of sync.

**Why it is accepted:** LOGIC §10 scopes the atomic boundary to the two multi-owner
workflows — order cancellation and POS checkout. This is one owner writing several
of its own rows, and promoting it would widen a guarantee the target defines
narrowly on purpose.

**What we did instead:** the save now attempts every menu even after one fails, and
returns a `degraded` result naming exactly which menus are out of sync, so a caller
can retry those. SOURCE threw on the first failure, leaving the rest unattempted
behind one generic error. Mutation-tested.

**Revisit at:** whenever the backend discussion (LOGIC §15) settles what a
transaction actually is here. If a real one becomes cheap, this is the first
candidate.

---

## D5 — Per-option stock is modeled but unreachable · `accepted`

**Found:** P3 S3.

`MenuVariantOption.inventory` is a full `InventoryPolicy`, but no editor writes it —
it is preserved across saves by id lookup and otherwise always `untracked`. Only POS
reads it, in its availability filter.

**Why it is accepted:** it is a domain type with a real reader, so it is not dead
code; there is simply no write path. Inventory is P3 S4-S5, which may well want to
own this. Removing it now would break POS later; adding an editor field now would be
inventing a feature.

**Revisit at:** P3 S5 (inventory part two), or P5 when the option editor UI is
built.

---

## D6 — Three different notions of "available" · `accepted`

**Found:** P3 S3.

The domain has `isMenuAvailable`, which is time-aware and stock-aware. The admin
list filter asks only whether `availability.status` says available. Storefront had a
third, equivalent to the second. Per the scout's read of SOURCE, the domain's
stricter version was never called by anything.

**Why it is accepted:** these are genuinely different questions — "is this menu
marked unavailable" and "can this be ordered right now" — and the list filter wants
the first. `catalog-read` deliberately preserves the plain status comparison so the
list keeps showing what it showed. Answering the stricter question there would have
silently changed the list.

**What to watch:** if a THIRD implementation of the strict question appears in a
later area, that is the signal to consolidate on the domain's. One unused function is
fine; two competing copies is drift.

---

## D7 — Variant options are never sorted on read · `accepted`

**Found:** P3 S3.

`catalog-read` sorts menus, categories and variant groups (`sortOrder`, then name).
Options inside a group are returned in stored array order and not sorted, even
though they carry a `sortOrder`.

**Why it is accepted:** SOURCE only rewrote option `sortOrder` on a full editor
save, and the editor shows array order. Sorting on read would make the list disagree
with the editor that produced it. The inconsistency is real but the alternative is
worse until option ordering has one owner.

---

## D8 — P1 domain tidy pass never ran · `open`

**Found:** P1 S7, deferred at the time because no tests existed yet.

An optional cleanup pass over `packages/domain` — reduce and clarify, no behavior
change — was left undone. It is safer now than it was: 17 domain tests plus
everything built on top would catch a regression.

**Why it is still open:** it buys clarity, not capability, and every phase since has
had something more valuable to do. Skippable indefinitely.

---

## D9 — Dead discount branch, ported nowhere · `accepted`

**Found:** P3 S3.

A variant option's `priceAdjustment` is validated as a non-negative whole amount, so
a discount option is impossible — yet SOURCE's UI rendered a minus-sign branch that
could never fire. Someone expected discounts.

**Why it is accepted:** the branch was presentation, so it did not come along, and
the engine now rejects a negative adjustment explicitly with a named issue rather
than by accident. If discount options are actually wanted, that is a feature
request, not debt — and it starts in `packages/domain`, whose validator is the thing
forbidding them.
