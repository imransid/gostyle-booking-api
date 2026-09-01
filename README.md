# gostyle-booking-api

A booking engine for salons. It answers which start times a branch can
actually deliver — from staff shifts, skills, buffers and chair capacity, all
computed on demand and never stored — then holds a chosen slot under a TTL
while the deposit is resolved and taken. From there it owns the whole
lifecycle: confirm, remind, check in, serve, settle, and every recovery path
in between (reschedule, cancel, no-show, expiry, waitlist backfill).

NestJS + CQRS over Postgres via Prisma. TypeScript throughout.

**API reference:** [docs/api/MOBILE.md](docs/api/MOBILE.md) — every endpoint,
every error, every example executed against a live server.
**Conventions:** [CLAUDE.md](CLAUDE.md) — read before your first pull request.

---

## Quick start

```bash
git clone <this repo> && cd gostyle-booking-api
pnpm install
npx prisma generate           # src/generated is gitignored — nothing compiles without this

docker compose up -d          # postgres on :5433, redis on :6379
npx prisma migrate dev        # creates the schema, applies every migration
pnpm dev                      # nest start --watch on :3099
```

`prisma generate` is the step that catches people on day one: the client is
generated into `src/generated`, which is not in git, so `pnpm typecheck` fails
with hundreds of missing-module errors until you have run it. CI runs it
between install and typecheck for the same reason.

`pnpm dev` starts Docker if it is not running, brings the compose stack up,
frees port 3099 and then watches. If you already have the stack up,
`pnpm start:dev` is the same thing without the Docker dance.

A `.env` is committed with working local defaults — the database URL, the
branch timezone (`Asia/Dubai`), and `JWT_ACCESS_SECRET=dev-access-change-me`.

### Getting a token

Every route needs a bearer token except `GET /health`,
`GET /v1/availability`, `GET /v1/availability/catalogue` and
`POST /v1/webhooks/payments` (signature-guarded instead). Mint a staff one:

```bash
node -e "console.log(require('jsonwebtoken').sign({
  sub: '22222222-2222-2222-2222-222222222222',
  roles: ['branch_manager'],
  branchId: '11111111-1111-1111-1111-111111111111'
}, 'dev-access-change-me', { issuer: 'gostyle-api', expiresIn: '1h' }))"
```

`roles` decides the actor kind: `super_admin`, `company_owner` and
`branch_manager` become `manager`; everything else becomes `staff`. A role
invented next month inherits the least power, not the most.

```bash
export TOK=<the token>
curl "localhost:3099/v1/availability?day=2026-10-15&services=full-colour&channel=desk"
curl -H "Authorization: Bearer $TOK" localhost:3099/v1/bookings/settings
```

Swagger UI is at `/docs`. Health, including outbox depth, is at `/health`.

---

## Architecture

Four layers, one direction of travel:

```
interface/http  →  application  →  domain
                        ↑
                 infrastructure
```

| Layer | What lives there |
| --- | --- |
| `domain` | The rules. Pure TypeScript — no Nest, no Prisma, no I/O. |
| `application` | Handlers that orchestrate a use case and own the ports. |
| `infrastructure` | Adapters: Prisma repositories, schedulers, fixtures, gateway. |
| `interface/http` | Controllers and DTOs. Validation, status codes, wire vocabulary. |

Path aliases `@domain`, `@application`, `@infrastructure`, `@interface` are
configured in `tsconfig.json` and mirrored in `vitest.config.mts`.

**Why the domain imports no framework.** `src/domain` is where availability
masks, the deposit ladder, the state machine and every money rule live. It has
no decorators and no database, so its tests need no mocks, no container and no
fixtures — `pnpm test:unit` runs 851 of them in about two seconds. That speed
is the point: it is what makes it cheap to write the rule first and the wiring
second.

**What the ports are for.** Four interfaces in `application/ports` are the
anti-corruption layer between this service and the ones it does not own:

- `BOOKING_CONTEXT` — the catalogue, roster, shifts and chair registry for one
  branch on one day. The engine never fetches; an adapter assembles.
- `CUSTOMER_CONTEXT` — six fields about a customer that change what a booking
  costs. Names and addresses belong to the customer service.
- `PAYMENT_GATEWAY` — start a payment, refund one, verify a webhook signature.
  The booking flow never learns which company processes the card.
- `EVENT_PUBLISHER` — where a domain event goes once it leaves the outbox.

Handlers own the ports and pass repositories what they need. A repository that
injects an application port to ask a question about the world inverts the
dependency the port was drawn to prevent — see CLAUDE.md §7 for the time that
failed at boot, correctly.

---

