# Journal integration: booking money in the general ledger

Every row of `deposit_ledger` (a capture, refund, forfeit, goodwill credit, revived no-show or course draw) becomes **exactly one balanced journal entry** in the salon's books on the platform. The platform side is `JournalLedger` over gRPC: see gostyle-platform `docs/booking-api-journal-setup.md` and `docs/grpc-journal-ledger.md`.

**The books live on the platform.** booking-api stores no journal entry, line or account. Each ledger row carries only a delivery receipt in its `journal_*` columns: whether it has reached the books yet and, once it has, the platform's entry id. That receipt is needed because the platform cannot tell us about an entry it never received: without it, a payment made while the platform was down or deploying would never reach the books.

## How it flows

```
money written ──▶ deposit_ledger row, journal_sync_status = 'pending'   (column default)
                        │  JournalSyncWorker, every 5s, only when JOURNAL_POSTING_ENABLED=true
                        ▼
      planJournalEntry(row + booking) ──▶ skip ──▶ skipped
                        │             └──▶ no mapping ──▶ parked
                        ▼
      CreateJournalEntry ──▶ posted (journal_entry_id) │ parked (refused) │ pending + backoff
```

| Piece | Where |
|---|---|
| Account mapping, VAT split, the request | `src/domain/journal/journal-entry-plan.ts` (pure, tested) |
| Account system keys | `src/domain/journal/accounts.ts` |
| Backoff (10s doubling, 10 min cap, no attempt limit) | `src/domain/journal/posting-backoff.ts` |
| gRPC client | `src/infrastructure/grpc/journal-grpc.module.ts`, `grpc-journal-ledger.ts`, `proto/journal.proto` (copied unchanged from the platform) |
| Port | `src/application/ports/journal-ledger.port.ts` |
| Receipt columns, guard, indexes | migration `20261006120000_deposit_ledger_journal_sync` |
| Claiming and marking rows | `src/infrastructure/persistence/journal-sync.repository.ts` |
| What an answer means | `src/application/commands/journal-sync.handler.ts` |
| A booking's journal | `src/application/queries/booking-journal.handler.ts` |
| Clock | `src/infrastructure/scheduling/journal-sync-worker.service.ts` |

**Every new row is pending by default, with no code involved.** `deposit_ledger` is written from eight repositories. The column default marks each new row `pending`, so no write path can forget to send it.

**`deposit_ledger` stays append-only, except for the receipt.** The guard trigger `gs_deposit_ledger_append_only` lets an UPDATE through only when nothing but the `journal_*` columns changed. Money, type, rail, actor and time stay immutable, and a DELETE is still refused.

**The request is rebuilt from the row on every send, never stored.**
- It comes out the same every time: the date comes from the row's own `created_at`, and the amounts from the row and its booking. That is what lets the platform replay a key.
- It would differ only if the booking's tax breakdown changed between a send that landed unseen and its retry. The platform then answers `IDEMPOTENCY_KEY_REUSED`, and the row parks for a person rather than posting twice.
- The idempotency key is `deposit-ledger:<deposit_ledger.id>`.

## The columns

| Column | Meaning |
|---|---|
| `journal_sync_status` | `pending`, `posted`, `parked` or `skipped`. **NULL is a row from before the cutover**, never sent |
| `journal_entry_id` | The platform's entry, once posted. What a void needs |
| `journal_attempts` | Failed sends so far |
| `journal_next_at` | When to send next. NULL once there is nothing left to send |
| `journal_error`, `journal_error_code` | Why it is waiting or parked (`ACCOUNT_NOT_FOUND`, `INVALID_ARGUMENT`, `NO_MAPPING`, ...) |

## Account heads the platform must add (prerequisite)

Add these to `AccountSystemKey` and the seed in `packages/nest-kernel/src/kernel/chart-of-accounts.ts`, and seed them for every existing tenant. None of these codes is taken by the current seed.

