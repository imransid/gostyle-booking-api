import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../persistence/prisma.service';
import { LifecycleRepository } from '../persistence/lifecycle.repository';
import {
  CheckInRequestRepository,
  arrivalClaimed,
} from '../persistence/check-in-request.repository';
import { NoShowSweeper } from './no-show-sweeper.service';
import { CheckInRequestSweeper } from './check-in-request-sweeper.service';

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
              ${branch}::uuid, ${randomUUID()}::uuid,
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
                                    decided_by_kind, decided_by_id, reason)
      VALUES (${randomUUID()}::uuid, ${bookingId}::uuid,
              ${state}::check_in_request_state, ${new Date(raisedAtMs)},
              'customer', ${randomUUID()}::uuid,
              ${state === 'waiting' ? null : new Date(raisedAtMs + MIN)},
              ${decidedBy}::actor_kind,
              ${decidedBy === 'staff' ? randomUUID() : null}::uuid,
              ${state === 'rejected' ? 'Not at the salon' : null})`;
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
});
