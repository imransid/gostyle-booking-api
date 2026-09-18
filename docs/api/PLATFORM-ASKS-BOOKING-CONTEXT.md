# What the booking engine needs from platform

> **From:** the booking API team (`gostyle-booking-api`).
> **For:** the platform team, who own `services.proto`, `staff.proto` and the platform database.
> **Why now:** the mobile app has started sending real platform UUIDs, and the booking engine
> cannot resolve them. Every booking flow currently answers `422 unknown_service` for a service
> that `ListServices` returns correctly.

---

## 1. The problem in one paragraph

The booking engine resolves services, stylists and chairs through one interface,
`BookingContextReader`. That interface is still backed by a **hard-coded fixture** — thirteen
services and six stylists with slug ids like `haircut-finish` and `maya`. `ListServices` and
`ListStylists` exist and work, but they are wired only to two directory endpoints; the engine
never calls them. So a real service id resolves to nothing, and the booking is refused.

Swapping the fixture for gRPC is the fix. **Most of what the engine needs is not in the protos
yet.** Some of it is data you already hold and do not expose. One piece — skills — turns out to
be two incompatible vocabularies that have to be reconciled before either side is usable.

---

## 2. Two very different kinds of ask

**Part A** is three items about data you already hold. Two are genuinely quick — one is a
platform-api code change, one is exposing tables that already exist. The third (A2) looked quick
when this document was first written and is not: it is a data reconciliation with a UI change
behind it. We have sequenced our work behind these.

**Part B** is four items that need new modelling — a decision about shape before any code.

---

# Part A — data you already hold

## A1. Populate `skill_id` in `services.proto` — a code change, not data entry

**Small, and it unblocks half the problem.**

> Corrected after this document was first written. The original said "the columns exist; the
> rows are empty". That was wrong, and wrong in your favour: **the service side is already
> done.**

All **70 rows** in `service_stage` carry a `skill_id`, referencing `catalog_skill` — 8 clean,
coded rows:

```
HAIRCUT   HAIR_COLOR   HAIR_STYLING   NAILS
SKINCARE  MASSAGE      MAKEUP         WAXING
```

`services.proto` declares `skill_id` and `min_skill_level`, and simply **is not populating them
from `service_stage`**. Nothing needs modelling and no data needs entering; the mapping in
platform-api needs to read a column it already has.

**Ask:** populate `skill_id` (and `min_skill_level`, if `service_stage` carries a level) in the
`ListServices` response.

## A2. Reconcile the two skill vocabularies — the real blocker

**This is the item that gates the booking engine, and it is bigger than a data fix.**

Staff skills do not reference `catalog_skill`. `staff_skill_assignment` points at a **different
table**, `skill`: **23 free-text rows**, with duplicates —

```
"Makeup" × 3      "Hair Cutting" × 2      "Skincare" × 2      …
```

A join between `staff_skill_assignment` and `catalog_skill` returns **0 rows**. The two
vocabularies do not overlap at all — not partially, not approximately. There is no mapping to
fall back on.

So the shape of the problem is not "some columns are empty". It is:

**Services will soon say** `requires HAIR_COLOR at level 2`.
**Staff say** they know `"Hair Colouring"`, typed by hand, possibly three times.
**Nothing matches anything**, and the booking engine's only honest answer is that no stylist is
eligible for any service.

### What has to happen

1. **Decide `catalog_skill` is the single vocabulary.** It is already coded, already clean, and
   already referenced by all 70 services. The other table is the one that moves.
2. **Map the 23 free-text rows onto the 8 coded ones.** A person has to do this; several will
   collapse (`"Makeup" × 3` → one `MAKEUP`) and some may have no home, which is itself worth
   knowing.
3. **Re-point `staff_skill_assignment`** at `catalog_skill`, deduplicating as it goes — a
   stylist with `"Makeup"` recorded three times should end with one `MAKEUP` assignment, not
   three.
4. **Fix the UI that allows free-text skill entry.** Without this, step 2 is temporary: the
   duplicates come back the first week somebody types `"Make-up"` instead of picking from a
   list. **A dedupe with the intake left open is a dedupe you do again next quarter.**

