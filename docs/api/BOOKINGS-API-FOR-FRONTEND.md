# Bookings API — what is live, and how to call it

> **For:** the frontend team building the Bookings module.
> **Server:** `gostyle-booking-api`, branch `feat/platform-directories`.
> **Status of this document:** every endpoint below was called against a running
> server with a real Postgres while this was written. Where something is not built, it says so
> and does not appear in the route tables.
>
> Companions: [FE-CONTRACT-AUDIT.md](./FE-CONTRACT-AUDIT.md) (creation flow) and
> [FE-CONTRACT-AUDIT-MODULE.md](./FE-CONTRACT-AUDIT-MODULE.md) (the gap analysis this work came
> from).

---

## 1. Read this first — six things that changed

**1. Every refusal now carries a machine-readable `code`.** You no longer have to string-match
error messages. The prose stays, because a desk agent reads it aloud, but you branch on `code`.

**2. Availability refusals carry `details` you can act on.** A blocked move tells you which
skills are missing, who *could* take the booking, and three refreshed offers.

**3. The screens now have read models.** List, day/week/month calendar, summary, worklist,
search, events, waitlist board and series board all exist. Previously there was no way to fetch
more than one booking at a time.

**4. `X-Branch-Id` is read, and CORS lets you send it.** It was in neither place before. Note
that `X-Tenant-Id` was being read server-side but **blocked by CORS**, so no browser could ever
send one — that is fixed.

**5. Money is minor units (fils) on the wire.** Your module contract asked for whole AED; we
publish both (`priceMinor` **and** `price`). See §9 — this is one of the open decisions.

**6. `POST /v1/series` used to double-create on retry.** It never read `Idempotency-Key`, so a
retried create made a second standing appointment for a year. Fixed, and the same store now
backs every keyed route. Even without a key, a create is now deduplicated by its own
fingerprint.

---

## 2. Calling convention

```
Base URL   http://localhost:3099/v1        (dev)
Auth       Authorization: Bearer <staff JWT>
Branch     X-Branch-Id: marina-walk
Tenant     X-Tenant-Id: <tenant>           (captured; not yet an isolation boundary)
Money      Idempotency-Key: <uuid>         required on every money-moving POST
```

### `X-Branch-Id`

Resolution order, highest first:

1. `X-Branch-Id` header
2. an explicit `branchId` / `branch` field in the body or query
3. `marina-walk`, the default every route used before the header existed

Rung 3 is why adopting the header breaks nothing. Send it everywhere; when you do, we flip
`REQUIRE_BRANCH_HEADER=true` and an unheadered request is refused instead of silently defaulted.

### Errors

```json
{
  "statusCode": 409,
  "code": "BOOKING_SKILL_MISSING",
  "message": "Lina K. does not hold the required skills: hair (hair at level 2).",
  "details": {
    "staffId": "lina",
    "missingSkills": ["hair"],
    "requires": [{ "skill": "hair", "level": 2 }],
    "eligibleStaff": [
      { "id": "anya", "name": "Anya V." },
      { "id": "maya", "name": "Maya E." },
      { "id": "reem", "name": "Reem S." }
    ]
  },
  "error": "Conflict"
}
```

`statusCode`, `message` and `error` are unchanged from before, so nothing you have already
written breaks. `code` and `details` are new.

**The 19 codes:**

| Code | Status |
| ---- | -----: |
| `BOOKING_NOT_FOUND` | 404 |
| `BOOKING_STATE_INVALID` | 409 |
| `BOOKING_HOLD_EXPIRED` | 409 |
| `BOOKING_SLOT_TAKEN` | 409 |
| `BOOKING_CAPACITY_BLOCKED` | 409 |
| `BOOKING_STAFF_UNAVAILABLE` | 409 |
| `BOOKING_SKILL_MISSING` | 409 |
| `BOOKING_GATE_BLOCKED` | 409 |
| `BOOKING_CHECKIN_WINDOW` | 409 |
| `BOOKING_WITHIN_GRACE` | 409 |
| `BOOKING_SERIAL_RESCHEDULE` | 409 |
| `BOOKING_NO_SLOT` | 409 |
| `BOOKING_SCAN_PENDING` | 409 |
| `BOOKING_REASON_REQUIRED` | 422 |
| `BOOKING_LEAD_HORIZON` | 422 |
| `FORBIDDEN_ROLE` | 403 |
| `IDEMPOTENCY_KEY_REUSED` | 409 |
| `UNAUTHENTICATED` | 401 |
| `BOOKING_PAYMENT_REQUIRED` | 402 |

The last two are **additions to your §19**. `UNAUTHENTICATED` because the guard is closed by
default and 401 is the most common refusal this service emits — forcing it into
`BOOKING_STATE_INVALID` told you a booking was in the wrong state when the answer was "sign in".
`BOOKING_PAYMENT_REQUIRED` because the deposit ladder refuses an underpaid confirm with
*"AED 240.00 is required before this booking can be confirmed"*, and that is a different branch
for you than "you may not do that".

> **One divergence from your §19:** you specify 409 for `BOOKING_HOLD_EXPIRED` and we previously
> answered 410 Gone. We adopted your 409.

