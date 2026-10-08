import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from './prisma.service';
import { toUuid } from './hold.repository';
import type { ActorKind, BookingStatus } from '@domain/booking/lifecycle';
import {
  lapseOf,
  raiseVerdict,
  type CheckInRequestState,
  type RaiseRefusal,
} from '@domain/booking/check-in-request';

/**
 * DID THE CUSTOMER SAY THEY ARRIVED? As SQL, because the auto no-show
 * sweeper has to FILTER on it, and the one copy is shared by both places
 * that ask (CLAUDE.md 4):
 *
 *   no-show-sweeper.service.ts   AND NOT <this>, in its candidate query
 *   lifecycle.repository.ts      <this>, again inside the booking's row lock
 *
 * True when the booking's LATEST request is anything but rejected: waiting,
 * and also expired, approved or closed. Only the desk saying no hands the
 * booking back to the sweeper; domain/booking/check-in-request.ts says why.
 *
 * WHY IN THE QUERY, NOT IN THE LOOP. The sweeper takes the oldest 50 due
 * bookings. Skipped in the loop instead, a claimed booking would keep its
 * place among the 50 every minute, and enough of them would stop the
 * sweeper reaching anybody else, with nothing in any log to say so.
 *
 * `bookingId` is SQL for the booking's id: a column (Prisma.sql`b.id`) or a
 * bound value (Prisma.sql`${id}::uuid`).
 */
export function arrivalClaimed(bookingId: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`EXISTS (
      SELECT 1
        FROM (SELECT r.state
                FROM check_in_request r
               WHERE r.booking_id = ${bookingId}
               ORDER BY r.raised_at DESC, r.id DESC
               LIMIT 1) latest
       WHERE latest.state <> 'rejected')`;
}

export interface CheckInRequestRow {
  readonly id: string;
  readonly bookingId: string;
  readonly state: CheckInRequestState;
  readonly raisedAt: Date;
  readonly raisedByKind: ActorKind;
  readonly decidedAt: Date | null;
  readonly decidedByKind: ActorKind | null;
  readonly reason: string | null;
}

const ROW_FIELDS = {
  id: true,
  bookingId: true,
  state: true,
  raisedAt: true,
  raisedByKind: true,
  decidedAt: true,
  decidedByKind: true,
  reason: true,
} as const;

export interface RaiseInput {
  readonly bookingId: string;
  readonly actor: ActorKind;
  readonly actorId: string;
  /** Test hook. A route passes the server's clock, never the caller's. */
  readonly nowMs?: number;
}

export type RaiseOutcome =
  | { readonly kind: 'raised'; readonly request: CheckInRequestRow }
  | { readonly kind: 'already_waiting'; readonly request: CheckInRequestRow }
  | { readonly kind: 'not_found' }
  | {
      readonly kind: 'refused';
      readonly why: RaiseRefusal;
      readonly bookingStatus: BookingStatus;
      readonly opensAtMs?: number;
    };

/** One lapse the job wrote. */
export interface LapsedRequest {
  readonly id: string;
  readonly code: string;
  readonly to: 'expired' | 'closed';
}

/** Named: a heredoc eats a line ending in `<`. */
interface LockedBookingRow {
  id: string;
  status: BookingStatus;
  start_at: Date;
  end_at: Date;
  tenant_id: string | null;
}

