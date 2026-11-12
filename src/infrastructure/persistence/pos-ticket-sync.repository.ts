import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { toUuid } from './hold.repository';
import type { StoredBreakdown } from '@domain/booking/stored-money';
import type { DepositRow } from '@domain/journal/deposit-position';
import type {
  BookingForPos,
  PosSyncKind,
  SyncBookingStatus,
} from '@domain/pos/pos-ticket-request';

/** A claimed row, as SQL returns it. Named: a heredoc eats a trailing `<`. */
interface DueRowSql {
  id: string;
  event_id: string;
  booking_id: string;
  kind: string;
  booking_status: string;
  attempts: number;
}

interface StatsSql {
  waiting_for_tenant: bigint;
  pending: bigint;
  parked: bigint;
  oldest_pending: Date | null;
}

interface UnsettledSql {
  id: string;
  tenant_id: string;
  pos_ticket_id: string;
}

/** One event claimed for one send. */
export interface DuePosSync {
  readonly id: string;
  readonly eventId: string;
  readonly bookingId: string;
  readonly kind: PosSyncKind;
  readonly bookingStatus: SyncBookingStatus;
  /** Failed sends so far. */
  readonly attempts: number;
}

export interface PosTicketSyncStats {
  /** Pending rows whose booking has no tenant_id yet. Should reach 0. */
  readonly waitingForTenant: number;
  readonly pending: number;
  /** Refused by the platform: each one needs a person, then a requeue. */
  readonly parked: number;
  /** Growing means the platform has been unreachable that long. */
  readonly oldestPendingSeconds: number | null;
}

/** Everything a send needs from the booking, read at send time. */
export interface BookingPosContext {
  readonly booking: BookingForPos;
  readonly breakdown: StoredBreakdown;
  readonly ledger: readonly DepositRow[];
  /**
   * Who made the booking's latest move into each status, from the history.
   * The check-in's is the staff member who checked them in (the approver of
   * a self check-in). Null for the system.
   */
  readonly actorByStatus: ReadonlyMap<string, string | null>;
}

/** error text is for a person to read, not a log to archive. */
const ERROR_MAX = 500;

/**
 * pos_ticket_sync: reads and writes the queue rows, and the booking's
 * pos_ticket_* columns. Nothing else.
 *
 * It never talks to the platform. The handler owns the POS_TICKET_INTAKE
 * port and hands this repository the outcome of each send (CLAUDE.md 7).
 */
