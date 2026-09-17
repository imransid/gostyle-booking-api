# FE contract audit — Bookings module contract (Draft v1)

The companion to [FE-CONTRACT-AUDIT.md](./FE-CONTRACT-AUDIT.md), which covered
`bookings-new.md` (frontend repo) — the fourteen creation endpoints. This one
covers **everything after creation**: lifecycle, conflicts, series, check-in, risk, walk-ins,
waitlist, ledger, and the seven screens' read models.

**Headline: the engine is largely built and the read surface is not.**

Almost every *rule* in this contract already exists in the domain, tested — the repair ladder,
the risk score, the cancellation bands, compaction, course draw-down, late capture, the reminder
ladder. What is missing is the layer the seven screens actually call: there is no list endpoint,
no calendar endpoint, no summary, no search and no event feed. A desk can do everything this
contract describes except *look at the day*.

The second theme is narrower and sharper: several behaviours are built, proven and **not routed**.
Drag-and-drop move, the check-in gates and the conflict worklist are all working code with no
URL in front of them.

---

## 0. Before the route map: two counting notes

Worth settling first, because both affect planning.

**The endpoint count is not 36.** Enumerating every path in §§6–16 gives **60** frontend-facing
endpoints, not the 36 in the header:

| § | Area | Endpoints |
| - | ---- | --------: |
| 6 | Read models | 7 |
| 7 | Lifecycle | 13 |
| 8 | Conflicts, scans, compaction | 8 |
| 9 | Events | 2 |
| 10 | Series | 8 |
| 11 | Check-in | 6 |
| 12 | Risk and merge | 4 |
| 13 | Walk-ins | 5 |
| 14 | Waitlist | 6 |
| 16 | Ledger | 1 |
| | **Total** | **60** |

**And the job count is not 3.** The header says three scheduled jobs; §18 lists six. Six is the
right number and we run five of them.

Neither is a criticism of the thinking — it is a planning input. Budget against 60 and 6.

---

## 1. Route map

Nothing in this contract is on the path it specifies. That is not as bad as it sounds: the
divergence is almost entirely a missing `bookings/` prefix, because our controllers were mounted
by aggregate (`/v1/waitlist`, `/v1/walk-ins`) rather than by screen.

### 1.1 Read models — §6

| They want | We have | Status |
| --------- | ------- | ------ |
| `GET /v1/bookings/summary` | — | **missing** |
| `GET /v1/bookings/worklist` | — | **missing** |
| `GET /v1/bookings/calendar/day` | — | **missing** |
| `GET /v1/bookings/calendar/week` | — | **missing** |
| `GET /v1/bookings/calendar/month` | — | **missing** |
| `GET /v1/bookings` (list + counts) | — | **missing** |
| `GET /v1/bookings/search` | — | **missing** |

Seven for seven. `GET /v1/bookings/{id}` exists and returns a good drawer payload; there is no way
to ask for **more than one booking at a time** anywhere in the API.

### 1.2 Lifecycle — §7

| They want | We have | Status |
| --------- | ------- | ------ |
| `POST /v1/bookings/{id}/remind` | — (scheduler only) | **missing endpoint**, ladder exists |
| `POST /v1/bookings/reminders/bulk` | — | **missing** |
| `POST /v1/bookings/{id}/reschedule/availability` | `GET /v1/availability` | different path, and see §3.1 |
| `POST /v1/bookings/{id}/reschedule/hold` | `POST /v1/holds` | different path |
| `POST /v1/bookings/{id}/reschedule` | `POST /v1/bookings/{id}/reschedule` | **same path** |
| `POST /v1/bookings/{id}/cancel` | `POST /v1/bookings/{id}/cancel` | **same path** |
| `POST /v1/bookings/{id}/move` | `RescheduleRepository.shiftInPlace()` | **built, not routed** |
| `POST /v1/bookings/{id}/no-show` | `POST /v1/bookings/{id}/no-show` | **same path** |
| `POST /v1/bookings/{id}/capture` | — | **missing** |
| `POST /v1/bookings/{id}/late-capture` | webhook path only | **logic exists**, no endpoint |
| `POST /v1/bookings/{id}/revive` | — | **missing** |
| `POST /v1/bookings/{id}/refund` | — | **missing** |
| `POST /v1/bookings/{id}/goodwill` | automatic only | **partial**, see §3.5 |

