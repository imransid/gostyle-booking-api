import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from './prisma.service';
import { toUuid } from './hold.repository';
import {
  AUTO_NO_SHOW_MIN,
  type ActorKind,
  type BookingStatus,
} from '@domain/booking/lifecycle';
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
  readonly decidedById: string | null;
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
  decidedById: true,
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

/** Who answers a request at the desk. */
export interface DeciderInput {
  readonly bookingId: string;
  readonly deciderKind: ActorKind;
  readonly deciderId: string;
  /** Test hook. A route passes the server's clock, never the caller's. */
  readonly nowMs?: number;
}

/** Nothing to answer: the booking is not there, or has nothing waiting. */
export type NothingToAnswer =
  | { readonly kind: 'not_found' }
  | {
      readonly kind: 'nothing_waiting';
      /** The booking's latest request, or null if it never had one. */
      readonly latest: CheckInRequestState | null;
    };

export type ApproveOutcome<T> =
  | {
      readonly kind: 'approved';
      readonly request: CheckInRequestRow;
      /** What the check-in answered. */
      readonly checkIn: T;
    }
  | NothingToAnswer;

export type RejectOutcome =
  | { readonly kind: 'rejected'; readonly request: CheckInRequestRow }
  | NothingToAnswer;

/** One row of the reception list: the request and its booking. */
export interface ReceptionRow {
  readonly request: CheckInRequestRow;
  readonly booking: {
    readonly id: string;
    readonly code: string;
    readonly status: BookingStatus;
    readonly startAt: Date;
    readonly endAt: Date;
    readonly customerId: string;
    readonly tenantId: string | null;
    readonly branchId: string;
  };
}

/** The "needs a decision" half of the list shows this many, oldest first. */
export const NEEDS_DECISION_LIMIT = 100;

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

interface ReceptionSqlRow {
  request_id: string;
  booking_id: string;
  state: CheckInRequestState;
  raised_at: Date;
  raised_by_kind: ActorKind;
  decided_at: Date | null;
  decided_by_kind: ActorKind | null;
  decided_by_id: string | null;
  reason: string | null;
  code: string;
  booking_status: BookingStatus;
  start_at: Date;
  end_at: Date;
  customer_id: string;
  tenant_id: string | null;
  branch_id: string;
}

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

/** The reception list's columns, one list for both halves. */
const RECEPTION_COLUMNS = Prisma.sql`
  r.id AS request_id, r.booking_id, r.state::text AS state, r.raised_at,
  r.raised_by_kind::text AS raised_by_kind, r.decided_at,
  r.decided_by_kind::text AS decided_by_kind, r.decided_by_id, r.reason,
  b.code, b.status::text AS booking_status, b.start_at, b.end_at,
  b.customer_id, b.tenant_id, b.branch_id`;

