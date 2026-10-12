import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { branchToday } from './hold.repository';
import type {
  LedgerActorKind,
  LedgerEntryType,
  LedgerRail,
  LedgerRowFacts,
} from '@domain/journal/journal-entry-plan';

/** A ledger row with its booking, as SQL returns it. Named: a heredoc eats a trailing `<`. */
interface LedgerRowSql {
  id: string;
  entry_type: string;
  amount_fils: number;
  rail: string | null;
  actor_kind: string;
  actor_id: string | null;
  created_at: Date;
  journal_attempts: number;
  tenant_id: string;
  booking_id: string;
  code: string;
  branch_id: string;
  net_fils: number | null;
  tax_fils: number | null;
  discount_fils: number | null;
}

interface StatsSql {
  waiting_for_tenant: bigint;
  pending: bigint;
  parked: bigint;
  oldest_pending: Date | null;
}

/** A ledger row claimed for one send. */
export interface DueLedgerRow {
  readonly facts: LedgerRowFacts;
  /** Failed sends so far. */
  readonly attempts: number;
}

export interface JournalSyncStats {
  /** Pending rows whose booking has no tenant_id yet. Should reach 0. */
  readonly waitingForTenant: number;
  readonly pending: number;
  /** Refused by the platform or unmapped: each one needs a person. */
  readonly parked: number;
  /** An hour here means the platform has been unreachable for an hour. */
  readonly oldestPendingSeconds: number | null;
}

/** One money movement on a booking, with how far it got toward the books. */
export interface LedgerSyncRow {
  readonly ledgerEntryId: string;
  readonly entryType: string;
  readonly amountFils: number;
  readonly rail: string | null;
  readonly recordedAt: Date;
  /** null: written before the cutover, never sent. */
  readonly status: string | null;
  readonly entryId: string | null;
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  readonly error: string | null;
  readonly errorCode: string | null;
  /** What the mapping needs. Null when the booking has no tenant yet. */
  readonly facts: LedgerRowFacts | null;
}

export interface BookingLedgerSync {
  readonly tenantId: string | null;
  readonly rows: readonly LedgerSyncRow[];
}

/** journal_error is for a person to read, not a log to archive. */
const ERROR_MAX = 500;

/**
 * The journal_* columns on deposit_ledger: reads and writes them, and nothing
 * else.
 *
 * THE BOOKS ARE ON THE PLATFORM. These columns are the delivery receipt for
 * each ledger row -- pending, posted (with the platform's entry id), parked
 * for a person, or skipped -- and the append-only trigger lets nothing else
 * on the row change. No entry, line or account is stored here.
 *
 * It never talks to the platform. The handler owns the JOURNAL_LEDGER port
 * and hands this repository the outcome of each send (CLAUDE.md 7).
 */