Three same-path. We also expose `start`, `complete` and `settle`, which this contract hands to
Point of sale (§15) — see §6.

### 1.3 Conflicts and compaction — §8

| They want | We have | Status |
| --------- | ------- | ------ |
| `GET /v1/bookings/conflicts` | `GET /v1/roster-changes/{id}` | **per-change, not branch-wide** |
| `POST /v1/bookings/{id}/conflict/resolve` | `POST /v1/roster-changes/{id}/items/{itemId}/resolve` | same idea, keyed differently |
| `POST /v1/bookings/conflicts/repair` | runs automatically at scan time | **different trigger** |
| `POST /v1/bookings/scans/staff-off` | `POST /v1/roster-changes` `kind=SHIFT_CONFLICT` | one endpoint, three kinds |
| `POST /v1/bookings/scans/resource` | `POST /v1/roster-changes` `kind=CHAIR_OUT_OF_SERVICE` | as above |
| `POST /v1/bookings/scans/closure` | `POST /v1/roster-changes` `kind=CLOSURE_SWEEP` | as above |
| commit gate / `BOOKING_SCAN_PENDING` | `POST /v1/roster-changes/{id}/commit` | **enforced by a DB trigger** |
| `GET /v1/bookings/compaction` | `GET /v1/compaction` | prefix only |
| `POST /v1/bookings/compaction/apply` | `POST /v1/compaction/apply` | prefix only |

This is the best-covered section in the contract. See §2.

### 1.4 Events, series, check-in, risk — §§9–12

| They want | We have | Status |
| --------- | ------- | ------ |
| `GET /v1/bookings/events` | — | **missing** (per-booking history exists) |
| `GET /v1/bookings/events/{id}` | — | **missing** |
| `GET /v1/bookings/series` (list) | — | **missing** (detail exists) |
| `GET /v1/bookings/series/{id}` | `GET /v1/bookings/series/{id}` | **same path** |
| `POST .../series/{id}/confirm-ask` | — | **missing endpoint**, the 48 h window exists |
| `POST .../series/{id}/skip` | `POST /v1/series/{id}/occurrences/{oid}/skip` | keyed by id, not index |
| `POST .../series/{id}/pattern` | `GET /v1/series/{id}/occurrences/{oid}/edit-scope` | **plan only, no write** |
| `POST .../series/{id}/pause` | `POST /v1/series/{id}/pause` + `/resume` | ours is two verbs |
| `POST .../series/{id}/end` | `POST /v1/series/{id}/end` | prefix only |
| `POST .../series/{id}/course-draw` | domain only | **built, not routed** |
| `GET /v1/bookings/{id}/check-in` (gates) | `canCheckIn()` in the domain | **built, not routed** |
| `POST /v1/bookings/{id}/check-in` | `POST /v1/bookings/{id}/check-in` | **same path**, no gates, no chair |
| `POST .../check-in/undo` | — | **missing** |
| `POST .../patch-test` | — | **missing** |
| `POST .../waiver` | — | **missing** |
| `POST .../shorten` | — | **missing** |
| `GET /v1/customers/{id}/risk` | `assessRisk()` in the domain | **built, not routed** |
| `POST/DELETE /v1/customers/{id}/require-deposit` | flag is *read* by the ladder | **no writer** |
| `POST /v1/customers/merge` | — | **missing** |

There are **no `/v1/customers` routes at all**. The customer is a port we read through
(`CustomerContextReader`), currently backed by a five-person fixture.

### 1.5 Walk-ins, waitlist, ledger — §§13–16