interface WaitingRow {
  id: string;
  code: string;
  booking_status: BookingStatus;
  end_at: Date;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Self check-in requests: raising one, reading one, the desk's answer
 * (approve, reject), the reception list, and the lapse job's read and write.
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
  /**
   * The desk says yes: run the check-in, then mark the request approved.
   *
   * THE REQUEST'S ROW IS LOCKED FIRST, and held while `checkIn` runs. It is
   * the caller's ordinary desk check-in (state machine, history row, outbox
   * event, in its own transaction); this only holds the lock around it, so:
   *
   *   - the lapse job cannot close the request in the moment between the
   *     check-in committing (the booking is no longer CONFIRMED) and the mark
   *     here: its write waits on this lock, then finds it approved;
   *   - two desks approving at once: the second waits, then finds nothing
   *     waiting, and the check-in runs once;
   *   - a rejection at the same moment waits the same way.
   *
   * THE CHECK-IN FIRST, THEN THE MARK. If the check-in refuses (too early, or
   * the booking was cancelled), it throws, this transaction rolls back, and
   * the request still waits: a request never says approved for a booking
   * that is not checked in. If the mark itself were lost after the check-in
   * committed, the lapse job closes the request on its next run.
   */
  async approveWith<T>(
    input: DeciderInput,
    checkIn: () => Promise<T>,
  ): Promise<ApproveOutcome<T>> {
    if (!UUID_RE.test(input.bookingId)) return { kind: 'not_found' };

    return this.prisma.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id
            FROM check_in_request
           WHERE booking_id = ${input.bookingId}::uuid
             AND state = 'waiting'
           FOR UPDATE`;
        const waiting = locked[0];
        if (waiting === undefined) {
          return nothingToAnswer(tx, input.bookingId);
        }

        const result = await checkIn();

        const request = await tx.checkInRequest.update({
          where: { id: waiting.id },
          data: {
            state: 'approved',
            decidedAt: new Date(input.nowMs ?? Date.now()),
            decidedByKind: input.deciderKind,
            decidedById: toUuid(input.deciderId),
          },
          select: ROW_FIELDS,
        });
        return { kind: 'approved' as const, request, checkIn: result };
      },
      // The check-in runs inside this window, on its own connection.
      { maxWait: 5_000, timeout: 20_000 },
    );
  }

  /**
   * The desk says no, with a reason. The booking is not touched: it goes back
   * to the ordinary rules, the auto no-show sweeper included (D1).
   *
   * One UPDATE ... WHERE state = 'waiting', so a request already answered,
   * or being approved right now (it waits on the approval's lock), is left
   * alone and the answer is nothing_waiting.
   */
  async reject(
    input: DeciderInput & { readonly reason: string },
  ): Promise<RejectOutcome> {
    if (!UUID_RE.test(input.bookingId)) return { kind: 'not_found' };
    const decidedAt = new Date(input.nowMs ?? Date.now());

    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        UPDATE check_in_request
           SET state = 'rejected',
               decided_at = ${decidedAt},
               decided_by_kind = ${input.deciderKind}::actor_kind,
               decided_by_id = ${toUuid(input.deciderId)}::uuid,
               reason = ${input.reason}
         WHERE booking_id = ${input.bookingId}::uuid
           AND state = 'waiting'
         RETURNING id`;
      const id = rows[0]?.id;
      if (id === undefined) return nothingToAnswer(tx, input.bookingId);

      const request = await tx.checkInRequest.findUniqueOrThrow({
        where: { id },
        select: ROW_FIELDS,
      });
      return { kind: 'rejected' as const, request };
    });
  }

  /**
   * THE RECEPTION LIST for one branch, in two halves:
   *
   *   waiting         requests nobody has answered yet, on bookings still
   *                   CONFIRMED, oldest first. A waiting request whose
   *                   booking moved on is not shown: the lapse job closes it.
   *   needsDecision   bookings the auto no-show sweeper is leaving to the
   *                   desk (D1): still CONFIRMED, past start plus
   *                   AUTO_NO_SHOW_MIN, the customer said they arrived
   *                   (arrivalClaimed, the sweeper's own SQL), and nothing is
   *                   waiting any more. Mostly "nobody answered" (expired).
   *                   Oldest first, NEEDS_DECISION_LIMIT of them.
   *
   * Whose rows the caller may see is the caller's to decide (the scope
   * check): this returns the branch's rows with their tenant.
   */
  async listForBranch(
    branchId: string,
    nowMs: number,
  ): Promise<{ waiting: ReceptionRow[]; needsDecision: ReceptionRow[] }> {
    // Folded as every branch id is written (CLAUDE.md 8).
    const branch = toUuid(branchId);
    const cutoff = new Date(nowMs - AUTO_NO_SHOW_MIN * 60_000);

    const waiting = await this.prisma.$queryRaw<ReceptionSqlRow[]>`
      SELECT ${RECEPTION_COLUMNS}
        FROM check_in_request r
        JOIN booking b ON b.id = r.booking_id
       WHERE b.branch_id = ${branch}::uuid
         AND r.state = 'waiting'
         AND b.status = 'confirmed'
       ORDER BY r.raised_at`;

    const needsDecision = await this.prisma.$queryRaw<ReceptionSqlRow[]>`
      SELECT ${RECEPTION_COLUMNS}
        FROM booking b
        JOIN LATERAL (
              SELECT x.*
                FROM check_in_request x
               WHERE x.booking_id = b.id
               ORDER BY x.raised_at DESC, x.id DESC
               LIMIT 1) r ON true
       WHERE b.branch_id = ${branch}::uuid
         AND b.status = 'confirmed'
         AND b.start_at <= ${cutoff}
         AND ${arrivalClaimed(Prisma.sql`b.id`)}
         AND r.state <> 'waiting'
       ORDER BY b.start_at
       LIMIT ${NEEDS_DECISION_LIMIT}`;

    return {
      waiting: waiting.map(receptionRow),
      needsDecision: needsDecision.map(receptionRow),
    };
  }
}

/** The booking is not there, or nothing on it is waiting: which one. */
async function nothingToAnswer(
  tx: Tx,
  bookingId: string,
): Promise<NothingToAnswer> {
  const booking = await tx.booking.findUnique({
    where: { id: bookingId },
    select: { id: true },
  });
  if (booking === null) return { kind: 'not_found' };
  const latest = await tx.checkInRequest.findFirst({
    where: { bookingId },
    orderBy: [{ raisedAt: 'desc' }, { id: 'desc' }],
    select: { state: true },
  });
  return { kind: 'nothing_waiting', latest: latest?.state ?? null };
}

function receptionRow(row: ReceptionSqlRow): ReceptionRow {
  return {
    request: {
      id: row.request_id,
      bookingId: row.booking_id,
      state: row.state,
      raisedAt: row.raised_at,
      raisedByKind: row.raised_by_kind,
      decidedAt: row.decided_at,
      decidedByKind: row.decided_by_kind,
      decidedById: row.decided_by_id,
      reason: row.reason,
    },
    booking: {
      id: row.booking_id,
      code: row.code,
      status: row.booking_status,
      startAt: row.start_at,
      endAt: row.end_at,
      customerId: row.customer_id,
      tenantId: row.tenant_id,
      branchId: row.branch_id,
    },
  };
}
