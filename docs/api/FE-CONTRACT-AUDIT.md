# FE contract audit — New Booking Flow (Draft v2)

What we already have, what is named differently, and what genuinely is not built.
Every line below was checked against the code, and the live claims were run against a
running server.

**Headline: the shape is right, the vocabulary is not, and four things are genuinely missing.**

Nine of their sixteen routes already exist on the exact path they specify. Most of the rest is
naming and representation — the same information under a different key. The real work is four
subsystems, and one of those (notifications) is explicitly out of our scope.

---

## 1. Route map

| # | They want | We have | Status |
| - | --------- | ------- | ------ |
| 1 | `GET /v1/bookings/settings` | `GET /v1/bookings/settings` | **same path** |
| 2 | `GET /v1/bookings/services` | `GET /v1/availability/catalogue` | different path |
| 3 | `GET /v1/bookings/eligible-staff` | `GET /v1/bookings/eligible-staff` | **same path** |
| 4 | `GET /v1/bookings/availability` | `GET /v1/availability` | different path |
| 5 | `POST /v1/bookings/availability/group` | `POST /v1/bookings/availability/group` | **same path** |
| 6 | `POST /v1/bookings/holds` | `POST /v1/holds` **+** `POST /v1/groups/holds` | different path, and split in two |
| 7 | `DELETE /v1/bookings/holds/{id}` | `DELETE /v1/holds/{id}` | different path |
| 8 | `POST /v1/bookings/quote` | `POST /v1/bookings/quote` | **same path** |
| 9 | `POST /v1/bookings` (SINGLE *or* GROUP) | `POST /v1/bookings` **+** `POST /v1/groups/{id}/confirm` | single matches; **group is a different endpoint** |
| 10 | `GET /v1/bookings/{id}` | `GET /v1/bookings/{id}` | **same path** |
| 11 | `POST /v1/bookings/{id}/payment-link` | `POST /v1/bookings/{id}/payment-link` | **same path** |
| 12 | `POST /v1/bookings/series/preview` | `POST /v1/bookings/series/preview` | **same path** |
| 13 | `POST /v1/bookings/series` | `POST /v1/series` | different path |
| 14 | `GET /v1/bookings/series/{id}` | `GET /v1/bookings/series/{id}` | **same path** |
| — | `POST /v1/webhooks/payments` | `POST /v1/webhooks/payments` | **same path** |
| — | nightly materialiser | `POST /v1/series/{id}/materialise` | exists, but **on demand, not scheduled** |

Five paths differ. All five are aliasable in an afternoon — the handlers already exist and are
proven. Nothing about the path list is hard.

---

## 2. The four things that are genuinely missing

These are the ones that need building, not renaming.

### 2.1 Payment intents — `LARGE`

They expect `POST /v1/bookings` to return a `paymentIntent` with `intentId`, `clientSecret`,
`status` and `expiresAt`, and to accept `method: CARD | WALLET | CASH | LINK | NONE`.

We **consume** an `intentId` on the webhook but we never **create** one. There is no gateway
integration, no client secret, and no intent lifecycle. We have a payment *link* and a
`payment` object on confirm carrying `rail` and `amountMinor`.

This is their open question 4, and the answer is: no provider is wired. Until one is, the FE
cannot render a card sheet. This is the single biggest gap and it blocks their payment step.

### 2.2 Machine-readable blocker codes — `SMALL`

They need six codes to branch on: `NO_ELIGIBLE_STAFF`, `STAFF_OFF_SHIFT`,
`STAFF_FULLY_BOOKED`, `RESOURCE_FULL`, `BRANCH_CLOSED`, `OUTSIDE_LEAD_WINDOW`.

We return **prose per professional** and no codes at all:

```json
"refusals": [
  { "id": "reem", "name": "Reem S.", "reason": "does not hold the required skills: color" }
]
```