| They want | We have | Status |
| --------- | ------- | ------ |
| `GET /v1/bookings/walk-ins` | `GET /v1/walk-ins` | prefix only |
| `POST /v1/bookings/walk-ins` | `POST /v1/walk-ins` | prefix; see §4.4 on phone matching |
| `POST .../walk-ins/{id}/seat` | `POST /v1/walk-ins/{id}/seat` | prefix only |
| `POST .../walk-ins/{id}/offer` | — | **missing** |
| `DELETE .../walk-ins/{id}` | `POST /v1/walk-ins/{id}/leave` | verb differs |
| `GET /v1/bookings/waitlist` | — | **missing** (no list read) |
| `POST /v1/bookings/waitlist` | `POST /v1/waitlist` | prefix only |
| `POST .../waitlist/{id}/offer` | automatic on a freed slot | **different trigger** |
| `POST .../waitlist/{id}/accept` | `POST /v1/waitlist/{id}/accept` | prefix only |
| `POST .../waitlist/{id}/decline` | `POST /v1/waitlist/{id}/decline` | prefix only |
| `DELETE .../waitlist/{id}` | — | **missing** |
| `GET /v1/bookings/{id}/ledger` | nested in `GET /v1/bookings/{id}` | **covered, not separate** |

### 1.6 Webhooks and jobs — §§17–18

| They want | We have | Status |
| --------- | ------- | ------ |
| `POST /v1/webhooks/payments` | `POST /v1/webhooks/payments` | **same path**, signed and idempotent |
| `POST /v1/webhooks/messaging` | — | **missing** — nothing delivers messages yet |
| Series materialiser, nightly | `@Cron('0 2 * * *')` | **runs** |
| Automatic no-show, every minute | `@Interval` 60 s | **runs** |
| Hold and offer expiry, every 15 s | two `@Interval`s at 30 s | **runs**, half the cadence |
| Confirm-ask expiry, hourly | — | **missing job**, the 48 h rule exists |
| Reminder scheduler, hourly | `@Interval` 60 s | **runs**, more often than asked |
| Risk flag expiry, nightly | — | **missing** |

> The previous audit said the materialiser "exists, but on demand, not scheduled". That is now
> out of date: `series-materialiser.service.ts` runs it at 02:00 nightly. The on-demand
> `POST /v1/series/{id}/materialise` is still there as well.

---

## 2. Where we are already there

Five subsystems in this contract are not gaps. They are built, unit-tested and in several cases
solve the exact problem the contract raises, in the words the contract uses.

**The repair ladder — §8.4.** Four rungs, in order: same minute with a different eligible
professional; ±15/±30/±45; any start in the same day-part; release with goodwill. That is
`domain/availability/disruption-ladder.ts`, rung for rung, with `DISRUPTION_SHIFT_STEPS_MIN =
[15, 30, 45]`. One deliberate difference: **rung 4 does not fire, it is proposed.** The code's
reason is that "cancelling a paying customer is not something a roster edit should do while
nobody is looking", which is why the commit gate exists at all.

**The commit gate — §8.5.** "A roster edit that would strand bookings must not commit until the
worklist is empty." We enforce that with a **constraint trigger in Postgres**, not an application
check, so a caller that ignores the gate is refused by the database.

**Diary compaction — §8.6.** Every hard constraint they list is already a named constant:
`MAX_MOVES = 3`, `MAX_MOVE_MIN = 30`, `MIN_SELLABLE_MIN = 25` for the sliver threshold, and an
`Ineligibility` union of exactly `not_confirmed | group_lane | series_occurrence`. Apply
recomputes the plan and re-validates each move against the live masks, skipping stale ones —
their "re-validated at that moment, not at plan time".

**The rolling risk score — §12.1.** Identical, to the constant:
`80 − 30·noShows − 15·lateCancels + 2·min(visits, 10)`, clamped to `[0, 100]`, `≥75 LOW`,
`≥45 WATCH`, else `HIGH`. The contract's own worked example (two no-shows, four visits, score 28)
is a fixture in our test suite.