### Enums

Every enum you **send** is `SCREAMING_SNAKE` (`"CASH"`, `"DEPOSIT"`, `"EVERY_N_WEEKS"`). Every
enum you **receive** is too. The database's lowercase spellings never reach you.

---

## 3. The seven screens

All of these are **desk-only** — a customer token is refused.

### 3.1 Overview — `/bookings/overview`

```
GET /v1/bookings/summary?range=7|30|90
GET /v1/bookings/worklist
```

```json
{
  "range": 30,
  "bookings":      { "value": 9,    "delta": "new" },
  "revenue":       { "value": 1640, "delta": "new" },
  "showUpRate":    { "value": 0.75, "delta": "−25 pts" },
  "averageTicket": { "value": 182,  "delta": "+182" },
  "noShows":       { "value": 2,    "delta": "+2" },
  "trend": [{ "date": "2026-09-12", "label": "Sat", "bookings": 2, "revenue": 280 }],
  "bookingsToday": 0
}
```

`delta` is a **server-rendered display string**, already compared against the prior window of
the same length. Do not compute one. Three kinds exist and they read differently: a count moves
by a percentage, a rate by points, an average by an absolute amount.

Two behaviours worth knowing:

- A prior window of **zero** reports `"new"`, never `"+Infinity%"`.
- `showUpRate` counts only visits that **concluded** (settled, completed, no-show, cancelled).
  A morning full of confirmed-but-not-yet-happened bookings would otherwise read as 0%. With
  nothing concluded it is `1`, not `0`.
- The minus sign is **U+2212**, not a hyphen.

**Worklist** returns one row per real problem. A tile with a count of zero is **absent**, not
present-and-empty:

```json
{ "items": [
  { "kind": "DEPOSITS_PENDING", "severity": "WARN", "count": 2,
    "target": { "screen": "UPCOMING", "filter": "DEPOSIT_PENDING" } },
  { "kind": "SERIES_AT_RISK", "severity": "DANGER", "count": 1,
    "context": { "seriesId": "ser_…", "customerId": "cus_…" },
    "target": { "screen": "RECURRING", "seriesId": "ser_…" } }
] }
```

Live kinds: `DEPOSITS_PENDING`, `CONFLICTS`, `SERIES_AT_RISK`, `WALK_INS_WAITING`.
**`DUPLICATE_CUSTOMER` and `DIARY_SLIVERS` are not emitted** — see §8.

### 3.2 Calendar — `/bookings/calendar`

```
GET  /v1/bookings/calendar/day?date=2026-09-20[&staffId=]
GET  /v1/bookings/calendar/week?from=2026-09-17
GET  /v1/bookings/calendar/month?month=2026-09
POST /v1/bookings/{id}/move
```

```json
{
  "date": "2026-09-20",
  "openMinute": 600, "closeMinute": 1320, "nowMinute": 1399,
  "closureReason": null,
  "columns": [
    { "staffId": "reem", "name": "Reem S.",
      "shift": { "fromMinute": 600, "toMinute": 1080 },
      "timeOff": [], "load": 2 }
  ],
  "bookings": [ /* Booking[] — §4 */ ],
  "kpis": { "booked": 5, "utilisation": 0.1053, "revenue": 1320,
            "pendingDeposits": 0, "conflicts": 0, "walkInsWaiting": 0 }
}
```

- `utilisation` is measured against **sellable** minutes (published shift minus approved time
  off), never trading hours. A stylist rostered 10:00–14:00 and fully booked reads 1.0, not 0.33.
- `nowMinute` is **branch-local** and independent of the server's timezone. Verified: the server
  running this was UTC+6 and it correctly reported branch (UTC+4) time.
- **`timeOff` is always `[]` today.** Time off *is* excluded from availability — but it reaches
  the engine as opaque entries on a professional's calendar, so there is no labelled list to
  publish. Grey out `shift` boundaries; do not expect gaps inside them.

**Move (drag-and-drop)** takes `date` plus `startTime` **or** `startMin`:

```json
POST /v1/bookings/{id}/move
{ "date": "2026-09-20", "startTime": "10:30", "staffId": "anya",
  "overbookReason": "regular client, squeezing in" }
```

Two paths, and the response tells you which ran:

| `path` | When | Why it matters |
| ------ | ---- | -------------- |
| `SHIFT_IN_PLACE` | same professional, same day | A booking nudged 15 minutes **overlaps itself**, so a hold on the new slot is refused by the exclusion constraint against the very booking being moved. This path releases and rewrites in one transaction. |
| `HOLD_AND_MOVE` | different professional or day | We place the hold server-side and move onto it, so your drag stays one gesture. `moveCount` increments and the deposit carries. |

`overbookReason` is **manager-only** and audited; a non-manager gets `FORBIDDEN_ROLE`.

### 3.3 Upcoming — `/bookings/upcoming`

```
GET /v1/bookings?filter=&from=&to=&staffId=&customerId=&page=&pageSize=
```

