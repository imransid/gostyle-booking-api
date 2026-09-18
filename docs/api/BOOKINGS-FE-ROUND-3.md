# Bookings API — answers to the 2026-09-18 audit

Reply to *"Bookings API — fixes we need"*. Same numbering, so you can read the
two side by side.

Thank you for the reproductions. Every item below was findable because you gave
the exact request and the exact response; three of them were found *by* your
evidence and not by any test we had.

**What is in this change:** §1, §2.1, §2.2, §2.4, §2.5, §3.1–§3.6 except where
noted, §4.1, §4.2, §5.1, §5.2, §5.3, §5.4.
**What is not:** §1b and §2.3 are provisioning, not code — see below for what we
changed anyway and what is still needed from platform.

Everything marked **proven** was run against a real Postgres and a real booting
server, not only unit-tested. The live transcript is in the section it belongs to.

---

## 1. The two branch resolvers — fixed, and it was worse than you thought

You were right about the symptom and close on the cause. There was never a
"JWT resolver": routes with no `branchId` parameter fell through to a hardcoded
`DEFAULT_BRANCH_ID = 'marina-walk'`, which is why every read echoed the demo
branch. Nothing read the token's branch at all.

**There is now one rule, `domain/booking/branch-scope.ts`, with a spec.**
Precedence, highest first:

1. the `branchId` claim on the verified token
2. `X-Branch-Id`
3. `branchId` in the body or query
4. `DEFAULT_BRANCH_ID`

Rung 1 is new and it is what closes the split. Rungs 2–4 are unchanged, so
customer tokens (which carry no branch) and every existing slug caller behave
exactly as before.

**A request that names a branch the token does not cover is now `403`**, not a
silent write to somewhere unreadable:

```
POST /v1/bookings/waitlist  {"branchId":"marina-walk", …}   ← token says b7e92439-…
  → 403 {"code":"BOOKING_BRANCH_MISMATCH",
         "message":"This token is scoped to branch b7e92439-…, and the request
                    named marina-walk. Send no branchId, or send that one: a
                    write to another branch would not be readable afterwards.",
         "details":{"branchId":"b7e92439-…","requested":"marina-walk"}}
```

**You can now stop sending `branchId` entirely.** It stays accepted and optional
everywhere so nothing breaks while you remove it.

Proven, back to back on one token:

```
POST /v1/bookings/waitlist {"serviceId":"fringe-trim","day":"2026-10-01",…}
  → 201 {"entryId":"0f3093de-…","position":1}
GET  /v1/bookings/waitlist
  → waiting[0].id = "0f3093de-…"          ← the write and the read now agree
```

**`GET /v1/bookings/settings` publishes the resolved branch**, as you asked,
plus the timezone from §3.6:

```json
"branch": {
  "id": "b7e92439-8285-469a-bba4-dcaa3dd5842c",
  "source": "token",
  "timezone": "Asia/Dhaka",
  "utcOffsetMinutes": 360,
  "tradingDay": "2026-09-18",
  "nowMinute": 1020
}
```

`source` is `token | header | request | default`, so you can tell "my token
scopes me here" from "nobody said, so you got the default".

**One thing your report did not catch, and it would have bitten on release.**
`POST /v1/holds` and `POST /v1/bookings` take `branch` (not `branchId`) and
defaulted it to `marina-walk`. Your creation path works today only because the
reads were *also* landing on `marina-walk`. Fixing the reads alone would have
sent every new booking to a branch you could no longer see. Those two routes,
plus `/availability` and `/eligible-staff`, now go through the same resolver;
`branch` is still accepted and still spelled `branch`.

### 1b. Provisioning — partly ours, mostly not

The half that was ours: `availability/catalogue` read the fixture and **only**
the fixture, while `/services-directory` read platform. That is why the two
described two different salons. `loadCatalogue` is now platform-first with the
fixture appended, so the wizard and the directory read the same source.

The half that is not: the engine's roster and catalogue come from platform only
when `SERVICES_FROM_PLATFORM` / `STAFF_FROM_PLATFORM` are on, and they are off
in the environment you tested. Turning them on is an ops change, not a deploy —
and `STAFF_FROM_PLATFORM` additionally needs `SKILLS_UNVERIFIED`, because
platform publishes no skills and we refuse to let the engine treat "no skill
recorded" as "anyone is qualified". See `PLATFORM-ASKS-BOOKING-CONTEXT.md`,
asks A1/A2.

**Until those flags are on, keep taking the roster and catalogue from the
engine.** You chose the lesser evil correctly.

---

## 2. P0

### 2.1 Waitlist accept — fixed, proven

