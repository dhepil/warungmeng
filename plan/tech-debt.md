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

## D10 — The shared write primitive lives in a contracts file · `open`

**Found:** P3 S4 (inventory part one). **Owner decision, deferred to the end of
P3 by the owner on 2026-07-31.** Do not ask again before then; do not act on it
alone either.

`planStockMovement`, `roundEntered` and `recomputeAverageUnitCost` are behavior,
and they sit in `engines/inventory/inventoryContracts.ts`, which every other area
uses for types only.

**Why it was done:** all three inventory write paths must share one set of
invariants — the manual adjustment (S4) and consumption and reversal (S5). LOGIC
§8 shows neither S5 child requiring a capability from a sibling, so
`stock-consumption` cannot depend on `stock-adjustment`. `plan.json` lists no
shared-helper slot inside an area (`engines/*` allows `*Engine.ts`,
`*Contracts.ts`, and `children/**`), and `packages/domain` is a closed phase. The
alternatives were a cross-sibling import, which the area-slice pattern forbids, or
three copies of the invariants — which is exactly how SOURCE ended up with four
low-stock rules.

**What it costs to fix:** one line in `plan.json` adding something like
`engines/*/<area>Operations.ts` to the `allow` list, then moving three functions.
Cheap mechanically. The reason it was not done in-slice is rule 7: the plan wins,
and an agent editing `plan.json` to make its own design fit is the exact failure
mode the guardrails exist to prevent. Only the owner can widen it.

**What it costs to leave:** a reader of any other area's contracts file learns
that "contracts hold no behavior" is not quite true, and the next agent may either
copy the exception where it is not needed or try to tidy it away and break S5. The
file says at length why it is there, which mitigates but does not remove this.

**Why it is deferred, and to when.** It blocks nothing: the code works, is tested,
and explains itself where it sits. The owner cannot judge it cold, and by the end
of P3 the evidence needed to judge it will exist — all seven areas will have been
built, so we will know whether "two children of one area must share a rule" is an
inventory quirk or a gap in the plan. If several areas hit it, the plan needs a
real slot and the answer is obvious. If inventory is the only one, leaving the
exception alone is clearly right. The decision makes itself at that point.

**The cost of waiting**, stated honestly: S5 will import this, and so will any
later area that writes stock. Moving it at the end of P3 means updating several
importers rather than one. That is a bigger edit but not a harder one, and it buys
a decision made on evidence instead of a guess.

**Revisit at:** the end of P3, together with the phase-gate slice (13). Whoever
does that slice should raise it — by then it is a five-minute decision.

---

## D11 — Average unit cost is unrounded float, and feeds prices · `open`

**Found:** P3 S4, reading SOURCE's cost math.

`recomputeAverageUnitCost` performs no rounding, exactly as SOURCE did. Each
purchase feeds the previous unrounded average back into the numerator, so the
error compounds across an ingredient's whole purchase history with no
re-anchoring, and there is no recompute-from-ledger path.

The value is the single input to all costing: HPP, the recommended selling price,
the gross margin, the reporting COGS, and the figure shown in the materials list.
HPP itself then rounds to two decimals, and the recommended price rounds to the
nearest 500 — so three different money conventions coexist for a currency with no
minor unit.

**Why it was left:** rounding it would change every cost figure the owner
currently sees, which is a behavior change dressed as a bug fix. It also cannot be
decided in isolation: whether IDR money should be integer rupiah is a question
about `packages/domain`'s `Money`, and it affects the Menu and Finance areas too.

**What it costs to fix:** one rounding call, plus a decision about which
precision is correct, plus accepting that existing stored averages are already
drifted and would need recomputing from the ledger to become consistent.

**What it costs to leave:** cost figures are approximately right and slowly get
less so. Nobody will notice until two reports disagree by a rupiah.

**Revisit at:** whenever `Money` gains an integer-minor-unit invariant. Related:
D12.

---

## D12 — "piece" and "portion" are interchangeable · `accepted`

**Found:** P3 S4, reading the domain's unit table.

Both are dimension `count` with factor 1, so 5 portions convert to 5 pieces with
no complaint, and both appear in the unit list for any count-based ingredient.
Nothing in the codebase treats them differently.

**Why it is accepted:** it is the domain's table, unchanged from SOURCE, and it is
a closed phase. Separating them would either forbid a conversion the old app
allowed or require a per-ingredient portion size, which is a feature.

**What to watch:** if a recipe ever means "portion" as a serving rather than a
countable unit, this silently under- or over-consumes stock.

---

## D13 — An adjustment can only be a delta, never an absolute count · `accepted`

**Found:** P3 S4.

There is no "set stock to N" operation. To correct a count after a stocktake the
user computes the difference themselves and records an `adjustment-in` or
`adjustment-out`, and nothing shows them the current level while they do it.

