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

**S13 judgement (phase gate, 2026-08-01) — the evidence is in, and it says this is
a pattern rather than an inventory quirk. OWNER DECISION NEEDED.**

With all seven areas built, two of them put behavior in a contracts file:

- `inventory/inventoryContracts.ts` — `planStockMovement`, `roundEntered`, and
  `recomputeAverageUnitCost`, shared by three write children (stock-adjustment,
  stock-consumption, stock-reversal).
- `pos/posContracts.ts` — `posCartFingerprint`, shared by the cart child and the
  checkout child.

The other five areas hold types only. So the deferred question — "is this an
inventory quirk or a gap in the plan?" — has answered itself the way the entry
predicted would make the decision obvious: two independent areas hit the same
need, arriving at it from unrelated directions, because LOGIC §8 gives neither
pair of siblings a capability edge to share the rule through and cross-child
imports are forbidden. That is a structural consequence of the design, not a
shortcut either slice took.

**What the owner is being asked.** Whether `plan.json` should gain one line —
something like `engines/*/*Operations.ts` in the `allow` list — so a shared,
pure, store-free rule has a named home instead of living in a file documented as
holding no behavior. It is one line plus moving four functions and updating six
importers. Nothing breaks either way.

**The honest case for leaving it alone:** it blocks nothing, both files explain at
length why the exception exists, and the alternative costs a plan edit plus a
mechanical refactor across two areas for zero behavior change. **The case for
fixing it:** the next agent reading any other area's contracts file learns that
"contracts hold no behavior" is not quite true, and may either copy the exception
where it is not needed or tidy it away and break three inventory children.

Only the owner may widen `plan.json` (rule 7). Not urgent — P4 is a different
package and inherits none of this.

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

## D16 — No recipe WRITE path, and no child owns recipe editing · `open`

**Found:** P3 S4 as "recipes are not on the port at all". **Half resolved in S5**:
`listRecipes` was added, because `hpp-calculation` genuinely needed it. This entry
is now the narrower remaining gap, restated rather than deleted.

`saveRecipe` is still absent from `InventoryStorePort`, so nothing in this runtime
can create or change a recipe — the engine can only cost recipes that already
exist. SOURCE's repository had `saveRecipe`, and the only caller was
`InventoryRecipeDialog`.

**Why it stays out:** LOGIC §8 names no child that owns recipe editing, so adding
the write method now would put a method on the port with no logic behind it — the
dead-surface problem the S5 addition of `listRecipes` was careful to avoid. It also
carries a pile of rules that currently live nowhere in logic, because in SOURCE
they were AntD form props: at least one component, quantity minimum 0.01, cost
floors, and the unit-compatibility filtering. And SOURCE's dialog generated
component ids **index-positionally** (`recipe?.components[index]?.id ?? ...`), so
deleting a row made the remaining rows inherit their neighbours' identities.
Nothing reads `RecipeComponent.id` today, so that is latent rather than corrupting
— but a recipe editor must not reproduce it.

**What it costs to fix:** a new child, most likely `recipe-editor`, with its own
capability, plus the write method and the rules above moved into logic. That is a
slice of its own, not an addition to an existing one, and it is P5-adjacent since
the screen is what needs it.

**What it costs to leave:** recipes can only be changed by seeding data, so HPP
costs whatever the seed says. Acceptable while there is no UI at all.

**Revisit at:** whenever the recipe screen is scheduled. Raise with the owner then,
since it needs a `plan.json` slot for the new child.

**S13 judgement (phase gate, 2026-08-01) — unchanged and now confirmed by the
complete graph.** All seven areas exist and no child owns recipe editing, so this
is a genuine structural gap rather than an artefact of an unfinished phase. It
needs an owner-approved `plan.json` addition and cannot be closed by an agent.
Raised with the owner alongside D28. Not urgent while there is no UI: recipes can
still be seeded, and HPP costs whatever the seed says.

---

## D19 — HPP rounds three times over the same figures · `accepted`

**Found:** P3 S5, reading the domain's costing math.

`calculateMenuHpp` rounds each component's cost to 2dp, then rounds the **sum of
already-rounded** costs, then rounds again after adding packaging and extras.
Every step is `roundMoney`, so the error is small, but the total is not the round
of the true sum.

**Why it is accepted:** the arithmetic is in `packages/domain`, a closed phase, and
it is SOURCE's exact expression. Changing it would move every cost figure the owner
currently sees. Compounds with D11 (the unrounded average cost that feeds it) and
should be decided together with it.