Your diagnosis was exactly right. `liveOffer` folded the *staff* id back to the
engine's spelling and left the *service* id as the stored uuid, so `place-hold`
was handed an id no catalogue knows. CLAUDE.md rule 8, sixth bite.

`liveOffer` now returns both: `serviceId` (the stored id, for anything that
queries a column) and `serviceRef` (what the engine answers to). Accept uses
`serviceRef`; decline still uses `serviceId`.

```
POST /v1/bookings/waitlist/96b7fac2-…/accept
  → 201 {"holdId":"b8caeae9-…","start":"15:00","end":"15:20","expiresInSeconds":900}
```

Two things the live run found that no unit test could:

- `waitlist_entry.service_id` is `TEXT` while `booking_item.service_id` is
  `UUID`. An "obvious" cast we added broke every backfill with
  `operator does not exist: text = uuid` — logged and swallowed, so the only
  symptom was an offer that never arrived. Removed.
- `markAccepted` cleared the offer columns, which destroys the only record that
  a cancellation was ever refilled. It now keeps all five (`waitlist_offer_paired`
  is all-or-nothing, and rightly refused our first attempt at keeping one).
  That is what makes `recovered` in §3.3 real.

### 2.2 Series invisible to its own board — fixed by §1

Same root cause, same fix. `POST /series-admin` with no `branchId` now stores
the token's branch, which is the branch `GET /series` reads.

### 2.3 Materialise seats nothing — not fixed, but it now tells you why

This is §1b reaching the materialiser: `loadServices` returns nothing for the
series' `service_id`, and the handler turned that into a bare
`needsAttention` with no reason. It now separates the causes and says which:

```json
"notes": ["4 could not be seated and need a human.",
          "4 could not be priced: the catalogue does not know service b8460336-…."]
```

and logs it at ERROR with the branch and the service id. A day the branch is
shut is now reported as that, separately. The underlying fix is the flags in §1b.

### 2.4 `GET /events/{id}` — fixed

The detail read and the list row are now **one mapper**, so the drawer carries
every field the row carries (`by`, `customer`, `service`, `slot`, `staffId`,
`servicePrice`, `depositAmount`, `outcome`) plus the maths. A deep link and a
refresh render without anything to merge. You can drop the row cache.

**The "Policy window" bug is fixed.** It was reading the free-text cancellation
`reason`. It is now derived from the two timestamps by
`domain/booking/cancellation-feed.ts`, whose spec pins it to the same thresholds
the *refund* uses — so the screen and the money can never disagree:

```
"Policy window": "more than 24h before start (69.8h before start)"
```

### 2.5 `pause` 500s on an AT_RISK series — fixed, proven against Postgres

Cause: `occurrence_alternatives_only_when_stuck` is
`alternatives IS NULL OR state = 'needs_attention'`. A NEEDS_ATTENTION
occurrence carries the repair ladder; `cancelOccurrences` moved it to `skipped`
and left the ladder behind. CHECK violation, transaction aborted, bare 500 — so
pause worked on every series nobody needs to pause and failed on exactly the
ones a desk reaches for. `detachOccurrence` (THIS_OCCURRENCE) had the identical
hole.

The constraint was right; the writes were wrong. Both now clear `alternatives`
with the state. Proof script: `prisma/proof-pause-at-risk.sql` — tests 1 and 3
must fail and do, naming the constraint; 2 and 4 must succeed and do.

---

## 3. P1

### 3.1 Customer names — added to the contract; populating them needs platform

`customer.name` is now on the booking list, the calendar day and week, the
events feed, the waitlist board, the series board and panel, and the walk-in
queue. Resolved once per page, never per row — you can delete the per-id
fallback and the ~40 doomed lookups.

**It is `string | null`, and today it is null for real customers.** This module
reaches customers through a port that answers tier and risk; there is no
customer directory over gRPC yet, which is the same shape of gap as
`ListStylists` and `ListServices` had. The field, the batching and every
call site are in place, so the day that RPC exists names appear with no
front-end change. The fixture answers for its own five seeds, which is how the
transcript above shows `"name": "Dana R."`.

One correction to your report: `/search` is not resolving names. `"GS-1107 · QA1"`
is the booking code plus its **service** names joined — `QA1` is a service.

### 3.2 `GET /v1/bookings/{id}` returned ids the engine rejects — fixed

Items now carry both spellings and the staff name:

```json
{"serviceId":"8eb9c038-…", "serviceRef":"fringe-trim", "serviceName":"Fringe trim",
 "staffId":"8d820e0c-…",   "staffRef":"maya",          "staffName":"Maya E."}
```