**Late capture and refund rails — §§7.7, 7.9.** Money arriving after the window runs the exact
decision they describe: reinstate if the slot survived, full refund if it was resold. A bounced
card refund credits the wallet and the code carries the sentence *"Nothing is marked refunded
until money actually moves"* — which is also the sentence in their §7.9 table.

Two more worth naming: the **course draw-down** recognises VAT per draw rather than at sale
(§10.5), using largest-remainder allocation so the draws sum back to the receipt; and the
**deposit ledger is append-only, enforced by a database trigger**, with signed amounts, exactly as
§16.2 requires.

---

## 3. Where our rules and theirs genuinely disagree

These are not renames. Each one changes what a customer is charged or who gets a slot, and each
needs a decision rather than a patch.

### 3.1 The reschedule deposit — `DECISION`

They say the deposit **carries to the successor untouched**, unconditionally.

Ours carries it *within policy* and **forfeits it inside the two-hour window**, re-quoting the new
time — `rescheduleOutcome()` treats a late move as a late cancel plus a new booking. A customer
moving a booking ninety minutes before the start loses their deposit with us and keeps it with
them.

This is the largest money divergence in the contract. It is also arguable in both directions:
theirs is kinder and simpler, ours stops a late move being a free way out of a late-cancel fee.

### 3.2 The cancellation matrix, middle band — `DECISION`

Their matrix says 2–24 h → `DEPOSIT_KEPT`, for any deposit state. Ours agrees **for a deposit**
and splits **50/50 for a booking paid in full**, on the reasoning that the salon has less chance
to resell but the customer paid for the whole visit.

Their matrix has no cell for a fully-prepaid booking. It needs one, and the FE needs a fifth
outcome to render (`PARTIALLY_REFUNDED`) if ours is kept.

We also have a band they do not: `salon_initiated` refunds in full regardless of timing. That is
their §8.3 `SALON_CANCEL` behaviour, already implemented, just reached through cancel rather than
through conflict resolution.

### 3.3 Waitlist ranking — `DECISION`

Their §14.2 wants join order **weighted** by a tier boost (ROYAL/VIP +2, GOLD +1.5, SILVER +1)
and window fit.

Ours is strict FIFO with tier and fit as tie-breaks — and the code says, in a comment, that those
tie-breaks **can never fire**, because millisecond join timestamps never tie. It was written that
way on purpose: the original spec ranked by join order first, and "changing who gets offered a
slot is a business decision, not a coding one."

Their weighted formula is the conversation that comment was waiting for. To implement it, join
order needs bucketing — a Gold customer who joined an hour ago should presumably beat a
no-tier customer who joined a minute ago, but not one who joined last Tuesday. **The bucket
width is the decision**, and the contract does not specify it.

### 3.4 Standing-reservation tiers — `DECISION`

Settings in their companion document say `standingRequiresTiers: ["VIP", "GOLD"]`. Ours is
**Gold and Royal**, and it *is* enforced — `mayHoldStandingReservation()` is called on series
create and rejects anyone else.

(The previous audit said this gate was not enforced. That is now out of date.)

So the sets disagree on two tiers in both directions. Ours also has no `COURSE_PREPAID` or
`FULL_PAYMENT` confirm rule; we have three where they have five.

### 3.5 Goodwill — `DECISION`, and the rate is unset

Their §7.10 goodwill is a **manager action**: credit a forfeited deposit toward a rebook without
reversing the forfeit.

Ours is **automatic and structural**: a salon cancellation at rung 4 of the repair ladder posts a
goodwill credit at `GOODWILL_PERCENT = 10`. The code is explicit that the shape is settled and
**the rate is a placeholder awaiting a business decision** — it has never been near a real
customer.

Both should probably exist. They are different events: theirs is discretionary, ours is
compensation for a salon-caused cancellation.

### 3.6 Serial reschedule — smaller, but the FE branches on it

Their `moveCount >= 3` rule makes the booking desk-only and a deposit mandatory, surfaced as
`BOOKING_SERIAL_RESCHEDULE` (409).