The information mostly exists; the vocabulary does not, and there is no day-level blocker
(`BRANCH_CLOSED`, `RESOURCE_FULL`) at all. Their rule — "empty availability always carries at
least one blocker code" — is not met today.

### 2.3 `GROUP_MINIMUM` deposit rule — `SMALL`

Their ladder has seven rungs. We have six of them. `GROUP_MINIMUM` (a group booking must take
at least `deposit.groupPct` of the party total) does not exist, and there is no `groupPct`
constant. Everything else maps — see §4.

### 2.4 Notifications — `OUT OF SCOPE`

`notifications[]` on the booking, the WhatsApp ask for `ASK_EACH_TIME`, the 48-hour reminder.
We do not build notifications and are not going to here. The **state machine** behind
`ASK_EACH_TIME` is worth checking separately from the delivery.

---
## 3. Settings — key by key

23 keys in their `GET /v1/bookings/settings`. We return 9 with the same value under a different
name, 7 differ in representation or value, and 7 we do not return at all.

| Their key | Want | Our key | Ours | Verdict |
| --------- | ---- | ------- | ---- | ------- |
| `currency` | AED | `money.currency` | AED | **match** |
| `minLeadMin` | 15 | `channels.DESK.leadMin` | 15 | match, renamed |
| `maxLeadDays` | 90 | `horizons.bookingDays` | 90 | match, renamed |
| `deposit.floorMinor` | 1000 | `money.depositFloorMinor` | 1000 | **match** |
| `deposit.ceilingMinor` | 50000 | `money.depositCeilingMinor` | 50000 | **match** |
| `deposit.firstVisitPct` | 20 | `money.firstVisitPercent` | 20 | **match** |
| `deposit.peakWindow.minPct` | 20 | `money.peakEscalationPercent` | 20 | **match** |
| `deposit.peakWindow.from` / `.to` | 17:00 / 20:00 | `peakWindow.fromMin` / `.toMin` | 1020 / 1200 | **same values**, minutes not "HH:MM" |
| `group.minGuests` | 2 | `groups.minParticipants` | 2 | **match** |
| `series.horizonDays` | 70 | `horizons.seriesDays` | 70 | **match** |
| `vatPct` | 5 | `money.vatPercent` | 5 | **match** |
| `slotGrainMin` | 15 | `channels.{DESK,ONLINE}.grainMin` | 5 / 15 | **ours is per channel** — desk 5, online 15 |
| `holdTtlSec` | 600 | `holds.ttlMs` | 900000 (15 min) | **differs — deliberate**, see §6 |
| `group.maxGuests` | 6 | `groups.maxParticipants` | 8 | ours is more permissive |
| `timezone` | Asia/Dubai | — | — | **missing** (hardcoded `BRANCH_TIMEZONE`) |
| `openingHours[]` | per weekday | — | — | **missing** (we return one flat `tradingWindow`) |
| `dayParts[]` | MORNING/AFTERNOON/EVENING | — | — | **missing** |
| `deposit.groupPct` | 20 | — | — | **missing** (no `GROUP_MINIMUM` rule) |
| `group.finishWindowsMin` | [0,15,30] | — | — | not advertised — but **the input exists** |
| `group.maxStaggerMin` | 30 | — | — | not advertised — but **the input exists** |
| `series.standingRequiresTiers` | ["VIP","GOLD"] | — | — | **missing**, and the gate is not enforced |

Two of those "missing" are only missing from the *response*: `finishWindowMin` and
`maxStaggerMin` are already accepted on `POST /v1/groups/holds`. Publishing them in settings is
a one-line change.

`slotGrainMin` is the one to decide, not to fix. We grain by channel — 5 minutes at the desk,
15 online — because a desk agent can book a 10:05 start and a customer on the web should not
see that granularity. Their single number assumes one grid.

---

## 4. The deposit ladder — six of their seven rungs already exist

This is the most detailed part of their contract and it maps almost exactly onto ours.

