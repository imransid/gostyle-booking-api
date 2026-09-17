# Answers to your integration report, and what changed

> **For:** the frontend team, in reply to *Bookings — integration gaps and open decisions*.
> **Server:** `feat/platform-directories`. Everything below was run against a real Postgres.
> Companion: [BOOKINGS-API-FOR-FRONTEND.md](./BOOKINGS-API-FOR-FRONTEND.md) is the full surface.

Your eight decisions are accepted as written — including the correction that `…Minor` is the
field that must never be dropped. Three of your questions had answers already in the code, one
found a **bug in your client**, and eight of your asks are now built.

---

## 1. Two answers you can act on immediately

### Q1 — occurrences already carry an `id`. Enable skip.

`OccurrenceView.id` has been on the payload since the panel was written; the guide's example
just didn't show it. Every occurrence in `GET /series-admin/{id}/occurrences` has one, and it is
exactly what `…/occurrences/{occurrenceId}/skip` takes.

You were right to refuse to send an index. Drop the conditional.

### Q8 — `groupId` and `holdId` are **different values**. Your party flow is broken.

`POST /v1/groups/holds` returns **both**, as separate fields:

```json
{ "groupId": "grp_…", "holdId": "hld_…", "expiresAt": "…", "lanes": [ … ] }
```

The path takes the **group** id; the body takes the **hold** id:

```
POST /v1/groups/{groupId}/confirm      { "holdId": "hld_…", "participants": [ … ] }
```

Sending the hold id as both looks up a group that does not exist and 404s. You noted it would
"fail loudly rather than book the wrong people" — correct, and it would have failed every time.
Both fields are now in `/docs-json`.

---

## 2. Your other questions

| # | Answer |
| - | ------ |
| **Q3** | **Six of seven, always.** `ALL`, `TODAY`, `TOMORROW`, `DEPOSIT_PENDING`, `CONFLICTS`, `NOT_REMINDED` are always present. **`UNCONFIRMED` is never counted** — it was an oversight, and rendering it blank is the right call meanwhile. Now documented in the schema rather than left for you to infer. |
| **Q4** | **Capped at 100**, silently, exactly as you feared. `pageSize` clamps to `[1, 100]` and `page` to `[1, 10000]`. Your "load more" will stop adding rows at 100 while `total` still claims more. Page instead of growing, or ask and we will raise it. |
| **Q5** | **Bare numbers are whole AED; strings are already formatted.** In `math[]`, `Service value` and `Deposit captured` are AED integers; `Policy window` and `Outcome` are strings. Your rendering is right. The outcome row now carries `PARTIALLY_REFUNDED` — see §3. |
| **Q6** | **The distinction is real but not yet reachable.** `completed` means the end condition was met; `ended` means someone stopped it early. Nothing sets `completed` today — only `POST …/end` runs, and it sets `ended`. Showing one word for both is correct until the materialiser closes a series on its last visit. |
| **Q7** | **Intended, and deliberate.** `showUpRate` counts only visits that *concluded*. A morning of confirmed-but-not-yet-happened bookings would otherwise read 0%, which is worse: it says the branch is failing when nothing has happened yet. With nothing concluded the honest answer is "no failures", so `1`. |

---

## 3. What is now built

### Decision 3 — the fifth outcome

`PARTIALLY_REFUNDED` exists, derived from the amounts rather than passed in:

```json
POST /v1/bookings/{id}/cancel
{ "code": "GS-1009", "from": "CONFIRMED", "to": "CANCELLED",
  "outcome": "PARTIALLY_REFUNDED",
  "refund": "AED 25.00", "refundMinor": 2500,
  "kept":   "AED 25.00", "keptMinor":   2500,
  "lateCancel": false,
  "explanation": "AED 25.00 refunded, AED 25.00 kept per policy." }
```

`outcome` ∈ `REFUNDED` · `PARTIALLY_REFUNDED` · `DEPOSIT_KEPT` · `NO_CHARGE`. The same word now
appears on the cancellations feed, where the prepaid split previously fell through to `LOST`.

`refundMinor` / `keptMinor` are new too, so you never parse `"AED 25.00"`.

### `Booking.category`

```json
"category": "Hair"
```

`Hair` · `Nails` · `Skin` · `Brows` · `Other`, derived from the resource classes the booking
occupies. `styling`, `color` and `wash` all map to `Hair`, so a mixed basket no longer flips band
depending on which service the query returned first. Stop deriving it from `resourceTypes[0]`.

### Q2 — `Booking.conflict` is populated

The chip and the tile now lead somewhere:

```json
"conflict": {
  "kind": "STAFF_OFF",
  "cause": "called in sick",
  "sourceEvent": "staff.shift_published",
  "raisedAt": "2026-09-18T…",
  "staffId": "anya",
  "resourceClass": null,
  "changeId": "a6fdc874-…",
  "itemId": "69826e69-…",
  "proposed": null
}
```

`kind` ∈ `SHIFT_CHANGE` · `STAFF_OFF` · `RESOURCE_OOS` · `BRANCH_CLOSURE` · `SKILL_REVOKED`.
A shift edit that names a professional is `STAFF_OFF`; one that names nobody is `SHIFT_CHANGE`.

**`changeId` and `itemId` are the repair path** — they are exactly what
`POST /v1/bookings/conflicts/{changeId}/items/{itemId}/resolve` takes, so the row can offer the
fix rather than just the bad news. `proposed` is set once the ladder has run out of rungs and
prepared a cancellation.