## What it does

**Availability** — 144 five-minute slots across a 10:00–22:00 day, answered as
bitwise operations over 144-bit masks: shift, busy (widened by buffers),
processing carve-back, chair capacity, channel grain and lead time, intersected
into a feasible set.

**Ranking and offers** — a fragmentation score plus a delta-capacity measure of
how much sellable capacity a start destroys, reduced to three offers: the
earliest, then the shortlist, spaced 25 minutes apart.

**Explainable refusals** — an empty window names the constraint, the object it
belongs to and the rule that produced it. An unexplained empty window is a
support ticket.

**Holds and races** — one transaction reserves every staff segment and a chair
unit per slice under a single hold with a 15-minute TTL, carrying a feasibility
token that detects a calendar that moved underneath it.

**The deposit engine** — six rungs (manager override, customer risk, service
rule, first visit, peak window, channel and branch defaults), strictest wins,
clamped to a floor and ceiling, with the full trace of why attached to the
quote and stored on the booking.

**Money** — VAT at 5% on the discounted subtotal, tier discount on services and
never retail, deposits on the pre-discount total, largest-remainder allocation
so split shares always sum back to the whole.

**Settlement** — retail, tips, promo codes, loyalty redemption and tax
exemption at the register, with the deposit applied as tender rather than a
discount and overpayment credited rather than kept.

**Lifecycle** — a server-enforced state machine from draft to settled. Every
illegal transition is refused with a typed error naming both ends.

**Timers** — hold expiry (30s sweep), auto no-show at start+30 (60s), payment
link windows (60s), waitlist offer lapse (30s), the reminder ladder (60s), and
a nightly series materialiser.

**Reschedule** — the booking moves rather than being replaced, so the deposit
stays attached; late moves forfeit, and a serial rescheduler acquires a deposit.

**Waitlist** — every path that frees a slot offers it to a ranked queue: join
order, then tier, then fit tightness, with a three-decline fairness cap.

**Groups** — a party of 2–8 planned as an assignment problem with backtracking,
arriving or finishing together, held all-or-nothing, with organiser / split /
own payment arrangements.

**Series** — weekly, every-N-weeks, monthly-on-date and custom patterns,
materialised on a rolling 70-day horizon with a per-occurrence repair ladder.

**Courses** — sold once, drawn down per visit, with the draws summing back to
exactly what was sold so the series can actually close at zero.

**Disruption repair** — when a professional goes off, affected bookings enter a
worklist and a four-rung ladder tries the least disruptive option first. The
roster edit cannot commit while the worklist is open.

**Compaction** — finds gaps under the 25-minute sellable minimum and proposes
at most three consent moves that close them.

**Walk-ins** — a queue with a live quote of the nearest options, seated through
the ordinary hold-and-confirm path.

**Packages** — expand into real services, so skills, buffers, chairs and
processing bands behave exactly as for a hand-picked chain. One line survives
in the quote.

**Payment webhooks** — HMAC-signed, idempotent by the gateway's intent id, and
handling late money: reinstate if the slot survived, auto-refund if it did not.

---

## Before you change anything

Five things that will bite you otherwise.

**1. Money is fils, never floats.** Integer minor units end to end, carried by
`Money` in `domain/shared/money.ts`, whose constructor rejects a fractional fil
outright. Round once, at the percentage. Split with `allocate`/`split` —
largest-remainder, so parts always sum back to the whole. Decimals appear only
in `toDisplay()`. Columns are `INTEGER` and `_fils`-suffixed.

**2. The exclusion constraint prevents double-booking, not application code.**

```sql
ALTER TABLE staff_reservation
  ADD CONSTRAINT staff_reservation_no_overlap
  EXCLUDE USING gist (
    staff_id WITH =,
    tstzrange(start_at, end_at, '[)') WITH &&
  ) WHERE (blocking);
```

Holds and bookings both live in that table, so both are covered. The
application re-checks feasibility because a good error message is worth having
— but the guarantee is the constraint, and it is unconditional. Chair capacity
cannot be expressed as a row constraint, so it is counted under an advisory
lock inside the same transaction.

**3. A hold is authoritative but not a guarantee.** It blocks other desks and
it has a TTL, but confirm re-runs the whole feasibility check on fresh masks
before it writes. A hold that lapsed protects nothing, and confirm will refuse
with a 410 rather than take money against a dead one. Group confirm re-plans
the entire party and can refuse even though you hold valid reservations.

**4. Every path that frees a slot publishes an event, and the waitlist
listens.** Cancel, no-show, expiry, skip and reschedule all write to the
`event_outbox` inside the same transaction as the state change; the relay
drains it every second. `WaitlistListener` sits in front of the publisher chain
and turns a freeing event into a ranked offer. If you add a path that releases
capacity, publish the event — do not call the waitlist directly.