| # | Their rule | Our rung | Verdict |
| - | ---------- | -------- | ------- |
| 1 | `MANAGER_OVERRIDE` | `1 Manual override` | **covered** |
| 2 | `CUSTOMER_RISK` | `2 Customer risk` | **covered** |
| 3 | `GROUP_MINIMUM` | — | **missing** |
| 4 | `SERVICE_RULE` | `3 Service-level setting` | **covered** |
| 5 | `FIRST_VISIT` | `4a First-visit rule` | **covered** |
| 6 | `PEAK_WINDOW` | `4b Peak window` | covered — **but different semantics**, below |
| 7 | `NONE` | `5 Channel default` / `6 Branch default` → "No deposit required" | **covered** |

We also have two rungs they do not: a **channel default** and a **branch default**. Those are
additive and harmless.

**Strictest-wins matches.** Their "evaluate in order, strictest wins, then clamp to
[floor, ceiling]" is exactly our `rungs.reduce((a, b) => stricter(b, a) ? b : a)` followed by
`clamp()`. Same algorithm.

**One real semantic difference: peak window.** Theirs is a *floor* — peak means "at least
`minPct`", competing with the other rungs on strictness. Ours is an *escalator* applied
**after** the winner is chosen: it moves the result up a level, so no-deposit becomes a
deposit and **a deposit becomes payment in full**. Ours can therefore demand 100% where theirs
would demand 20%. That needs a decision, not a rename.

**`rule` is prose here, an enum there.** They want `deposit.rule: "SERVICE_RULE"` to switch on.
We return `requirementSource: "Service rule 50% (Full color and gloss)"` plus the full
`requirement.trace`. Ours carries strictly more information but nothing machine-readable. Adding
a `rule` enum alongside the prose is small and worth doing — it is what their support screen
branches on.

---
## 5. Their eight open questions, answered

| # | Question | Answer |
| - | -------- | ------ |
| 1 | Does a resource/chair registry exist? | **Yes, and it is enforced in the database.** `resource_reservation` with a `resource_type`, a GiST `EXCLUDE` constraint, and per-type unit counts. A real refusal reads *"Every styling station is taken at 12:40 (3 of 3 in use)."* Kernel rule 6 is live, not aspirational. |
| 2 | Where do buffers live? | **On the service**, as you assumed. Whether the merge is larger-claim-wins is confirmed in §6 below. |
| 3 | Is `reference` generated by the API? | **Partly.** Bookings get `GS-1058` from a Postgres sequence (`booking_code_seq`) — so stop inventing them client-side. But group children get plain sequential codes (`GS-1414`, `GS-1415`), **not** `GS-1047A/B`, the group row has **no human reference at all**, and series have **no reference scheme** — there is no `GS-S3058`. |
| 4 | Which payment provider, and the four methods? | **None is wired.** See §2.1. We accept a `rail` of `WALLET \| CARD \| APPLE_PAY \| CASH \| LINK` on confirm and we consume gateway webhooks, but we never create an intent. |
| 5 | Risk band source for `CUSTOMER_RISK`? | The rung exists and evaluates (`"score 100, LOW band"` appears in a live trace), so the ladder is wired end to end. What feeds the score is worth a separate look before you rely on it. |
| 6 | Hold TTL under contention? | Ours is **15 minutes**, not 10 — a deliberate divergence recorded in the code. Worth the conversation you flagged; a group hold blocking several chairs for 15 minutes on a Saturday is a real cost. |
| 7 | Group guests without a record? | **Your assumption is right** — we keep a `guest_name` on the participant, no shell customer. A database CHECK enforces customer-or-guest. So such a guest cannot be sent their own link, exactly as you predicted. |
| 8 | Series horizon vs lead window? | **70 and 90**, matching your numbers: `horizons.seriesDays: 70`, `horizons.bookingDays: 90`. |

