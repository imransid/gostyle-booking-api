import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../persistence/prisma.service';
import { LifecycleRepository } from '../persistence/lifecycle.repository';
import {
  CHAIR_LOCK_CLASS,
  CheckInRequestRepository,
  arrivalClaimed,
} from '../persistence/check-in-request.repository';
import { NoShowSweeper } from './no-show-sweeper.service';
import { CheckInRequestSweeper } from './check-in-request-sweeper.service';
import { ConflictException } from '@nestjs/common';
import { LifecycleHandler } from '@application/commands/lifecycle.handler';
import { FixtureCustomerContext } from '../fixtures/fixture-customer-context';
import type { ScannedChair } from '@domain/booking/chair-check-in';

/**
 * SELF CHECK-IN AND THE AUTO NO-SHOW SWEEPER, AGAINST A REAL POSTGRES.
 *
 * A filter in SQL is only proven by running the SQL (CLAUDE.md 5), so these
 * run the real sweeper, the real transition and the real raise on a real
 * database. Skipped unless LIVE_DATABASE_URL is set:
 *
 *   createdb gostyle_booking_checkin
 *   DATABASE_URL=postgres://.../gostyle_booking_checkin pnpm prisma migrate deploy
 *   LIVE_DATABASE_URL=postgres://.../gostyle_booking_checkin \
 *     pnpm vitest run src/infrastructure/scheduling/self-check-in.live.spec.ts
 *
 * A THROWAWAY DATABASE ONLY. The status history is append-only, so nothing
 * written here can be cleaned up. Two guards: the database's name must say
 * checkin, test or proof, and every test that sweeps first checks there is
 * NOTHING else due, because the sweeper takes the oldest 50 due bookings of
 * the whole database, not just these.
 */
const LIVE = process.env.LIVE_DATABASE_URL ?? '';

const MIN = 60_000;
/** Older than any real booking, so these are always the sweeper's first. */
const BASE = Date.UTC(2001, 0, 1, 4, 0);

