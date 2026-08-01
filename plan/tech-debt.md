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

## Owner decisions — 2026-08-01 ("settle debt once for all")

The owner decided every open item in one sitting, then **revised two of those
decisions the same day** after the cost of the first version became clear. What is
written here is the FINAL state. **Settled — do not re-litigate, do not ask again.**
The table is live: resolved rows name their implementation commits, while scheduled
rows are still decisions rather than completed work. The original decision-recording
commits scheduled work only; later PD commits perform it.

| # | Decision | Result |
|---|---|---|
| D1 | Deleting must clean up the links it leaves behind | `scheduled` |
| D2 | Saving a menu must check the category really exists | `scheduled` |
| D8 | Domain tidy pass — lost its carrier slice, see below | `accepted` |
| D10 | Shared rules get a real home (`*Operations.ts`) | `resolved` — commit `refactor(admin-engine): DS-A move shared rules to operations` |
| D11 | **Money stays as it is; format at display instead** | `accepted` |
| D12 | "piece" and "portion" genuinely mean the same thing | `accepted`, closed |
| D16 | Recipe editing authorized; build it with its screen at P5 | `scheduled` |
| D19 | Folded into D11 — same reasoning, same answer | `accepted` |
| D20 | **Per-item historical profit — via a NEW CHILD, no rewrite** | `resolved` — ca27c32, f147482 |
| D22 | Dedicated reversal type — lost its carrier slice, see below | `accepted` |
| D25 | Warung Meng is **one outlet**. Closed as deliberate | `accepted`, closed |
| D27 | Not a decision — resolves when P4 storefront checkout lands | `open` |
| D28 | **Forward order progression authorized** — new child | `resolved` — 3b12f3b, 1493d9f |

### The revision, and why it matters more than the original decision

The first version of D11 was "money becomes whole rupiah everywhere". Building that
would have rewritten expected figures across 516 tests — the riskiest slice on the
whole list, and one where a mistake hides behind "the numbers were supposed to
change". The owner asked whether display formatting could do the job instead. It
can, and checking why exposed that the premise was wrong:

- **Cash is ALREADY whole rupiah, and always was.** An order total is whole prices ×
  quantities, plus `Math.round` tax, rounded to the nearest 500 at the till
  (`submitPosCheckoutAtomically.ts:107-112`). Every finance row copies
  `order.totals.total` verbatim (`finance.ts:264`). The ledger and the cash drawer
  were never in disagreement.
- **Fractions exist only in COSTING, where they are required.** `averageUnitCost` is
  a rate per BASE unit — per gram, per millilitre. A spice at 800/kg is 0.8
  rupiah/gram; rounding that to 1 is a 25% error on every gram of every recipe
  forever, and rounding to 0 makes the ingredient free. Rounding per-unit rates
  would have been an actively WRONG change, not merely an expensive one.

So the real defect was never wrong arithmetic — it was that a cost like `1234.5678`
had no defined way of being SHOWN. That is a display concern and belongs in the
display layer. **D11 and D19 are therefore `accepted`, and a money formatter is
recorded against P5 in `roadmap.md`.**