---

## 6. Cross-cutting

### `X-Branch-Id` does not exist

You require it on every route. **There is no such header anywhere in the codebase.** Branch
arrives as a `branchId` (or `branch`) field in the body or query, defaulting to `marina-walk`
on several routes, and a staff token also carries a `branchId` claim. Anything sending
`X-Branch-Id` today is ignored silently.

This is the one cross-cutting change that touches every endpoint, and it is the one most likely
to bite: a header that is ignored rather than rejected fails *open*, which is the opposite of
your rule 2.

### `X-Tenant-Id` is captured but not enforced

We read it, store it on the rows you create, and **filter on nothing**. A different tenant id
reads everything — verified live. That is deliberate and staged (populate, backfill, then
filter), but until the filter lands it is not an isolation boundary. Do not build UI that
assumes it is.

### Permissions are coarser than `bookings.read` / `bookings.create`

We resolve an actor to `customer`, `staff` or `manager` from token roles. There are no scoped
permissions. Most booking routes require only authentication; a few check actor kind (a
customer cannot cancel a checked-in booking). Mapping `bookings.read`/`bookings.create` onto
that is a design decision, not a rename.

### Idempotency-Key is on `POST /v1/bookings` only

You require it on **both** create routes. `POST /v1/bookings` reads it and replays correctly —
verified live, the same key returns the same booking. **`POST /v1/series` does not read it at
all**, so a retried series create makes a second series. That is a real gap and a cheap fix.

### Hold ownership is not checked

`DELETE /v1/holds/{id}` takes no actor. Any authenticated caller can release any hold. Your
requirement — "one desk cannot release another desk's hold" — is not met.

It *is* idempotent, which is the other half of your §7: releasing an already-released or
unknown hold returns `200 {"released": false}`, never a 404. The status differs (`200` with a
body, not `204`) but the behaviour is what you asked for.

### Time representation

You want ISO instants (`startAt`) plus branch-local (`date` + `startLocal`). We speak
minute-of-day (`startMin: 900`) plus a display string (`start: "15:00"`) plus a `tradingDay`.
Both carry the same information; every offer, lane and occurrence would need an added ISO
field. Mechanical, but it touches most responses.

Money already matches: integer minor units, `priceMinor`-style naming, with `"AED 480.00"`
display strings riding alongside.

---

## 7. Item-level coverage

400 individual items checked — every field, rule and status code in the contract.
*Covered* and *renamed* are both usable today; renamed costs a field alias.

| § | Section | Covered | Renamed | Partial | Missing | Conflict |
| - | ------- | ------: | ------: | ------: | ------: | -------: |
| 1 | settings | 2 | 12 | 4 | 5 | 7 |
| 2 | services | 3 | 4 | 2 | 7 | 5 |
| 3 | eligible-staff | 2 | 5 | 4 | 3 | 3 |
| 4 | availability (single) | 0 | 11 | 8 | 5 | 3 |
| 5 | availability (group) | 9 | 6 | 8 | 9 | 9 |
| 6 | holds | 3 | 7 | 4 | 3 | 5 |
| 7 | release hold | 1 | 1 | 1 | 0 | 2 |
| 8 | quote | 13 | 7 | 8 | 11 | 15 |
| 9 | create | 3 | 6 | 11 | 14 | 13 |
| 10 | get booking | 7 | 5 | 2 | 15 | 5 |
| 11 | payment-link | 2 | 0 | 0 | 7 | 3 |
| 12 | series preview | 13 | 13 | 5 | 6 | 10 |
| 13 | series create | 8 | 1 | 5 | 9 | 5 |
| 14 | get series | 2 | 0 | 4 | 0 | 1 |
| — | cross-cutting | 0 | 0 | 3 | 3 | 2 |
| | **Total** | **68** | **78** | **69** | **97** | **88** |

146 of 400 items (36%) are usable today or after a rename.