Verified live: a `STAFF_OFF` scan on one stylist produced a worklist tile, a chip count of 1, and
a row carrying cause, kind and both ids.

### B2 — the series `pattern` write

```
POST /v1/bookings/series-admin/{id}/pattern
{ "occurrenceId": "…", "scope": "THIS_AND_FUTURE",
  "pattern": { "kind": "WEEKLY", "weekdays": [5] },
  "startMin": 900,
  "reason": "customer moved to weekly Fridays" }
```

`scope` is required and never defaulted. **The same planner backs this and `edit-scope`**, so what
your dialog previewed and what happens cannot differ.

| Scope | Behaviour | `pattern` |
| ----- | --------- | --------- |
| `THIS_OCCURRENCE` | Detaches that visit. Cadence untouched; later edits skip it. | omit |
| `THIS_AND_FUTURE` | Re-expands from that occurrence forward. Earlier visits keep their dates. | required |
| `ENTIRE_SERIES` | Re-anchors the whole cadence. Delivered visits stay. | required |

The response returns **the regenerated timeline**, so the screen updates in one round trip. A
visit that has started or closed is never touched by any scope — history survives by
construction, not by remembering to check.

Proven live: a 3-weekly series re-patterned to weekly Fridays cleared 3 future occurrences,
planned 6 new ones, and left the already-planned first visit alone. `THIS_OCCURRENCE` marked one
`DETACHED` and changed nothing else. A `THIS_AND_FUTURE` with no pattern is a 422 that says so.

### S4 — `Idempotency-Key` is honoured on everything you send it on

`move`, `reschedule`, `cancel`, `no-show`, `check-in`, `start`, `complete`, `settle`,
`check-in/undo`, `shorten`, `waiver`, `remind`, `late-capture`, `course-draw`, the walk-in queue
writes, compaction apply and the conflict scans — all replay-safe now, alongside
`POST /v1/bookings`, `POST /v1/series` and the four money routes.

Same key + same body replays the stored response. Same key + a **different** body is a
`409 IDEMPOTENCY_KEY_REUSED`. The fingerprint covers the path params as well as the body, so the
same key on two different bookings is not mistaken for a retry.

**One honest limit:** this protects the common case — you gave up and retried. Two requests
racing *concurrently* with the same key both proceed. The money routes handle that properly,
inside their transaction, because that is where the rare case means charging twice.

### §4 — response schemas are in `/docs-json`

The nine read models now publish theirs: `GET /bookings`, `summary`, `worklist`, `calendar/day`,
`search`, `events`, `waitlist`, `series` and `customers/{id}/risk`.

```bash
curl -s http://156.67.214.42:3851/docs-json | node -e "
  const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
  for (const [p,i] of Object.entries(d.paths))
    for (const [m,o] of Object.entries(i))
      if (Object.values(o.responses||{}).some(r=>r.content)) console.log(m.toUpperCase(), p);
"
```

They are **documentation, not validation** — Nest returns plain objects and never instantiates
these classes, so they can drift from the handler. That is the honest cost of declaring them
separately, and it is why they describe only what your screens read.

---

## 4. A bug your report surfaced indirectly

While checking your `staff.id` usage I found the list and the calendar were publishing the
**stored uuid hash** for a professional while the series and waitlist boards published the
**roster slug** — the same stylist arriving as `"8d820e0c-…"` on one screen and `"maya"` on
another. A client keying a cache on one and looking it up with the other finds nothing, silently.

Fixed: **every endpoint now spells a professional the same way**, including `conflict.staffId`.
If you built any lookup around the hash, it now receives `anya` / `maya` / `reem`.

The previous document claimed this was already true. It was not. Apologies — that one was ours.

---

## 5. Still open, and why

| Your # | Item | Status |
| ------ | ---- | ------ |
| 1 | **Realtime** | Agreed it is the worst one. The outbox events are correct and ordered; the publisher writes to a log. Needs a transport decision (Redis/BullMQ is already a dependency), not code. **Escalating.** |
| 2 | **`REQUIRE_BRANCH_HEADER=true`** | Ready. It is one environment variable on the swarm service. Say the word and it flips — you have confirmed you always send the header, and S2 (refusing when a Company Owner's token carries `branchId: null`) is exactly the right client behaviour. |
| 3 | **`customer.name`** | Not yet. The booking module reads a port answering tier and risk only; putting a name on the payload means either widening that port or the platform adding `GET /v1/customers?ids=`. Your N-round-trip workaround is the right temporary shape and the wrong permanent one. **Needs a cross-service decision — flagging with platform.** |
| 12–16 | payment provider, message transport, customer writes, goodwill rate, per-branch config, tenant isolation | Unchanged. All blocked on a provider or an owner, none on this service. |

---

## 6. Corrections to your report

Two small ones, both in your favour:

- **D12** — you list `GET /{id}/ledger` as "does not exist". Correct, and the ledger rides inline
  on `GET /{id}` as `ledger[]`, which you found. Worth noting it is append-only and enforced by a
  database trigger, so it can be cached hard.
- **§4** — you infer `POST /availability/group` returns `offers[{startMin, plan[], spreadMin}]`.
  It answers whether **one** target is feasible with a single plan, not a ranked list of starts.
  The guide's §5 describes a ranked search we did not build. Your shape will not match.