`filter` ∈ `ALL` · `TODAY` · `TOMORROW` · `DEPOSIT_PENDING` · `CONFLICTS` · `UNCONFIRMED` ·
`NOT_REMINDED`. An unknown filter is a `422 BOOKING_REASON_REQUIRED` naming it, not a silent
`ALL`.

```json
{
  "data": [ /* Booking[], sorted by startsAt ascending */ ],
  "page": 1, "pageSize": 25, "total": 14,
  "counts": { "ALL": 14, "TODAY": 0, "TOMORROW": 4,
              "DEPOSIT_PENDING": 0, "CONFLICTS": 0, "NOT_REMINDED": 10 }
}
```

`counts` are computed against the **unfiltered** set, so the chips do not all read the same
number once you click one.

### 3.4 Recurring — `/bookings/recurring`

```
GET /v1/bookings/series?status=ALL|ACTIVE|PAUSED|ENDED|COMPLETED|AT_RISK
```

```json
{ "data": [ {
    "id": "ef906905-…",
    "status": "ACTIVE", "health": "HEALTHY", "riskCause": null,
    "customer": { "id": "…" },
    "service": { "id": "blow-dry" },
    "staff":   { "id": "maya" },
    "pattern": { "kind": "EVERY_N_WEEKS", "interval": 2, "weekdays": [],
                 "dayOfMonth": null, "timeOfDay": "18:00", "anchorDate": "2026-09-24" },
    "confirmRule": "AUTO_CONFIRM_ON_SCHEDULE",
    "ends": { "kind": "AFTER_COUNT", "count": 12, "date": null },
    "nextDate": "2026-09-24",
    "pricePerVisit": 140, "lifetimeValue": 840,
    "occurrences": { "total": 6, "needsAttention": 0, "skipped": 0 },
    "course": null,
    "materialisedThrough": "2026-12-03"
  } ],
  "summary": { "live": 1, "atRisk": 0, "paused": 0,
               "futureOccurrences": 6, "lifetimeValue": 840 } }
```

`health` is **derived** from the occurrences that exist, never stored — a stored flag and the
occurrences are two facts that can disagree, and the stored one is always the wrong one.
`status` (`ACTIVE`/`PAUSED`/…) and `health` (`HEALTHY`/`AT_RISK`) are deliberately separate: a
paused series can still be at risk, and you should not have to pause one to clear a warning.

Series detail, occurrences, pause/resume/end/skip live under `/v1/bookings/series-admin/{id}`
(§7).

### 3.5 Cancellations — `/bookings/cancellations`

```
GET /v1/bookings/events?range=7|30|90&kind=ALL|NO_SHOW|CANCELLED&page=&pageSize=
GET /v1/bookings/events/{id}
```

```json
{
  "data": [ {
    "id": "01a0b0d0-…", "bookingId": "…", "code": "GS-1010",
    "kind": "NO_SHOW", "by": "MANAGER",
    "occurredAt": "2026-09-17T19:20:18.125Z",
    "customer": { "id": "…" }, "service": "Signature blow-dry",
    "staffId": "…", "slot": { "startTime": "11:40", "durationMinutes": 45 },
    "reason": "never arrived",
    "servicePrice": 140, "depositAmount": 40, "outcome": "DEPOSIT_KEPT"
  } ],
  "total": 2,
  "summary": { "events": 2, "noShows": 1, "lostValue": 160, "depositsKept": 40 }
}
```

**Windowed on when the event happened, not on the visit's date.** A cancellation made today of
a booking three days out belongs in today's feed. (The first implementation filtered on the
visit's trading day and hid exactly the events the screen exists to show.)

The detail drawer adds the **worked policy maths** so the desk can answer a dispute:

```json
{ "math": [
    { "label": "Service value",    "value": 140 },
    { "label": "Deposit captured", "value": 40 },
    { "label": "Policy window",    "value": "start + grace passed" },
    { "label": "Outcome",          "value": "DEPOSIT_KEPT" }
  ],
  "messageLog": [] }
```

`messageLog` is **always empty**. Nothing in this service sends a message — see §8.

### 3.6 Walk-ins — `/bookings/walk-ins`

```
GET  /v1/bookings/walk-ins?branchId=&tradingDay=&nowMin=
POST /v1/bookings/walk-ins
POST   /v1/bookings/walk-ins/{id}/seat
DELETE /v1/bookings/walk-ins/{id}          ← leave the queue
```

Each queue row carries `waitingMin` and a live `quote` from **the same availability engine the
booking wizard uses** — a quote the diary cannot honour is worse than "no gap today".

Identity is `customerId` **or** `guestName`. **Phone matching is not implemented**: we never
take a phone here, so "a matching phone attaches to the existing customer" does not happen yet.

### 3.7 Waitlist — `/bookings/waitlist`

```
GET    /v1/bookings/waitlist
POST   /v1/bookings/waitlist
POST   /v1/bookings/waitlist/{id}/accept
POST   /v1/bookings/waitlist/{id}/decline
DELETE /v1/bookings/waitlist/{id}          ← leave the list
```

Both `DELETE`s are **idempotent and never 404**: leaving twice, or leaving an entry that already
lapsed, answers `{ "left": false }`. A desk that cannot tell a double-click from a real error
will retry, and a 404 makes that retry look like a bug.