**5. Group status is derived, never stored directly.** `deriveGroupStatus` in
`domain/booking/group-status.ts` computes it from the participants, because a
stored status and a set of participant statuses are two facts that can
disagree, and the stored one is always the one that is wrong. `active_count` is
the exception, and only because a party of three losing one is still
`confirmed` — the change would otherwise be unobservable.

---

## Testing

```bash
pnpm test:unit    # vitest, 851 tests, ~2s
pnpm typecheck    # tsc --noEmit
pnpm lint         # eslint --fix
```

CI gates publish behind all three.

**`pnpm test:unit`** runs every `*.spec.ts` under `domain`, `application`,
`infrastructure` and `interface`. The domain specs are the bulk of it and need
no database. This is what proves a rule.

**`scripts/qa-suite.mjs`** is behaviour, not smoke: races, refusals, money
arithmetic, forced timers and the state machine, against a running server. It
distinguishes PASS from BLOCKED, and a blocked case is a finding with a reason
rather than a flake. It writes real rows and cleans up after itself.

```bash
JWT_ACCESS_SECRET=... node scripts/qa-suite.mjs            # ~2 min
JWT_ACCESS_SECRET=... SLOW=yes node scripts/qa-suite.mjs   # + the 15-min waits
JWT_ACCESS_SECRET=... ONLY=MONEY node scripts/qa-suite.mjs
```

**`scripts/proof-endpoints.mjs`** exercises every endpoint once. Use it to
check a deploy is alive; use the QA suite to check it is correct.

**`scripts/verify-docs.mjs`** executes every `curl` block in a markdown file
and checks the response still carries the keys the doc shows. A documentation
example that does not run is worse than no example.

**`prisma/proof*.sql`** make the database constraints actually fail. A
constraint that was never made to fail has only been shown to be
syntactically valid.

---

## Deployment

```bash
./deploy.sh
```

Refuses to run on a dirty tree, builds `linux/amd64`, pushes
`ghcr.io/<repo>:<short-sha>`, then re-pulls from the registry to prove the tag
exists before printing the two commands to run on the host:

```bash
docker pull ghcr.io/imransid/gostyle-booking-api:<sha>
docker service update --force --with-registry-auth \
  --image ghcr.io/imransid/gostyle-booking-api:<sha> gostyle-booking_api
```

**Tags are commit SHAs, never `:latest`.** A rollback has to be "deploy the
previous sha" — a specific, immutable artifact — not "hope latest is old
enough". Treat a `:latest` in a deploy path as a bug.

**Migrations do not run on container boot.** They travel inside the image, and
a separate job runs `prisma migrate deploy` from that same image. Deploying the
API alone does not apply a migration, which is worth remembering when a new
column is involved.

---

## What is not built

Honestly, so you do not discover it in an incident.

**Notifications.** Nothing is ever sent. The reminder ladder claims each rung
under `FOR UPDATE SKIP LOCKED` and stamps `reminded_24h_at`, `reminded_3h_at`
or `nudged_15m_at` — but there is no WhatsApp client behind it, and no outbox
row either. The scheduling is real; the delivery is absent.

**A real payment provider.** `PAYMENT_GATEWAY` is wired to `SimulatedGateway`,
which moves no money. It does sign its webhooks with a genuine HMAC, so the
verification path is exercised, but every intent and refund is fictional.

**The upstream services.** Catalogue, staff, shifts, chairs and customers come
from `infrastructure/fixtures`, not from anywhere real. `DbBookingContext`
reads live bookings and holds from Postgres and delegates the rest to
`FixtureBookingContext`. This is also why slugs and uuids coexist — see
CLAUDE.md §8, which is the sharpest edge in the codebase.

**Multi-tenant isolation.** `X-Tenant-Id` is captured and stamped on the rows
you create, and **nothing filters on it**. That is deliberate and documented in
the schema: a filter added before every row carries a value silently hides the
rows written without one. Backfill, then filter, then make it `NOT NULL` — in
that order.

**Branch-level configuration.** There is no branch table. Every constant in
`GET /v1/bookings/settings` is global, so trading hours, deposit rules and the
peak window are the same for every branch. Changing one is a rebuild and a
redeploy.

**Consumer authentication** depends on a gRPC service at `CONSUMER_GRPC_ADDR`.
Customer tokens are verified there, with no local signature check; if that
service is unreachable, customer requests fail with a 500 by design, so an
outage is not reported as an auth failure.