**Also noted:** `calculateGrossMarginPercentage` rounds without the `Number.EPSILON`
nudge that `roundMoney` uses, so one module rounds two ways — the same class of
inconsistency S4 fixed in `roundEntered`. And the margin is unclamped: a cost above
the selling price yields a negative percentage with no label saying "loss-making".

**Revisit at:** the same moment as D11.

---

## D20 — Historical dashboard COGS needs movement-to-menu attribution · `open, narrowed in P3 S11`

**Found:** P3 S5, from the scout's sweep for HPP consumers. **Slice 11.**

SOURCE multiplied **today's** HPP—derived from today's average ingredient cost—by
historical order quantities. A later purchase could therefore rewrite an earlier
month's COGS and gross margin.

**What S11 fixed:** stock-consumption now snapshots sale-time `unitCost` on every
new consumption movement instead of writing `null`. The amount is expressed in
the movement's entered unit, including conversion from the ingredient base unit.
Reports flag legacy consumption rows with a null cost as degraded. This does not
round the snapshot, so D11/D19 remains a separate precision concern.

**Why this remains open:** the domain's reporting snapshot and aggregators still
accept `menuHpp`, while an inventory movement carries only the order
`referenceId`—not an order-item or menu attribution. The exact Dashboard capability
graph also contains no catalog/HPP dependency. P3 S11 therefore neither reopened
the closed P1 domain nor invented a hidden dependency. It passes no current HPP,
preserves the domain's missing-cost signal, and does not silently restate history;
but it cannot yet calculate historical item-level COGS from the new snapshots.

**Decision needed later:** when the domain/data attribution model is reopened,
link consumption rows to order items or menu quantities and teach the domain
reporting owner to aggregate their stored costs. Until then the capture side is
ready, legacy rows degrade explicitly, and the historical COGS reader remains
incomplete.

---

## D21 — An archived ingredient blocks cancelling an order that used it · `accepted`

**Found:** P3 S5, while building `stock-reversal`.

Archiving an ingredient makes its stock immovable, and a reversal is a stock
movement — so an order that consumed an ingredient which has since been archived
cannot be reversed, and therefore (once slice 8 exists) cannot be cancelled. In
SOURCE this surfaced as a `retryable: true` failure whose retry could never
succeed. Here it is at least an honest, named refusal before anything is written.

**Why it is accepted:** the alternative is letting a reversal move archived stock,
which contradicts the rule the whole area enforces. `archiveIngredient` has no
guard against open orders referencing the ingredient, so the real fix is upstream:
refuse to archive while unreversed consumption exists, which needs an order query
inventory does not have and should not grow.

**What to watch:** if this bites in practice, the fix is a guard at archive time,
not a hole at reversal time.

---

## D22 — A seeded `adjustment-in` can still suppress a real reversal · `accepted`

**Found:** P3 S5, while building `stock-reversal`.

The reversal's idempotency guard keys on `(referenceId, "adjustment-in")`, and
`adjustment-in` is a generic user-facing movement type. Any row of that type
carrying an order's id makes the guard believe the order was already reversed.

**Why it is accepted, and why it is nearly harmless here:** nothing reachable
through the admin engine can create such a row — `RecordMovementInput` has no
`referenceId` field at all and `stock-adjustment` passes `null` unconditionally. In
SOURCE the same protection existed only because one dialog happened to hardcode
`null`; here it is structural. Only externally seeded or directly-written data can
still do it. A dedicated `reversal` movement type would close it completely, but
`InventoryMovementType` lives in `packages/domain`, a closed phase.

**Revisit at:** whenever the domain is next open. One new union member and one
constant.

---

## D24 — Three manual finance transaction types have no write path · `accepted`

**Found:** P3 S6, from the rule hidden in the transaction dialog's submit handler.

The domain accepts `cash-in`, `cash-out`, and `adjustment`, but SOURCE's only
manual-transaction screen derived the type from direction with one ternary:
inflow became `manual-income`, outflow became `expense`. Nothing could create the
other three. The rule is now named, but the types remain unreachable.

**Why it is accepted:** making them selectable is a feature, not a port. It needs a
product definition of how cash-in differs from manual income, how cash-out differs
from expense, and whether adjustment changes only cash balance or the whole
cashflow. Exposing labels without those semantics would pretend the decision was
made.