```json
{
  "offered": [ {
    "id": "67fbec01-…", "status": "OFFERED", "position": 1,
    "customer": { "id": "…" }, "service": { "id": "haircut-finish" },
    "window": { "date": "2026-09-20", "fromMinute": 600, "toMinute": 900,
                "fromTime": "10:00", "toTime": "15:00" },
    "preferredStaffId": null, "declineCount": 0,
    "joinedAt": "2026-09-17T19:46:53.490Z",
    "offer": { "date": "2026-09-20", "startTime": "10:30",
               "startsAt": "2026-09-20T06:30:00.000Z", "durationMinutes": 45,
               "staffId": "anya", "bookingCode": "GS-1004",
               "expiresAt": "2026-09-17T20:03:50.796Z" }
  } ],
  "waiting": [],
  "summary": { "waiting": 0, "offered": 1, "recovered": 0, "conversionRate": 0 }
}
```

`waiting` arrives in the **server's order**; render `position`, do not compute it.

**Offers are automatic.** Cancel, no-show, expiry and reschedule-away all call the backfill
before the slot returns to general availability. There is no "make an offer" endpoint because
nothing should have to remember to call one. Proven end to end: cancelling `GS-1004` produced
the offer above, with its 15-minute TTL, within seconds.

Ranking is **join order (FIFO)**. Your §14.2 tier weighting is an open decision, not an
omission — see §9.

### 3.8 Check-in drawer

```
GET  /v1/bookings/{id}/check-in        ← the gates
POST /v1/bookings/{id}/check-in        ← perform it
POST /v1/bookings/{id}/check-in/undo   ← within 5 minutes
POST /v1/bookings/{id}/shorten         ← triage a late arrival
POST /v1/bookings/{id}/waiver          ← manager only
```

```json
{
  "bookingId": "…", "code": "GS-1004",
  "windowOpensAt": "2026-09-20T05:35:00.000Z",
  "graceMinutes": 15,
  "graceEndsAt": "2026-09-20T06:20:00.000Z",
  "autoNoShowAt": "2026-09-20T06:35:00.000Z",
  "lateMinutes": 0,
  "verdict": "TOO_EARLY",
  "gates": [
    { "gate": "CONSENT", "passed": null, "reason": "NOT_MODELLED",
      "detail": "Consent and patch-test records live on the customer service; this module cannot see them yet.",
      "remedies": ["MANAGER_WAIVER", "BOOK_PATCH_TEST"] },
    { "gate": "PAYMENT", "passed": true },
    { "gate": "CHAIR",   "passed": true }
  ],
  "availableChairs": [ { "resourceClass": "styling", "free": 2, "units": 3 } ],
  "estimate": { "services": 160, "prepaid": 0, "total": 160 }
}
```

`verdict` ∈ `READY` · `TOO_EARLY` · `GATES_AMBER`. Grace is 15 minutes, 20 for VIP; check-in
opens at start − 30; automatic no-show fires at start + 30.

**`CONSENT` reports `passed: null`, not `true`.** Consent and patch-test records live on the
customer service, which this module cannot read. Returning a pass we cannot justify is how an
untested client gets a colour service. Render the null as "unknown", not as a green tick.

`availableChairs` is free/busy **by resource class**, not individual named chairs — this service
models capacity as counted units per class, not a chair map.

**Undo** is valid for five minutes and returns the booking to `CONFIRMED`, releasing the chair.
Past that it is refused — by then the station has been given away, and undoing would be a claim
that the customer never arrived.

**Shorten** triages a late arrival down to what still fits:

```json
POST /v1/bookings/{id}/shorten
{ "toDurationMinutes": 30, "reason": "arrived 15 min late" }

200 { "code": "GS-1003", "fromDurationMinutes": 45,
      "toDurationMinutes": 30, "releasedMinutes": 15 }
```

The **reservations shrink with the booking**, so those 15 minutes are genuinely back in the
diary rather than freed on paper. Anything under 15 minutes is refused: that is a disappointed
customer, not a service — rebook or record a no-show instead.

**Waiver** is manager-only and writes an audited `booking.patch_test_waived` event carrying who
waived it and why. The question support asks months later is "who waived this", and a boolean
on the booking cannot answer it.

### 3.9 Reminders

```
POST /v1/bookings/{id}/remind
POST /v1/bookings/reminders/bulk      { "limit": 50 }
```

```json
{ "sent": false, "queued": true, "channel": "OUTBOX",
  "queuedUntil": "2026-09-18T05:00:00.000Z",
  "explanation": "Inside quiet hours. It will go out at 09:00 this morning.",
  "delivered": false,
  "note": "No message transport is wired yet; the event is queued in the outbox." }
```

**Quiet hours (21:00–09:00) queue rather than fail.** A desk agent pressing this at 22:30 wants
the customer reminded, not woken; refusing would only move the waiting onto a person.

**`delivered` is always `false`.** The event is written to the outbox and will be relayed, but
nothing in this service actually sends a WhatsApp. A `sent: true` meaning "we wrote a row" is a
lie the desk would act on, so both fields are published and they mean different things.

---