Ours fires at the same point — `SERIAL_MOVE_THRESHOLD = 4`, meaning the fourth move — but does
**not refuse**. It attaches a 20% deposit and sends a payment link, and the booking sits in
`pending_payment` until it is paid. We also do not make it desk-only.

Ours is the better outcome for the desk; theirs is the one the FE has written error handling
for. Pick one.

---

## 4. Shape and vocabulary

### 4.1 The `Booking` object — §5.1

Their payload is a **screen-ready row**; ours is a **record**. Everything they need about the
booking itself is there; everything about the people around it is not.

| Their field | Ours | Verdict |
| ----------- | ---- | ------- |
| `id`, `code`, `status` | `bookingId`, `code`, `status` | match, shouted enum |
| `date`, `startTime`, `startsAt`, `durationMinutes` | `tradingDay`, `start`, `startAt`, `durationMin` | **all three sent already** |
| `price`, `payment.deposit` | `priceMinor`/`price`, `depositMinor`/`deposit` | **minor units, see §5** |
| `payment.requirement.source` | `requirementSource` | match, prose not enum |
| `moveCount` | `moveCount` | **match** |
| `overbook` | `overbooked` + `overbookReason` | columns exist — **nothing writes them** |
| `recurring.seriesId` | — | occurrence links to booking, not back |
| `services[]` with `processingWindow` | `items[]`; `ProcessingBand {fromMin,toMin}` on the service | **the band exists**, not on the booking payload |
| `customer{name,phone,tier,visits,...}` | `customerId` | **join not made** |
| `staff{id,name}` | `items[].staffId` | **join not made** |
| `chair` | — | missing |
| `startedAt`, `pausedAt` | — | missing (status history has the instants) |
| `reminded` | `reminded24hAt` / `reminded3hAt` / `nudged15mAt` | ours is strictly richer |
| `note`, `extras[]`, `gate`, `conflict`, `group` | — | missing |
| — | `ledger[]`, `history[]` | **ours, and worth keeping** |

The names exist on the platform side already — `grpc-staff-directory` and
`grpc-services-directory` are wired. The joins are work, not research.

### 4.2 Statuses

They model ten; we have fourteen. Nine map cleanly. The differences:

- `PENDING_CONFIRM` ↔ `pending_confirmation`; `SETTLED` ↔ `settled`; the rest are 1:1 uppercase.
- **We have four they do not**: `draft`, `held`, `rescheduled`, `skipped`. `held` and `draft` are
  pre-creation and arguably never leave the API; `rescheduled` and `skipped` will reach a screen.
- Their `IN_SERVICE` we have; they have no equivalent of our `BLOCKING_STATES` / `RELEASING_STATES`
  distinction, which is what decides whether a row still occupies a chair.

`payment.state` (`NONE`/`PENDING`/`PAID`/`FULL`) maps onto our eight-value `PaymentStatus`; ours
splits `partially_refunded`, `refunded`, `forfeited` and `settled` where theirs has none.

### 4.3 Ledger kinds — §16.1

Six of their eight already exist, one to one:

| Theirs | Ours |
| ------ | ---- |
| `DEPOSIT_HELD` | `captured` |
| `APPLIED_AS_TENDER` | `applied_at_pos` |
| `REFUNDED` | `refunded` |
| `FORFEITED` | `forfeited` |
| `GOODWILL_CREDIT` | `goodwill` |
| `COURSE_DRAW` | `course_draw` |
| `INTENT_CREATED` | — (no intents exist; see the previous audit §2.1) |
| `COURSE_PREPAID` | — |

We also have `partially_refunded` and `reversed`, which their enum cannot express.

### 4.4 Smaller shape notes

- **Group** maps cleanly: `organiser_pays_all`/`split_equally`/`each_pays_own` ↔ `ORGANIZER`/
  `SPLIT`/`OWN`; `arrive_together`/`finish_together` ↔ `mode`. Note the spelling — we are British
  (`organiser`), they are American (`ORGANIZER`).