**Why it is accepted:** SOURCE had no such operation either, and adding one is a
new capability rather than a ported one. It is also not purely additive — an
absolute set has to decide what ledger row it writes, which is the same question
as a stocktake feature.

**Revisit at:** whenever a stocktake workflow is wanted. It would be a new child,
not a change to `stock-adjustment`.

---

## D14 — The movement query cannot filter by `referenceId` · `scheduled`

**Found:** P3 S4, while defining `MovementStoreQuery`. **Scheduled for S5. No
owner decision needed** — this was mis-filed as one. It is not a choice between
designs; it is a lookup the next slice needs and the port does not yet allow. One
optional field, inside the area S5 is already building, with the plainly correct
shape. S5 adds it and records that it did.

`referenceId` is a public field on every movement and is what SOURCE's idempotency
check keys on — consumption bails if a `consumption` row already exists for an
order id, reversal bails if an `adjustment-in` does. But SOURCE's movement query
carried only `ingredientId`, `outletId` and `type`, so the check worked by
scanning the full movement array in memory. The port faithfully reproduces that
gap: you can read `referenceId` on a returned row, you cannot query by it.

**Why it was left:** adding it in S4 would have been speculative — no S4 child
needs it, and a port method nobody calls invites an adapter to implement dead
surface. Recorded so S5 does not rediscover it as a surprise.

**What S5 does:** add `referenceId?: string` to `MovementStoreQuery`, use it in the
consumption and reversal idempotency checks, and delete this entry on the way out
(a resolved item belongs in `porting-log.md`, per the top of this file).

**What it costs to leave:** the idempotency check is a linear scan of every
movement ever recorded, on every checkout.

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

---

## D15 — The dashboard reaches into inventory's store shape, not its capability · `open`

**Found:** P3 S4, from the scout's sweep for second consumers. **Decide by S11.**

SOURCE's dashboard declares its own `Pick<InventoryRepository, "listIngredients" |
"listStockBalances" | "listMovements" | "listRecipes" | "calculateHpp">` inside the
dashboard feature — a structural slice of the inventory *repository*, not the
inventory feature's own read capability. So two competing definitions of
"inventory read" overlap on five methods, and neither knows about the other. Its
loader also calls `listIngredients()` with no query at all, so it includes archived
ingredients and relies on downstream status filters.

**Why it is not fixed yet:** the dashboard is slice 11 and does not exist here yet.
S4 did the part it could — `materials-read` and `stock-movements` publish plain
`listIngredients` / `listSuppliers` / `listStockBalances` / `listMovements`
returning raw domain entities precisely so the dashboard has a real capability to
come through, which is why those methods exist alongside the joined list queries.
LOGIC §8 confirms the intent: `admin.dashboard.overview` requires
`admin.inventory.materials-read`, and `admin.dashboard.reports` requires
`admin.inventory.stock-movements`.

**What it costs to fix:** nothing extra, if slice 11 resolves the two capabilities
instead of re-deriving a store shape. The debt is only that nothing yet *forces*
it — an agent building the dashboard could reintroduce a structural Pick and every
check would stay green.

**What it costs to leave:** two definitions of the same read surface drift, and the
boundary rule "a gate must not import a repository" is satisfied in letter while
being violated in spirit.

**Action for S11:** resolve the capabilities. Do not declare a structural type over
`InventoryStorePort`.

---

## D16 — Recipes are read through the port but nothing owns them yet · `open`

**Found:** P3 S4, while defining `InventoryStorePort`.

`listRecipes` and `saveRecipe` exist in SOURCE's repository and are consumed by
HPP and by the dashboard, but `InventoryStorePort` as written in S4 does not carry
them — S4's three children have no use for them, and adding unused methods to a
port invites an adapter to implement something nobody calls.

**Why it was left:** speculative port surface is its own kind of drift. S5 builds
`hpp-calculation`, which genuinely needs recipe reads, and that is the slice that
should add them.

**What it costs to fix:** two methods on the port in S5, where the requirement is
real. Recorded here only so S5 does not treat their absence as an oversight.

**Related:** D14, the same shape of deliberate gap.

---

## D17 — `package-lock.json` carries an unexplained uncommitted change · `open`

**Found:** P3 S4, present at session start and untouched throughout.

The working tree has `package-lock.json` modified — 3 lines added, 56 removed,
dropping some optional/peer `@emnapi/*` entries. It predates this slice; no S4
commit includes it, and all four checks are green with it in place.

**Why it was left:** it is not product code and it is not this slice's work.
Folding an unexplained dependency-graph change into a feature commit would make
that commit describe something it did not do.

**What it costs to fix:** either commit it on its own once someone can say what
produced it (most likely an `npm install` on a different Node or platform), or
`git checkout package-lock.json` to discard it. Both are one command; the decision
is which.

**What it costs to leave:** every future session starts with a dirty tree, so
"working tree clean" stops being a usable signal that nothing unexpected happened.