## 4. The `Booking` object

Returned by the list, the calendar and the week view.

```json
{
  "id": "bcb5c4d2-…",
  "code": "GS-1004",
  "status": "CONFIRMED",
  "statusDetail": "CONFIRMED",
  "customer": { "id": "…", "tier": null, "isNew": false,
                "requiresDeposit": false, "riskBand": "LOW", "riskScore": 92 },
  "services": ["Haircut and finish"],
  "staff": { "id": "reem", "name": "Reem S." },
  "date": "2026-09-20",
  "startTime": "10:20",
  "startsAt": "2026-09-20T06:20:00.000Z",
  "endsAt":   "2026-09-20T07:05:00.000Z",
  "durationMinutes": 45,
  "price": 160, "priceMinor": 16000,
  "payment": {
    "state": "NONE", "deposit": 0, "depositMinor": 0,
    "depositOutcome": null,
    "requirement": { "source": null },
    "linkExpiresAt": null
  },
  "channel": "DESK",
  "moveCount": 1,
  "reminded": false,
  "remindedAt": { "confirm24h": null, "dayOf3h": null, "nudge15m": null },
  "overbook": null,
  "group": null,
  "resourceTypes": ["styling"]
}
```

### `status` and `statusDetail`

We model **14** booking states; you model 10. `status` is the projection onto your ten.
`statusDetail` is our own word, **on every row**, because three of your words are ambiguous:

| Your word | Ours that map to it |
| --------- | ------------------- |
| `PENDING_CONFIRM` | `draft`, `held`, `pending_confirmation` |
| `CANCELLED` | `cancelled`, `rescheduled` |
| `EXPIRED` | `expired`, `skipped` |

The other seven are one-to-one. Branch on `status`; show `statusDetail` in a tooltip or an
audit view when the distinction matters.

`category` ∈ `Hair` · `Nails` · `Skin` · `Brows` · `Other` — derived from the resource classes
the booking occupies, so `styling`/`color`/`wash` share one band. Do not derive it from
`resourceTypes[0]`.

`conflict` is populated when a roster change has stranded the booking, and carries `changeId`
and `itemId` — the repair path, not just the bad news. See
[BOOKINGS-FE-ROUND-2.md](./BOOKINGS-FE-ROUND-2.md) §3.

`payment.state` ∈ `NONE` · `PENDING` · `PAID` · `FULL`. Everything after settlement
(`refunded`, `forfeited`, `settled`, `partially_refunded`) reports as `PAID` — money *was*
taken; what became of it is the ledger's story, and the ledger travels on the booking detail.

### Fields not yet populated

- `customer.name` / `.phone` / `.visits` — the customer service owns these; this module reads a
  port that answers tier and risk only.
- `chair`, `startedAt`, `pausedAt`, `note`, `extras`, `gate`, `conflict`, `recurring` — no
  column behind them yet.
- `overbook` — the columns exist and are read back, but **nothing writes them** except a
  manager `move` with `overbookReason`.

### Ids: slugs, not UUIDs

`staff.id` is `"reem"`, `service.id` is `"blow-dry"`. The columns are `uuid` and the fixtures
speak slugs; we fold ids back to slugs on the way out so **every endpoint spells the same
stylist the same way**. When the platform's real UUIDs arrive, these become UUIDs everywhere at
once.

> This was claimed here before it was true. The series and waitlist boards folded their ids; the
> booking list and calendar did not, so the same stylist arrived as `"maya"` on one screen and a
> uuid hash on another. Fixed, including `conflict.staffId`. If you built a lookup around the
> hash, it now receives the slug.

`customer.id` is still a UUID — there is no customer slug registry.

---

## 5. Money actions

All four are `POST /v1/bookings/{id}/…`, all four **require `Idempotency-Key`**, and a repeat
with the same key returns the original ledger entry with `"replayed": true`, having written
nothing.

| Endpoint | Role | What it does |
| -------- | ---- | ------------ |
| `capture` | desk | Takes the pending link amount in person. **The link is invalidated in the same transaction** — otherwise the same deposit can be paid twice, once here and once on a phone in the car park. `PENDING_PAYMENT → CONFIRMED`. |
| `refund` | manager | Writes a **linked reversal** on a settled booking. The original capture row stays; a negative row is appended beside it. |
| `goodwill` | manager | Credits a forfeited deposit toward a rebook **without reversing the forfeit**. Both sides stay on the ledger; the risk score is untouched. |
| `revive` | manager | Puts a no-show back on the diary and **reverses the forfeit**, re-opening the original position rather than refunding. `NO_SHOW → CONFIRMED`. |

```json
POST /v1/bookings/{id}/capture
Idempotency-Key: 5f3a…
{ "reason": "paid at the desk", "rail": "CASH" }

200
{ "code": "GS-1014", "ledgerEntryId": "01a0b0f8-…",
  "amount": 240, "amountMinor": 24000, "amountDisplay": "AED 240.00",
  "balanceMinor": 24000, "balanceDisplay": "AED 240.00",
  "status": "CONFIRMED", "paymentStatus": "DEPOSIT_PAID",
  "replayed": false }
```