**Revisit at:** P5, when the finance editor UI is built and the owner can judge a
concrete workflow rather than a union member.

---

## D25 — The finance ledger defaults to one hardcoded outlet · `open`

**Found:** P3 S6.

SOURCE always loaded orders with `outletId: "wm-1"`, so sales and refunds from any
other outlet were silently absent from Finance. The destination preserves `wm-1`
as `DEFAULT_FINANCE_OUTLET_ID` so the current view does not change, but callers may
override it explicitly.

**What it costs to fix:** decide whether Finance is per-outlet or consolidated. A
consolidated ledger removes the filter; a per-outlet ledger needs the active outlet
as composition/application state rather than a package constant.

**What it costs to leave:** a future multi-outlet deployment can understate revenue
unless every caller remembers to pass the outlet. Today the seeds and SOURCE
behavior are single-outlet, so this does not block P3.

**Revisit at:** P6 application composition, when outlet/session state has a real
owner.

**S12 evidence:** Business Hours now persists and evaluates schedules under an
explicit outlet id, but Settings does not own active-outlet selection and no
outlet-management child was added. This confirms rather than resolves D25: P6
composition must decide whether the application selects one outlet or consolidates
them. Finance's default remains unchanged.

---

## D26 — Custom finance category ids can collide · `accepted`

**Found:** P3 S6.

A custom category id is `custom:` plus a slug of its label. Different labels such
as `"Sewa & Kios"` and `"Sewa Kios"` can become the same id, and the expense
breakdown groups by id, so their totals merge while retaining whichever label was
seen first. SOURCE used the same convention.

**Why it is accepted:** Finance has no category repository or category editor; a
custom label is stored directly on each transaction. Giving categories durable
identity would be a new entity and migration, not a safer slug function. The id is
at least deterministic, and the visible label remains on every row.

**Revisit at:** if P5 introduces a persistent custom-category manager. Then ids
should be generated once and labels edited independently.

---

## D27 — POS and Storefront must supply stable order-create retry identity · `open`

**Found:** P3 S7, while building `order-submission`. **Slice 10 / P4 checkout.**

SOURCE has no create idempotency. Its in-memory repository assigns a new id and
appends on every call. The POS `processing` flag and Storefront
`submissionLockRef` suppress same-screen double clicks only; neither protects a
successful backend write whose response is lost. Retrying that submission can
create a duplicate order, and POS increments its order-number sequence only after
the response returns.

S7 closes the engine/storage seam: `SubmitOrderInput` requires an idempotency key,
and the authoritative store write distinguishes `created`, `replayed`, and
`conflict`. What S7 deliberately cannot choose is the application identity from
which that key comes.

**Action for slice 10:** derive a stable POS key before submission from durable
session/checkout identity (not a freshly generated random value on each retry),
and preserve it until the full atomic checkout outcome is known. Report replay to
the cashier rather than pretending fresh work happened.

**Action for P4 Storefront checkout:** apply the same rule to checkout submission;
a React ref remains only a responsiveness guard, never the durability mechanism.

---

## D28 — Forward order status progression has no target logic child · `open`

**Found:** P3 S7, while mapping SOURCE Order detail against the target Orders tree.

SOURCE Admin advances orders through
`new → accepted → preparing → ready → completed` via the repository's authoritative
`updated | not-found | invalid-transition` write. Cancellation is a different path
and correctly owns slice 8's atomic workflow. The target logic tree, however, names
only `order-read`, `order-submission`, and `order-cancellation`; there is no planned
file/capability for ordinary forward progression.

S7 did not smuggle mutation into `order-read` and did not widen submission into a
lifecycle manager. Doing either would make the capability name false and hide a
real structural omission.

**What it costs to leave:** a later Admin Orders gate can read and cancel an order
but has no authorized headless capability for accept/prepare/ready/complete.

**Revisit at:** P3 slice 13 phase gate, when the complete Admin capability graph can
be judged. If the owner authorizes a new planned child/file, its store mutation must
preserve the SOURCE authoritative outcome and reuse the domain transition machine;
never add the file by bypassing `plan.json`.

**S13 judgement (phase gate, 2026-08-01) — confirmed as a real gap. OWNER DECISION
NEEDED, and this is the more consequential of the two.**

