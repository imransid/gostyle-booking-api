# AUDIT-2 — the booking API against the Booking Flow documentation

Audited: `GoStyle_Booking_Flow_Documentation.pdf` v1.0 (73 pages) against this
repository at commit `e856885`, section by section, table by table, number by
number.

**Nothing was changed. This is a report.**

---

## How this was produced, and what to distrust in it

Nineteen auditors walked the document in parallel, one per section group plus a
dedicated numbers pass, and every claim below is anchored to a file and a line
that was actually read. On top of that I independently re-derived the highest-
value tables myself (6.1, 6.2, 7.3, 7.5, 8.4, 11.1, 12.1, 19.3, C.1) and
personally verified every finding marked **[verified]** — those I opened the
code for, not the commit message.

Three honest caveats:

1. **There is no `AUDIT.md` in this repository or anywhere in its git history.**
   I could not match a prior format, so I have used the three lists you asked
   for and added the four extra buckets you asked me to flag.
2. **8 of the 19 auditors never produced a result.** Two died when the machine
   slept mid-response (§15.1 group, §15.2 series) and six stalled through all
   six retries (§7 ranking/hold, §8 pay-and-confirm, §9–10 lifecycle, §11–12
   timers and concurrency, §13 day-of, §14 exceptions). Those sections are
   covered by **my own direct reading** instead — which is why nearly every
   entry in them is marked *[verified]*. Coverage is complete; the *method*
   differs by section. The completeness critic also failed (network), so there
   was no independent sweep for things every auditor missed.
3. **The adversarial verification pass did complete, and it matters.** It
   re-checked 186 negative findings and **refuted 30 of them — 16%.** Every
   refutation has been applied below; nine of them changed or removed a claim
   in an earlier draft of this file, and I re-verified each against the document
   and the code myself before accepting it. Findings still marked *[agent]* are
   ones the verifier upheld but I did not personally re-open.

   That 16% is the most useful number in this report for judging the rest of
   it: roughly one in six confident-sounding automated findings was wrong.

### Scope key

The repository is the **booking API only**. The document also specifies a wizard
UI, WhatsApp templates, a POS, screens and panels. A doc rule absent from a
backend is not automatically a defect, so every entry is tagged:

| Tag | Meaning |
|---|---|
| **backend** | this service's job — a gap here is a real gap |
| **ui** | wizard, panel, badge, copy — another application |
| **external** | catalogue, staff/shift, POS, CRM, gateway, customer service |
| **infra** | sockets, dashboards, residency, deployment |

The summary counts every finding; the backend-only split is given beside it,
and it is the one that matters.

---

## Summary

Agent findings, 11 sections, **after the verification pass corrected them**:

| | All scopes | Backend only |
|---|---|---|
| Total | 520 | 443 |
| — MATCH | 273 | 269 |
| — WRONG | 107 | 107 |
| — MISSING | 121 | 54 |
| — INVENTED | 8 | 5 |
| — DOC CONTRADICTION | 4 | 3 |
| — CONSTANT MISMATCH | 7 | 5 |

Verification moved 30 findings: **21 alleged defects turned out not to be
defects at all**, and 9 were re-classified (6 → WRONG, 3 → MISSING). The raw
pre-verification numbers were 258 MATCH / 118 WRONG / 12 INVENTED.

Scope split of all 520: backend 443, ui 39, external 31, infra 7. Two-thirds of
the MISSING list is wizard, message-template or another-service work — which is
why the backend column, not the raw total, is the honest headline.

My own direct audit covers §7–§15.2 (the eight sections that never returned)
plus re-verification of every severe agent claim, and adds 3 of the 6 surviving
doc contradictions (D2, D3, D4).

**The headline.** The *domain* is in excellent shape: the arithmetic, the
policies and the constants are faithful to the document, often to the fil. The
failure is at the **wiring**. Twenty exported domain rules — including the
check-in gates, the capture gate and the manager override — are implemented,
unit-tested, and never called by anything. The document's guarantees are
largely present as functions and largely absent as behaviour.

---

## MATCHES

Implemented and correct. File and line given; all verified by reading the code.

### The money engine — the strongest area in the codebase

| Doc | Code | Note |
|---|---|---|
| §8.1 Table 8.1 six precedence rungs, **strictest wins, not first** | `src/domain/booking/customer.ts:216-395` | rung 1 short-circuits; 4b escalates rather than scoring; verified with the doc's own worked trace |
| §8.2 percentage rounded to whole dirhams | `customer.ts` `percentRung` → `Money.roundToDirhams` | |
| §8.2 clamp AED 10 floor / AED 500 ceiling | `customer.ts:178-179, 486-512` | emits "raised to the branch floor" / "capped at the branch ceiling" verbatim |
| §8.2 fixed-amount beats percentage when larger | `customer.ts` `serviceRung` | keratin AED 400 case correct |
| §8.2 **deposit computed on the pre-discount total** | `confirm-booking.handler.ts` | discounts never shrink the deposit |
| §8.1.2 risk ladder `80 − 30×no_shows − 15×late_cancels + 2×min(visits,10)`, clamped 0–100, bands ≥75 / 45–74 / <45 | `customer.ts:37-44` | every coefficient and boundary exact |
| §13.4 the full settlement arithmetic block | `quote.ts:191-238` | subtotal, tier discount on services only, promo on (services − tier), base, tip on (base − retail), VAT on base, due, credit floor — every line matches |
| §13.4 deposits are tender not discounts; overpayment credited; tips never drawn from a deposit | `quote.ts:216-236` | |
| §8.3 Table 8.4 refund matrix rows 1, 2, 3, 5 incl. **50/50 split on full payment in the 24h–2h band** | `lifecycle.ts:404-472` | boundary is `>=` so exactly T-2h is inside the band, as the doc's row reads |
| §14.1 serial rescheduler: 4th move, 20%, only when nothing captured | `reschedule.ts:15-16, 83-86` | |