`rail` ∈ `WALLET` · `CARD` · `APPLE_PAY` · `CASH` · `LINK` · `INTERNAL`.

### Late capture

```
POST /v1/bookings/{code}/late-capture
{ "intentId": "pi_abc123", "amountMinor": 24000, "rail": "CARD" }
```

Money that arrived after the payment window closed. Runs **the same decision the gateway webhook
runs** — reinstate if the slot survived, refund in full if it was resold — because a second copy
of that rule matters most exactly when it disagrees. Normally the webhook drives this; the
endpoint exists so the desk can replay it.

### Course draw

```
POST /v1/bookings/series-admin/{seriesId}/course-draw
{ "bookingId": "bk_…" }

200
{ "visit": 1, "of": 6,
  "drawnMinor": 31500, "drawnDisplay": "AED 315.00",
  "netMinor": 30000, "vatMinor": 1500,
  "remainingMinor": 157500, "remainingDisplay": "AED 1575.00",
  "endsCourse": false, "tender": "Course credit applied" }
```

The amount comes from the draw **schedule**, not a division — the draws must sum back to exactly
what was sold, or the course never closes at zero and somebody shuts it by hand. **VAT is
recognised per draw**, not at the point of sale: the salon has not earned the sixth visit's
revenue on the day the course is bought.

**Goodwill and revive are alternatives, not a sequence.** Both credit the same forfeited
deposit, so doing both hands it back twice. `revive` refuses when a goodwill credit already
exists and tells you to apply that credit instead. (Found by doing exactly that against a
running server: the booking ended up carrying AED 80 against a AED 40 capture.)

### The ledger

`GET /v1/bookings/{id}` returns it inline:

```json
"ledger": [
  { "entryType": "captured",  "amountMinor":  4000, "rail": "card" },
  { "entryType": "forfeited", "amountMinor": -4000, "rail": "internal" },
  { "entryType": "goodwill",  "amountMinor":  4000, "rail": "internal" },
  { "entryType": "reversed",  "amountMinor":  4000, "rail": "internal" }
]
```

Append-only, **enforced by a database trigger** — no endpoint can edit or delete an entry. A
negative amount means money left the protected balance. Two further constraints you will see
reflected in the API's behaviour: a zero-amount entry is refused outright, and a `reversed`
entry must name the row it reverses.

Kinds: `captured` · `applied_at_pos` · `refunded` · `partially_refunded` · `forfeited` ·
`reversed` · `goodwill` · `course_draw`. Your `INTENT_CREATED` and `COURSE_PREPAID` do not
exist (no payment intents — §8).

---

## 6. Lifecycle

```
POST /v1/bookings/{id}/reschedule     hold-then-move
POST /v1/bookings/{id}/move           calendar drag (§3.2)
POST /v1/bookings/{id}/cancel
POST /v1/bookings/{id}/no-show
POST /v1/bookings/{id}/check-in
POST /v1/bookings/{id}/start
POST /v1/bookings/{id}/complete
POST /v1/bookings/{id}/settle
```

Cancel returns what the policy did, as a sentence the desk reads out:

```json
{ "code": "GS-1009", "from": "CONFIRMED", "to": "CANCELLED",
  "paymentStatus": "UNCHANGED",
  "refund": "AED 0.00", "kept": "AED 0.00", "lateCancel": false,
  "explanation": "No charge. Any pending payment intent is voided." }
```

The policy bands: **>24 h** refund in full · **2–24 h** deposit kept (a *fully prepaid* booking
splits 50/50 — see §9) · **<2 h** kept and flagged `lateCancel` · **nothing captured** no charge ·
**salon-initiated** refunds in full whatever the timing.

`start` / `complete` / `settle` live here today. Your §15 assigns them to Point of sale calling
in — that seam has not moved yet.

---

## 7. Conflicts, compaction, series admin

Aliased under `/v1/bookings/*`; the original aggregate paths still work.

| Contract | Live path |
| -------- | --------- |
| scans + conflict worklist | `POST /v1/bookings/conflicts` with `kind` ∈ `SHIFT_CONFLICT` · `CLOSURE_SWEEP` · `CHAIR_OUT_OF_SERVICE` |
| conflict list for a change | `GET /v1/bookings/conflicts/{id}` |
| resolve one | `POST /v1/bookings/conflicts/{id}/items/{itemId}/resolve` — `REASSIGN` · `MOVE` · `OVERRIDE` · `ACCEPT_CANCELLATION` |
| commit gate | `POST /v1/bookings/conflicts/{id}/commit` |
| compaction plan | `GET /v1/bookings/compaction?branchId=&tradingDay=` |
| compaction apply | `POST /v1/bookings/compaction/apply` |
| series admin | `/v1/bookings/series-admin/{id}` + `/pause` `/resume` `/end` `/materialise` `/occurrences` |
| holds | `POST /v1/bookings/holds`, `DELETE /v1/bookings/holds/{id}` |
| availability | `GET /v1/bookings/availability`, `…/availability/catalogue` |

**Three differences from your §8:**