### Why we cannot work around it

We considered matching on the skill *name* instead of the id. We are not going to: `"Hair
Cutting"` and `HAIRCUT` are the same skill to a human and not to a string comparison, and the
failure mode of a fuzzy match is putting an unqualified stylist on a colour. That is exactly the
thing skills exist to prevent, so guessing is worse than refusing.

### Then expose it

This is now the LAST thing standing between the engine and a real roster. The roster itself
resolves from platform (see A3); every stylist it resolves arrives with **no skills at all**, so
they can take a platform service — whose own `skill_id` is blank, which is why that pairing sits
behind `SKILLS_UNVERIFIED` — and are refused by name for anything from the fixture. Nobody
booked through that path has been *shown* to be qualified for what they are booked for.

Once the vocabulary is one thing, the engine needs it over gRPC — per stylist, which skills they
hold and at what level:

```proto
message Stylist {
  // ... existing fields ...
  repeated StaffSkill skills = N;
}

message StaffSkill {
  string skill_id = 1;   // a catalog_skill code: HAIRCUT, HAIR_COLOR, ...
  int32  level    = 2;   // matched against service.min_skill_level
}
```

**What we do with it:** a stylist is eligible for a basket only if they hold *every* skill it
needs at or above each level. Partial coverage is not coverage.

If `skill` carries no level today, send `1` for every assignment and tell us — we will treat
level as unenforced and say so, rather than inventing a grading nobody entered.

## A3. Expose shifts over gRPC

**No longer blocking the roster swap. Still blocking a roster we can trust.**

> Updated. The roster now resolves from `ListStylists` behind
> `STAFF_FROM_PLATFORM`, using the `opening_time`, `closing_time` and `offday`
> already on the `Stylist` message. That was enough to unblock the mobile app,
> which could not book with a named stylist at all: it picks one from
> `ListStylists` and sends the `staff_profile_id` back, and the engine's roster
> was six hard-coded slugs, so every such booking was refused.
>
> **Those three fields are empty in practice today.** Every stylist who sends
> none of them is offered across the branch's whole trading window, 10:00 to
> 22:00, which sells hours nobody published. The engine logs one warning per
> load naming exactly who that is. What follows is still the ask.

The engine needs each stylist's **published working window for a given day**, and any approved
time off inside it. You hold this in `shift` and `shift_roster`.

```proto
rpc ListShifts(ListShiftsRequest) returns (ListShiftsResponse);

message ListShiftsRequest {
  string tenant_id   = 1;
  string branch_id   = 2;
  string date        = 3;   // YYYY-MM-DD, branch-local
}

message StaffShift {
  string staff_id     = 1;
  int32  start_minute = 2;  // minutes past branch-local midnight
  int32  end_minute   = 3;
  repeated TimeOff time_off = 4;
}

message TimeOff {
  int32 start_minute = 1;
  int32 end_minute   = 2;
}
```

**Minutes past midnight, not timestamps**, please — the whole engine works that way and a
timestamp would be converted straight back.

**A second thing this fixes:** we publish a `timeOff[]` array on the calendar that is *always
empty*, because time off currently reaches us as opaque calendar entries with no label. The
frontend greys out shift boundaries only and has been told why.

---

# Part B — four that need new modelling

These need a shape agreed before anyone builds. Ordered by how much they cost us.

## B1. A resource (chair / room) registry per branch

**Nothing like this exists in either proto, and `category_id` is not it** — a category groups
services on a menu; it does not say a branch has two colour stations of which one is out of
service.

Without it the engine cannot count chairs. Everything shares one pool, and four colours sell
against two stations.

What a service needs: **which resource class it occupies** (`resource_type`).
What a branch needs: **how many units of each class exist**, how many are out of service, and the
**changeover** minutes after a visit before the unit is free again (a treatment room is held ten
minutes; a styling chair none).

```proto
// on Service
string resource_type = N;           // "styling" | "color" | "wash" | "nail" | "room" | ...

// new, per branch
message BranchResource {
  string resource_type = 1;
  int32  units         = 2;
  int32  out_of_service = 3;
  int32  changeover_minutes = 4;
}
```