interface WaitingRow {
  id: string;
  code: string;
  booking_status: BookingStatus;
  end_at: Date;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Self check-in requests: raising one, reading one, and the lapse job's
 * read and write. Approve and reject come with the desk routes.
 */
@Injectable()
export class CheckInRequestRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * "I am here", on one booking.
   *
   * INSIDE THE BOOKING'S ROW LOCK, the same FOR UPDATE that every lifecycle
   * move takes (lifecycle.repository.ts). So a raise and the auto no-show
   * sweeper cannot pass each other: whichever takes the lock first wins, and
   * the other reads what it wrote. A no-show that wins makes the raise
   * not_confirmed; a raise that wins is seen by the sweeper's check inside
   * the same lock, and the booking is left alone. Two taps at once queue on
   * the lock too, and the second gets the first's request.
   *
   * The tenant is the BOOKING's, never the request's header: the request
   * belongs to whoever owns the booking.
   */
  async raise(input: RaiseInput): Promise<RaiseOutcome> {
    if (!UUID_RE.test(input.bookingId)) return { kind: 'not_found' };
    const nowMs = input.nowMs ?? Date.now();

    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<LockedBookingRow[]>`
        SELECT id, status, start_at, end_at, tenant_id
          FROM booking
         WHERE id = ${input.bookingId}::uuid
         FOR UPDATE`;
      const booking = locked[0];
      if (booking === undefined) return { kind: 'not_found' as const };

      const latest = await tx.checkInRequest.findFirst({
        where: { bookingId: booking.id },
        orderBy: [{ raisedAt: 'desc' }, { id: 'desc' }],
        select: ROW_FIELDS,
      });

      const verdict = raiseVerdict({
        bookingStatus: booking.status,
        startAtMs: booking.start_at.getTime(),
        endAtMs: booking.end_at.getTime(),
        nowMs,
        latest: latest?.state ?? null,
      });

      switch (verdict.kind) {
        case 'already_waiting':
          // latest is the waiting one: that is what the verdict read.
          return {
            kind: 'already_waiting' as const,
            request: latest as CheckInRequestRow,
          };
        case 'refused':
          return {
            kind: 'refused' as const,
            why: verdict.why,
            bookingStatus: booking.status,
            ...(verdict.opensAtMs !== undefined
              ? { opensAtMs: verdict.opensAtMs }
              : {}),
          };
        case 'raise':
          break;
      }

      const request = await tx.checkInRequest.create({
        data: {
          bookingId: booking.id,
          tenantId: booking.tenant_id,
          raisedAt: new Date(nowMs),
          raisedByKind: input.actor,
          // Folded as every actor id is written (CLAUDE.md 8).
          raisedById: toUuid(input.actorId),
        },
        select: ROW_FIELDS,
      });
      return { kind: 'raised' as const, request };
    });
  }

  /** The booking's latest request, or null if it never had one. */
  async latestFor(bookingId: string): Promise<CheckInRequestRow | null> {
    if (!UUID_RE.test(bookingId)) return null;
    return this.prisma.checkInRequest.findFirst({
      where: { bookingId },
      orderBy: [{ raisedAt: 'desc' }, { id: 'desc' }],
      select: ROW_FIELDS,
    });
  }

  /**
   * End every waiting request that has lapsed: closed if its booking moved
   * on, expired if nobody answered by the end time. domain lapseOf decides;
   * this reads the facts and writes the answer.
   *
   * NO LIMIT, ON PURPOSE. A waiting request is somebody at a door right now,
   * so the set is small and drains itself. A LIMIT with an ORDER BY would let
   * requests that are not due yet hold the first places and keep due ones
   * waiting forever, which is the very failure the no-show filter exists to
   * prevent.
   *
   * COMPARE AND SET. Each write is `WHERE id = ? AND state = 'waiting'`, so a
   * desk answer that lands between the read and the write wins, and the job
   * writes nothing over it.
   */
  async lapseWaiting(nowMs: number): Promise<LapsedRequest[]> {
    const waiting = await this.prisma.$queryRaw<WaitingRow[]>`
      SELECT r.id, b.code, b.status::text AS booking_status, b.end_at
        FROM check_in_request r
        JOIN booking b ON b.id = r.booking_id
       WHERE r.state = 'waiting'
       ORDER BY r.raised_at`;

    const lapsed: LapsedRequest[] = [];
    for (const row of waiting) {
      const lapse = lapseOf({
        bookingStatus: row.booking_status,
        endAtMs: row.end_at.getTime(),
        nowMs,
      });
      if (lapse === null) continue;

      const written = await this.prisma.checkInRequest.updateMany({
        where: { id: row.id, state: 'waiting' },
        data: {
          state: lapse.to,
          decidedAt: new Date(nowMs),
          decidedByKind: 'system',
          decidedById: null,
          reason: lapse.reason,
        },
      });
      if (written.count === 1) {
        lapsed.push({ id: row.id, code: row.code, to: lapse.to });
      }
    }
    return lapsed;
  }
}