1. The three scans are **one endpoint with a `kind`**, not three endpoints.
2. The repair ladder **runs automatically** when a scan opens — there is no
   `POST /conflicts/repair` to call. Rungs 1–3 apply themselves; rung 4 (salon cancellation) is
   **prepared but not applied**, because cancelling a paying customer is not something a roster
   edit should do while nobody is looking.
3. The commit gate is a **database trigger**, so a caller that ignores it is refused anyway.
   That is your `BOOKING_SCAN_PENDING`.

Compaction honours **every** limit you specified: at most 3 moves, at most 30 minutes each,
singles only (groups, series occurrences and anything not confirmed are excluded), sliver
threshold 25 minutes, a booking already moved three times is left alone, and every move is
**re-validated at apply time**, not at plan time.

---

## 8. Not built — do not design around these

Everything the contract asked for that could be built without a provider or an owner decision
now exists. What is left is listed plainly, and none of it is faked: where an endpoint would
have to invent data it returns an empty list or a null rather than something plausible.

### Blocked on a decision that is not ours

| Area | State |
| ---- | ----- |
| **Payment intents** | No provider is wired. We never create an intent; we consume gateway webhooks. Your card sheet is blocked on this, and nothing else is. |
| **Message delivery** | Reminders, consent asks and confirm asks all **queue correctly** — the event is written, quiet hours are enforced, `queuedUntil` is populated. Nothing sends. `delivered` is always `false` and `messageLog` is always `[]`. Wiring a transport is a provider choice. |
| **`POST /v1/webhooks/messaging`** | Not built; there is nothing on the other end of it yet. |
| **Realtime (§20)** | No socket. The events exist and are correct — a transactional outbox writes them in the same commit as the change — but the publisher currently writes to the log. Transport is an infrastructure decision. |
| **Customer writes** | `GET /v1/customers/{id}/risk` exists. `require-deposit` and `merge` write to the **customer service's** record, which this module reads through a port and cannot write. The nightly sweep now identifies who has earned a flag lift and emits `customer.deposit_flag_liftable`; consuming it needs an endpoint on their side. |
| **Per-branch config** | There is no branch table. Grace, cancel windows, sliver threshold and hold TTL are constants — correct values, wrong storage. `GET /v1/bookings/settings` publishes them and is explicit that it is not a configuration surface. |
| **Tenant isolation** | `X-Tenant-Id` is captured and stored. **Nothing filters on it.** Do not build UI that assumes isolation. |

### Genuinely still missing

| Area | State |
| ---- | ----- |
| **`POST /{id}/patch-test`** | Books the free 10-minute patch-test visit and chains it to the colour. **There is no patch-test service in the catalogue**, so there is nothing to book. Needs a catalogue entry before the endpoint can mean anything. The `waiver` half of that gate is built. |
| ~~Series `pattern` write~~ | **Built.** `POST /v1/bookings/series-admin/{id}/pattern`, backed by the same planner as `edit-scope`. |
| **`POST /series/{id}/confirm-ask`** | The 48-hour window is enforced and now expires on schedule (below). Sending the ask itself is blocked on message delivery. |
| **Worklist tiles** | `DUPLICATE_CUSTOMER` needs the customer service. `DIARY_SLIVERS` needs a per-day compaction run, which would make the cheapest screen the slowest. Neither is emitted; an INFO tile that always reads zero is worse than no tile. |
| **`columns[].timeOff`** | Always `[]`. Time off *is* excluded from availability, but it reaches the engine as opaque calendar entries, so there is no labelled list to publish. |

### Scheduled jobs — all six now run

| Job | Cadence |
| --- | ------- |
| Series materialiser | nightly, 02:00 |
| Automatic no-show | every 60 s |
| Hold expiry | every 30 s |
| Waitlist offer expiry | every 30 s |
| Reminder ladder | every 60 s |
| Payment-link sweeper | every 60 s |
| **Confirm-ask expiry** | **hourly — new** |
| **Risk-flag lift** | **nightly, 03:00 — new** |

The confirm-ask rule had been written, specified and tested for months and **nothing ever ran
it**: every unanswered ask sat as `PENDING_CONFIRMATION` forever, holding a chair against a visit
that was never going to happen. Both jobs were driven against the real database to confirm they
fire — see §11.

### Idempotency

`Idempotency-Key` is honoured on **every write route**: the four money actions, `POST /v1/bookings`,
`POST /v1/series`, the whole lifecycle (`move`, `reschedule`, `cancel`, `no-show`, `check-in`,
`start`, `complete`, `settle`), the desk extras (`undo`, `shorten`, `waiver`, `remind`,
`late-capture`, `course-draw`), the walk-in queue, compaction apply and the conflict scans. Same key and same body replays the stored response with
`replayed: true`; same key and a **different** body is a `409 IDEMPOTENCY_KEY_REUSED`, because
that is a client bug and answering the first response would hide it.

The fingerprint ignores JSON key order, so two client builds that serialise the same request
differently are still recognised as the same request.

---

## 9. Decisions we need from you

These are where our behaviour and your contract genuinely disagree. We implemented **your**
answer wherever we could do so safely; these are the ones that change what a customer is charged
or who gets a slot, so we have not picked unilaterally.