### The availability engine

| Doc | Code | Note |
|---|---|---|
| §1.4 / §7.2 trading window 600–1320, 144 slots of 5 min | `grid.ts:14-23` | |
| §6.3 Table 6.2 buffers: colour 10/20, room 10/15, styling 5/10, wash 5/5, nail 5/10, brow 0/5 | `fixture-booking-context.ts:20-25` | all six exact |
| §6.3 **the larger claim wins, never the sum** | `staff-mask.ts` `gapBetween` | |
| §6.1 Table 6.1 all 12 catalogue rows — duration, price, resource, deposit %, fixed amount | `fixture-booking-context.ts:27-130` + `confirm-booking.handler.ts:331-345` | every cell exact |
| §6.1 processing bands 45–75, 45–85, 60–105 | `fixture-booking-context.ts:72, 85, 98` | |
| §6.4 5-minute guard at each end of the hands-free band | `grid.ts:26` `PROCESSING_GUARD_MIN` | |
| §7.4 Table 7.3 chair registry: styling 4 (1 out of service), colour 2, wash 2, nail 3, brow 1, room 2 | `fixture-booking-context.ts:248-253` | |
| §7.4 changeover room 10 / colour 5, chair-only | `fixture-booking-context.ts:248-253` | |
| §7.6.1 Table 7.5 fragmentation weights +3 / +3 / −4 / −4 / +6 / +0.3 / −0.5 | `ranking.ts:14-28` | all seven exact |
| §7.6.2 demand mix .26 / .16 / .18 / .14 / .10 / .16 | `ranking.ts` `DEMAND_MIX` | sums to 1.00 |
| §7.6.2 `sc7 = fragmentation − 0.5 × ΔC` | `ranking.ts` `DELTA_CAPACITY_WEIGHT`, `finalScore` | |
| §7.6.3 offer one is always earliest; others ≥25 min apart; displayed in time order | `ranking.ts` `selectOffers` | |

### Lifecycle, waitlist and the database guarantees

| Doc | Code | Note |
|---|---|---|
| §10.1 all 14 booking states | `prisma/schema.prisma` `BookingStatus` | complete |
| §10.3 transition guard with `allowedActors` and mandatory reasons | `lifecycle.ts:281` `checkTransition`, wired at `lifecycle.repository.ts:177` | the guard genuinely runs |
| §13.1 Table 13.1 reminder ladder −24h / −3h / −15min | `reminders.ts:24-44` | |
| §11.1 reminder marking idempotent per rung | `reminders.ts` per-column flags | |
| §14.5.1 all five waitlist match conditions | `waitlist.ts:66-105` | |
| §14.5.2 Table 14.4 rank: join order, then Royal/VIP > Gold > Silver > none, then tightest fit | `waitlist.ts:107-140` | |
| §14.5.3 fairness cap: three declines and offers stop | `waitlist.ts:48` `DECLINE_CAP = 3` | |
| §12.1 Table 12.1 no double-booking — `EXCLUDE USING gist` on (staff, tstzrange) where blocking | `migrations/20260821125424_core_booking/migration.sql:151` | the real guarantee, unconditional |
| §12.1 no chair oversold — advisory lock per (branch, type, day) | 5 call sites | |
| §12.1 no silent overwrite — row locks | 15 `FOR UPDATE` sites | |
| §14.4 late money: reinstate if the slot survived, else auto-refund + rebook | `payment-webhook.ts:44-80` | `reinstate`, `auto_refund`, `refund_to_wallet` all real |
| §14.6 disruption ladder rungs 1–3 and §15.2.3 series ladder rungs 1–4 | `disruption-ladder.ts`, `series-ladder.ts` | and correctly *different*: 15/30/45 vs 15/30 |
| §14.6 the commit gate | `migrations/20260828122800_roster_change_worklist/migration.sql` trigger | enforced in the database, not the application — stronger than the doc asks |
| §14.7 Table 14.6 compaction: ≤3 moves, ≤30 min, 5-min steps, one per booking, gain > 4 | `compaction.ts:27-36` | eligibility correctly excludes group and series occurrences |
| §15.2.1 patterns, end conditions, 70-day rolling horizon, nightly 02:00 | `recurrence.ts`, `series-materialiser.service.ts` | month-end fallback correct |
| §15.2.2 Table 15.4 the three auto-confirm rules and their birth states | `auto-confirm.ts` | ask-each-time correctly outranks the payment requirement |
| §15.4 packages are never a special case in the engine | `package.ts` `resolveSelection` | **proved live**: availability for `colour-and-finish` and for its two parts hand-picked return identically 170 min / 95 starts / same first offer |

