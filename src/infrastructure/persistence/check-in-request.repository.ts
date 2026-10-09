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
  withdrawVerdict,
  type CheckInRequestState,
  type Lapse,
  type RaiseRefusal,
} from '@domain/booking/check-in-request';
import {
  IN_THE_CHAIR,
  chairCheckInVerdict,
  type ChairRefusal,
  type ClaimedChair,
  type ScannedChair,
} from '@domain/booking/chair-check-in';

/**
 * DID THE CUSTOMER SAY THEY ARRIVED? As SQL, because the auto no-show
 * sweeper has to FILTER on it, and the one copy is shared by both places
 * that ask (CLAUDE.md 4):
 *
 *   no-show-sweeper.service.ts   AND NOT <this>, in its candidate query
 *   lifecycle.repository.ts      <this>, again inside the booking's row lock
 *
 * True when the booking's LATEST request is anything but rejected: waiting,
 * and also expired, approved, closed or withdrawn. Only the desk saying no
 * hands the booking back to the sweeper; domain/booking/check-in-request.ts
 * says why.
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
  /** The scanned chair, as platform answered at the scan; null: none. */
  readonly chairId: string | null;
  readonly chairNumber: string | null;
  readonly chairZoneName: string | null;
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
  chairId: true,
  chairNumber: true,
  chairZoneName: true,
} as const;

export interface RaiseInput {
  readonly bookingId: string;
  readonly actor: ActorKind;
  readonly actorId: string;
  /**
   * The chair the customer scanned, as platform answered. Resolved by the
   * CALLER, before this runs: platform is a network call, and this holds the
   * booking's row lock. Absent: a request with no chair.
   */
  readonly chair?: ScannedChair;
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
    }
  /** The booking may raise, but not with this chair (chair-check-in.ts). */
  | { readonly kind: 'chair_refused'; readonly refusal: ChairRefusal };

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
  /**
   * Somebody else is in the claimed chair now. Nothing was checked in, and
   * the request still waits. For the desk: which chair, and who is in it.
   */
  | {
      readonly kind: 'chair_occupied';
      readonly chairNumber: string;
      readonly occupant: string;
    }
  | NothingToAnswer;

export type RejectOutcome =
  | { readonly kind: 'rejected'; readonly request: CheckInRequestRow }
  | NothingToAnswer;

/** The customer taking their own request back. */
export interface WithdrawInput {
  readonly bookingId: string;
  /** The customer. Only the one who raised it (check_in_request_withdrawn_by_raiser). */
  readonly actorId: string;
  /** Test hook. A route passes the server's clock, never the caller's. */
  readonly nowMs?: number;
}

export type WithdrawOutcome =
  | { readonly kind: 'withdrawn'; readonly request: CheckInRequestRow }
  /** A second tap: the request it withdrew, and nothing written. */
  | { readonly kind: 'already_withdrawn'; readonly request: CheckInRequestRow }
  /**
   * It had lapsed. The lapse job's own write was made here (closed or
   * expired, by the system, with the job's reason), and this is the request
   * as it now stands. Never a withdrawal.
   */
  | { readonly kind: 'lapsed'; readonly request: CheckInRequestRow }
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
  branch_id: string;
}

/** The waiting request approve locks, and the chair it claims. */
interface LockedRequestRow {
  id: string;
  chair_id: string | null;
  chair_number: string | null;
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
  chair_id: string | null;
  chair_number: string | null;
  chair_zone_name: string | null;
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
  r.chair_id, r.chair_number, r.chair_zone_name,
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
        SELECT id, status, start_at, end_at, tenant_id, branch_id
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

      // THE CHAIR, after the booking's own answers: a booking that may not
      // raise at all is told that first, whatever chair it scanned. Asked in
      // the lock, of this booking's tenant and branch as the row has them.
      // No chair lock here: approve takes it and asks again, and approve is
      // the moment a customer is seated.
      let chair: ClaimedChair | null = null;
      if (input.chair !== undefined) {
        const verdict = chairCheckInVerdict({
          chair: input.chair,
          booking: { tenantId: booking.tenant_id, branchId: booking.branch_id },
          occupant: await occupantOf(tx, {
            chairId: input.chair.chairId,
            bookingId: booking.id,
          }),
        });
        if (verdict.kind === 'refused') {
          const { kind: _refused, ...refusal } = verdict;
          return { kind: 'chair_refused' as const, refusal };
        }
        chair = verdict.chair;
      }

