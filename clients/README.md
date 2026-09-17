# Booking API — front end integration

A typed client for the single-booking flow: availability → quote → hold →
confirm → lifecycle. Zero dependencies, global `fetch`, works in the browser,
Node 18+, Bun and Deno.

- [`gostyle-booking-client.ts`](./gostyle-booking-client.ts) — the client
- [`example.ts`](./example.ts) — the whole flow as a runnable script

Copy the client into your app, or publish this folder as an internal package.
It imports nothing from the server.

```bash
BASE_URL=http://localhost:3099 TOKEN=<staff jwt> npx ts-node clients/example.ts
```

## Quick start

```ts
import { BookingClient } from './gostyle-booking-client';

const api = new BookingClient({
  baseUrl: 'http://localhost:3099', // origin only, no /v1
  token: () => auth.accessToken, // called before every request
  defaultBranch: 'marina-walk',
});

const { topOffers } = await api.availability({
  day: '2027-05-13',
  services: ['full-colour'],
});

const quote = await api.quote({
  day: '2027-05-13',
  serviceIds: ['full-colour'],
  customerId: 'dana',
  startMin: topOffers[0].startMin,
});

const hold = await api.placeHold({
  day: '2027-05-13',
  services: ['full-colour'],
  startMin: topOffers[0].startMin,
  staffId: topOffers[0].assignedTo.id,
});

const booking = await api.confirm({
  holdId: hold.holdId,
  day: '2027-05-13',
  services: ['full-colour'],
  customerId: 'dana',
  amountMinor: quote.depositMinor,
  rail: 'CARD',
  gatewayRef: paymentIntent.id,
});
// booking.code -> "GS-1007"
```

## Before your first request

**The server must allow your origin.** The API reads `CORS_ORIGINS`, a comma
separated allowlist. Unset means localhost dev ports only (3000, 3001, 4200,
5173, 8080), so a deployed front end gets nothing until it is listed:

```bash
CORS_ORIGINS=https://app.gostyle.ae,https://desk.gostyle.ae
```

A blocked request fails in the browser before the server sees it, so the API
logs stay empty and it looks like your bug. The client reports it as
`NetworkError` rather than a status code.

**Every route needs a bearer token** except `GET /health`,
`GET /v1/availability` and `GET /v1/availability/catalogue`. A catalogue and a
slot picker can therefore render before sign-in; everything from `quote()`
onwards cannot.

Mint a dev staff token:

```bash
node -e "console.log(require('jsonwebtoken').sign({
  sub: '22222222-2222-2222-2222-222222222222',
  roles: ['branch_manager'],
  branchId: '11111111-1111-1111-1111-111111111111'
}, 'dev-access-change-me', { issuer: 'gostyle-api', expiresIn: '1h' }))"
```

Staff tokens are verified locally. **Customer tokens are verified over gRPC
against the consumer API**, so if that service is down every customer request
answers `503` — `DependencyUnavailableError` — while staff tokens keep
working. That is a dependency outage, not a booking fault; say so in the UI
and retry rather than reporting a failed booking.

## The flow

| Call                            | Route                            | Needs token | Gives you                                         |
| ------------------------------- | -------------------------------- | ----------- | ------------------------------------------------- |
| `catalogue()`                   | `GET /v1/availability/catalogue` | no          | service ids, durations                            |
| `availability()`                | `GET /v1/availability`           | no          | `topOffers` (show 3), `offers` (grid), `refusals` |
| `quote()`                       | `POST /v1/bookings/quote`        | yes         | totals, `depositMinor`, requirement trace         |
| `placeHold()`                   | `POST /v1/holds`                 | yes         | `holdId`, 15 minute `expiresAt`                   |
| `releaseHold()`                 | `DELETE /v1/holds/:id`           | yes         | the slot back, immediately                        |
| `confirm()`                     | `POST /v1/bookings`              | yes         | the booking and its `code`                        |
| `getBooking()`                  | `GET /v1/bookings/:id`           | yes         | items, ledger, history                            |
| `checkIn/start/complete/settle` | `POST /v1/bookings/:id/…`        | yes         | the transition, and a receipt on settle           |

Availability is advice, a hold is a promise, and only `confirm()` creates
anything. **Nothing is ever charged on an error path.**

## Conventions that will bite you

**Money is integer fils.** 1 AED = 100 fils, so `24000` is AED 240.00. Never
send a decimal. Every money field arrives with a formatted twin —
`depositMinor: 24000` and `deposit: "AED 240.00"` — so render the twin and
compute with the integer.