`serviceId` is the frozen snapshot; `serviceRef`/`staffRef` are what
`/availability` and `/eligible-staff` take. The reschedule drawer can stop
round-tripping the service name through the catalogue.

### 3.3 The cancellations feed — all four, fixed

| Gap | What it does now |
|---|---|
| page-scoped `summary` | Computed over the whole `range` and the active `kind`, in SQL. Verified: `pageSize=1` returns one row and `summary.events: 2`. |
| no date on the row | `tradingDay`, `startAt`, `slot.date`, and `hoursBeforeStart` (signed; negative after the start). |
| late cancel indistinguishable | `lateCancel: boolean` and `policyBand` on every row. `kind=LATE_CANCEL` is a **real filter** now — it narrows the rows, the count and the summary — and an unknown `kind` is a 400 naming the legal values instead of a silent coercion. |
| no reasons, no recovery | Top-level `reasons: [{reason, count, value}]` over the same window, grouped case-insensitively, biggest first. `recovered: boolean` per row and `summary.recovered`. |

On `recoveredByCode`: we can tell you a cancellation **was** refilled, and that
is now honest data. We cannot name the replacement booking — the acceptance
produces a hold, and the booking is a separate confirm call that does not write
back to the waitlist entry. Tell us if the code matters and we will thread it
through; `recovered` alone may be enough for the KPI.

**`lostValue`: you were right to query it, and it was wrong.** It summed
`servicePrice` over rows whose payment status was *not* `forfeited` — counting a
fully refunded booking as a total loss and a forfeited one as nothing. It is now
stated: *the service value of every event in the window, less the deposits
actually kept*. Definition and spec in `cancellation-feed.ts`.

### 3.4 Calendar

**Utilisation is renarrowed.** With `staffId`, the columns, the booked minutes
*and the denominator* are all that professional's. You were right not to
recompute it client-side.

**Conflicts:** `booking.conflict` and `kpis.conflicts` are populated, and have
been — the join and the mapper exist and carry the exact shape you describe. Two
reasons you saw zero. First, both queries are branch-scoped, so §1 was hiding
them. Second, `POST /conflicts` reporting `autoRepaired: [3 codes]` means those
three items are **resolved**, not open: the repair ladder fixed them without a
human. `conflict` is populated only for `state = 'open'` items — a booking the
ladder already moved is not a conflict, it is a completed repair. Please re-test
on the token branch; if you can produce an open item that still shows null, send
it and we will chase it.

### 3.5 Series panel

- **The header exists.** `GET /series-admin/{id}` now carries `summary`, which
  is the **same projection the board row uses, from the same mapper** — customer,
  service, staff, pattern, confirmRule, ends, nextDate, pricePerVisit,
  lifetimeValue, occurrences, course. A deep link renders.
- **`bookingId` is on every occurrence**, beside `bookingCode`, plus `startsAt`.
  "Open booking" and `course-draw` have a usable id.
- **`alternatives`** is populated on the write-race path too (it was `[]` because
  the handler threw its candidates away on the way out) and uses the ladder's own
  definition of "the nearest three", so one list however the occurrence got
  stuck. It stays null off NEEDS_ATTENTION — the DB constraint enforces that, and
  a stale ladder on a seated visit is a list nobody will take.
- **`riskCause` and `healthReasons`/`healthExplanation` are one derivation now.**
  Both surfaces publish all three: `healthReasons` (enum, to branch on),
  `healthExplanation` (the sentence), and `riskCause` kept as an alias of the
  sentence so nothing reading it breaks.

### 3.6 Smaller items

| Item | Status |
|---|---|
| `counts.UNCONFIRMED` | **Added.** The predicate already existed; the projection just never called it. The OpenAPI note claiming it was deliberate is gone. |
| `/search` SERVICE ids | **Fixed.** SERVICE hits carry the engine's id. `SERIES` is still not implemented; `kind` is enumerated in the DTO so you can type-check it. |
| walk-in rows anonymous | **Fixed.** `customerId` and `guestName` on the row, and `label` is the customer's name when the directory can give one. |
| `payment-link` has no URL | **Added**, as `url` plus `linkDelivery: "URL" \| "SERVICE_DELIVERS"`. It is built from `PAYMENT_LINK_BASE_URL` + the booking code. **With no base configured `url` is `null`** — we will not hand a customer a plausible dead page. Tell us the checkout URL and we will set it. |
| group hold cannot be released | **`DELETE /v1/groups/holds/{holdId}`** exists. Idempotent, `{released: boolean}`, never a 404. One hold covers the party, so one delete returns all six lanes. |
| no branch timezone | **Fixed** — see §1, `settings.branch`. |
| compaction shows nothing | Very likely §1 used literally, as you suspected. Please re-test on the token branch. We have not reproduced the one-off difference either and have not pretended to fix it. |