---

## WRONG

Implemented, but does not match the document.

### Severe — money and capacity

**W1. Groups bypass the payment requirement entirely.** *[verified]*
`group-confirm.repository.ts:200-208` hardcodes every participant lane to
`status: 'confirmed'`, `paymentStatus: 'none_required'`, `depositFils: 0`.
`requirementFor()` is never called anywhere on the group path. §15.1.3 requires
"one requirement computed on the group total, charged to the organiser (20% by
default, floored and capped like any deposit)" and Appendix C sets
`groupMinimumRequirement` to a 20% deposit. The share *arithmetic* for all three
arrangements is correct (`sharesFor()`), but no money is ever asked for. A party
of six colour services confirms free where one of those services alone would
demand 50%.

**W2. The daily cap of eight is fed by a dead number.** *[verified]*
`bookingsToday` is only ever set in the fixture (2, 3, 1, 4, 0, 0) and
`db-booking-context.ts:121` passes `base.professionals` straight through without
recomputing it. `feasible.ts:136` compares that frozen number against
`DAILY_BOOKING_CAP`. §7.5 Table 7.4 calls the cap "an eligibility filter, not a
soft warning" — in practice it never reflects a single real booking.

**W3. The lead time is applied when offering and dropped when holding.**
*[verified]* `place-hold.handler.ts:101-102` hardcodes `isToday: false` and
`nowMin: 0`, so the alignment mask's lead-time filter is switched off at the
moment the slot is actually taken. §16.3 requires it "Enforced at: Engine", and
§7.11 requires re-validation on the way out of stage 3.

**W4. The confirm re-validation ladder is one check of four.** *[verified]*
§8.6 Table 8.6 specifies, in order: hold alive, skills still held, slot still
feasible on fresh masks, token still matches. `booking.repository.ts:276-277`
implements only the first. There is no skill re-check, no re-run of the kernel,
and no token comparison; the exclusion constraint catches a conflict as a
backstop, which delivers the *outcome* of check 3 but not the stated mechanism
(§12.4 "Re-validation asks the same question as search, of the same code").
The group path does re-plan on fresh masks — so the two paths disagree.

**W5. The feasibility token is written and never read.** *[verified]*
`place-hold.handler.ts:169,205` computes a real content digest and stores it.
Nothing anywhere compares it back. Three of the five hold paths write a literal
placeholder instead of a digest: `group:${id}`, `walk-in:${id}`,
`repair:${changeId}`. §12.3's whole argument — that a digest catches the ABA
problem a count cannot — is defeated by never comparing it.

### Wiring: rules that exist and never run

**W6. The check-in gates never gate anything.** *[verified]*
`canCheckIn()` (`lifecycle.ts:345`) implements §13.2's three gates and the
30-minute window, and is referenced **only by its own spec file**.
`POST /bookings/:id/check-in` takes no gate inputs and succeeds at any time of
day. §16.6 "Check-in opens 30 minutes before the start" and "All check-in gates
must be green" are therefore unenforced.

**W7. The manager override cannot be reached.** *[verified]*
Rung 1 is fully implemented (`customer.ts:222-238`) — it short-circuits the other
rungs, records the reason, stamps the source. No handler ever passes
`managerOverride`. §8.5 is domain-only.

**W8. No rule is manager-exclusive.** *[verified]* The most restrictive actor
list in the codebase is `ANY_STAFF = ['staff','manager']` (`lifecycle.ts:92`).
There is no manager-only list, no `@Roles` decorator, no role guard. §3.2's
"May not" column and §16.6's "Only a manager may waive a fee or a patch test" /
"Only a manager may overbook" are unenforced. *(Correcting an agent claim: the
actor kind **is** derived at `actor.ts:37` and `checkTransition` **does** enforce
`allowedActors` — the gap is exclusivity, not roles.)*

**W9. Courses never draw.** *[verified]* `drawCourseVisit()`
(`series.repository.ts:717`) is defined and never called. The panel meter and
`planDraws()` are correct, but `course_drawn` never increments, no live path
writes a `course_draw` ledger row, and §15.2.5's "the final draw ends the series
at a zero balance" cannot occur.

**W10. Series edit scope is a preview, not an edit.** *[verified]*
`previewEdit` is the only caller of `planEdit`; there is no `PATCH /series/:id`
and the `detached` occurrence state is **read** at `series.handler.ts:380` and
never written. §15.2.4's "'This only' detaches the occurrence and marks it
detached" cannot happen.

**W11. The grandfather switch has no switch.** *[verified]* `grandfathered` is
read at `materialise-series.handler.ts:297` but nothing can set it, and nothing
compares the live price to `baselinePriceFils`, so §15.2.4's price-change
detection and disclosure do not exist.

**W12. Overbooking has columns and no code.** *[verified]* `overbooked` and
`overbook_reason` exist in the schema with a CHECK tying them together; no code
path sets either. §7.10 path 5 is absent.