**The residue, stated honestly so a formatter is not mistaken for a fix:** the
average cost still compounds a small error per purchase with no way to recompute
from the ledger (D11's original complaint), and HPP still rounds three times over
the same figures (D19). Both are small, neither touches cash, and both are now
deliberate. Also note a known consequence of edge formatting: a column of small
costs can display rows that do not visibly sum to their displayed total (0.4 + 0.4
shows as 0 + 0 = 1). Normal, affects displayed COST breakdowns only, never cash.

### D20 needs no rewrite either — the same lesson, applied again

The original plan reopened `packages/domain` to add an attribution model. It does
not need to. Everything required is already recorded: a consumption movement carries
`ingredientId`, `referenceId` (the order), `baseQuantityDelta` and — since S11 —
`unitCost` snapshotted at sale time (`inventory.ts:50-62`); an order carries its
items with `menuItemId`, `quantity` and `lineTotal` (`orders.ts:39-48`); and
`MenuRecipe` links a menu item to its ingredients (`inventory.ts:72-78`). Per-item
historical profit is a JOIN over existing data, so it is a new READ child, not a
domain change.

**Three constraints carried by the resolved implementation:**
1. When one order contains two dishes sharing an ingredient, the stock record is a
   single row covering both. Splitting it by recipe proportion is a RECONSTRUCTION,
   not a recorded fact. Say so in the capability's own documentation.
2. That reconstruction is exact **today** only because recipes cannot be edited at
   all (D16). Once the authorized recipe editor ships, changing a recipe silently
   changes what past months look like. Decide recipe versioning THEN, not now.
3. Pre-S11 movements have no cost snapshot. They must report as **unknown**, never
   as zero — a zero cost reads as pure profit, which is the one wrong answer that
   looks plausible. S11 already established the degraded-source pattern; reuse it.

**Resolved shape:** one new child in the INVENTORY area, because recipes and
movements already live there, requiring `admin.orders.read` and publishing per-menu
historical cost plus the sale revenue/profit read through that capability. Dashboard
was not edited and did NOT gain repository access — that is D15, which S11 resolved.

### D8 and D22 lost their carrier, and that is the honest status

Both were parked with "revisit whenever the domain is next open", and the revised
D11/D20 decisions mean **the domain is no longer being reopened**. Neither is worth
opening a closed phase on its own, so both revert to `accepted`. If some future work
opens `packages/domain` for an unrelated reason, these two come along then.

### Structural note — how a new child is actually authorized

`plan.json` already permits `engines/<area>/children/<name>/<name>Child.ts` through
an existing allow glob, so **no `plan.json` line is needed for a new child**. Earlier
text in D16/D28 claiming otherwise was wrong and was corrected on 2026-08-01; the
claim had been written and re-endorsed across several sessions because everyone
quoted the entry instead of reading the glob list. What actually withholds permission
is `new-target/LOGIC-TARGET-FILE-TREE.md` (§4 names the children, §8 grants the
capabilities), plus the S13 phase gate, which asserts both verbatim and turns red on
any unlisted child. So the authorizing act is an edit to the DESIGN DOCUMENT,
belonging in the slice that builds the child as its own clearly-labelled first
commit.

**D10 was the last item that genuinely needed a `plan.json` line, and it is now
resolved** — `*Operations.ts` and `*Operations.test.ts` were added to the P3 allow
list in commit `53fbba3` (plan-only, owner-approved), and the four shared rules moved
in `fff46ad`. **No open item now requires a `plan.json` structure edit.**

### Ordering

The original recording said the debt block must precede P4 because whole-rupiah money
would otherwise force the storefront to be ported twice. **That reason is gone** — the
money decision was revised and D20 became additive. Nothing in this list now blocks
P4. The owner's chosen order is still debt-first, because the items are small and the
admin engine is fresh in the plan-of-record, whereas P4 is a whole phase that would
push that context far away. Easily reversed if the storefront becomes urgent.

---

## D1 — Deleting a menu or variant group leaves stale links · `scheduled`

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

## D2 — Nothing checks that a `categoryId` points at a real category · `scheduled`

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

## D8 — P1 domain tidy pass never ran · `accepted` (carrier slice dropped 2026-08-01)

**Found:** P1 S7, deferred at the time because no tests existed yet.

An optional cleanup pass over `packages/domain` — reduce and clarify, no behavior
change — was left undone. It is safer now than it was: 17 domain tests plus
everything built on top would catch a regression.

**Why it is still open:** it buys clarity, not capability, and every phase since has
had something more valuable to do. Skippable indefinitely.

---

## D11 — Average unit cost is unrounded float, and feeds prices · `accepted` (revised 2026-08-01 — format at display)

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

**REVISED 2026-08-01 — `accepted`, superseding the 'whole rupiah' decision made
earlier the same day.** Rounding this value would be actively WRONG, not merely
expensive: it is a rate per BASE unit, so a spice at 800/kg is 0.8 rupiah per gram
and rounding it to 1 is a 25% error on every gram of every recipe, forever. Cash was
never affected — order totals and every finance row are already whole rupiah. The
real gap was that a cost like `1234.5678` had no defined way of being DISPLAYED, so
a money formatter is recorded against P5 instead. The compounding-error residue is
accepted as stated above. See "Owner decisions" at the top of this file.

---

## D12 — "piece" and "portion" are interchangeable · `accepted` (closed 2026-08-01)

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

## D16 — No recipe WRITE path, and no child owns recipe editing · `scheduled`

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

**Revisit at:** whenever the recipe screen is scheduled. ~~since it needs a
`plan.json` slot for the new child~~ — **CORRECTED 2026-08-01: it does NOT need a
`plan.json` slot.** The allow glob `engines/*/children/**/*Child.ts` already covers
it; the real gate is `new-target/LOGIC-TARGET-FILE-TREE.md` §4/§8 plus the S13 phase
gate. See "Owner decisions" at the top of this file.

**S13 judgement (phase gate, 2026-08-01) — unchanged and now confirmed by the
complete graph.** All seven areas exist and no child owns recipe editing, so this
is a genuine structural gap rather than an artefact of an unfinished phase. It
needs an owner-approved addition and cannot be closed by an agent. Raised with the
owner alongside D28. Not urgent while there is no UI: recipes can still be seeded,
and HPP costs whatever the seed says.

**OWNER DECISION 2026-08-01 — AUTHORIZED**, to be built with the screen that needs
it (P5), not before. Recorded in `roadmap.md` under P5. The authorizing edit is to
`new-target/LOGIC-TARGET-FILE-TREE.md`, NOT to `plan.json` — this entry said
`plan.json` twice above and was wrong both times.

**DS-C dependency note (2026-08-01).** The resolved historical-profit child now
publishes the assumptions `recipe-proportional-reconstruction` and
`current-recipe-assumed-unchanged`, and it degrades when recorded movement quantity
does not match the current recipe. Before this editor enables its first recipe
write, decide recipe versioning and revisit that DS-C contract; otherwise editing a
recipe would silently restate past cost and profit.

---

## D19 — HPP rounds three times over the same figures · `accepted` (revised 2026-08-01, with D11)

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

**REVISED 2026-08-01 — `accepted`, for the same reason as D11** (this entry always
said "revisit at the same moment as D11"). Triple rounding stays. The figures are
correct to within a fraction of a rupiah and cash is unaffected. The one thing worth
preserving from this entry: `calculateGrossMarginPercentage` rounds without the
`Number.EPSILON` nudge that `roundMoney` uses, so one module rounds two ways — if
any future slice legitimately touches `finance.ts`, make those consistent then.

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

## D22 — A seeded `adjustment-in` can still suppress a real reversal · `accepted` (carrier slice dropped 2026-08-01)

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

## D25 — The finance ledger defaults to one hardcoded outlet · `accepted` (closed 2026-08-01)

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
read capability never came up is an Orders area too broken to mutate through,
whether or not a writer happens to call it. DS-B confirms the meaning: progression
declares the read requirement but deliberately performs no pre-read, leaving the
store's write as the one authoritative transition judge. The gate's exclusion
tests enforce both declarations.