@Injectable()
export class JournalSyncRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Claim up to `limit` pending rows that are due, for this replica alone,
   * with what the mapping needs from their booking.
   *
   * ONE STATEMENT, UPDATE ... WHERE id IN (SELECT ... SKIP LOCKED) RETURNING,
   * as reminder.repository.ts does: replicas divide the work without a lock
   * held across the network call. The claim is a LEASE -- journal_next_at
   * pushed past the longest a batch can take -- so a replica that dies
   * mid-send leaves a row that comes due again on its own. Sending it twice
   * is safe: the key makes the platform replay the first entry.
   *
   * FOR NO KEY UPDATE, not FOR UPDATE: a money write inserting a reversal
   * that links to one of these rows takes KEY SHARE on it, and must not wait
   * behind a claim that changes no key.
   *
   * A booking with no tenant_id cannot be posted -- the platform needs to
   * know whose books -- so its rows are never claimed, only counted.
   * `tenants` empty means every tenant; otherwise only those.
   */
  async claimDue(
    limit: number,
    tenants: readonly string[],
    leaseMs: number,
  ): Promise<DueLedgerRow[]> {
    const allow = [...tenants];
    const rows = await this.prisma.$queryRaw<LedgerRowSql[]>`
      UPDATE deposit_ledger dl
         SET journal_next_at = now() + (${leaseMs} * interval '1 millisecond')
        FROM booking b
       WHERE b.id = dl.booking_id
         AND dl.id IN (
           SELECT d.id
             FROM deposit_ledger d
             JOIN booking bk ON bk.id = d.booking_id
            WHERE d.journal_sync_status = 'pending'
              AND d.journal_next_at <= now()
              AND bk.tenant_id IS NOT NULL
              AND (cardinality(${allow}::text[]) = 0
                   OR bk.tenant_id = ANY(${allow}::text[]))
            -- Then the order the money moved: after a requeue every row
            -- shares one next_at, and a refund should not reach the books
            -- before the capture it refunds.
            ORDER BY d.journal_next_at, d.created_at, d.id
            LIMIT ${limit}
              FOR NO KEY UPDATE OF d SKIP LOCKED
         )
      RETURNING dl.id,
                dl.entry_type::text AS entry_type,
                dl.amount_fils,
                dl.rail::text       AS rail,
                dl.actor_kind::text AS actor_kind,
                dl.actor_id,
                dl.created_at,
                dl.journal_attempts,
                b.tenant_id,
                b.id AS booking_id,
                b.code,
                b.branch_id,
                b.net_fils,
                b.tax_fils,
                b.discount_fils`;

    return rows.map((r) => ({
      facts: toFacts(r),
      attempts: r.journal_attempts,
    }));
  }

  /** The platform has it. `replayed` or not, the outcome is the same. */
  async markPosted(ledgerId: string, entryId: string): Promise<void> {
    await this.prisma.depositLedger.updateMany({
      where: { id: ledgerId, journalSyncStatus: 'pending' },
      data: {
        journalSyncStatus: 'posted',
        journalEntryId: entryId,
        journalNextAt: null,
        journalError: null,
        journalErrorCode: null,
      },
    });
  }

  /** booking-api never posts this one (applied_at_pos: the till does). */
  async markSkipped(ledgerId: string): Promise<void> {
    await this.prisma.depositLedger.updateMany({
      where: { id: ledgerId, journalSyncStatus: 'pending' },
      data: { journalSyncStatus: 'skipped', journalNextAt: null },
    });
  }

  /** No verdict: stay pending, try again at `nextAttemptAt`. */
  async markRetry(
    ledgerId: string,
    error: string,
    nextAttemptAt: Date,
  ): Promise<void> {
    await this.prisma.depositLedger.updateMany({
      where: { id: ledgerId, journalSyncStatus: 'pending' },
      data: {
        journalAttempts: { increment: 1 },
        journalError: error.slice(0, ERROR_MAX),
        journalErrorCode: null,
        journalNextAt: nextAttemptAt,
      },
    });
  }

  /**
   * Refused by the platform, or nothing to map it to. Nothing was written to
   * the books, so the key is still unused: a person fixes the cause and
   * requeues it. `sent` counts the attempt when it went to the platform.
   */
  async markParked(
    ledgerId: string,
    code: string,
    error: string,
    sent: boolean,
  ): Promise<void> {
    await this.prisma.depositLedger.updateMany({
      where: { id: ledgerId, journalSyncStatus: 'pending' },
      data: {
        journalSyncStatus: 'parked',
        ...(sent ? { journalAttempts: { increment: 1 } } : {}),
        journalErrorCode: code,
        journalError: error.slice(0, ERROR_MAX),
        journalNextAt: null,
      },
    });
  }

  /**
   * Put parked rows back in the queue, once their cause is fixed (an account
   * created on the platform, a mapping corrected and deployed). The request
   * is rebuilt from the row on every send, so the next attempt uses the
   * current mapping. Narrowed by `code` and/or `ids`; both empty is every
   * parked row. Returns how many moved.
   */
  async requeue(filter: {
    readonly code?: string | null;
    readonly ids?: readonly string[];
  }): Promise<number> {
    const code = filter.code ?? null;
    const ids = [...(filter.ids ?? [])];
    return this.prisma.$executeRaw`
      UPDATE deposit_ledger
         SET journal_sync_status = 'pending',
             journal_attempts    = 0,
             journal_next_at     = now(),
             journal_error       = NULL,
             journal_error_code  = NULL
       WHERE journal_sync_status = 'parked'
         AND (${code}::text IS NULL OR journal_error_code = ${code}::text)
         AND (cardinality(${ids}::uuid[]) = 0 OR id = ANY(${ids}::uuid[]))`;
  }

  /** For /health. Each count is backed by a partial index. */
  async stats(nowMs = Date.now()): Promise<JournalSyncStats> {
    const [row] = await this.prisma.$queryRaw<StatsSql[]>`
      SELECT
        (SELECT count(*)
           FROM deposit_ledger dl
           JOIN booking b ON b.id = dl.booking_id
          WHERE dl.journal_sync_status = 'pending'
            AND b.tenant_id IS NULL)                                      AS waiting_for_tenant,
        (SELECT count(*) FROM deposit_ledger
          WHERE journal_sync_status = 'pending')                          AS pending,
        (SELECT count(*) FROM deposit_ledger
          WHERE journal_sync_status = 'parked')                           AS parked,
        (SELECT min(created_at) FROM deposit_ledger
          WHERE journal_sync_status = 'pending')                          AS oldest_pending`;

    const oldest = row?.oldest_pending ?? null;
    return {
      waitingForTenant: Number(row?.waiting_for_tenant ?? 0),
      pending: Number(row?.pending ?? 0),
      parked: Number(row?.parked ?? 0),
      oldestPendingSeconds:
        oldest === null
          ? null
          : Math.max(0, Math.round((nowMs - oldest.getTime()) / 1000)),
    };
  }

  /** One booking's money movements, oldest first. Null: no such booking. */
  async forBooking(bookingId: string): Promise<BookingLedgerSync | null> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        tenantId: true,
        code: true,
        branchId: true,
        netFils: true,
        taxFils: true,
        discountFils: true,
        ledger: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      },
    });
    if (booking === null) return null;

    return {
      tenantId: booking.tenantId,
      rows: booking.ledger.map((l) => ({
        ledgerEntryId: l.id,
        entryType: l.entryType,
        amountFils: l.amountFils,
        rail: l.rail,
        recordedAt: l.createdAt,
        status: l.journalSyncStatus,
        entryId: l.journalEntryId,
        attempts: l.journalAttempts,
        nextAttemptAt: l.journalNextAt,
        error: l.journalError,
        errorCode: l.journalErrorCode,
        facts:
          booking.tenantId === null
            ? null
            : toFacts({
                id: l.id,
                entry_type: l.entryType,
                amount_fils: l.amountFils,
                rail: l.rail,
                actor_kind: l.actorKind,
                actor_id: l.actorId,
                created_at: l.createdAt,
                journal_attempts: l.journalAttempts,
                tenant_id: booking.tenantId,
                booking_id: booking.id,
                code: booking.code,
                branch_id: booking.branchId,
                net_fils: booking.netFils,
                tax_fils: booking.taxFils,
                discount_fils: booking.discountFils,
              }),
      })),
    };
  }
}

/** The one place a row and its booking become what the mapping reads. */
function toFacts(r: LedgerRowSql): LedgerRowFacts {
  return {
    ledgerId: r.id,
    entryType: r.entry_type as LedgerEntryType,
    amountFils: r.amount_fils,
    rail: r.rail as LedgerRail | null,
    actorKind: r.actor_kind as LedgerActorKind,
    actorId: r.actor_id,
    // The branch's date, by the same rule as trading_day: a 01:00 payment in
    // the branch is not the previous UTC day's money.
    entryDate: branchToday(r.created_at.getTime()),
    tenantId: r.tenant_id,
    bookingId: r.booking_id,
    bookingCode: r.code,
    branchId: r.branch_id,
    breakdown: {
      netFils: r.net_fils,
      taxFils: r.tax_fils,
      discountFils: r.discount_fils,
    },
  };
}
