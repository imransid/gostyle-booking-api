import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../generated/prisma/client';
import {
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