| system_key | Code | Name | Kind | Holds |
|---|---|---|---|---|
| `CUSTOMER_DEPOSITS` | 2300 | Customer Deposits | LIABILITY | Money held against bookings until served or forfeited |
| `CUSTOMER_WALLET` | 2310 | Customer Wallet Balances | LIABILITY | Credit owed to customers in their wallet |
| `CANCELLATION_FEE_INCOME` | 4020 | Cancellation & No-show Fees | INCOME | Forfeited deposits |
| `FRONT_DESK_CASH` | 1030 | Front Desk Cash (Bookings) | ASSET | Deposit cash taken at the desk outside the till |
| `PAYMENTS_CLEARING` | 1060 | Payments Clearing | ASSET | Money in by an unidentified method, to reclassify |

Until a key exists on the platform, it refuses the posting with `INVALID_ARGUMENT`, and the row parks with nothing written. Once the keys are deployed, requeue the parked rows (see below).

Also owed by the platform:
- A POS "booking deposit" tender that debits `CUSTOMER_DEPOSITS`. booking-api never posts `applied_at_pos` rows (they are `skipped`); the till must.
- When that tender exists, it must not charge VAT again on the deposit part of the ticket: that VAT was declared when the deposit was received.

## The mapping

`A` is `|amount_fils|`. The side comes from `entry_type` only, never from the sign. The money account depends on the row's `rail` (table further down).

When the booking has VAT, `A` is split into `n` (the net share) and `v` (the VAT share), in the proportion of the booking's own `net_fils`, `tax_fils` and `discount_fils`. The split is done once, by largest remainder, so `n + v = A` always. With no VAT on the booking, `v = 0` and `n = A`. Zero lines are dropped.

| entry_type | Debit | Credit |
|---|---|---|
| `captured` | money `A` | `CUSTOMER_DEPOSITS` `n`, `SALES_TAX_PAYABLE` `v` |
| `refunded` | `CUSTOMER_DEPOSITS` `n`, `SALES_TAX_PAYABLE` `v` | money `A` |
| `goodwill` | `CUSTOMER_GOODWILL` `A` | `CUSTOMER_DEPOSITS` `n`, `SALES_TAX_PAYABLE` `v` |
| `forfeited` | `CUSTOMER_DEPOSITS` `n` | `CANCELLATION_FEE_INCOME` `n` |
| `reversed` (revived no-show) | `CANCELLATION_FEE_INCOME` `n` | `CUSTOMER_DEPOSITS` `n` |
| `course_draw` | `CUSTOMER_DEPOSITS` `n` | `SERVICE_INCOME` `n` |
| `applied_at_pos` | skipped: the POS tender owns it | |
| `partially_refunded`, negative `reversed`, a capture or refund with no rail | parked `NO_MAPPING` | |

The VAT rule:
- **Every Deposits leg is net of VAT.**
- **VAT moves with money crossing the boundary:** a capture, a refund, or a goodwill credit.
- **VAT stays put when Deposits becomes income:** a forfeit or a course draw moves only the net share.

The money account, by rail:

| rail | money account |
|---|---|
| `card`, `apple_pay`, `google_pay`, `link` | `UNDEPOSITED_FUNDS` |
| `wallet` | `CUSTOMER_WALLET` |
| `cash` | `FRONT_DESK_CASH` |
| `other` | `PAYMENTS_CLEARING` |
| `internal` | `CUSTOMER_WALLET` on a refund, `PAYMENTS_CLEARING` on a capture |

The rest of the request:

| Field | Value |
|---|---|
| `entry_date` | The branch-local date of `deposit_ledger.created_at` (`branchToday`, in `BRANCH_TIMEZONE`, Asia/Dhaka by default: the same zone as `trading_day`) |
| `source_id` | The booking id |
| `memo` | e.g. `Deposit captured (card), booking GS-1010` |
| `branch_id` | Set on every line |
| `customer_id` | Always `''`: booking customer ids are not platform customer ids |
| `posted_by_id` | `actor_id` when the actor is staff or a manager, else `''` |

A booking with no `tenant_id` is never sent; its rows wait as `pending`, counted as `waitingForTenant`. A `tenant_id` that is not a UUID parks as `TENANT_NOT_UUID`.

## What an answer means