// Real round trips: fifty transitions are more than vitest's default 5s.
describe.skipIf(LIVE === '')('self check-in, live', { timeout: 60_000 }, () => {
  let prisma: PrismaService;
  let lifecycle: LifecycleRepository;
  let requests: CheckInRequestRepository;
  let noShow: NoShowSweeper;
  let lapse: CheckInRequestSweeper;
  const branch = randomUUID();
  let seq = 0;

  beforeAll(async () => {
    const name = new URL(LIVE).pathname.replace(/^\//, '');
    if (!/checkin|test|proof/i.test(name)) {
      throw new Error(
        `Refusing to write to "${name}": the live spec runs on a throwaway ` +
          'database whose name says checkin, test or proof.',
      );
    }
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = LIVE;
    prisma = new PrismaService();
    process.env.DATABASE_URL = saved;
    await prisma.$connect();

    lifecycle = new LifecycleRepository(prisma);
    requests = new CheckInRequestRepository(prisma);
    noShow = new NoShowSweeper(prisma, lifecycle);
    lapse = new CheckInRequestSweeper(requests);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  /** A booking of this run. One hour long unless told otherwise. */
  async function seed(input: {
    readonly startAtMs: number;
    readonly status?: string;
    readonly tenantId?: string | null;
    readonly branchId?: string;
  }): Promise<string> {
    const id = randomUUID();
    seq += 1;
    const code = `GS-LIVE-${branch.slice(0, 8)}-${seq}`;
    const start = new Date(input.startAtMs);
    const end = new Date(input.startAtMs + 60 * MIN);
    const day = start.toISOString().slice(0, 10);
    const minute = start.getUTCHours() * 60 + start.getUTCMinutes();
    await prisma.$executeRaw`
      INSERT INTO booking (id, tenant_id, code, branch_id, customer_id, status,
                           payment_status, trading_day, start_at, end_at,
                           start_minute, duration_min, price_fils,
                           deposit_fils, channel, updated_at)
      VALUES (${id}::uuid, ${input.tenantId ?? null}, ${code},
              ${input.branchId ?? branch}::uuid, ${randomUUID()}::uuid,
              ${input.status ?? 'confirmed'}::booking_status, 'none_required',
              ${day}::date, ${start}, ${end}, ${minute}, 60, 0, 0, 'mobile',
              now())`;
    return id;
  }

  /** A request in any state, written straight to the table. */
  async function claim(
    bookingId: string,
    state: 'waiting' | 'approved' | 'rejected' | 'expired' | 'closed',
    raisedAtMs: number,
    chair?: { readonly id: string; readonly number: string },
  ): Promise<void> {
    const decidedBy =
      state === 'approved' || state === 'rejected'
        ? 'staff'
        : state === 'waiting'
          ? null
          : 'system';
    await prisma.$executeRaw`
      INSERT INTO check_in_request (id, booking_id, state, raised_at,
                                    raised_by_kind, raised_by_id, decided_at,
                                    decided_by_kind, decided_by_id, reason,
                                    chair_id, chair_number)
      VALUES (${randomUUID()}::uuid, ${bookingId}::uuid,
              ${state}::check_in_request_state, ${new Date(raisedAtMs)},
              'customer', ${randomUUID()}::uuid,
              ${state === 'waiting' ? null : new Date(raisedAtMs + MIN)},
              ${decidedBy}::actor_kind,
              ${decidedBy === 'staff' ? randomUUID() : null}::uuid,
              ${state === 'rejected' ? 'Not at the salon' : null},
              ${chair?.id ?? null}::uuid, ${chair?.number ?? null})`;
  }

  async function statusOf(id: string): Promise<string> {
    const b = await prisma.booking.findUniqueOrThrow({
      where: { id },
      select: { status: true },
    });
    return b.status;
  }

  /** Everything the sweeper could take, in the whole database. */
  async function dueAnywhere(): Promise<number> {
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n
        FROM booking b
       WHERE b.status = 'confirmed'
         AND b.start_at <= now() - interval '30 minutes'
         AND NOT ${arrivalClaimed(Prisma.sql`b.id`)}`;
    return Number(rows[0]?.n ?? 0);
  }

  it(
    'one sweep: a waiting request on the OLDEST due booking is skipped, ' +
      'and the 50 due behind it are all still swept',
    async () => {
      expect(await dueAnywhere()).toBe(0);

      const claimed = await seed({ startAtMs: BASE });
      const raised = await requests.raise({
        bookingId: claimed,
        actor: 'customer',
        actorId: 'sara',
        nowMs: BASE + 5 * MIN,
      });
      expect(raised.kind).toBe('raised');

      const others: string[] = [];
      for (let i = 1; i <= 50; i += 1) {
        others.push(await seed({ startAtMs: BASE + i * MIN }));
      }
      expect(await dueAnywhere()).toBe(50);

      await noShow.sweep();

      expect(await statusOf(claimed)).toBe('confirmed');
      const swept = await prisma.booking.count({
        where: { id: { in: others }, status: 'no_show' },
      });
      // 49 here would be the filter in the loop instead of the query: the
      // claimed booking took one of the 50 places and was then skipped.
      expect(swept).toBe(50);
      expect(await dueAnywhere()).toBe(0);

      // The claim is untouched, and the 50 went the ordinary way: one
      // history row each, by the system, with the sweeper's reason.
      expect((await requests.latestFor(claimed))?.state).toBe('waiting');
      const history = await prisma.bookingStatusHistory.findMany({
        where: { bookingId: { in: [claimed, ...others] } },
        select: { bookingId: true, toStatus: true, actorKind: true },
      });
      expect(history).toHaveLength(50);
      expect(history.every((h) => h.bookingId !== claimed)).toBe(true);
      expect(
        history.every(
          (h) => h.toStatus === 'no_show' && h.actorKind === 'system',
        ),
      ).toBe(true);
    },
  );

  it('the latest request decides: only the desk saying no lets the sweeper in', async () => {
    expect(await dueAnywhere()).toBe(0);
    const at = BASE + 2 * 60 * MIN;

    const none = await seed({ startAtMs: at });
    const waiting = await seed({ startAtMs: at });
    const approved = await seed({ startAtMs: at }); // check-in then undone
    const expired = await seed({ startAtMs: at }); // nobody answered
    const closed = await seed({ startAtMs: at });
    const rejected = await seed({ startAtMs: at });
    const rejectedLast = await seed({ startAtMs: at });

    await claim(waiting, 'waiting', at);
    await claim(approved, 'approved', at);
    await claim(expired, 'expired', at);
    await claim(closed, 'closed', at);
    await claim(rejected, 'rejected', at);
    // An older closed request, then a rejection: the rejection is latest.
    await claim(rejectedLast, 'closed', at);
    await claim(rejectedLast, 'rejected', at + 10 * MIN);

    await noShow.sweep();

    expect(await statusOf(none)).toBe('no_show');
    expect(await statusOf(rejected)).toBe('no_show');
    expect(await statusOf(rejectedLast)).toBe('no_show');
    expect(await statusOf(waiting)).toBe('confirmed');
    expect(await statusOf(approved)).toBe('confirmed');
    expect(await statusOf(expired)).toBe('confirmed');
    expect(await statusOf(closed)).toBe('confirmed');
  });

  it(
    'a raise that lands AFTER the sweeper picked the booking still wins, ' +
      'because the check is inside the row lock',
    async () => {
      expect(await dueAnywhere()).toBe(0);
      const at = BASE + 4 * 60 * MIN;
      const booking = await seed({ startAtMs: at });
      const spy = vi.spyOn(lifecycle, 'transition');

      // The raise, slowed down: it holds the booking's lock, writes its
      // request, and only commits 600ms later. The sweeper starts 150ms in,
      // picks the booking (nothing committed yet), then queues on the lock.
      const raise = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT id FROM booking WHERE id = ${booking}::uuid FOR UPDATE`;
        await tx.$executeRaw`
          INSERT INTO check_in_request (id, booking_id, raised_at,
                                        raised_by_kind, raised_by_id)
          VALUES (${randomUUID()}::uuid, ${booking}::uuid, ${new Date(at)},
                  'customer', ${randomUUID()}::uuid)`;
        await tx.$executeRaw`SELECT pg_sleep(0.6)`;
      });
      await new Promise((r) => setTimeout(r, 150));
      await Promise.all([raise, noShow.sweep()]);

      // The sweeper DID pick it: the guard, not the query, saved it.
      const picked = spy.mock.calls.findIndex(
        (c) => c[0].bookingId === booking,
      );
      expect(picked).toBeGreaterThanOrEqual(0);
      expect(spy.mock.calls[picked]?.[0].unlessArrivalClaimed).toBe(true);
      const outcome: unknown = await (spy.mock.results[picked]
        ?.value as Promise<unknown>);
      expect(outcome).toMatchObject({ kind: 'illegal' });
      expect(await statusOf(booking)).toBe('confirmed');
      spy.mockRestore();
    },
  );

  it('control: the same race without the in-lock check is lost', async () => {
    // Shows the race is real, so the test above is not passing by luck.
    const at = BASE + 5 * 60 * MIN;
    const booking = await seed({ startAtMs: at });

    const raise = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM booking WHERE id = ${booking}::uuid FOR UPDATE`;
      await tx.$executeRaw`
        INSERT INTO check_in_request (id, booking_id, raised_at,
                                      raised_by_kind, raised_by_id)
        VALUES (${randomUUID()}::uuid, ${booking}::uuid, ${new Date(at)},
                'customer', ${randomUUID()}::uuid)`;
      await tx.$executeRaw`SELECT pg_sleep(0.6)`;
    });
    await new Promise((r) => setTimeout(r, 150));
    const [, outcome] = await Promise.all([
      raise,
      lifecycle.transition({
        bookingId: booking,
        to: 'no_show',
        actor: 'system',
        actorId: null,
        reason: 'control',
      }),
    ]);
    expect(outcome.kind).toBe('transitioned');
    expect(await statusOf(booking)).toBe('no_show');
  });

  it('raise: one claim at a time, the tenant is the booking’s, and the refusals', async () => {
    const at = BASE + 6 * 60 * MIN;
    const during = at - 10 * MIN;
    const booking = await seed({ startAtMs: at, tenantId: 'tenant-live' });

    const first = await requests.raise({
      bookingId: booking,
      actor: 'customer',
      actorId: 'sara',
      nowMs: during,
    });
    const second = await requests.raise({
      bookingId: booking,
      actor: 'customer',
      actorId: 'sara',
      nowMs: during + MIN,
    });
    expect(first.kind).toBe('raised');
    expect(second.kind).toBe('already_waiting');
    if (first.kind !== 'raised' || second.kind !== 'already_waiting') return;
    expect(second.request.id).toBe(first.request.id);
    const row = await prisma.checkInRequest.findUniqueOrThrow({
      where: { id: first.request.id },
    });
    expect(row.tenantId).toBe('tenant-live');

    // The desk says no; the customer may not try again.
    await prisma.checkInRequest.update({
      where: { id: first.request.id },
      data: {
        state: 'rejected',
        decidedAt: new Date(during + 2 * MIN),
        decidedByKind: 'staff',
        decidedById: randomUUID(),
        reason: 'Not at the salon',
      },
    });
    expect(
      await requests.raise({
        bookingId: booking,
        actor: 'customer',
        actorId: 'sara',
        nowMs: during + 3 * MIN,
      }),
    ).toMatchObject({ kind: 'refused', why: 'rejected_before' });

    const early = await seed({ startAtMs: at });
    expect(
      await requests.raise({
        bookingId: early,
        actor: 'customer',
        actorId: 'sara',
        nowMs: at - 31 * MIN,
      }),
    ).toMatchObject({
      kind: 'refused',
      why: 'too_early',
      opensAtMs: at - 30 * MIN,
    });

    const gone = await seed({ startAtMs: at, status: 'no_show' });
    expect(
      await requests.raise({
        bookingId: gone,
        actor: 'customer',
        actorId: 'sara',
        nowMs: during,
      }),
    ).toMatchObject({
      kind: 'refused',
      why: 'not_confirmed',
      bookingStatus: 'no_show',
    });

    expect(
      await requests.raise({
        bookingId: randomUUID(),
        actor: 'customer',
        actorId: 'sara',
      }),
    ).toEqual({ kind: 'not_found' });

    // Tidy: the rejected one and the early one are due and unclaimed, and
    // would be the next test's sweep. Straight to cancelled, test data only.
    await prisma.booking.updateMany({
      where: { id: { in: [booking, early] } },
      data: { status: 'cancelled' },
    });
  });

  it('the lapse job: expired when nobody answered, closed when the booking moved on, and an expired one is still not swept', async () => {
    expect(await dueAnywhere()).toBe(0);
    const at = BASE + 8 * 60 * MIN;

    const ignored = await seed({ startAtMs: at });
    const movedOn = await seed({ startAtMs: at });
    const soon = await seed({ startAtMs: Date.now() + 60 * MIN });
    for (const id of [ignored, movedOn, soon]) {
      await claim(id, 'waiting', at);
    }
    // The desk checked this one in with the ordinary button.
    await prisma.booking.update({
      where: { id: movedOn },
      data: { status: 'checked_in' },
    });

    await lapse.sweep();

    const ended = await prisma.checkInRequest.findMany({
      where: { bookingId: { in: [ignored, movedOn, soon] } },
      select: {
        bookingId: true,
        state: true,
        decidedByKind: true,
        decidedById: true,
        reason: true,
      },
    });
    const of = (id: string) => ended.find((r) => r.bookingId === id);
    expect(of(ignored)).toMatchObject({
      state: 'expired',
      decidedByKind: 'system',
      decidedById: null,
      reason: 'Nobody answered before the booking ended.',
    });
    expect(of(movedOn)).toMatchObject({
      state: 'closed',
      decidedByKind: 'system',
      reason: 'The booking became checked_in before the desk answered.',
    });
    expect(of(soon)).toMatchObject({ state: 'waiting', decidedByKind: null });

    // D1: nobody answered, and the sweeper still leaves it to the desk.
    await noShow.sweep();
    expect(await statusOf(ignored)).toBe('confirmed');
  });

  // ------------------------------------------------------------ the desk

  const DESK = '33333333-3333-4333-8333-333333333333';
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // The desk check-in itself: what approve runs (CheckInDeskHandler).
  const checkIn = (bookingId: string) => () =>
    new LifecycleHandler(lifecycle, new FixtureCustomerContext()).execute({
      bookingId,
      to: 'checked_in',
      actor: 'staff',
      actorId: DESK,
    });
  const decider = (bookingId: string) => ({
    bookingId,
    deciderKind: 'staff' as const,
    deciderId: DESK,
  });

  it(
    'approve: the lapse job cannot close the request between the check-in ' +
      'and the mark, because approve holds its lock',
    async () => {
      const at = BASE + 10 * 60 * MIN;
      const booking = await seed({ startAtMs: at });
      await claim(booking, 'waiting', at);

      // The check-in commits (the booking is CHECKED_IN, which the lapse job
      // reads as "moved on"), then the approval waits 600ms before its mark.
      // The lapse job runs 300ms in.
      const approval = requests.approveWith(decider(booking), async () => {
        const out = await checkIn(booking)();
        await sleep(600);
        return out;
      });
      await sleep(300);
      const lapsed = await requests.lapseWaiting(Date.now());
      const out = await approval;

      expect(out.kind).toBe('approved');
      expect(lapsed.map((l) => l.code)).not.toContain(
        (await prisma.booking.findUniqueOrThrow({ where: { id: booking } }))
          .code,
      );
      expect((await requests.latestFor(booking))?.state).toBe('approved');
      expect(await statusOf(booking)).toBe('checked_in');
    },
  );

  it('control: the same moment without the lock, and the request is lost to closed', async () => {
    const at = BASE + 11 * 60 * MIN;
    const booking = await seed({ startAtMs: at });
    await claim(booking, 'waiting', at);

    await checkIn(booking)();
    await requests.lapseWaiting(Date.now());
    const marked = await prisma.checkInRequest.updateMany({
      where: { bookingId: booking, state: 'waiting' },
      data: { state: 'approved' },
    });

    expect(marked.count).toBe(0);
    expect((await requests.latestFor(booking))?.state).toBe('closed');
  });

  it('two desks approve at once: one check-in, one approval, the other is told nothing waits', async () => {
    const at = BASE + 12 * 60 * MIN;
    const booking = await seed({ startAtMs: at });
    await claim(booking, 'waiting', at);
    let checkIns = 0;
    const slowCheckIn = async () => {
      checkIns += 1;
      const out = await checkIn(booking)();
      await sleep(300);
      return out;
    };

    const outs = await Promise.all([
      requests.approveWith(decider(booking), slowCheckIn),
      requests.approveWith(decider(booking), slowCheckIn),
    ]);

    expect(outs.map((o) => o.kind).sort()).toEqual([
      'approved',
      'nothing_waiting',
    ]);
    expect(outs.find((o) => o.kind === 'nothing_waiting')).toEqual({
      kind: 'nothing_waiting',
      latest: 'approved',
    });
    expect(checkIns).toBe(1);
    const history = await prisma.bookingStatusHistory.findMany({
      where: { bookingId: booking },
    });
    expect(history.map((h) => [h.toStatus, h.actorKind])).toEqual([
      ['checked_in', 'staff'],
    ]);
  });

  it('a rejection during an approval waits, then finds it approved', async () => {
    const at = BASE + 13 * 60 * MIN;
    const booking = await seed({ startAtMs: at });
    await claim(booking, 'waiting', at);

    const approval = requests.approveWith(decider(booking), async () => {
      const out = await checkIn(booking)();
      await sleep(400);
      return out;
    });
    await sleep(150);
    const rejection = await requests.reject({
      ...decider(booking),
      reason: 'Not at the salon',
    });

    expect((await approval).kind).toBe('approved');
    expect(rejection).toEqual({ kind: 'nothing_waiting', latest: 'approved' });
  });

  it('a check-in the state machine refuses: the error is the answer, and the request still waits', async () => {
    const at = BASE + 14 * 60 * MIN;
    const booking = await seed({ startAtMs: at, status: 'cancelled' });
    await claim(booking, 'waiting', at);

    await expect(
      requests.approveWith(decider(booking), checkIn(booking)),
    ).rejects.toThrow(
      new ConflictException('A cancelled booking cannot become checked_in.'),
    );
    expect((await requests.latestFor(booking))?.state).toBe('waiting');
  });

  it('reject: rejected with who and why, and the booking is untouched', async () => {
    const at = BASE + 15 * 60 * MIN;
    const booking = await seed({ startAtMs: at });
    await claim(booking, 'waiting', at);

    const out = await requests.reject({
      ...decider(booking),
      reason: 'Not at the salon',
    });

    expect(out).toMatchObject({
      kind: 'rejected',
      request: {
        state: 'rejected',
        decidedByKind: 'staff',
        decidedById: DESK,
        reason: 'Not at the salon',
      },
    });
    expect(await statusOf(booking)).toBe('confirmed');
    // Tidy: rejected and due, so the next run's sweep would take it.
    await prisma.booking.update({
      where: { id: booking },
      data: { status: 'cancelled' },
    });
  });

  it('the reception list: who waits, and who the sweeper left to the desk', async () => {
    const here = randomUUID();
    const elsewhere = randomUUID();
    const past = BASE + 16 * 60 * MIN;
    const soon = Date.now() + 10 * MIN;
    const later = Date.now() + 3 * 60 * MIN;

    const waiting = await seed({ startAtMs: soon, branchId: here });
    await claim(waiting, 'waiting', soon - 5 * MIN);
    const stale = await seed({
      startAtMs: soon,
      branchId: here,
      status: 'checked_in',
    });
    await claim(stale, 'waiting', soon - 5 * MIN);
    const ignored = await seed({ startAtMs: past, branchId: here });
    await claim(ignored, 'expired', past);
    const undone = await seed({ startAtMs: past + MIN, branchId: here });
    await claim(undone, 'approved', past);
    const rejected = await seed({ startAtMs: past, branchId: here });
    await claim(rejected, 'rejected', past);
    const unclaimed = await seed({ startAtMs: past, branchId: here });
    const notDueYet = await seed({ startAtMs: later, branchId: here });
    await claim(notDueYet, 'approved', later - 20 * MIN);
    const otherBranch = await seed({ startAtMs: soon, branchId: elsewhere });
    await claim(otherBranch, 'waiting', soon - 5 * MIN);

    const list = await requests.listForBranch(here, Date.now());

    expect(list.waiting.map((r) => r.booking.id)).toEqual([waiting]);
    expect(list.needsDecision.map((r) => r.booking.id)).toEqual([
      ignored,
      undone,
    ]);
    expect(list.needsDecision[0]?.request.state).toBe('expired');

    // Tidy: the unclaimed and rejected ones are due, for the next run's sweep.
    await prisma.booking.updateMany({
      where: { id: { in: [rejected, unclaimed] } },
      data: { status: 'cancelled' },
    });
  });

  // ------------------------------------------------------------ chairs

  const TENANT = 'f2a9882b-c822-4107-b650-29af2e303c24';
  /** Far ahead: a booking a chair test leaves CONFIRMED is never due. */
  const AHEAD = Date.UTC(2099, 0, 1, 4, 0);

  const scanned = (
    chairId: string,
    over: Partial<ScannedChair> = {},
  ): ScannedChair => ({
    cardStatus: 'LIVE',
    chairId,
    tenantId: TENANT,
    branchId: branch,
    chairNumber: '7',
    zoneName: 'Window section',
    chairState: 'ACTIVE',
    chairBookable: true,
    ...over,
  });

  /** "I am here" at a chair, five minutes before the booking starts. */
  const raiseAt = (bookingId: string, startAtMs: number, chair: ScannedChair) =>
    requests.raise({
      bookingId,
      actor: 'customer',
      actorId: 'sara',
      chair,
      nowMs: startAtMs - 5 * MIN,
    });

  async function codeOf(id: string): Promise<string> {
    const b = await prisma.booking.findUniqueOrThrow({
      where: { id },
      select: { code: true },
    });
    return b.code;
  }

  /** Can another connection take the chair's lock right now? */
  async function chairLockFree(chairId: string): Promise<boolean> {
    const rows = await prisma.$queryRaw<{ got: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(${CHAIR_LOCK_CLASS}::int4,
                                       hashtext(${chairId})) AS got`;
    return rows[0]?.got === true;
  }

  it('raise at a chair: the claim keeps the chair, and a waiting claim does not block the next customer', async () => {
    const chair = randomUUID();
    const at = AHEAD;
    const first = await seed({ startAtMs: at, tenantId: TENANT });
    const second = await seed({ startAtMs: at, tenantId: TENANT });

    expect(await raiseAt(first, at, scanned(chair))).toMatchObject({
      kind: 'raised',
      request: {
        state: 'waiting',
        chairId: chair,
        chairNumber: '7',
        chairZoneName: 'Window section',
      },
    });
    // Waiting is not in the chair. And platform's spelling of the branch is
    // not another salon (CLAUDE.md 8: the column holds the folded uuid).
    expect(
      await raiseAt(
        second,
        at,
        scanned(chair, { branchId: branch.toUpperCase(), zoneName: null }),
      ),
    ).toMatchObject({
      kind: 'raised',
      request: { chairId: chair, chairNumber: '7', chairZoneName: null },
    });

    const list = await requests.listForBranch(branch, Date.now());
    const mine = list.waiting.filter((r) =>
      [first, second].includes(r.booking.id),
    );
    expect(mine.map((r) => r.request.chairNumber)).toEqual(['7', '7']);
  });

  it('raise at a chair: another branch, a booking with no tenant, a stale card are refused, and nothing is written', async () => {
    const chair = randomUUID();
    const at = AHEAD + 60 * MIN;
    const mine = await seed({ startAtMs: at, tenantId: TENANT });
    const untenanted = await seed({ startAtMs: at, tenantId: null });

    expect(
      await raiseAt(mine, at, scanned(chair, { branchId: randomUUID() })),
    ).toEqual({
      kind: 'chair_refused',
      refusal: { why: 'other_salon', which: 'other_branch' },
    });
    expect(
      await raiseAt(mine, at, scanned(chair, { cardStatus: 'REPLACED' })),
    ).toEqual({
      kind: 'chair_refused',
      refusal: { why: 'card_out_of_date', cardStatus: 'REPLACED' },
    });
    expect(await raiseAt(untenanted, at, scanned(chair))).toEqual({
      kind: 'chair_refused',
      refusal: { why: 'other_salon', which: 'untenanted_booking' },
    });
    expect(
      await prisma.checkInRequest.count({
        where: { bookingId: { in: [mine, untenanted] } },
      }),
    ).toBe(0);
  });

  it('who is in the chair: checked in or in service, the same trading day, and a latest claim that was not rejected', async () => {
    const at = AHEAD + 2 * 60 * MIN;
    /** A booking in `status` whose latest claim, in `state`, names a chair. */
    async function sitting(
      status: string,
      state: 'approved' | 'closed' | 'rejected',
      startAtMs = at,
    ) {
      const chair = randomUUID();
      const id = await seed({ startAtMs, tenantId: TENANT, status });
      await claim(id, state, startAtMs - 10 * MIN, { id: chair, number: '7' });
      return { chair, code: await codeOf(id) };
    }
    /** Another customer scans that chair. */
    async function next(chair: string) {
      const id = await seed({ startAtMs: at, tenantId: TENANT });
      return raiseAt(id, at, scanned(chair));
    }
    const occupied = (occupant: string) => ({
      kind: 'chair_refused',
      refusal: { why: 'chair_occupied', occupant },
    });

    const approved = await sitting('checked_in', 'approved');
    expect(await next(approved.chair)).toEqual(occupied(approved.code));

    // Scanned, then checked in with the desk's own button: the request closed.
    const deskButton = await sitting('checked_in', 'closed');
    expect(await next(deskButton.chair)).toEqual(occupied(deskButton.code));

    const inService = await sitting('in_service', 'approved');
    expect(await next(inService.chair)).toEqual(occupied(inService.code));

    const rejected = await sitting('checked_in', 'rejected');
    expect((await next(rejected.chair)).kind).toBe('raised');

    const finished = await sitting('completed', 'approved');
    expect((await next(finished.chair)).kind).toBe('raised');

    // Checked in yesterday and never closed: not in the chair today.
    const yesterday = await sitting(
      'checked_in',
      'approved',
      at - 24 * 60 * MIN,
    );
    expect((await next(yesterday.chair)).kind).toBe('raised');
  });

  it('two desks approve two bookings for one chair at once: one is seated, the other is told who is in it', async () => {
    const chair = randomUUID();
    const at = BASE + 18 * 60 * MIN;
    const a = await seed({ startAtMs: at, tenantId: TENANT });
    const b = await seed({ startAtMs: at, tenantId: TENANT });
    await claim(a, 'waiting', at, { id: chair, number: '7' });
    await claim(b, 'waiting', at + MIN, { id: chair, number: '7' });
    // The wait comes BEFORE the check-in, so both approvals have asked who
    // is in the chair before either has seated anybody: without the chair
    // lock, both would find it free.
    const slow = (id: string) => async () => {
      await sleep(300);
      return checkIn(id)();
    };

    const outs = await Promise.all([
      requests.approveWith(decider(a), slow(a)),
      requests.approveWith(decider(b), slow(b)),
    ]);

    expect(outs.map((o) => o.kind).sort()).toEqual([
      'approved',
      'chair_occupied',
    ]);
    const seated = outs[0]?.kind === 'approved' ? a : b;
    const turnedAway = seated === a ? b : a;
    expect(outs.find((o) => o.kind === 'chair_occupied')).toEqual({
      kind: 'chair_occupied',
      chairNumber: '7',
      occupant: await codeOf(seated),
    });
    expect(await statusOf(seated)).toBe('checked_in');
    expect(await statusOf(turnedAway)).toBe('confirmed');
    expect((await requests.latestFor(turnedAway))?.state).toBe('waiting');
  });

  it('approve holds the chair lock while it seats somebody, and lets it go after', async () => {
    const chair = randomUUID();
    const at = BASE + 19 * 60 * MIN;
    const a = await seed({ startAtMs: at, tenantId: TENANT });
    await claim(a, 'waiting', at, { id: chair, number: '7' });

    expect(await chairLockFree(chair)).toBe(true);
    const approval = requests.approveWith(decider(a), async () => {
      await sleep(500);
      return checkIn(a)();
    });
    await sleep(200);
    expect(await chairLockFree(chair)).toBe(false);
    expect((await approval).kind).toBe('approved');
    expect(await chairLockFree(chair)).toBe(true);
  });

  it('its own key space: a capacity-style one-bigint lock with the very same 64 bits never holds the chair lock', async () => {
    const chair = randomUUID();
    await prisma.$transaction(async (tx) => {
      // The capacity lock's form (hold.repository.ts), on purpose built from
      // the chair key's own bits: high 32 the class, low 32 the hash.
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(
                 (${CHAIR_LOCK_CLASS}::int8 << 32)
               | (hashtext(${chair})::int8 & 4294967295))`;

      // pg_locks: the same classid and objid as the chair key; only objsubid
      // (1: one bigint, 2: two ints) tells them apart.
      const held = await tx.$queryRaw<
        { classid: bigint; objid: bigint; objsubid: number; want: bigint }[]
      >`
        SELECT l.classid::int8 AS classid, l.objid::int8 AS objid,
               l.objsubid::int AS objsubid,
               hashtext(${chair})::int8 & 4294967295 AS want
          FROM pg_locks l
         WHERE l.locktype = 'advisory' AND l.pid = pg_backend_pid()`;
      expect(held).toHaveLength(1);
      expect(Number(held[0]!.classid)).toBe(CHAIR_LOCK_CLASS);
      expect(held[0]!.objid).toBe(held[0]!.want);
      expect(held[0]!.objsubid).toBe(1);

      // Another connection takes the chair lock beside it.
      expect(await chairLockFree(chair)).toBe(true);
    });

    // Control: the chair lock held, and the same probe is refused.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(${CHAIR_LOCK_CLASS}::int4,
                                     hashtext(${chair}))`;
      expect(await chairLockFree(chair)).toBe(false);
    });
  });
});