> **How this table was produced, and its limits.** Eight agents read the contract against
> the source, one per section. An adversarial verification pass was scheduled to re-check
> every finding — it did not run, because the account hit its weekly limit partway through.
> So treat the *counts* as a first pass: unverified MISSING findings tend to be inflated,
> because our equivalent is often on another route under another name. I hand-checked the
> load-bearing claims against a running server, and those are the ones stated as fact in
> §§1–6 and 8–10 above. Several first-pass findings were wrong and are corrected there —
> for example `GET /v1/bookings/{id}` was reported as lacking ISO instants and snapshot
> line items, and in fact returns both.
## 8. What we have that your contract does not mention

Worth knowing before you design around gaps that are already filled:

- **Waitlist** — join, offer on a freed slot, accept/decline. Offers are made automatically when
  a booking is cancelled, no-showed, expires **or is rescheduled away**.
- **Walk-ins** — a queue with live seatable options, and seating that returns an ordinary hold.
- **Full lifecycle** — check-in, start, complete, settle, cancel, no-show, reschedule.
- **Roster disruption** — a worklist with a repair ladder and a commit gate that blocks a roster
  edit while the worklist is non-empty.
- **Diary compaction** — proposes moves that close stranded slivers, applied only with consent.
- **`requirement.trace`** — the full deposit ladder, rung by rung, for "why was I charged".

---
## 9. Per-endpoint verdict

| § | Endpoint | Verdict | What is actually needed |
| - | -------- | ------- | ----------------------- |
| 1 | settings | **mostly there** | Same path. 11 of 23 keys match by value. Add `timezone`, `openingHours[]`, `dayParts[]`, `groupPct`, `standingRequiresTiers`; publish the two group knobs we already accept. |
| 2 | services | **wrong route, thin payload** | Alias to `/v1/bookings/services`, add `priceMinor`, `category`, `depositPct`, buffers, `seriesEligible`, `?q`. We already return `skill`/`requiredLevel`/`resourceType`. |
| 3 | eligible-staff | **there, needs shape** | Same path, same idea. `missingSkills` is prose today, not structured; no `jobTitle`/`avatarUrl` (needs Staff Management). |
| 4 | availability | **there, needs codes + ISO** | Alias the route. Add `blockers[]` with the six codes, ISO `startAt`, `chainDurationMin`, `limit`, `dayPart`. `isEarliest` exists as the `EARLIEST` badge. |
| 5 | availability/group | **same path, different answer** | We answer "is *this* target feasible" with one plan; they want a **ranked list of party-feasible starts**. Add per-guest `ref` echo, `staffName`, `durationMin`, `dayPart`. The hard part — backtracking distinct assignment — is done. |
| 6 | holds | **there, split in two** | Merge `/v1/holds` + `/v1/groups/holds` behind one route, or alias both. Add `laneCount`, per-lane `startAt`, `LANE_CONFLICT`. Atomicity and kernel re-proof already hold. |
| 7 | release hold | **behaviour right, status differs** | Idempotent, never 404 — as required. Returns `200 {"released"}` not `204`. **No ownership check** — that is the real gap. |
| 8 | quote | **strong, three gaps** | Same path. Ladder is 6 of 7 rungs with the same strictest-wins algorithm. Needs: per-service `lines[]`, `shares[]` with `payer`, a machine-readable `rule` enum, `GROUP_MINIMUM`, and a `policy` block. Peak-window semantics need a decision. |
| 9 | create | **weakest section** | Single works and is idempotent. Group is a different endpoint with no `kind` discriminator, no money, no intents, no `staffMemberId` on the 201, no group reference scheme. Payment intents are the blocker. |
| 10 | get booking | **good bones, missing joins** | ISO `startAt`/`endAt` and a full snapshot `items[]` already match. Missing the `customer`, `staff`, `group`, `series` and `notes` blocks — mostly joins we do not currently make. |
| 11 | payment-link | **works, different contract** | Returns outstanding + `cappedBy`, not `{sentAt, expiresAt}`. No 429. Two of our errors (422 nothing owed, 409 window shut) are not in their contract and are worth keeping. |
| 12 | series preview | **best-covered section** | Same path. Month-end fallback, alternatives, ladder rung and per-occurrence `why` all exist. Mostly renames: `index`→`sequence`, `day`→`date`, `movedFromDayOfMonth`→`movedToMonthEnd`. Add `endLocal`, `staffName`, `estimatedAnnualValueMinor`, and `feasible: null` beyond the horizon. |
| 13 | series create | **there, wrong route** | Alias `/v1/series` → `/v1/bookings/series`. **Add Idempotency-Key** (real gap). Add a `GS-S…` reference, tier gate for STANDING, `SERVICE_NOT_SERIES_ELIGIBLE`. Patterns map: `BIWEEKLY`/`SIX_WEEKLY` are `EVERY_N_WEEKS` with 2 and 6. |
| 14 | get series | **there** | Same path, needs the reference and the renamed occurrence fields. |
| — | webhook | **there and better than specified** | Idempotent by event id, and late-capture handling (reinstate vs auto-refund) is implemented. |
| — | materialiser | **exists, not scheduled** | The logic and its per-occurrence idempotency exist behind `POST /v1/series/{id}/materialise`. Nothing runs it nightly. |