1. **Money on the wire.** Your creation contract says minor units; this one says whole AED and
   explicitly rejects minor units. We currently send **both** (`priceMinor` and `price`) on
   bookings. One answer, both documents, please — a float that round-trips is how deposits end
   up a fil short.
2. **Does a deposit survive a late reschedule?** You say it carries **always**. We forfeit and
   re-quote inside the 2-hour window, treating a late move as a late cancel plus a new booking.
   Yours is kinder; ours stops a late move being a free way out of a late-cancel fee.
3. **A fully prepaid booking cancelled 2–24 h out.** Your matrix has no cell for it. We split
   50/50. If ours stands you need a fifth outcome to render.
4. **Waitlist ranking.** You want join order weighted by tier (ROYAL/VIP +2, GOLD +1.5,
   SILVER +1). We are strict FIFO. To weight it, join order needs bucketing — a Gold customer
   beating someone who joined a minute earlier is fine, beating someone who joined last Tuesday
   is not. **The bucket width is the decision**, and your contract does not specify it.
5. **Standing reservations.** Your settings say VIP + Gold. We enforce **Gold + Royal**.
6. **Serial reschedule.** You want a `BOOKING_SERIAL_RESCHEDULE` refusal on the 4th move. We
   instead attach a 20% deposit automatically and send a link, leaving the booking in
   `PENDING_PAYMENT`. Ours is the better desk outcome; yours is what you have written error
   handling for.
7. **Goodwill rate.** `GOODWILL_PERCENT = 10` on an automatic salon cancellation is a
   placeholder that has never reached a real customer. The business needs to set it.
8. **`start` / `complete` / `settle`** — your §15 says Point of sale calls in. They are booking
   endpoints today. Who owns them?

---

## 10. Trying it

```bash
pnpm dev                     # docker compose + nest --watch on :3099
open http://localhost:3099/docs
```

Swagger is complete and every endpoint above is documented there with its rationale.

A staff token for local work (the platform signs with the same symmetric secret):

```js
jwt.sign(
  { sub: 'desk-1', roles: ['branch_manager'], branchId: 'marina-walk', tenantId: 'demo' },
  process.env.JWT_ACCESS_SECRET,
  { issuer: 'gostyle-api', expiresIn: '12h' },
)
```

`roles: ['branch_manager']` resolves to a **manager**; anything unrecognised resolves to
**staff**, which is deliberate — a role invented next month inherits the least power, not the
most.

---

## 11. What was verified, and how

Every endpoint in §§2–7 was called against a running server backed by a real Postgres, with data
created through the **real flow** (availability → hold → confirm), not inserted behind the
engine's back. Specifically confirmed:

- KPI arithmetic against known seed values: 9 bookings, AED 1,640, show-up 0.75, average
  ticket AED 182 — each matching the seed exactly.
- Both `move` paths, including reassignment from Reem to Anya with `moveCount` incrementing.
- The waitlist chain end to end: cancel → outbox event → listener → offer on the board with its
  15-minute TTL.
- Idempotent goodwill (same key twice → one entry, `replayed: true`, balance unchanged).
- **Series idempotency**: the same key returned the same `seriesId` with `replayed: true`,
  instead of a second year of standing appointments.
- Capture invalidating the payment link in the same transaction.
- **Shorten releasing real capacity**: booking, staff reservation and chair reservation all read
  30 minutes after a 45 → 30 shorten, so the 15 minutes are genuinely back in the diary.
- **Course draw maths**: AED 1,800 net over 6 visits drew AED 315 gross (AED 300 net + 5% VAT),
  leaving AED 1,575 — the draws sum back to the receipt.
- **Both new jobs driven against the real database**: the confirm-ask sweep expired a 49-hour-old
  ask and wrote its history row and event; the risk-flag sweep identified a customer with three
  clean visits and emitted `customer.deposit_flag_liftable`.
- Queue deletions are idempotent and never 404 — leaving twice, or leaving an unknown entry, both
  answer `{ "left": false }`.
- Skill and capacity refusals returning the right code plus actionable `details`.

Test suite: **1,107 passing, 11 todo, across 51 files** (up from 970 before this work).
`tsc --noEmit` and `eslint` both clean.

**Seven bugs were found by running it rather than reading it**, and all seven are fixed:

1. The events feed windowed on the visit's date instead of when the event happened, hiding
   exactly the events the screen exists to show.
2. The staff-name lookup missed, because the roster speaks slugs and the column holds a hash.
3. A 5-second Prisma transaction timeout killed a move mid-transaction.
4. `POST /v1/series` never read `Idempotency-Key`, so a retry made a second series.
5. Goodwill followed by revive credited the same forfeited deposit **twice** — the ledger was
   right about every row and the total was nonsense.
6. Shorten and waiver wrote `from == to` rows to the status history.
7. A reversal was written without naming what it reversed.

**Four of those were caught by the database's own constraints**, not by the code: a zero-amount
ledger row, an unlinked reversal, and the `bsh_actually_moved` check that refuses a status
history entry recording no movement. One more was caught by the repo's vocabulary test, which
spotted a lowercase enum that would have reached you as `"card"` instead of `"CARD"`.