## B2. Per-service buffers and the processing band

**Buffers** are the setup/teardown minutes either side of a visit. They occupy the *chair*, never
the professional, and between two neighbours the larger claim wins — never the sum.

**The processing band** is the window inside a service where the chair is occupied and the
professional is free — colour development. A 100-minute colour with a 40-minute band lets the
stylist take another client in the middle.

Without the band, that stylist is held for the full 100 minutes. **This is not a rounding error:
it is the single biggest source of sellable colourist hours in the engine**, and losing it is
directly visible in a day's capacity.

```proto
// on Service
int32 buffer_before_minutes = N;
int32 buffer_after_minutes  = N;

// optional; absent means the professional is held for the whole service
message ProcessingBand {
  int32 from_minute = 1;            // offset from the service's own start
  int32 to_minute   = 2;
  bool  releases_chair = 3;         // does the client leave the chair?
}
```

## B3. A per-service deposit rule

The deposit ladder has six rungs and one of them is *"what this service asks for"*. With nothing
from platform, that rung is silent and deposits fall back to first-visit / risk / peak only — so
a keratin that should take AED 400 up front takes 20% of whatever it costs.

A service may set a percentage, a fixed amount, or both. Where both, the larger wins.

```proto
// on Service
optional int32 deposit_percent    = N;   // 0-100
optional int64 deposit_fixed_minor = N;  // fils
```

## B4. `GetServices(ids[])` — lookup by id

`ListServices` is **list-by-branch only**. The engine's own interface is
`loadServices(branchId, serviceIds)`, called on every availability query, hold, quote and
confirm. Today that would mean fetching a branch's entire catalogue and filtering in memory, on
every one of those calls.

We can cache it, and we will have to. But a cache raises a staleness question about **price**,
which is the one field where being a minute out of date is a customer-visible problem.

```proto
rpc GetServices(GetServicesRequest) returns (ListServicesResponse);

message GetServicesRequest {
  string tenant_id = 1;
  string branch_id = 2;
  repeated string service_ids = 3;
}
```

## B5. There is no product catalogue at all

Noted rather than asked for. The mobile contract's `products[]` is refused with
`422 products_not_supported`, and that refusal is correct and permanent until a catalogue exists.
A product silently dropped from a basket is money the salon does not take.

---

# 3. The slug-to-UUID migration

**This is the part that will otherwise be discovered in production.**

`ListServices` requires a **branch_id UUID**. Everything in the booking engine currently speaks
slugs — `marina-walk`, `haircut-finish`, `maya` — and folds them into synthetic UUIDs with a hash
function so they fit `uuid` columns. Those synthetic UUIDs are **not** platform ids and platform
has never seen them.

So the day services come from gRPC, the slug era ends. That is a breaking change, and it is
larger than it looks.

## 3.1 What breaks

**Every booking route takes a branch and most take service ids.** Counted from the source:

| Surface | Count | Detail |
| ------- | ----: | ------ |
| Controllers taking a `branchId` / `branch` | 14 | availability, holds, quote, bookings, groups ×2, series ×2, waitlist, walk-ins, compaction, roster-changes, stylists, directories |
| Controllers taking service ids | 9 | availability, holds, bookings, quote, eligible-staff, group-availability, groups, series, walk-ins, mobile-booking |
| **DTO fields defaulting to the literal `'marina-walk'`** | **9** | These fail *silently* — an omitted branch resolves to a slug that platform will reject |
| Resolver fallbacks to `DEFAULT_BRANCH_ID` | 6 | Same, one layer down |

**Three things beyond the API surface also break:**

1. **`priceOf()`** — a hard-coded slug→fils map that returns **`0`** for an unknown id. A real
   UUID service that got past the catalogue check today would book at **AED 0.00, silently.**
   This is the most dangerous line in the migration and it is ours, not yours.
2. **`PACKAGES`** — bundles (`colour-and-finish`, `bridal-morning`) defined over service *slugs*,
   with a bundle price. Platform has no equivalent concept. These either move to platform or stop
   existing.
