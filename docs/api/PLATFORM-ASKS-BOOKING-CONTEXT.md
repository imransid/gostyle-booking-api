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
yet**, and a third of it is data you already hold and simply do not expose.

---

## 2. Two very different kinds of ask

**Part A** is three items you already have in your database. They need populating or exposing,
not designing. They unblock us soonest and we have sequenced our work behind them.

**Part B** is four items that need new modelling — a decision about shape before any code.

---

# Part A — data you already hold

## A1. Populate `skill_id` and `min_skill_level` on services

**Blocking. This is the single most important item in this document.**

`services.proto` carries `skill_id` and `min_skill_level`. Both are **empty in production**, and
the proto says empty means unknown.

Those two fields decide **who is allowed to perform a service**. With them empty the booking
engine has two choices, and both are bad:

| If unknown means | Then |
| ---------------- | ---- |
| "no skill required" | Every stylist is eligible for everything. A trainee is offered for a balayage. |
| "cannot verify" | Nobody is eligible. Availability returns empty. A total outage. |

Our own rule is that missing data must *remove* availability, never add it — which points at the
second. That ships a dead booking engine, so we will not do it silently. Our interim plan is in
§5, and it is deliberately ugly so that nobody forgets it is temporary.

**Ask:** populate `skill_id` and `min_skill_level` for every service in every branch. The columns
exist; the rows are empty.

## A2. Expose `staff_profile.skills` over gRPC

**Blocking.**

`staff.proto` returns identity and branch. The engine needs, per stylist, **which skills they
hold and at what level** — it is the other half of A1 and neither works alone.

You already store this in `staff_profile.skills`.

```proto
message Stylist {
  // ... existing fields ...
  repeated StaffSkill skills = N;
}

message StaffSkill {
  string skill_id     = 1;
  int32  level        = 2;   // matched against service.min_skill_level
}
```

**What we do with it:** a stylist is eligible for a basket only if they hold *every* skill it
needs at or above each level. Partial coverage is not coverage.

## A3. Expose shifts over gRPC

**Blocking for the roster swap, not for services.**

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
| Stylist **skills** | fixture, until A2 |
| **Shifts** | fixture, until A3 |
| **Chairs** | fixture, until B1 |
| Buffers / processing | absent — buffers 0, no band, until B2 |
| Deposit rule | absent — rung 3 silent, until B3 |

Every one of those stubs is *safe* in the sense that it over-reserves or under-charges rather
than overbooking a chair — **except the skill question in A1**, which is unsafe in one direction
and an outage in the other.

Our interim plan for A1: treat an unknown skill as *"no skill required"*, but **only** while an
explicit `SKILLS_UNVERIFIED` flag is set, with a warning logged on every booking it affects. A
deliberate, visible, noisy temporary state — not a default that outlives the memory of why it was
chosen.

---

# 5. What we need back

**To start:** A1 populated, and a yes/no on the `SKILLS_UNVERIFIED` interim.

**Soon after:** A2 and A3, which unblock the roster and remove two of the four stubs.

**To scope properly:** whether B1–B4 are a quarter's work or a week's, so we can sequence around
them. B1 and B2 are what stand between us and a correct diary; B3 is money; B4 is performance.

**A decision together:** stage 3 of the migration — backfill or translation table.

Happy to walk through any of this. The one item that changes what we build next week is **A1**.