- **Walk-ins**: `waitingMin` ↔ `waitedMinutes`, and the live `quote` comes from the same
  availability engine the wizard uses, which is exactly their requirement. What is missing is
  their identity rule — we take a `customerId` **or** a `guestName`; we never take a phone and we
  never match one, so "a matching phone attaches to the existing customer" is not implemented.
- **Occurrence state**: ours is `planned | materialised | needs_attention | skipped | detached`.
  Theirs adds `COMPLETED`, `UPCOMING`, `AWAITING_CONFIRM` — all three derivable from the
  underlying booking — and demotes `detached` from a state to a flag. Their four occurrence flags
  (`monthEndFallback`, `detached`, `courseDraw`, `priceSnapshot`) all have machinery behind them;
  only `detached` is currently exposed.

---

## 5. Cross-cutting

### Money is the opposite way round from the other contract

This is the one that will bite hardest, and it is new.

`bookings-new.md` (frontend repo) specifies **minor units** (`priceMinor: 48000`),
which matches us exactly. This contract specifies **whole AED as a `number`** (`"price": 480`) and
explicitly says an integer minor-unit field "is **not** wanted here" — except in the ledger, which
gets two decimals.

We are integer fils everywhere, by rule (CLAUDE.md 2), and columns are `INTEGER` and `_fils`-
suffixed. We are not going to carry AED floats into the domain. So this is a **presentation
decision at the edge**, and it needs to be one decision, not two: the same booking cannot be
`priceMinor: 48000` in the creation flow and `price: 480` in the list.

My recommendation: keep `priceMinor` as the wire truth on both, and add an AED mirror if the FE
wants one. A float that has to round-trip is how deposits end up a fil short.

### There is still no `X-Branch-Id`, and now CORS blocks the tenant header too

Unchanged since the last audit: **no route reads `X-Branch-Id`**. Branch arrives as a body or
query field, defaulting to `marina-walk` in several places. A header that is ignored rather than
rejected fails open, which is the opposite of their rule 2.

New and worse: `X-Tenant-Id` *is* read server-side, but the CORS allowlist is
`['Content-Type', 'Authorization', 'Idempotency-Key']`. **A browser cannot send either header
today** — the preflight rejects it before the request leaves. The comment right above that array
warns about precisely this failure mode for `Idempotency-Key`. If the FE adopts these headers,
both go in the allowlist in the same change.

`X-Tenant-Id` is also still captured-but-not-filtered. Do not build UI that assumes isolation.

### `Idempotency-Key` is honoured on exactly one route

The contract marks ⚿ on about 25 endpoints. We read the header on `POST /v1/bookings` and nowhere
else. `POST /v1/series` still ignores it.

Every money-moving endpoint in §7 — capture, refund, goodwill, revive, late-capture — is new work,
so idempotency can be built in rather than retrofitted. That is the cheap moment and it is now.

### There are no error codes and no `details`

§19 lists 17 codes. We emit Nest's default envelope — `{ statusCode, message, error }` — with a
prose message and **no machine-readable code anywhere**. There is no global exception filter.

The status codes themselves are mostly right (409 for contention, 410 for a lapsed hold, 403 for
actor refusals), and the prose is often better than the code would be — *"Every styling station is
taken at 12:40 (3 of 3 in use)"*. The fix is to add a `code` and a `details` alongside the prose,
not to replace it. One filter, one enum, and each throw site names its code.

This was `SMALL` in the previous audit for six availability codes. Across 17 codes and ~60
endpoints it is `MEDIUM`, and it is the single change that most improves what the FE can do
without asking us.

### Permissions are still coarse

They want `bookings.read` / `update` / `delete` / `create` plus a manager role on nine actions. We
resolve an actor to `customer | staff | manager` and have a `@DeskOnly()` decorator. Manager-only
is expressible today; scoped permissions are not.

The two new permission module ids they flag (`bookings-walk-ins`, `bookings-waitlist`) are a
platform seed change, not ours.

### Nothing is per-branch