---

## 10. What I would do, in order

**1. Route aliases — half a day, unblocks the most.**
Five paths. The handlers exist and are proven; this is routing, not logic.
`/v1/bookings/services`, `/v1/bookings/availability`, `/v1/bookings/holds`,
`/v1/bookings/holds/{id}`, `/v1/bookings/series`.

**2. The cheap correctness gaps — half a day.**
`Idempotency-Key` on series create; hold ownership on release; `staffMemberId` on the confirm
201. Each is small and each is a real defect, not a preference.

**3. Blocker codes — one day.**
Six codes on availability, plus day-level `BRANCH_CLOSED` / `RESOURCE_FULL`. Their rule that an
empty result must always explain itself is a good rule and we half-honour it already.

**4. Quote completion — one to two days.**
Per-service `lines[]`, `shares[]` with `payer`, the `rule` enum, `GROUP_MINIMUM` + `groupPct`,
the `policy` block.

**5. Settings completion — half a day.**
`timezone`, `openingHours[]`, `dayParts[]`, and publish the group knobs we already accept.

**6. Group create through `POST /v1/bookings` — two to three days.**
The `kind` discriminator, group creation on the same path, group reference scheme, and money on
the group path.

**7. Payment intents — needs a provider decision first.**
Nothing to estimate until question 4 is answered. This blocks their payment step and nothing
else.

**8. Schedule the materialiser — small, but needs an ops decision.**
The job exists; it needs a nightly trigger and somewhere to run.

Notifications stay out of scope.

---

## 11. Decisions I need from you

These are the ones where our behaviour and theirs genuinely disagree, and I should not pick
unilaterally:

1. **Hold TTL — 15 minutes (ours) or 10 (theirs)?** Their operations point about a group hold
   blocking several chairs is a fair one.
2. **Slot grain — per channel (5 desk / 15 online, ours) or one number (15, theirs)?** Their
   contract assumes one grid.
3. **Peak window — escalator (ours) or floor (theirs)?** Ours can turn a deposit into full
   payment; theirs raises a percentage. This changes what customers are charged.
4. **Max party size — 8 (ours) or 6 (theirs)?** Ours is more permissive; the FE can simply cap.
5. **`X-Branch-Id`** — do we adopt the header, or do they keep sending `branchId` in the body?
   Adopting it touches every route, and a header that is ignored fails open.
6. **Booking status enum** — they modelled four; we have fourteen. They need to handle the
   others or we need a coarse projection.