**W26. Delta capacity is measured for 24 candidates, not for each one.**
*[verified]* §7.6.2 says "**For each candidate** the engine measures the salon's
sellable start count ... simulates the booking, measures again, and takes the
difference." `ranking.ts:411` samples at most `deltaSampleSize ?? 24` via
`sampleForMeasurement`; every unmeasured candidate is handed
`deltaCapacity: 0` and scored on fragmentation alone (`ranking.ts:417-424`), and
because `selectOffers` is given only the measured subset, **the three offers can
only ever come from those 24**. The code documents this as a deliberate cost
decision (130 starts x 6 baskets = 780 kernel runs) — it is a defensible
optimisation, but it is not what the document specifies, and on a busy day it
changes which offers are reachable.

### Smaller

- **W13.** Add-ons are plumbed into the money model (`addOnFils`) but hardcoded
  to `0` at both call sites (`confirm-booking.handler.ts:218`,
  `lifecycle.handler.ts:133`) and **never extend duration**, which §6.5 requires
  ("They add both price and duration, and they are checked against the same
  feasibility masks"). *[verified]*
- **W14.** §7.8 Table 7.7 lists six refusal verdicts; the code has three
  (`missing_skills`, `daily_cap`, `not_preferred` — `feasible.ts:94-97`). No
  chair, outside-shift or buffer-collision verdict; no per-minute explanation
  endpoint; no four-reason cap. *[verified]*
- **W15.** Offers carry no price snapshot and no feasibility token, both
  required by §7.3 step 10. *[verified]*
- **W16.** `GET /series/:id/occurrences` strips the health §17.2 requires it to
  carry. *[agent]*
- **W17 — withdrawn.** I claimed cancel must return the outcome before a final
  confirm flag. §17.2 asks for "Cancel with a reason. Returns the computed
  outcome", which the endpoint does; the two-step confirmation is a wizard
  affordance, not a backend contract.
- **W18.** The reschedule endpoint bypasses `checkTransition`, so the mandatory
  reason of §14.1 step 2 and §16.6 is not enforced — an empty string is accepted
  and written to history. *[agent]*
- **W19.** `POST /bookings` accepts `rail: 'cash'` together with
  `channel: 'online'`; §3.3 and §16.5 forbid it. *[agent]*
- **W20.** The closed-day branch is wired everywhere but unreachable: nothing in
  the service ever sets `closureReason`. *[agent]*
- **W21.** All three §14.8 conflict scans run the same disruption ladder; the doc
  gives each scan its own resolutions (closure sweep → salon-cancel with
  unconditional refund or move; chair out of service → re-seat within the type
  first). *[verified]*
- **W22.** §17.3 event names: `waitlist.offered` where the doc says
  `waitlist.offer_sent`; money events are emitted under gateway verbs matching
  none of the four documented names; `booking.skipped` is never emitted because
  the skip path bypasses the lifecycle. *[verified]*
- **W23.** §17.4's audit trail is partly assemblable. Two of my earlier claims
  were wrong and are withdrawn: the creation **is** recorded (no booking row
  exists before confirm, so the `held→confirmed` row at
  `booking.repository.ts:220-230`, carrying the requirement source as its
  reason, *is* the creation record), and a repair **does** reach the trail (the
  rung is written into the reschedule reason at
  `roster-change.handler.ts:228`). What genuinely does not reach the history:
  the payment webhook changes status without writing a row, reminder sends are
  timestamped on the booking but never appended, the check-in row can never name
  a chair because none is ever assigned, and a repair never names the
  professional who was replaced. *[verified]*
- **W24.** §18 Concurrency: "Hold creation limited per customer to stop slot
  hoarding" has no implementation at all. *[verified]*
- **W25.** §18 Security: branch scoping is caller-supplied; there is no
  row-level tenancy. *[agent]*

---

## MISSING

In the document, absent from the code. Backend-scope first.

### Backend — real gaps

| Doc | What is absent |
|---|---|
| §7.3 step 6, §7.5 Table 7.4, Appendix C `maxLeadDays` | **The 90-day booking horizon is never enforced.** `BOOKING_HORIZON_DAYS` is consulted only by the series materialiser; the availability engine and the hold path accept any date. *[verified — availability for 2027-03-04 returns offers]* |
| §7.3 step 7, §6.6 Table 6.4 outcome 3, §7.7 RELAY, §7.10 path 1 | **Relay hand-off.** No per-item professional assignment exists; a chain nobody covers simply yields nothing. Only a comment at `feasible.ts:110`. *[verified]* |
| §7.7 WITH A WAIT, §7.10 path 2 | **The gapped chain.** No lounge-wait split of 15/30/45 minutes. *[verified]* |
| §7.10 path 3 | Next-feasible-day scan (14 days forward for a requested professional). |
| §7.10 path 5 | Manager overbook from an empty window. |
| §7.9, §11 | **The single silent 3-D Secure hold extension.** `extendOnce()` exists and has no caller. *[verified]* |
| §14.3 | **The revive tool** for a late arrival after the no-show fired. No `POST /bookings/:id/revive`, and the state machine has no edge out of `no_show`. |
| §14.3 | Goodwill-without-rewriting-history on a no-show (a wallet credit linked to a standing forfeit). Goodwill exists only on the disruption path. |
| §14.9 | **Post-settlement refund.** `reversed` and `partially_refunded` are the only two of the eight `LedgerEntryType` values no code ever writes, despite a CHECK constraint and a proof test existing for them. No loyalty clawback. *[verified]* |
| §13.3 | Offline POS: no outbox for the ticket-open event, no refusal of settlement while offline. |
| §13.2.1 | Self-scan approval queue. |
| §13.2.2 Table 13.3 | Late-arrival triage: shorten / rebook / mark no-show. |
| §12.7 | Real-time socket push. There is no socket transport in the service. |
| §17.2 | `GET /bookings` and `GET /bookings/:id` — **there is no read surface for bookings at all.** |
| §17.2 | `POST /bookings/:id/payment-link` (the window rules and its sweeper both exist, but nothing can issue a link on demand). |
| §17.2 | `PATCH /series/:id`, `POST /groups/:id/participants`, `DELETE /waitlist/:id`, `POST /callbacks/notifications`. |
| §17.3 | `booking.held`, `hold.expired`, `series.at_risk` (health is computed, never published), `conflict.detected`, `conflict.resolved`, `risk.band_changed`, `risk.require_deposit_set`, `waitlist.offer_accepted`, `waitlist.offer_expired`. |
| §17.1 | Booking-record concepts with no column: tier, category, deposit outcome/disposition, the outstanding-gate marker, add-ons, in-session extras, consent state. *[verified — `gate` looks present to a naive grep but only matches `gatewayRef`]* **The conflict marker is not in this list**: it exists, on `RosterChangeItem.rung`/`.proposal` (`schema.prisma:734-739`), just not as a column on the booking as §17.1 describes. That is a shape difference, filed under WRONG, not a gap. |
| §16.2 | Archived services: `Service` has no active/archived flag and `loadCatalogue` filters nothing. |
| §16.3 | Calendar resize re-validation — no endpoint changes a booking's duration. |
| §18 | Money-invariant sweeps ("captured implies confirmed or refunded, tenders equal totals"), and every alert on them. |
| §15.1 Table 15.1 | **The default maximum of 6 participants per branch.** Only the minimum of 2 (application layer) and the hard cap of 8 (application + deferred DB trigger) exist. *[verified]* |
| Appendix C, §8.5 | `depositPercentPresets` (10, 20, 50) and the override's preset list (waive / 20% / 50% / full). The override rung accepts an arbitrary `amountFils` and constrains it to nothing. |
| §6.7, Table 13.2 | The patch-test numbers: a **free 10-minute** patch-test visit booked **at least 48 hours** before the colour appointment. Only an unused `consentAndPatchTest` boolean survives. |
| §13.2.2 Table 13.3 | Shorten-on-late-arrival: reduce to what fits, rounded down to the grid, **with a floor of 15 minutes**. No shortening logic exists. |
| §7.10 Table 7.9 | "Up to **two** relay options are shown"; the **15/30/45** minute lounge wait; the **14-day** forward scan for a requested professional. |
| §6.1 Table 6.1 caption | The catalogue is **13 services, not the stated 22** (`fixture-booking-context.ts`: 13 services + 6 professionals + 3 packages). *(external scope — the catalogue belongs to another service; this is a fixture.)* *[verified]* |

### External / UI — listed for completeness, not defects here

§5.2 search and match · §5.3 quick-add · §5.5 the merge map and its
"customer re-pointed" history line · §6.7 the patch-test gate as a stage-2 gate
(only an unused boolean survives) · §8.4 the wallet PIN and WhatsApp
verification code · §9.1 the confirmed panel and Pass QR · §9.2 all five message
templates · §9.3 the pending panel · §4 the nine entry points as a wizard
concept · §18 accessibility and localisation.

---

## INVENTED — in the code, not in the document

| Code | Doc position |
|---|---|
| `requiredLevel` 1–3 on services, compared against a held skill level | §6.6 has skills but **no notion of skill levels**. |
| `POST /bookings` defaults an unsupplied `customerId` to the fixture customer `'dana'` (`bookings.controller.ts:54`) | The doc never describes a default customer; §16.1 requires a resolved customer. *[verified]* |
| `expandPackage` throws a raw `Error` when a package costs more than its parts | Nothing in §15.4 constrains package price against part total; this turns a catalogue pricing mistake into a 500. |
| Three packages (`colour-and-finish`, `bridal-morning`, `hands-and-feet`) | §6.5 names exactly one package, **Bridal glow**, which does not exist in the code. |
| `Wash and condition` (15 min, AED 40) | Not a row in Table 6.1. |
| `PaymentRail.internal` | Table 8.5 lists five rails; `internal` is a sixth, used for forfeits and course draws. |
| ~~Six event-name families not in Table 17.3~~ | **Withdrawn.** Every one of the six is a documented concept (the reminder rungs are Table 13.1, occurrences are §15.2, walk-ins §15.3, the roster worklist §14.8). The names differ from Table 17.3; that is the naming defect already filed as W22, not an invention. |
| `not_preferred` ineligibility reason | Not one of Table 7.7's six verdicts. |
| The **threshold** `SKIPS_AT_RISK = 3` (`series-health.ts:37`) | Table 10.2 does say "skip counted in health", so the *rule* is documented — but the document never says how many skips make a series At risk. The number 3 is the code's own. *(Corrected: an earlier draft called the whole rule invented. It is not.)* |
| The **figure** `GOODWILL_PERCENT = 10` (`disruption-ladder.ts:45`) | The goodwill credit itself is documented in at least six places (§14.6 rung 4, Table 8.4, §14.3). What no passage states is the amount. The code picks 10% of the booking price and its own comment flags this as awaiting a business decision. |
| Sweep cadences, batch sizes and retry counts: `SWEEP_INTERVAL_MS 30s`, `REMINDER_INTERVAL_MS 60s`, `NO_SHOW_SWEEP_MS 60s`, `WAITLIST_SWEEP_MS 30s`, `LINK_SWEEP_MS 60s`, `RELAY_INTERVAL_MS 1s`, `RELAY_BATCH_SIZE 50`, `MAX_ATTEMPTS 10`, `MATERIALISE_BATCH 200` | Table 11.1 says only when timers *fire*. The document never specifies how often a sweeper ticks, how many rows it takes, or how often a failed event is retried. *(infra scope — reasonable engineering, simply unsourced.)* |
| The DB demands a reason for `confirmed→no_show`; the domain gate does not | A reasonless no-show passes the domain and is refused by Postgres. |

---

## DOC CONTRADICTIONS

**D1 — withdrawn, but worth knowing.** An earlier draft called the 19-minute
fragmentation bound and the 25-minute sliver threshold a contradiction. On
challenge that does not hold: the document states each explicitly for a
different purpose (Table 7.5 prices a gap of 1–19 in the ranking; Table 19.3 and
§14.7 define unsellable as under 25), and the code reproduces both correctly
(`ranking.ts:35` = 19, `grid.ts:29` = 25). Not a defect in either.

  The *consequence* is still worth a product decision: a 20–24 minute gap is
  stranded time that earns no ranking penalty, so the engine can create a gap
  that §14.7 will later propose consent moves to close. That is a gap between two
  rules, not an error in either.

**D2. The waitlist tie-breaks can never fire.** *[verified]* §14.5.2 ranks by join order
first, with tier and fit tightness as tie-breaks "when join order ties". Join
times are millisecond timestamps and never tie, so Table 14.4's keys 2 and 3 are
unreachable as specified. The code implements it exactly as written and says so
in a comment at `waitlist.ts` `rank()` rather than quietly improving it — the
right call, but the document needs a decision (bucket join order by day?).

**D3. Series ladder vs disruption ladder shift sizes.** *[verified]* §15.2.3 rung 3 allows
"15 or 30 minutes"; §14.6 rung 2 allows "15, 30 or 45". Both are implemented as
written (`series-ladder.ts:23`, `disruption-ladder.ts:36`). This is probably
deliberate — but the document never says so, and the two ladders are described
as mirrors of each other.

**D4. §20 claims work is resolved that is absent from the code.** The "resolved"
list names series edit scope (preview only), booking-time add-ons (hardcoded to
zero, never extend duration), post-settlement reversal (never written) and
service-archive blast radius (no archived flag exists). *[verified]*

**D5. Daily cap: configurable or not?** *[agent]* Appendix C lists `maxPerDayPerStaff` as
a branch-scoped setting; §20 lists "per-professional daily cap as a configurable
branch setting" as an open P3 gap.

**D6. Channel lists disagree.** *[agent]* §3.1's glossary enumerates app / front desk /
walk-in / recurring / group; §3.3's Table 3.3 enumerates front desk / online /
walk-in / recurring materialiser / waitlist accept. `group` appears only in the
first, `waitlist accept` only in the second.

**D7. Entry-point count.** *[agent]* §4's preamble says all nine entry points produce the
same draft and differ only in pre-fill and opening stage; rows 6, 7 and 8 of
Table 4.1 then say they never enter the wizard at all (confirm path directly,
waitlist join, reschedule drawer).

---

## THE NUMBERS

Every value in Table 19.3, checked against the constant that holds it.
**19 of 21 agree exactly.**

| Doc constant | Doc value | Code | Verdict |
|---|---|---|---|
| Trading window | 600–1320 | `grid.ts:14,17` 600 / 1320 | ✅ |
| Grid | 144 slots × 5 min | `grid.ts:20,23` SLOT_MIN 5, SLOTS derived = 144 | ✅ |
| Grain | 5 desk / 15 online | `feasible.ts:65-66` grainMin 5 / 15 | ✅ |
| Lead time today | 15 desk / 60 online | `feasible.ts:65-66` leadMin 15 / 60 | ✅ value — but see W3, dropped at hold |
| Horizon | 90 days | `recurrence.ts:32` = 90 | ⚠️ value right, **never enforced by the engine** |
| Series horizon | 70 days | `recurrence.ts:29` = 70 | ✅ |
| Daily cap | 8 per professional | `grid.ts:42` = 8 | ⚠️ value right, **fed by a dead fixture number** (W2) |
| Sliver threshold | 25 min | `grid.ts:29` = 25 | ✅ (see D1) |
| Offer spacing | 25 min | `grid.ts:39` = 25 | ✅ |
| Peak window | 17:00–20:00 | `customer.ts:155-156` 1020 / 1200 | ✅ (escalation default off, as Appendix C says) |
| Deposit floor / ceiling | AED 10 / 500 | `customer.ts:178-179` | ✅ — and the ceiling now applies to **full payment** too (`eabacae`), closing the invented exemption this audit flagged |
| **Group deposit default** | **20% of the group total** | **no constant exists** | ❌ **MISMATCH, STILL OPEN** — the group path still never charges (W1) |
| **Hold TTL** | **10:00** | **15 min** (`hold.ts`), walk-in 5 min, repair 1 min | ⚠️ **DELIBERATE DIVERGENCE** — the front-end contract says fifteen and is later than this document, so it wins (`eabacae`). The group handler's private copy of the ten-minute value is gone; walk-in and repair keep their own distinctly-named TTLs on purpose |
| 3-D Secure grace | +5:00, once | **10 min** (`hold.ts`) | ⚠️ **DELIBERATE DIVERGENCE** — front-end contract, same precedence as the TTL (`eabacae`). Still no caller: `extendOnce` remains unreachable |
| Waitlist offer TTL | 15:00 | `waitlist.ts:51` = 15 min | ✅ |
| Payment-link window | 6 h, capped at start−2 h | `payment-link.ts:13,22` | ✅ |
| Arrival grace | 15 min, 20 VIP | `lifecycle.ts:309,311` | ✅ value — but `canCheckIn` has no caller (W6) |
| Auto no-show | start + 30 | `lifecycle.ts:313` = 30 | ✅ |
| Room changeover | 10 room / 5 colour | `fixture-booking-context.ts:248-253` | ✅ |
| VAT | 5% | `quote.ts:15` = 5 | ✅ |
| Tier discount | 10% Gold | `customer.ts:105` | ✅ |

### Other numbers, elsewhere in the document

All correct: the risk coefficients and bands (80 / −30 / −15 / +2 / cap 10 /
75 / 45), the seven fragmentation weights, the six demand-mix weights, all six
buffer pairs, all twelve catalogue rows and their three processing bands, the
six chair-registry counts, ΔC weight 0.5, decline cap 3, compaction's 30 / 5 /
3 / 4, the two ladder step lists, the 48-hour series protection window, the
7-day confirmation lead and 48-hour confirmation window, `CONSECUTIVE_EXPIRIES_AT_RISK` 2.

Two numbers in the code the document never states: `SKIPS_AT_RISK = 3`
(`series-health.ts:37`) and `GOODWILL_PERCENT = 10`
(`disruption-ladder.ts:45`) — the latter is flagged in its own comment as
awaiting a business decision.

### Appendix C — the values are right; most of the scoping is not

*(Corrected on challenge. An earlier draft said none of the settings was
configurable, which is too strong.)* Three tiers:

- **Genuinely scoped as the doc says.** Row 1, `requirement | Service`, is real
  data: `Service.depositPercent` and `Service.depositFixedFils`
  (`feasible.ts:55-56`) are read per service by rung 3, so two services can and
  do carry different deposit rules. `overlapEnabled | Professional` is likewise
  a per-professional flag.
- **Shape without a source.** `BranchRules` (`customer.ts:145-158`) models
  `onlineDefault`, `peakEscalation` and `peakWindows` exactly as Appendix C
  scopes them — but `DEFAULT_BRANCH` is the **only instance ever constructed**,
  passed literally at both call sites (`confirm-booking.handler.ts:172`,
  `materialise-series.handler.ts:314`). No branch's settings are ever loaded,
  and there is **no Branch or configuration table among the 17 Prisma models**.
- **Plain module constants, no scoping at all.** The deposit floor and ceiling,
  `firstVisitRequirement`, `riskDeposit`, `nonRefundableWindowHours`,
  `lateCancelWindowHours`, granularity, lead times, `maxLeadDays`,
  `seriesHorizonDays` and `maxPerDayPerStaff` — every one a `const` that cannot
  vary by anything.

`depositPercentPresets` does not exist at all.

---

## THE PATTERN WORTH ACTING ON

Of 113 exported domain functions, **20 have no caller in their own file and no
caller anywhere in `src/` — only their own `.spec.ts`.** The doc-critical ones:

| Function | Doc rule it implements |
|---|---|
| `canCheckIn` (`lifecycle.ts:345`) | §13.2 the three check-in gates and the 30-minute window |
| `captureGate` (`hold.ts:207`) | §8.6 the capture re-validation gate |
| `extendOnce` (`hold.ts`) | §7.9 the single silent 3-D Secure extension |
| `nextDraw` (`course.ts`) | §15.2.5 the per-visit course draw |
| `isBlocking` (`lifecycle.ts`) | §10.2 "the single most load-bearing predicate in the engine" — the DB `blocking` column is the real enforcement point instead |
| `balances` (`lifecycle.ts`) | deposit-ledger balances |
| `isUrgent` (`hold.ts`) | §7.9 the urgent countdown |

Plus `drawCourseVisit` in the repository layer, and `managerOverride` in the
requirement engine, both defined and never invoked.

This is the audit's single most useful conclusion: **the specification has been
read carefully and implemented faithfully as domain logic, then not connected.**
The tests pass because they test the domain directly. A reader of the commit log
would reasonably believe check-in is gated and the capture ladder runs; neither
is true at runtime.

---

## What has been fixed since this audit was written

Five commits act on it. The findings below are **closed**; everything else in
this report still stands as written.

| Audit finding | Closed by |
|---|---|
| Deposit ceiling exempted full payment (invented carve-out) | `eabacae` — the ceiling applies to every requirement; a full requirement that hits it becomes a deposit |
| §17.2 `GET /bookings` / `GET /bookings/:id` — no read surface at all | `77380f6` — `GET /v1/bookings/{id}` returns the visit, its items, its ledger and its history in one call |
| §17.2 `POST /bookings/:id/payment-link` missing | `77380f6` — with §8.4.1's window, and a refusal rather than a dead link inside the cutoff |
| Appendix C values unreachable by the front end | `77380f6` — `GET /v1/settings`, imported from the owning modules so it cannot drift |
| `OFFER_SPACING_MIN` duplicated | already fixed in `3671f27` before this audit was written |
| Group holds kept a private copy of the hold TTL | `eabacae` — same duplication class; it imports the one definition now |
| Promo was a flat house-wide 10% with no code on the receipt | `eabacae` — the rate rides on the code, and the settlement names it |
| Request DTOs still spoke domain vocabulary (5 enums, incl. all three series enums) | `5db4141` — a front end holding the contract could not create a series at all before this |
| `GET /v1/roster-changes/:id` returned a raw database row (4 leaks) | `5db4141` — a real view type, and `toWireProposal` renames the two integers the JSONB was smuggling past `tsc` |
| `@Get('api/v1/me')` registered at `/v1/api/v1/me` | `5db4141` |

Two bugs were found **only by running the new code**, both caught by CHECK
constraints written months earlier, and both recorded in `77380f6`: a
hard-coded `actorKind: 'staff'` with no actor id, and — worse — a
`booking.update` and its audit insert that were not in one transaction, which
left a booking in `PENDING_PAYMENT` with a link and no row saying who sent it.

Still open and worth naming: **groups still confirm free** (W1), the daily cap
still reads a frozen fixture number (W2), the lead time is still dropped at
hold (W3), the confirm ladder is still one check of four (W4), and the
feasibility token is still never compared (W5).

---

## Coverage and confidence

Every section §1–§20 and Appendices A–C was audited.

| Sections | Method |
|---|---|
| §1–§6, §15.3–§18, Appendices A–C, and an end-to-end numbers pass | 11 agents, then an adversarial verifier that refuted 30 of their 186 negative findings |
| §7 ranking/hold, §8 pay-and-confirm, §9–10 lifecycle, §11–12 timers and concurrency, §13 day-of, §14 exceptions, §15.1 group, §15.2 series | **My own direct reading** — these 8 auditors never returned (2 died when the machine slept, 6 stalled through all retries) |

Findings marked *[verified]* I proved directly by opening the code. *[agent]*
findings were upheld by the verifier but not re-opened by me. Every severe
finding in this report is *[verified]*.

The independent numbers pass and my own arrived at the same answer on every
value in Table 19.3, which is the strongest corroboration here: the two
mismatches — group deposit default and hold TTL — were found twice, separately,
by different methods.

**The one gap in the method.** The completeness critic, whose job was to find
rules that fell between two auditors' ranges, failed on a network error and was
not re-run. So this audit is thorough on everything it looked at, and cannot
prove it looked at everything. The likeliest blind spots are boundaries between
section ranges and the figures, whose captions carry rules the extracted text
renders poorly.

**What the verification pass changed in this file.** Nine claims in an earlier
draft were withdrawn or narrowed after challenge, each re-checked by me against
both the document and the code before I accepted the correction:

| Claim | Outcome |
|---|---|
| `FLUSH` badge is invented | **Withdrawn.** §7.7 requires each offer row to carry "whether the start is flush with the diary" (doc line 3539). |
| `SKIPS_AT_RISK` is a fourth, invented At-risk reason | **Narrowed.** Table 10.2 says "skip counted in health" (doc line 5271). Only the threshold of 3 is unsourced. |
| `GOODWILL_PERCENT` is invented | **Narrowed.** Goodwill is documented in six places; only the 10% figure is the code's own. |
| Six event families are invented | **Withdrawn.** All six are documented concepts; the *names* differ, which is W22. |
| Sliver 19 vs 25 is a doc contradiction | **Withdrawn (D1).** Two different quantities, each stated explicitly for its own purpose. |
| Cancel must preview before applying | **Withdrawn (W17).** §17.2 asks only that it return the computed outcome. |
| Nothing records the booking's creation | **Withdrawn (W23).** No booking row exists before confirm, so the `held→confirmed` row *is* the creation record. |
| A repair leaves no trail | **Withdrawn (W23).** The rung is written into the reschedule reason. |
| The conflict marker is missing | **Re-classified.** It exists on `RosterChangeItem`, not on the booking — a shape difference, not a gap. |
| No Appendix C setting is configurable | **Narrowed.** Per-service and per-professional scoping are real; per-branch has a shape with no source. |

Two further corrections were mine, made while writing: the findings total is 520
(I had double-added an intermediate snapshot to 648), and the summary originally
presented all-scope counts as if they were backend-only.

Nothing in the repository was modified.