**Times are minutes from midnight**, in the branch timezone (Asia/Dubai), on a
`YYYY-MM-DD` trading day. `610` is 10:10. Offers carry both (`startMin: 610`,
`start: "10:10"`). `startAt` / `endAt` on a booking are true ISO instants, for
a calendar.

**Enums are SHOUTED on the wire**: `CONFIRMED`, `DEPOSIT_PAID`, `CARD`.

**`channel` has two spellings, and the wrong one is a 400.** `quote()` takes
`'DESK' | 'ONLINE'`; `availability()`, `placeHold()` and `confirm()` take
`'desk' | 'online'`. The client's types keep them apart — let TypeScript check
it rather than remembering.

**Service order matters.** `['full-colour', 'blow-dry']` is booked in that
order, and the duration and price depend on it.

**`amountMinor` and `rail` travel together.** Send one without the other and
the server records no payment at all — the booking exists, unpaid, with no
error to tell you. Omit both only when the requirement was `NONE`.

**Ids are fixture slugs today** (`'maya'`, `'full-colour'`, `'dana'`), not
uuids. They become uuids when the real services land; keep them opaque
strings and do not parse them.

**Every POST answers 201**, including `quote()` and the lifecycle
transitions. Do not branch on `=== 200`.

## Holds and the countdown

A hold lives 15 minutes. Drive the countdown from `expiresAt`, never by
decrementing `expiresInSeconds` — that number was true when the response was
built, and a slow render or a sleeping laptop makes it a lie.

```tsx
import {
  secondsLeft,
  formatCountdown,
  type Hold,
} from './gostyle-booking-client';

function HoldCountdown({ hold, onExpired }: { hold: Hold; onExpired(): void }) {
  const [left, setLeft] = useState(() => secondsLeft(hold));

  useEffect(() => {
    const t = setInterval(() => {
      const s = secondsLeft(hold);
      setLeft(s);
      if (s === 0) onExpired(); // send them back to availability
    }, 1000);
    return () => clearInterval(t);
  }, [hold, onExpired]);

  return <span>{formatCountdown(left)}</span>;
}
```

Release the hold when the customer backs out (`releaseHold()`), including on
unmount. The slot returns to the grid in the same statement, rather than
sitting dead for the rest of the TTL.

## Idempotency

`confirm()` sends an `Idempotency-Key`. **Generate it once per booking
attempt and reuse it on every retry** — the same key replays the original
booking (`replayed: true`) and charges nothing; a new key books again.

```ts
const key = newIdempotencyKey(); // once, when the user hits Pay
await api.confirm(input, { idempotencyKey: key });
// on a timeout or a 5xx, retry with the SAME key
```

If you let the client generate one per call, a retry becomes a second
booking. That is the one mistake in this API that costs real money.

## Errors

Every error is a `BookingApiError` with `status`, `message` (written to be
shown to a human) and `body`.

| Class                        | Status | What happened                                | What the UI should do                           |
| ---------------------------- | ------ | -------------------------------------------- | ----------------------------------------------- |
| `ValidationError`            | 400    | malformed request; `.details` has the fields | fix the form; log it, users cannot              |
| `UnauthorizedError`          | 401    | no or expired token                          | sign in again                                   |
| `ForbiddenError`             | 403    | customer token on a desk-only route          | hide the action; signing in again will not help |
| `NotFoundError`              | 404    | no such booking                              | refresh the list                                |
| `ConflictError`              | 409    | slot taken, or gateway ref already recorded  | re-run `availability()`, offer new times        |
| `HoldExpiredError`           | 410    | the hold died or was released                | back to availability; **nothing was charged**   |
| `UnprocessableError`         | 422    | understood and refused, with a reason        | show `error.message`                            |
| `DependencyUnavailableError` | 503    | consumer auth is down                        | retry later; not a booking fault                |
| `NetworkError`               | 0      | offline, DNS, timeout, or CORS               | retry; check `CORS_ORIGINS`                     |

```ts
try {
  await api.confirm(input, { idempotencyKey: key });
} catch (e) {
  if (isHoldExpired(e)) return restartFromAvailability();
  if (isConflict(e)) return showTaken(e.message);
  throw e;
}
```

## Empty days

An empty `offers` array always comes with a reason — `refusals` (who was
considered and why they were not offered) or `closureReason`. Show it. An
unexplained empty window is a support ticket; the API is written so you never
have to produce one.