| Platform answer | Row becomes |
|---|---|
| An entry, `replayed` true or false | `posted`, with `journal_entry_id` |
| `INVALID_ARGUMENT`, `NOT_FOUND`, `FAILED_PRECONDITION`, `PERMISSION_DENIED`, `ALREADY_EXISTS` | `parked`, `journal_error_code` = the platform's `error-code` (or the status), logged at ERROR |
| Anything else (`UNAVAILABLE`, `DEADLINE_EXCEEDED`, `UNKNOWN`, timeouts, ...) | stays `pending`; sent again after the backoff, with no attempt limit |

Rows are sent in the order the money moved.

## Switches

| Env | Default | Meaning |
|---|---|---|
| `JOURNAL_POSTING_ENABLED` | `false` | Send to the platform. Off, nothing moves: new rows wait as `pending` with their own dates and go when it is turned on |
| `JOURNAL_POSTING_TENANTS` | empty | A comma-separated allow-list of tenant ids for sending. Empty means every tenant |
| `PLATFORM_GRPC_ADDR` | `platform-api:50052` | Shared with the directories. In production it is `gostyle_api:50052`, never `api` |

## Rollout

1. **Platform first:**
   - the release with migration `20260930090000_journal_source_booking`;
   - the five account heads above.
2. **Ship booking-api with sending off.**
   - New money rows wait as `pending`.
   - `GET /v1/bookings/:id/journal` shows, for each one, the entry it will post (`plan`).
3. **Turn sending on for one tenant:**
   - set `JOURNAL_POSTING_ENABLED=true` and `JOURNAL_POSTING_TENANTS=<tenant>`;
   - check the entries in the console's journal report;
   - reconcile Deposits (below).
4. **Clear the allow-list for every tenant, once the till takes the deposit as a tender.** Before that, a deposit used at checkout is either missing from the books or in them twice.

## Operating it

**Health.** `GET /health` has a `journal` block:
- `parked > 0` marks the service `degraded`. Each parked row is money that will not reach the books until somebody acts.
- `oldestPendingSeconds` growing means the platform has been unreachable that long, unless `sendingEnabled` is false.

**One booking.** `GET /v1/bookings/:id/journal` (desk) returns:
- **`entries`:** the booking's journal entries, read from the platform.
- **`movements`:** every money movement with its sync status, and, for one not yet posted, the entry it will post.

**Requeue.** `POST /v1/journal/requeue` (manager), with body `{ "code"?, "ids"? }`.
- It moves `parked` rows back to `pending`.
- The entry is rebuilt from the row under the current mapping. That is safe because a refused row wrote nothing, so its key is still unused.

**Correcting a posted entry.** Use `VoidJournalEntry` on the row's `journal_entry_id`, then post the replacement under `deposit-ledger:<id>:2` (`journalKey(id, 2)`). The port supports both calls; there is no endpoint for it yet. Business events (refunds, revivals, goodwill) are new ledger rows and need no void.

**Posting history.** The cutover is the migration: rows written before it have a NULL status and are never sent. To post them as well, with their original dates:

```sql
UPDATE deposit_ledger
   SET journal_sync_status = 'pending', journal_next_at = now()
 WHERE journal_sync_status IS NULL;
```

Otherwise, post one opening entry per tenant for the deposits held at the cutover.

**Reconciling.** Because every Deposits leg is net of VAT, the platform's `CUSTOMER_DEPOSITS` credit balance should equal the sum of the posted rows' net shares, per tenant. Also check that every row since the cutover is `posted` or `skipped`:

```sql
SELECT journal_sync_status, count(*) FROM deposit_ledger
 WHERE journal_sync_status IS NOT NULL GROUP BY 1;
```

Until the till posts `applied_at_pos`, the GL balance runs higher than the subledger by exactly the deposits applied at the till.

## Proof

- `prisma/proof-journal.sql` covers the new-row default, the receipt update, the append-only guard (money changes and deletes refused, including a money change slipped in alongside a receipt update) and the CHECKs, each made to fail on purpose. It runs in a transaction and rolls back.