3. **Existing rows.** 40 bookings across 1 branch in our database carry slug-derived UUIDs in
   `branch_id`, `service_id` and `staff_id`. They are valid `uuid` values that resolve to nothing
   on your side. Historical reads must keep working.

## 3.2 What the cutover looks like

We do not want a flag day. Proposed:

**Stage 1 — accept both.** The engine resolves an id by asking platform first and falling back to
the fixture. A real UUID works; a slug still works. Nothing breaks, and we can measure which
callers are still sending slugs before removing anything.

**Stage 2 — stop defaulting.** The nine `'marina-walk'` DTO defaults become required fields. This
is the change that turns a silent wrong-branch answer into a 400. We already ship
`REQUIRE_BRANCH_HEADER`, off by default, for exactly this; the frontend confirms it sends
`X-Branch-Id` on every call.

**Stage 3 — backfill or map.** Either backfill the 40 existing rows to real UUIDs, or keep a
translation table for historical reads. **This needs a decision from both teams**: we can map old
→ new if you can tell us which platform service each fixture slug corresponds to.

**Stage 4 — delete the fixture.** Slugs stop being accepted. `priceOf` and `PACKAGES` go with it.

Stages 1 and 2 are ours. Stage 3 needs you. Stage 4 is the end state.

---

# 4. What we will do in the meantime

A hybrid, and we will say so out loud rather than let it look finished:

| Component | Source after the first change |
| --------- | ----------------------------- |
| Services | **platform gRPC** |
| Prices | **platform gRPC** (`price_minor`) — fixes the AED 0.00 bug |
| Stylist identity | platform gRPC |
| Stylist **skills** | **every stylist treated as holding every skill**, behind `SKILLS_UNVERIFIED`, until A2 |
| **Shifts** | fixture, until A3 |
| **Chairs** | fixture, until B1 |
| Buffers / processing | absent — buffers 0, no band, until B2 |
| Deposit rule | absent — rung 3 silent, until B3 |

Every one of those stubs is *safe* in the sense that it over-reserves or under-charges rather
than overbooking a chair — **except skills (A2)**, which is unsafe in one direction and an
outage in the other.

**The interim, and why it is shaped the way it is.** Once A1 lands, services will carry a real
coded requirement and staff will still carry free text that matches nothing. Matching honestly
at that point returns *no eligible stylist for any service* — a total outage. So we will treat
every stylist as holding every skill, behind an explicit `SKILLS_UNVERIFIED` flag, with a
warning logged on every booking it affects.

Note what that means: **A1 alone makes the situation worse, not better**, because it replaces an
unknown with a requirement nothing can satisfy. A1 is still worth doing first — it is small, and
it is a precondition — but the flag has to be in place before it ships, and the flag only comes
off when A2 does.

A deliberate, visible, noisy temporary state, not a default that outlives the memory of why it
was chosen.

---

# 5. What we need back

**This week:** A1 — populate `skill_id` from `service_stage` in the `ListServices` response.
It is a code change against data that is already correct, and it is the one item we can build
on immediately. Pair it with a yes/no on the `SKILLS_UNVERIFIED` flag, which has to ship at the
same time or A1 makes things worse.

**The one that actually decides the timeline:** A2. Three questions, and we would rather have
rough answers now than precise ones later:

1. Is `catalog_skill` agreed as the single vocabulary?
2. Who owns mapping the 23 free-text rows onto the 8 coded ones, and roughly when?
3. **Is the free-text skill UI yours to change?** If it is not, say so now — the dedupe is
   pointless without it and we should plan for the duplicates being permanent.

**Soon after:** A3, which unblocks the roster and removes the shift stub.

**To scope properly:** whether B1–B4 are a quarter's work or a week's, so we can sequence around
them. B1 and B2 are what stand between us and a correct diary; B3 is money; B4 is performance.

**A decision together:** stage 3 of the migration — backfill or translation table.

Happy to walk through any of this. The item that unblocks us next week is **A1**; the item that
decides the quarter is **A2**.
