# gostyle-booking-api

NestJS + CQRS booking API over Postgres (Prisma). Salon bookings: availability,
holds, confirmation, money, waitlist, groups.

## Commands

```bash
pnpm dev         # docker compose up + nest start --watch on :3099
pnpm test:unit   # vitest, src/domain/**/*.spec.ts only
pnpm typecheck   # tsc --noEmit
pnpm lint
```

CI (`.github/workflows`) gates publish behind typecheck + lint + test:unit.

## Layers

`interface/http` → `application` (handlers own ports) → `domain` (pure).
`infrastructure` implements the ports and is injected downward, never upward.
Aliases: `@domain`, `@application`, `@infrastructure`, `@interface`.

---

## 1. Domain first, with tests, before any wiring

The rule goes in `src/domain/<area>/<rule>.ts` with `<rule>.spec.ts` beside it —
no Nest imports, no Prisma, no mocks needed. Wiring follows once it passes.
`domain/availability/party.ts` + its spec landed alone (c42cf82); schema, hold,
confirm and lifecycle were built on top of it afterwards.

## 2. Money in fils, never floats

Money is whole fils (1 AED = 100 fils) carried by `Money` in
`src/domain/shared/money.ts`. The constructor rejects a fractional fil outright.
Round once, at the percentage (`percent`, `roundToDirhams`) — never downstream.
Split with `allocate`/`split` (largest-remainder: parts always sum back to the
whole). Decimals appear only in `toDisplay()`. Columns are `INTEGER` and
`_fils`-suffixed: `price_fils`, `deposit_fils`, `share_fils`.

## 3. Constraints and partial indexes in raw SQL

Anything Prisma cannot express — `CHECK`, `EXCLUDE`, constraint triggers,
sequences, and any index with a `WHERE` — is hand-written below the generated
block in the migration, with a comment saying why. See
`prisma/migrations/20260828083321_booking_groups/migration.sql`
(`participant_is_customer_or_guest`, and the deferred `group_size_check`
trigger: a CHECK cannot count rows in another table, and an immediate trigger
would reject every group at its first insert) and
`20260827090435_auto_no_show_index/migration.sql` (partial on
`status = 'confirmed'` — the sweeper scans it every minute forever; unpredicated
it grows without bound).

Make them retry-safe (`CREATE INDEX IF NOT EXISTS`) — 5208162 and aa47bc9 were
both fixes for migrations that were not. Plain composite indexes stay in
`schema.prisma` as `@@index([...], map: "explicit_name")`.

## 4. One source of truth: share, don't copy

Two copies are two things to change, and one eventually lags. `planParty` is
imported by both `group-hold.repository.ts` and `group-confirm.repository.ts`;
`priceOf` is imported from `confirm-booking.handler.ts` into the group path. CI
pins no pnpm version because `package.json`'s `packageManager` field is the
source of truth and the action reads it.

Prefer deriving over storing a second copy: a group's status is computed from
its participants (`domain/booking/group-status.ts`), because a stored status and
the participant statuses can disagree and the stored one is always wrong. Where
a derived value must be stored (`active_count`), it is because the change is
otherwise unobservable — a party of three losing one is still `confirmed`.

## 5. Prove it live before committing

Unit tests prove the domain; only the running system proves the wiring and the
constraints. A constraint that was never made to fail has only been shown to be
syntactically valid. Pattern: `prisma/proof.sql`, `prisma/proof3.sql` —
`\set ON_ERROR_STOP off`, seed a realistic scenario, then numbered
`=== TEST n: ... MUST FAIL ===` inserts so expected errors print in order and a
silent success shows up as a missing error. Report what actually happened.

## 6. Deploy by commit SHA, never `:latest`

The server deploys `ghcr.io/<repo>:sha-<short>` (`type=sha,prefix=sha-` in the
publish job). A rollback must be "deploy the previous sha" — a specific known
artifact — not "hope latest is old". Treat a `:latest` reference in a deploy
path as a bug.

## 7. Persistence never injects an application port

The handler owns the ports and passes the repository what it needs. A repository
reaching into an application port to ask a question about the world inverts the
dependency the port was drawn to prevent. `GroupHoldRepository` injecting
`BOOKING_CONTEXT` failed at boot, correctly — Nest refused to wire it.

So `GroupHoldInput.roster` is resolved by the caller:
`group-hold.handler.ts` already holds `BOOKING_CONTEXT`, resolves the roster and
chair registry, and hands them down. Persistence stays a thing that reads and
writes rows.

## 8. The slug/uuid boundary

The fixture catalogue and roster speak slugs (`"maya"`, `"full-colour"`); the
columns are `uuid`. Writes fold through `toUuid()` (`hold.repository.ts`), so
**anything reading an id back holds the hash** and a slug-keyed lookup silently
misses. That has bitten four times in one feature — a lost Gold discount, a
waitlist that matched nobody, a failed catalogue lookup, an accept for a
professional who did not exist. All silent, all only visible by running the flow.

Use `SlugIndex` (`persistence/slug-uuid.ts`) or share an existing lookup. Never
add another local conversion — each one is a place to forget. All of this goes
when the real services speak uuids.

## 9. Read the log before theorising

When something silently does nothing, read the application log first. Errors are
logged at ERROR level from the first attempt, not only after retries are
exhausted — see `outbox-relay.service.ts` (first failure, then every thirtieth)
and `group-status-listener.ts` (logs and continues; the event is delivered
anyway). The answer is usually already printed.