      const request = await tx.checkInRequest.create({
        data: {
          bookingId: booking.id,
          tenantId: booking.tenant_id,
          raisedAt: new Date(nowMs),
          raisedByKind: input.actor,
          // Folded as every actor id is written (CLAUDE.md 8).
          raisedById: toUuid(input.actorId),
          ...(chair === null
            ? {}
            : {
                chairId: chair.chairId,
                chairNumber: chair.chairNumber,
                chairZoneName: chair.zoneName,
              }),
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
        data: lapseWrite(lapse, nowMs),
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
        const locked = await tx.$queryRaw<LockedRequestRow[]>`
          SELECT id, chair_id, chair_number
            FROM check_in_request
           WHERE booking_id = ${input.bookingId}::uuid
             AND state = 'waiting'
           FOR UPDATE`;
        const waiting = locked[0];
        if (waiting === undefined) {
          return nothingToAnswer(tx, input.bookingId);
        }

        // A CLAIMED CHAIR: take the chair's lock, then ask who is in it.
        // Held until this transaction ends, which is after checkIn() and the
        // mark below have both committed: a second approval for the same
        // chair waits here, then finds this booking in it.
        if (waiting.chair_id !== null) {
          await tx.$executeRaw`
            SELECT pg_advisory_xact_lock(${CHAIR_LOCK_CLASS}::int4,
                                         hashtext(${waiting.chair_id}))`;
          const occupant = await occupantOf(tx, {
            chairId: waiting.chair_id,
            bookingId: input.bookingId,
          });
          if (occupant !== null) {
            return {
              kind: 'chair_occupied' as const,
              // Never null with a chair_id: check_in_request_chair_is_whole.
              chairNumber: waiting.chair_number ?? '',
              occupant,
            };
          }
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
   * The customer takes their request back (the app's Cancel Request).
   * domain withdrawVerdict decides; this locks, reads the facts, and writes.
   *
   * THE REQUEST'S ROW FIRST, THEN THE BOOKING'S, the order approve takes
   * them in (its request lock, then the booking's inside the check-in), so
   * the two can never deadlock:
   *
   *   - an approval in progress holds the request: this waits, then finds
   *     it approved, and nothing is withdrawn;
   *   - a desk check-in in progress holds the booking: this waits on the
   *     FOR SHARE, then reads CHECKED_IN, and the request has lapsed;
   *   - the lapse job's compare-and-set waits on the request, then finds it
   *     withdrawn and writes nothing.
   *
   * FOR SHARE, not a plain read: a check-in committing between the read and
   * the write would otherwise leave WITHDRAWN on a checked-in booking.
   *
   * LAPSED: the booking moved on or has ended, so it is the job's to end,
   * and the job's write is made here, now (lapseWrite, the same one): closed
   * or expired, by the system, with the job's reason. The customer's tap is
   * never recorded as a withdrawal of what the desk or the clock had already
   * ended, and the answer carries the state as it now is, so the app moves
   * on at once instead of reading WAITING until the job's next run.
   */
  async withdraw(input: WithdrawInput): Promise<WithdrawOutcome> {
    if (!UUID_RE.test(input.bookingId)) return { kind: 'not_found' };
    const nowMs = input.nowMs ?? Date.now();

    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id
          FROM check_in_request
         WHERE booking_id = ${input.bookingId}::uuid
           AND state = 'waiting'
         FOR UPDATE`;
      const bookings = await tx.$queryRaw<
        { status: BookingStatus; end_at: Date }[]
      >`
        SELECT status, end_at
          FROM booking
         WHERE id = ${input.bookingId}::uuid
         FOR SHARE`;
      const booking = bookings[0];
      if (booking === undefined) return { kind: 'not_found' as const };

      const waitingId = locked[0]?.id;
      const latest =
        waitingId === undefined
          ? await tx.checkInRequest.findFirst({
              where: { bookingId: input.bookingId },
              orderBy: [{ raisedAt: 'desc' }, { id: 'desc' }],
              select: ROW_FIELDS,
            })
          : null;

      const verdict = withdrawVerdict({
        latest: waitingId === undefined ? (latest?.state ?? null) : 'waiting',
        bookingStatus: booking.status,
        endAtMs: booking.end_at.getTime(),
        nowMs,
      });

      switch (verdict.kind) {
        case 'already_withdrawn':
          // latest is the withdrawn one: that is what the verdict read.
          return {
            kind: 'already_withdrawn' as const,
            request: latest as CheckInRequestRow,
          };
        case 'refused':
          if (verdict.why === 'nothing_waiting') {
            return {
              kind: 'nothing_waiting' as const,
              latest: latest?.state ?? null,
            };
          }
          return {
            kind: 'lapsed' as const,
            request: await tx.checkInRequest.update({
              // The locked waiting row: lapsed is only ever said of one.
              where: { id: waitingId as string },
              data: lapseWrite(verdict.lapse, nowMs),
              select: ROW_FIELDS,
            }),
          };
        case 'withdraw':
          return {
            kind: 'withdrawn' as const,
            request: await tx.checkInRequest.update({
              where: { id: waitingId as string },
              data: {
                state: 'withdrawn',
                decidedAt: new Date(nowMs),
                decidedByKind: 'customer',
                // Folded as raised_by_id was (CLAUDE.md 8), so the two match.
                decidedById: toUuid(input.actorId),
              },
              select: ROW_FIELDS,
            }),
          };
      }
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

/**
 * THE CHAIR LOCK: one approval at a time per chair.
 *
 * Two desks approving two bookings for the same chair each lock only their
 * own request, so without it both could find the chair free and both seat a
 * customer in it. approveWith takes this before it asks who is in the chair,
 * and holds it until its check-in and its mark have committed.
 *
 * ITS OWN KEY SPACE, ON PURPOSE: the capacity lock is NOT reused, and the two
 * can never collide. Capacity (hold, group hold, group confirm, series,
 * reschedule) locks the ONE-bigint form,
 * pg_advisory_xact_lock(hashtextextended('<branch>:<type>:<day>', 0)). This
 * is the TWO-int form, (CHAIR_LOCK_CLASS, hashtext(chair_id)), and Postgres
 * keeps the two forms in key spaces that do not overlap (pg_locks: objsubid
 * 1 for the first, 2 for the second), so no capacity key can equal a chair
 * key, and a hold never waits on an approval or the other way round. Not
 * reused, because they guard different things: capacity is selling a chair
 * TYPE on a day, this is one physical chair now, and an approval knows
 * neither the type nor the capacity it would be queueing behind.
 *
 * CHAIR_LOCK_CLASS names this feature in the first int, so a later two-int
 * lock that picks its own class cannot collide with it either. Inside it,
 * two chairs whose ids hash alike (32 bits) share a lock: their approvals
 * take turns, which costs a moment and is never wrong.
 *
 * NO DEADLOCK: an approval holds one request row, then one chair lock,
 * always in that order, and only READS the bookings it asks about.
 *
 * Proven live: self-check-in.live.spec.ts holds a one-bigint lock with the
 * very same 64 bits and takes this one beside it.
 */
export const CHAIR_LOCK_CLASS = 0x43484952; // 'CHIR'

/**
 * WHO IS IN THIS CHAIR, if anybody but the claiming booking: the code of the
 * booking, or null. The rule is chair-check-in.ts's (4. occupied); this is
 * that rule as SQL, the one copy, asked by raise and by approve.
 *
 *   IN_THE_CHAIR     checked in or in service
 *   same branch and trading day as the claiming booking: a visit nobody
 *                    closed yesterday is not in the chair today
 *   latest request   names this chair and was neither rejected nor
 *                    withdrawn, so a customer who scanned it and was checked
 *                    in with the desk's own button (the request then
 *                    closes) is in it too, and one who took the claim back
 *                    and was then checked in at the desk is not: the chair
 *                    they scanned is the one they said was wrong
 *
 * From the claiming booking's branch and day, so booking_branch_day_idx
 * finds the day's bookings and check_in_request_booking_idx each one's
 * latest request. The day is read in SQL, never round-tripped as a JS Date.
 */
async function occupantOf(
  tx: Tx,
  claim: { readonly chairId: string; readonly bookingId: string },
): Promise<string | null> {
  const rows = await tx.$queryRaw<{ code: string }[]>`
    SELECT b.code
      FROM booking me
      JOIN booking b
        ON b.branch_id = me.branch_id
       AND b.trading_day = me.trading_day
       AND b.id <> me.id
      JOIN LATERAL (
            SELECT x.state, x.chair_id
              FROM check_in_request x
             WHERE x.booking_id = b.id
             ORDER BY x.raised_at DESC, x.id DESC
             LIMIT 1) latest ON true
     WHERE me.id = ${claim.bookingId}::uuid
       AND b.status = ANY(${[...IN_THE_CHAIR]}::booking_status[])
       AND latest.chair_id = ${claim.chairId}::uuid
       AND latest.state NOT IN ('rejected', 'withdrawn')
     ORDER BY b.start_at, b.code
     LIMIT 1`;
  return rows[0]?.code ?? null;
}

/**
 * THE LAPSE JOB'S WRITE: lapseOf's state and reason, answered by the system,
 * which is nobody. One copy, for the job and for a withdrawal that finds the
 * request already lapsed, because either way it is the job's write and never
 * the customer's.
 */
function lapseWrite(lapse: Lapse, nowMs: number) {
  return {
    state: lapse.to,
    decidedAt: new Date(nowMs),
    decidedByKind: 'system' as const,
    decidedById: null,
    reason: lapse.reason,
  };
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
      chairId: row.chair_id,
      chairNumber: row.chair_number,
      chairZoneName: row.chair_zone_name,
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