§7.3 calls the policy matrix "branch-configurable, defaults shown". §11.1 returns `graceMinutes`
per booking. Our settings endpoint is explicit that it is **not a configuration surface**: there
is no branch table, `DEFAULT_BRANCH` is the only instance, and every one of these values is a
constant imported from the module that owns it.

The values themselves match: grace 15, VIP grace 20, auto-no-show at +30, check-in opens at −30,
free-cancel 24 h, late-cancel 2 h, sliver 25 min, waitlist offer TTL 15 min. Good numbers, wrong
storage. Making them configurable is a branch-table project, not an endpoint.

### Realtime does not exist

§20 wants five events pushed over a socket in under 200 ms. We have a **transactional outbox** —
`booking.confirmed`, `booking.rescheduled`, `waitlist.offered`, `group.confirmed`,
`occurrence.materialized`, `roster_change.committed` and more, written in the same commit as the
change and relayed at-least-once.

The event stream they need is therefore already produced and already correct. What is missing is
the transport: `EventPublisher` is currently `LoggingEventPublisher`, which writes to the log.
There is no Redis, no BullMQ, no socket, and `src/infrastructure/realtime/` is an empty directory.

Their names map onto ours nearly one to one. This is a delivery project, not a modelling one.

### Notifications remain out of scope

Quiet hours (09:00–21:00), WhatsApp templates, the `messageLog` in §9.2, the consent asks in
§8.6, delivery receipts in §17 — none of it exists, and **there is no quiet-hours concept anywhere
in the codebase**. The reminder ladder decides *which* message is due and records that it fired;
nothing sends anything.

Note one consequence: §8.6 compaction says "nothing moves without a yes", and our apply endpoint
takes the booking codes that already agreed. The consent *ask* has no sender.

---

## 6. What we have that this contract does not mention

- **`start` / `complete` / `settle`** as booking lifecycle endpoints. §15 assigns these to Point
  of sale, calling in. They exist here today, which means the seam is currently on our side of the
  line and someone has to move it.
- **`requirement.trace`** — the full deposit ladder, rung by rung, on every quote.
- **Per-booking `history[]`** — every status change with actor, reason and instant. This is most of
  what §9's event feed needs; it is per-booking rather than per-branch.
- **`passedOver`** on a waitlist offer — who wanted this slot, and the reason each one missed it.
  Their §14 has no equivalent, and it is the answer to "why wasn't I offered that?".
- **Decline cap** — three declines and offers stop for that window, so one customer holding out
  cannot absorb every freed slot.
- **Group exit and `active_count`** — a party losing one member is handled; their §5.1 `group`
  object has no notion of it.
- **The database as the last word** — GiST `EXCLUDE` on resource reservations, the deferred group
  size trigger, the append-only ledger trigger, the roster-change commit trigger. Several rules in
  this contract cannot be bypassed even by our own code.

---

## 7. What I would do, in order

**1. The read models — 4 to 6 days, and it unblocks all seven screens.**
`GET /v1/bookings` with filters and counts first, then `calendar/day`, then `week`/`month`, then
`summary`, `worklist` and `search`. Nothing here needs new domain logic; it needs projections and
joins. The index the calendar wants — `(branch_id, trading_day, status)` — already exists.

Two caveats worth planning for: `utilisation` must be computed against **sellable** minutes, and
we have no time-off model — `Shift` is a single `{startMin, endMin}` and breaks are passed as
opaque bookings. Their `columns[].timeOff[]` has no source today.

**2. Route the three things that are already built — 1 day.**
`POST /v1/bookings/{id}/move` over `shiftInPlace()`; `GET /v1/bookings/{id}/check-in` over
`canCheckIn()`; `GET /v1/customers/{id}/risk` over `assessRisk()`. All three are tested domain
code with no URL. `shiftInPlace` changes *when*, never *who*, so a column-to-column drag needs
reassignment added — the `move()` path already does that, so it is a merge of two existing methods.

**3. Error codes and a `details` envelope — 2 days.**
One exception filter, one code enum, `code` and `details` alongside the existing prose. Availability
failures carry the refreshed offers. Do this before the read models ship, so the FE branches on
codes from day one rather than on strings it will have to unlearn.

