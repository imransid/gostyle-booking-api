import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../generated/prisma/client';
import {
  CHAIR_LOCK_CLASS,
  CheckInRequestRepository,
  arrivalClaimed,
} from './check-in-request.repository';
import { toUuid } from './hold.repository';

/**
 * The repository's own decisions, with the database faked. What the SQL
 * does against a real Postgres is self-check-in.live.spec.ts's question.
 */

const BOOKING = 'eeeeeeee-5555-4eee-8eee-eeeeeeeeeeee';
const MIN = 60_000;
const START = Date.UTC(2026, 9, 11, 10, 0);

function locked(over: Record<string, unknown> = {}) {
  return {
    id: BOOKING,
    status: 'confirmed',
    start_at: new Date(START),
    end_at: new Date(START + 60 * MIN),
    tenant_id: 'tenant-a',
    ...over,
  };
}

function repo(opts: {
  booking?: Record<string, unknown> | null;
  latest?: Record<string, unknown> | null;
}) {
  const created = { id: 'new-request', state: 'waiting' };
  const tx = {
    $queryRaw: vi.fn(() =>
      Promise.resolve(opts.booking === null ? [] : [opts.booking ?? locked()]),
    ),
    checkInRequest: {
      findFirst: vi.fn(() => Promise.resolve(opts.latest ?? null)),
      create: vi.fn(() => Promise.resolve(created)),
    },
  };
  const prisma = {
    $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return {
    r: new CheckInRequestRepository(prisma as never),
    prisma,
    tx,
    created,
  };
}

const raise = (r: CheckInRequestRepository, nowMs = START - 10 * MIN) =>
  r.raise({ bookingId: BOOKING, actor: 'customer', actorId: 'sara', nowMs });

describe('raise', () => {
  it('writes the claim with the BOOKING’s tenant and the folded actor id', async () => {
    const h = repo({});
    await expect(raise(h.r)).resolves.toEqual({
      kind: 'raised',
      request: h.created,
    });
    expect(h.tx.checkInRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          bookingId: BOOKING,
          tenantId: 'tenant-a',
          raisedAt: new Date(START - 10 * MIN),
          raisedByKind: 'customer',
          raisedById: toUuid('sara'),
        },
      }),
    );
  });

  it('takes the booking row lock before it reads anything else', async () => {
    const h = repo({});
    await raise(h.r);
    const sql = Prisma.sql(
      ...(h.tx.$queryRaw.mock.calls[0] as unknown as [
        TemplateStringsArray,
        ...unknown[],
      ]),
    );
    expect(sql.text).toMatch(/FROM booking[\s\S]*FOR UPDATE/);
    expect(h.tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      h.tx.checkInRequest.findFirst.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('answers a second tap with the waiting request and writes nothing', async () => {
    const waiting = { id: 'first', state: 'waiting' };
    const h = repo({ latest: waiting });
    await expect(raise(h.r)).resolves.toEqual({
      kind: 'already_waiting',
      request: waiting,
    });
    expect(h.tx.checkInRequest.create).not.toHaveBeenCalled();
  });

  it('passes a refusal on with the booking status, and writes nothing', async () => {
    const h = repo({ booking: locked({ status: 'checked_in' }) });
    await expect(raise(h.r)).resolves.toEqual({
      kind: 'refused',
      why: 'not_confirmed',
      bookingStatus: 'checked_in',
    });
    expect(h.tx.checkInRequest.create).not.toHaveBeenCalled();
  });

  it('says when check-in opens on a refusal for being early', async () => {
    const h = repo({});
    await expect(raise(h.r, START - 31 * MIN)).resolves.toMatchObject({
      kind: 'refused',
      why: 'too_early',
      opensAtMs: START - 30 * MIN,
    });
  });

  it('refuses after a rejection', async () => {
    const h = repo({ latest: { id: 'old', state: 'rejected' } });
    await expect(raise(h.r)).resolves.toMatchObject({
      kind: 'refused',
      why: 'rejected_before',
    });
  });

  it('is not_found for a booking that is not there', async () => {
    const h = repo({ booking: null });
    await expect(raise(h.r)).resolves.toEqual({ kind: 'not_found' });
  });

  it('is not_found for a malformed id, without a query', async () => {
    const h = repo({});
    await expect(
      h.r.raise({ bookingId: 'nope', actor: 'customer', actorId: 'sara' }),
    ).resolves.toEqual({ kind: 'not_found' });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('lapseWaiting', () => {
  const NOW = START + 2 * 60 * MIN;

  function lapsing(rows: Record<string, unknown>[], counts: number[] = []) {
    const updateMany = vi.fn(() =>
      Promise.resolve({ count: counts.shift() ?? 1 }),
    );
    const prisma = {
      $queryRaw: vi.fn(() => Promise.resolve(rows)),
      checkInRequest: { updateMany },
    };
    return {
      r: new CheckInRequestRepository(prisma as never),
      prisma,
      updateMany,
    };
  }

  const row = (id: string, status: string, endAtMs: number) => ({
    id,
    code: `GS-${id}`,
    booking_status: status,
    end_at: new Date(endAtMs),
  });

  it('expires, closes, and leaves alone, each as lapseOf says', async () => {
    const h = lapsing([
      row('ignored', 'confirmed', NOW - MIN),
      row('moved', 'cancelled', NOW + 60 * MIN),
      row('fresh', 'confirmed', NOW + 60 * MIN),
    ]);
    await expect(h.r.lapseWaiting(NOW)).resolves.toEqual([
      { id: 'ignored', code: 'GS-ignored', to: 'expired' },
      { id: 'moved', code: 'GS-moved', to: 'closed' },
    ]);
    expect(h.updateMany).toHaveBeenCalledTimes(2);
    expect(h.updateMany).toHaveBeenCalledWith({
      where: { id: 'ignored', state: 'waiting' },
      data: {
        state: 'expired',
        decidedAt: new Date(NOW),
        decidedByKind: 'system',
        decidedById: null,
        reason: 'Nobody answered before the booking ended.',
      },
    });
  });

  it('reports nothing for a request the desk answered in between', async () => {
    // Compare and set: the desk's answer stands, and the job does not
    // claim a lapse it did not write.
    const h = lapsing([row('raced', 'confirmed', NOW - MIN)], [0]);
    await expect(h.r.lapseWaiting(NOW)).resolves.toEqual([]);
  });

  it('reads every waiting request, with no LIMIT', async () => {
    const h = lapsing([]);
    await h.r.lapseWaiting(NOW);
    const sql = Prisma.sql(
      ...(h.prisma.$queryRaw.mock.calls[0] as unknown as [
        TemplateStringsArray,
        ...unknown[],
      ]),
    );
    expect(sql.text).toMatch(/WHERE r\.state = 'waiting'/);
    expect(sql.text).not.toMatch(/LIMIT/i);
  });
});

describe('arrivalClaimed', () => {
  it('asks of the LATEST request only, and lets only a rejection through', () => {
    const sql = arrivalClaimed(Prisma.sql`b.id`);
    expect(sql.text).toMatch(
      /ORDER BY r\.raised_at DESC, r\.id DESC\s+LIMIT 1\) latest/,
    );
    expect(sql.text).toMatch(/WHERE latest\.state <> 'rejected'/);
    expect(sql.values).toEqual([]);
  });

  it('binds an id as a value, never as text', () => {
    const sql = arrivalClaimed(Prisma.sql`${BOOKING}::uuid`);
    expect(sql.values).toEqual([BOOKING]);
    expect(sql.text).not.toContain(BOOKING);
  });
});

describe('approveWith: lock, check in, then mark', () => {
  const NOW = START + 5 * MIN;
  const decider = {
    bookingId: BOOKING,
    deciderKind: 'staff' as const,
    deciderId: 'desk-1',
    nowMs: NOW,
  };

  function approving(opts: {
    waiting?: boolean;
    bookingExists?: boolean;
    latest?: string | null;
    /** The waiting request claims a chair; occupant: who is in it. */
    chair?: { id: string; number: string; occupant: string | null };
  }) {
    const order: string[] = [];
    const approved = { id: 'req-1', state: 'approved' };
    let queries = 0;
    const tx = {
      // The first query locks the waiting request, as the table returns it:
      // chair_id and chair_number are null on a request with no chair. Any
      // later one asks who is in the chair.
      $queryRaw: vi.fn(() => {
        queries += 1;
        if (queries > 1) {
          order.push('occupant');
          const code = opts.chair?.occupant ?? null;
          return Promise.resolve(code === null ? [] : [{ code }]);
        }
        order.push('lock');
        return Promise.resolve(
          opts.waiting === false
            ? []
            : [
                {
                  id: 'req-1',
                  chair_id: opts.chair?.id ?? null,
                  chair_number: opts.chair?.number ?? null,
                },
              ],
        );
      }),
      $executeRaw: vi.fn(() => {
        order.push('chair lock');
        return Promise.resolve(1);
      }),
      checkInRequest: {
        update: vi.fn(() => {
          order.push('mark');
          return Promise.resolve(approved);
        }),
        findFirst: vi.fn(() =>
          Promise.resolve(
            opts.latest === undefined || opts.latest === null
              ? null
              : { state: opts.latest },
          ),
        ),
      },
      booking: {
        findUnique: vi.fn(() =>
          Promise.resolve(
            opts.bookingExists === false ? null : { id: BOOKING },
          ),
        ),
      },
    };
    const prisma = {
      $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const checkIn = vi.fn(() => {
      order.push('check-in');
      return Promise.resolve({ to: 'CHECKED_IN' });
    });
    return {
      r: new CheckInRequestRepository(prisma as never),
      tx,
      checkIn,
      order,
      approved,
    };
  }

  it('locks the waiting request, runs the check-in, then marks it, in that order', async () => {
    const h = approving({});
    await expect(h.r.approveWith(decider, h.checkIn)).resolves.toEqual({
      kind: 'approved',
      request: h.approved,
      checkIn: { to: 'CHECKED_IN' },
    });
    expect(h.order).toEqual(['lock', 'check-in', 'mark']);
    const lock = Prisma.sql(
      ...(h.tx.$queryRaw.mock.calls[0] as unknown as [
        TemplateStringsArray,
        ...unknown[],
      ]),
    );
    expect(lock.text).toMatch(/state = 'waiting'\s+FOR UPDATE/);
    expect(h.tx.checkInRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'req-1' },
        data: {
          state: 'approved',
          decidedAt: new Date(NOW),
          decidedByKind: 'staff',
          decidedById: toUuid('desk-1'),
        },
      }),
    );
  });

  it('a claimed chair: the request, then the chair lock, then who is in it, then the check-in and the mark', async () => {
    const chair = '0192a3b4-0000-7000-8000-000000000007';
    const h = approving({ chair: { id: chair, number: '7', occupant: null } });
    await expect(h.r.approveWith(decider, h.checkIn)).resolves.toMatchObject({
      kind: 'approved',
    });
    expect(h.order).toEqual([
      'lock',
      'chair lock',
      'occupant',
      'check-in',
      'mark',
    ]);
    // The two-int form, in the chair's own key space (CHAIR_LOCK_CLASS).
    const lock = Prisma.sql(
      ...(h.tx.$executeRaw.mock.calls[0] as unknown as [
        TemplateStringsArray,
        ...unknown[],
      ]),
    );
    expect(lock.text).toMatch(
      /pg_advisory_xact_lock\(\$1::int4,\s*hashtext\(\$2\)\)/,
    );
    expect(lock.values).toEqual([CHAIR_LOCK_CLASS, chair]);
  });

  it('the claimed chair is taken: nobody is checked in, nothing is marked, and the desk is told who', async () => {
    const h = approving({
      chair: { id: 'c-7', number: '7', occupant: 'GS-1402' },
    });
    await expect(h.r.approveWith(decider, h.checkIn)).resolves.toEqual({
      kind: 'chair_occupied',
      chairNumber: '7',
      occupant: 'GS-1402',
    });
    expect(h.checkIn).not.toHaveBeenCalled();
    expect(h.tx.checkInRequest.update).not.toHaveBeenCalled();
  });

  it('a refused check-in throws, and the request is never marked', async () => {
    const h = approving({});
    const refused = new Error('A cancelled booking cannot become checked_in.');
    h.checkIn.mockRejectedValueOnce(refused);
    await expect(h.r.approveWith(decider, h.checkIn)).rejects.toBe(refused);
    expect(h.tx.checkInRequest.update).not.toHaveBeenCalled();
  });

  it('nothing waiting: no check-in, and the latest state says why', async () => {
    const h = approving({ waiting: false, latest: 'approved' });
    await expect(h.r.approveWith(decider, h.checkIn)).resolves.toEqual({
      kind: 'nothing_waiting',
      latest: 'approved',
    });
    expect(h.checkIn).not.toHaveBeenCalled();
  });

  it('nothing waiting and no booking: not_found', async () => {
    const h = approving({ waiting: false, bookingExists: false });
    await expect(h.r.approveWith(decider, h.checkIn)).resolves.toEqual({
      kind: 'not_found',
    });
  });

  it('a malformed id: not_found, without a transaction', async () => {
    const h = approving({});
    await expect(
      h.r.approveWith({ ...decider, bookingId: 'nope' }, h.checkIn),
    ).resolves.toEqual({ kind: 'not_found' });
    expect(h.checkIn).not.toHaveBeenCalled();
  });
});

describe('reject', () => {
  function rejecting(updated: { id: string }[], bookingExists = true) {
    const row = { id: 'req-1', state: 'rejected' };
    const tx = {
      $queryRaw: vi.fn(() => Promise.resolve(updated)),
      checkInRequest: {
        findUniqueOrThrow: vi.fn(() => Promise.resolve(row)),
        findFirst: vi.fn(() => Promise.resolve({ state: 'expired' })),
      },
      booking: {
        findUnique: vi.fn(() =>
          Promise.resolve(bookingExists ? { id: BOOKING } : null),
        ),
      },
    };
    const prisma = {
      $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    return { r: new CheckInRequestRepository(prisma as never), tx, row };
  }
  const input = {
    bookingId: BOOKING,
    deciderKind: 'manager' as const,
    deciderId: 'desk-2',
    reason: 'Not at the salon',
    nowMs: START,
  };

  it('one UPDATE, only of a WAITING request, with who, when and why', async () => {
    const h = rejecting([{ id: 'req-1' }]);
    await expect(h.r.reject(input)).resolves.toEqual({
      kind: 'rejected',
      request: h.row,
    });
    const sql = Prisma.sql(
      ...(h.tx.$queryRaw.mock.calls[0] as unknown as [
        TemplateStringsArray,
        ...unknown[],
      ]),
    );
    expect(sql.text).toMatch(
      /UPDATE check_in_request[\s\S]*state = 'rejected'/,
    );
    expect(sql.text).toMatch(/AND state = 'waiting'\s+RETURNING id/);
    expect(sql.values).toEqual([
      new Date(START),
      'manager',
      toUuid('desk-2'),
      'Not at the salon',
      BOOKING,
    ]);
  });

  it('nothing waiting: the latest state says why', async () => {
    await expect(rejecting([]).r.reject(input)).resolves.toEqual({
      kind: 'nothing_waiting',
      latest: 'expired',
    });
  });

  it('no booking: not_found', async () => {
    await expect(rejecting([], false).r.reject(input)).resolves.toEqual({
      kind: 'not_found',
    });
  });
});

describe('listForBranch', () => {
  it('waiting: this branch, still CONFIRMED; needsDecision: the sweeper’s own claim rule, past the auto no-show time', async () => {
    const queryRaw = vi.fn(() => Promise.resolve([]));
    const r = new CheckInRequestRepository({ $queryRaw: queryRaw } as never);
    const NOW = START + 2 * 60 * MIN;
    await r.listForBranch('marina-walk', NOW);

    const [waiting, needs] = (
      queryRaw.mock.calls as unknown as [TemplateStringsArray, ...unknown[]][]
    ).map((c) => Prisma.sql(...c));
    expect(waiting?.text).toMatch(/r\.state = 'waiting'/);
    expect(waiting?.text).toMatch(/b\.status = 'confirmed'/);
    expect(waiting?.values).toEqual([toUuid('marina-walk')]);

    expect(needs?.text).toMatch(/b\.status = 'confirmed'/);
    expect(needs?.text).toContain(arrivalClaimed(Prisma.sql`b.id`).text);
    expect(needs?.text).toMatch(/r\.state <> 'waiting'/);
    expect(needs?.values).toEqual([
      toUuid('marina-walk'),
      new Date(NOW - 30 * MIN),
      100,
    ]);
  });
});