@Injectable()
export class PosTicketSyncRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Queue one booking event for the till. Idempotent on the event: the
   * relay re-delivers an event after any link fails, and a second insert is
   * ON CONFLICT DO NOTHING.
   *
   * ONE STATEMENT, with the tenant allow-list decided by the database
   * against the booking itself: the chain carries no tenant, and a lookup
   * then an insert would be two round trips per event for every event.
   * `tenants` empty means every tenant -- including a booking with none
   * yet, whose row waits (unclaimed, counted) for its tenant.
   *
   * True when a row was written.
   */
  async enqueue(
    row: {
      readonly eventId: string;
      readonly eventAt: Date;
      readonly bookingId: string;
      readonly kind: PosSyncKind;
      readonly bookingStatus: SyncBookingStatus;
    },
    tenants: readonly string[],
  ): Promise<boolean> {
    const allow = [...tenants];
    const written = await this.prisma.$executeRaw`
      INSERT INTO pos_ticket_sync
             (id, event_id, event_at, booking_id, kind, booking_status)
      SELECT gen_random_uuid(), ${row.eventId}::uuid, ${row.eventAt},
             b.id, ${row.kind}::pos_sync_kind, ${row.bookingStatus}
        FROM booking b
       WHERE b.id = ${row.bookingId}::uuid
         AND (cardinality(${allow}::text[]) = 0
              OR b.tenant_id = ANY(${allow}::text[]))
      ON CONFLICT (event_id) DO NOTHING`;
    return written > 0;
  }

  /**
   * Claim up to `limit` rows that are due, for this replica alone -- and
   * only ever THE OLDEST UNFINISHED ROW OF ITS BOOKING. A booking's
   * `completed` must never overtake its `checked_in`, and a void must never
   * overtake the open it voids. A row with an older pending or PARKED row
   * for the same booking waits behind it: a parked open blocks the rest of
   * its visit until a person fixes it, rather than sending a status for a
   * ticket that does not exist.
   *
   * The claimed row stays `pending` (a lease: next_attempt_at pushed past
   * the batch), so its successors stay blocked while it is in flight, and a
   * replica that dies mid-send leaves it to come due again by itself.
   *
   * FOR NO KEY UPDATE OF p SKIP LOCKED, as the journal's claim: replicas
   * divide the work without a lock held across the network call.
   */
  async claimDue(
    limit: number,
    tenants: readonly string[],
    leaseMs: number,
  ): Promise<DuePosSync[]> {
    const allow = [...tenants];
    const rows = await this.prisma.$queryRaw<DueRowSql[]>`
      UPDATE pos_ticket_sync s
         SET next_attempt_at = now() + (${leaseMs} * interval '1 millisecond'),
             updated_at = now()
       WHERE s.id IN (
         SELECT p.id
           FROM pos_ticket_sync p
           JOIN booking b ON b.id = p.booking_id
          WHERE p.status = 'pending'
            AND p.next_attempt_at <= now()
            AND b.tenant_id IS NOT NULL
            AND (cardinality(${allow}::text[]) = 0
                 OR b.tenant_id = ANY(${allow}::text[]))
            AND NOT EXISTS (
              SELECT 1
                FROM pos_ticket_sync o
               WHERE o.booking_id = p.booking_id
                 AND o.status IN ('pending', 'parked')
                 AND (o.event_at, o.id) < (p.event_at, p.id)
            )
          ORDER BY p.next_attempt_at, p.event_at, p.id
          LIMIT ${limit}
            FOR NO KEY UPDATE OF p SKIP LOCKED
       )
      RETURNING s.id, s.event_id, s.booking_id, s.kind::text AS kind,
                s.booking_status, s.attempts`;

    return rows.map((r) => ({
      id: r.id,
      eventId: r.event_id,
      bookingId: r.booking_id,
      kind: r.kind as PosSyncKind,
      bookingStatus: r.booking_status as SyncBookingStatus,
      attempts: r.attempts,
    }));
  }

  /** The platform has it. */
  async markDone(id: string, ticketId: string | null): Promise<void> {
    await this.prisma.posTicketSync.updateMany({
      where: { id, status: 'pending' },
      data: {
        status: 'done',
        ticketId,
        lastError: null,
        lastErrorCode: null,
      },
    });
  }

  /** Nothing to send, and why (an open for a visit that has since ended). */
  async markSkipped(id: string, reason: string): Promise<void> {
    await this.prisma.posTicketSync.updateMany({
      where: { id, status: 'pending' },
      data: {
        status: 'skipped',
        lastError: reason.slice(0, ERROR_MAX),
        lastErrorCode: null,
      },
    });
  }

  /** No verdict: stay pending, try again at `nextAttemptAt`. */
  async markRetry(
    id: string,
    code: string | null,
    error: string,
    nextAttemptAt: Date,
  ): Promise<void> {
    await this.prisma.posTicketSync.updateMany({
      where: { id, status: 'pending' },
      data: {
        attempts: { increment: 1 },
        lastError: error.slice(0, ERROR_MAX),
        lastErrorCode: code,
        nextAttemptAt,
      },
    });
  }

  /** Refused by the platform: a person fixes the cause, then requeues it. */
  async markParked(id: string, code: string, error: string): Promise<void> {
    await this.prisma.posTicketSync.updateMany({
      where: { id, status: 'pending' },
      data: {
        status: 'parked',
        attempts: { increment: 1 },
        lastErrorCode: code,
        lastError: error.slice(0, ERROR_MAX),
      },
    });
  }

  /**
   * Put parked rows back in the queue, once their cause is fixed (the
   * service added to the tenant's menu, the branch created). The request is
   * rebuilt from the booking on every send. Narrowed by `code` and/or `ids`;
   * both empty is every parked row. Returns how many moved.
   */
  async requeue(filter: {
    readonly code?: string | null;
    readonly ids?: readonly string[];
  }): Promise<number> {
    const code = filter.code ?? null;
    const ids = [...(filter.ids ?? [])];
    return this.prisma.$executeRaw`
      UPDATE pos_ticket_sync
         SET status          = 'pending',
             attempts        = 0,
             next_attempt_at = now(),
             last_error      = NULL,
             last_error_code = NULL,
             updated_at      = now()
       WHERE status = 'parked'
         AND (${code}::text IS NULL OR last_error_code = ${code}::text)
         AND (cardinality(${ids}::uuid[]) = 0 OR id = ANY(${ids}::uuid[]))`;
  }

  /** For /health. Each count is backed by a partial index. */
  async stats(nowMs = Date.now()): Promise<PosTicketSyncStats> {
    const [row] = await this.prisma.$queryRaw<StatsSql[]>`
      SELECT
        (SELECT count(*)
           FROM pos_ticket_sync s
           JOIN booking b ON b.id = s.booking_id
          WHERE s.status = 'pending'
            AND b.tenant_id IS NULL)                                 AS waiting_for_tenant,
        (SELECT count(*) FROM pos_ticket_sync
          WHERE status = 'pending')                                  AS pending,
        (SELECT count(*) FROM pos_ticket_sync
          WHERE status = 'parked')                                   AS parked,
        (SELECT min(created_at) FROM pos_ticket_sync
          WHERE status = 'pending')                                  AS oldest_pending`;

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

  /**
   * The booking as a send needs it, read NOW. Safe to build the request
   * from the current state: once a visit is checked in, its items and
   * prices cannot change (only "shorten" moves, and only the duration).
   * Null: no such booking, or one with no tenant.
   */
  async bookingFor(bookingId: string): Promise<BookingPosContext | null> {
    const b = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        code: true,
        tenantId: true,
        branchId: true,
        startAt: true,
        status: true,
        customerId: true,
        groupId: true,
        netFils: true,
        taxFils: true,
        discountFils: true,
        items: {
          orderBy: { position: 'asc' },
          select: {
            id: true,
            serviceId: true,
            serviceName: true,
            staffId: true,
            priceFils: true,
            durationMin: true,
          },
        },
        products: {
          orderBy: { position: 'asc' },
          select: {
            id: true,
            productId: true,
            productName: true,
            priceFils: true,
            quantity: true,
          },
        },
        ledger: {
          select: { entryType: true, amountFils: true, vatFils: true },
        },
        statusHistory: {
          orderBy: { createdAt: 'desc' },
          select: { toStatus: true, actorId: true },
        },
      },
    });
    if (b === null || b.tenantId === null) return null;

    // Newest first, so the first one seen per status is the latest move.
    const actorByStatus = new Map<string, string | null>();
    for (const h of b.statusHistory) {
      if (!actorByStatus.has(h.toStatus)) {
        actorByStatus.set(h.toStatus, h.actorId);
      }
    }

    return {
      booking: {
        id: b.id,
        code: b.code,
        tenantId: b.tenantId,
        branchId: b.branchId,
        startAt: b.startAt,
        status: b.status,
        customerId: b.customerId,
        // A guest lane's customer id is the folded group id
        // (group-confirm.repository.ts): it names no person.
        isGuest: b.groupId !== null && b.customerId === toUuid(b.groupId),
        items: b.items,
        products: b.products,
      },
      breakdown: {
        netFils: b.netFils,
        taxFils: b.taxFils,
        discountFils: b.discountFils,
      },
      ledger: b.ledger.map((l) => ({
        entryType: l.entryType,
        amountFils: l.amountFils,
        vatFils: l.vatFils,
      })),
      actorByStatus,
    };
  }

  /**
   * The till opened this ticket for the visit. Not over a settled booking:
   * the ticket that paid is the one the paid callback wrote.
   */
  async setTicket(
    bookingId: string,
    ticketId: string,
    ticketNumber: string,
  ): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE booking
         SET pos_ticket_id = ${ticketId}::uuid,
             pos_ticket_number = ${ticketNumber},
             updated_at = now()
       WHERE id = ${bookingId}::uuid
         AND status <> 'settled'`;
  }

  /**
   * The till voided this ticket. Only that ticket: a newer one opened by a
   * second check-in is left alone.
   */
  async clearTicket(bookingId: string, ticketId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE booking
         SET pos_ticket_id = NULL,
             pos_ticket_number = NULL,
             updated_at = now()
       WHERE id = ${bookingId}::uuid
         AND pos_ticket_id = ${ticketId}::uuid
         AND status <> 'settled'`;
  }

  /**
   * The safety net's worklist: visits completed with a live ticket, still
   * not settled, and quiet for `minAgeMs` -- long enough that a paid
   * callback should have arrived if the ticket was paid. Oldest first.
   */
  async unsettledCompleted(
    minAgeMs: number,
    limit: number,
    tenants: readonly string[],
  ): Promise<{ bookingId: string; tenantId: string; posTicketId: string }[]> {
    const allow = [...tenants];
    const rows = await this.prisma.$queryRaw<UnsettledSql[]>`
      SELECT b.id, b.tenant_id, b.pos_ticket_id
        FROM booking b
       WHERE b.status = 'completed'
         AND b.pos_ticket_id IS NOT NULL
         AND b.tenant_id IS NOT NULL
         AND b.updated_at <= now() - (${minAgeMs} * interval '1 millisecond')
         AND (cardinality(${allow}::text[]) = 0
              OR b.tenant_id = ANY(${allow}::text[]))
       ORDER BY b.updated_at
       LIMIT ${limit}`;
    return rows.map((r) => ({
      bookingId: r.id,
      tenantId: r.tenant_id,
      posTicketId: r.pos_ticket_id,
    }));
  }
}