---

## 4. P2 — both enforced now, proven

### 4.1 Check-in window

```
POST /v1/bookings/{id}/check-in        ← booking three days out
  → 409 {"code":"BOOKING_CHECKIN_WINDOW",
         "message":"Check-in opens at 2026-09-21T08:30:00.000Z.",
         "details":{"windowOpensAt":"…","startAt":"…"}}
```

### 4.2 No-show inside the grace

```
POST /v1/bookings/{id}/no-show         ← hours before the start
  → 409 {"code":"BOOKING_WITHIN_GRACE",
         "details":{"graceEndsAt":"…","autoNoShowAt":"…","startAt":"…"}}
```

The booking stays `CONFIRMED` and no money moves: both gates run before the
transaction.

Why they were missing: the only timing rule was in minutes-of-day, which cannot
tell today's 16:45 from Sunday's. Both now compare absolute instants
(`checkInTiming` / `noShowTiming` in `domain/booking/lifecycle.ts`, with specs).
The auto-no-show sweeper is exempt by design — it fires past the grace already,
and gating it would be a second copy of a schedule it keeps.

---

## 5. P3

### 5.1 Query validation — fixed

Every read-model route, the walk-in queue and compaction now have query DTOs, so
the `ValidationPipe` sees the query string. `forbidNonWhitelisted` was already
on globally, so **an unknown parameter is now refused rather than ignored**.

```
GET /calendar/day?date=banana   → 400 ["date must be YYYY-MM-DD"]
GET /calendar/month?month=banana→ 400 ["month must be YYYY-MM"]
GET /events?kind=BANANA         → 400 ["kind must be one of: ALL, CANCELLED, LATE_CANCEL, NO_SHOW"]
GET /events?range=17            → 400 ["range must be 7, 30 or 90"]
GET /walk-ins                   → 400 ["tradingDay must be YYYY-MM-DD"]
```

Every DTO still declares `branchId` as optional, so your current calls keep
working while you remove it.

Two more from that table:

- **`customerId` was being applied to the rows and not to the count**, so a
  filtered read returned five rows and reported `total: 109`. Fixed —
  `staffId` too.
- **`from`/`to` are now both INCLUSIVE.** `to` was passed through as the
  exclusive bound, which is why `from` alone gave 102 and adding `to` gave 0.
  `from=X&to=X` returns that one day.

### 5.2 `code` on a 400 — added

Validation failures carry `code: "BOOKING_VALIDATION_FAILED"`. `message` stays
an array of field errors — that array is the useful part and flattening it would
lose the field names.

### 5.3 `/v1/me` — fixed

It carried its own `@UseGuards(AuthGuard)` — the customer-only gRPC guard —
while everything else went through the global one. It now returns the verified
actor for either token kind:

```json
{"id":"…","kind":"manager","branchId":"b7e92439-…","tenantId":"f2a9882b-…"}
```

`branchId` here is the branch every read on that token is scoped to, so it is a
second way to check §1.

### 5.4 `pageSize` cap — documented

Still capped at 100, still clamped rather than refused, and now stated in the
OpenAPI description with the response echoing the value used.

---

## One thing to check on your side first

If you see this, it is not a permission problem and not your token:

```json
{"statusCode":503,"code":"AUTH_MISCONFIGURED",
 "message":"This server cannot verify staff tokens: its signing secret is not
            configured. Your token is probably fine. Set JWT_ACCESS_SECRET.",
 "details":{"variable":"JWT_ACCESS_SECRET"}}
```

It means `JWT_ACCESS_SECRET` is unset on that server, so no signature can be
checked. It used to be reported as `401 UNAUTHENTICATED "Staff authentication
unavailable"`, which reads as "your credential is bad" and sends you looking on
the wrong side of the wire — that was our bug and it is fixed. The service also
shouts it once at boot now. A `docker stack deploy` wiping a variable set with
`--env-add` is the usual cause.

---

## What we did not change

- **`messageLog` on an event is still `[]`.** Nothing in this service sends a
  message; the reminder ladder marks a rung fired and writes an outbox event,
  and the transport does not exist. A fabricated `DELIVERED` row would be worse.
- **`DUPLICATE_CUSTOMER` / `DIARY_SLIVERS` worklist tiles are still absent.**
  Same reason: the data is not ours to invent.
- **`recoveredByCode`** — see §3.3.
- **Customer names for real customers** — see §3.1. This is the one item on your
  list we could not close, and it is the one we would most like a decision on.

Everything else in your report is addressed above.