The complete graph can now be judged, and it confirms the omission rather than
resolving it. LOGIC §4 names exactly three Orders children (`order-read`,
`order-submission`, `order-cancellation`) and §8 gives forward progression no
capability — re-read at S13, so this is the target tree's own gap, not an artifact
of how we ported it. The phase gate asserts that requirement graph verbatim, so the
gap is now *enforced*: adding a forward-progression capability by editing an
existing child would fail the gate, which is the intended outcome.

`OrdersStorePort` has no door for it either, and that is also correct — S8 removed
SOURCE's `updateStatus(orderId, status)` bypass because it accepted `"cancelled"`
and could flip a paid order outside any transaction. The bypass was worse than the
gap.

**What this means in practice.** The ported Admin runtime can create an order,
read it, and cancel it — but cannot move one from `new` to `accepted` to
`preparing` to `ready` to `completed`. SOURCE could. Whoever runs the kitchen
would have no way to advance a ticket. Everything needed already exists: the
domain owns the transition machine, and the SOURCE repository's authoritative
`updated | not-found | invalid-transition` write is the shape to reuse.

**What the owner is being asked.** Whether to authorize one new planned child —
most likely `engines/orders/children/order-progression/` with its child and test
file — added to `plan.json` with approval. Adding it WITH approval is not drift;
an agent silently editing the plan to match code it already wrote is. It is a
slice of its own, not an addition to an existing one.

**If authorized, three constraints carry over:** reuse the domain transition
machine rather than restating the status rules; preserve the store's authoritative
outcome instead of pre-reading (the rule S6/S7/S8 all settled); and do NOT create
a general status-setter door — S8 deleted exactly that from SOURCE, where
`updateStatus(orderId, status)` accepted `"cancelled"` and could bypass the whole
multi-owner cancellation workflow. Cancellation must stay unreachable from the
progression path.

**Deferrable without harm until P6**, when the Admin Orders gate is built and the
missing button becomes concrete — nothing in P4 or P5 depends on it. The one thing
that must not happen is a later agent quietly widening `order-read` or
`order-submission` to cover it.

---

## D29 — Cancellation declares `admin.orders.read` but never calls it · `accepted`

**Found:** P3 S8, writing the cancellation child against LOGIC §8.

LOGIC §8 lists four requirements for `admin.orders.order-cancellation`:
`admin.orders.read`, `admin.inventory.stock-reversal`,
`admin.finance.refund-projection`, and `admin.atomic-operation`. Three are resolved
and used. `admin.orders.read` is resolved and never called.

**Why it was left this way:** the store's `cancelOrder` is the authoritative judge of
whether the order exists and may be cancelled — it computes the transition and
returns `cancelled | not-found | invalid-transition`. Reading first to pre-validate
would be a second judge and a race, which is the rule S6 settled for Finance's
writes and S7 restated for submission. So there is genuinely nothing for the read
capability to do in this workflow.

Dropping the declaration was the alternative and was rejected: `new-target/` is the
structural authority (rule 1), and the declaration is not inert — it keeps
cancellation out of a runtime whose Orders read capability never came up, which
would be an Orders area too broken to cancel through. Satisfying it with a
decorative call would be worse: a read whose result is discarded is exactly the
shape of SOURCE's `refunded` gate, which computed a value to answer a question it
had no business answering.

**What it costs to leave:** a reader comparing the `requires` list against the code
sees a dependency with no call site and has to reconstruct why. That is what this
entry is for.

**Revisit at:** P3 slice 13 phase gate, alongside D28 — if a forward-progression
child is authorized, it will need the read capability for real, and the question of
what `requires` means for a write-first child should be answered once for both.

**S13 judgement (phase gate, 2026-08-01) — stays `accepted`, and the gate now
enforces the declaration.** The phase gate asserts the LOGIC §8 requirement graph
verbatim, including cancellation's four edges, so dropping the uncalled
`admin.orders.read` declaration to tidy the code would now turn the suite red.
That is the right outcome: the doc is the structural authority and the declaration
is not inert.

The question this entry parked for S13 — what `requires` means for a write-first
child — is answered by the gate itself: **`requires` states what must be RUNNING
for this child to be safe to publish, not what it calls.** An Orders area whose
read capability never came up is an Orders area too broken to cancel through,
whether or not cancellation happens to call it. The gate's exclusion tests
demonstrate the mechanism directly. If D28's forward-progression child is
authorized it will use the read capability for real, but that will not change this
answer.