**4. Path aliases — half a day.**
`/v1/waitlist`, `/v1/walk-ins`, `/v1/compaction`, `/v1/series` and `/v1/roster-changes` gain
`bookings/`-prefixed aliases. Routing, not logic. Worth doing in the same pass as (1) so the
screens only ever see one surface.

**5. The money endpoints — 3 to 4 days.**
`capture`, `refund`, `goodwill`, `revive`, `late-capture`. Each writes exactly one ledger entry and
returns its id, each takes `Idempotency-Key`, each is manager-gated. The ledger, the rails and the
append-only trigger are all in place; this is the endpoint layer over them.

**6. The event feed — 2 days.**
§9 over the status-history rows we already write, plus the policy maths for the detail drawer.
`recoveredByCode` needs attribution at the point the freed slot is resold — the waitlist already
knows, so capture it there rather than inferring it later.

**7. Customer endpoints — needs a decision first.**
`require-deposit`, the 3-settled-visit expiry, and merge. The flag is *read* by rung 2 today and
nothing writes it. But the customer record lives in another service, and merge re-points bookings
through a map — that is an owner question before it is an estimate.

**8. Series writes — 2 to 3 days.**
`pattern` with scope (the `EditScope` union and its plan already exist — only the write is
missing), `course-draw`, `confirm-ask`, and the hourly confirm-ask expiry job.

**9. Realtime — needs an infrastructure decision.**
The events are produced and correct. Swapping `LoggingEventPublisher` for a real transport is one
provider; picking the transport is not our call.

**10. Waitlist ranking, once §3.3 is answered.** Small once the bucket width is decided.

Notifications, quiet hours and the messaging webhook stay out of scope.

---

## 8. Decisions I need from you

1. **Money on the wire — minor units or whole AED?** This contract and bookings-new.md disagree
   with each other. One answer, both documents. (§5)
2. **Does a deposit survive a late reschedule?** Yours says always; ours forfeits inside two
   hours. This changes what customers are charged. (§3.1)
3. **What happens to a fully-prepaid booking cancelled 2–24 h out?** Your matrix has no cell for
   it; ours splits 50/50. (§3.2)
4. **Waitlist ranking — FIFO or tier-weighted, and if weighted, what bucket width?** A Gold
   customer beating someone who joined a minute earlier is fine; beating someone who joined last
   Tuesday is not. (§3.3)
5. **Standing reservations — VIP+Gold (yours) or Gold+Royal (ours)?** Both are enforced; they
   disagree on two tiers. (§3.4)
6. **Serial reschedule — refuse with `BOOKING_SERIAL_RESCHEDULE`, or auto-attach the deposit and
   send a link (ours)?** (§3.6)
7. **Goodwill rate.** `GOODWILL_PERCENT = 10` is a placeholder that has never reached a customer
   and is waiting on the business. (§3.5)
8. **`X-Branch-Id` and `X-Tenant-Id` — adopt the headers?** If yes, they go in the CORS allowlist
   in the same change, or the browser silently cannot send them. (§5)
9. **Who owns `start` / `complete` / `settle`?** §15 says Point of sale calls in. They are booking
   endpoints today. (§6)

---

## 9. How this was checked, and its limits

Every claim above was read out of the source on branch `feat/platform-directories` at `8531532`,
and the file and symbol are named wherever the claim is load-bearing. The domain claims — the
ladder rungs, the risk formula, the cancellation bands, the compaction constraints, the course
draw-down — are backed by the test suite, which runs green: **970 passing, 11 todo, across 45
files**.

**Nothing here was verified against a running server.** Docker was not available in this session,
so unlike the previous audit there is no live column. That matters most for the route map: a route
that exists in a controller is asserted to exist, not observed to answer. The statements I would
most want to re-check live are the ones in §1 marked *same path*, and the CORS claim in §5.

Two findings in the previous audit are now **out of date** and are corrected here: the series
materialiser *is* scheduled nightly, and the standing-reservation tier gate *is* enforced.
