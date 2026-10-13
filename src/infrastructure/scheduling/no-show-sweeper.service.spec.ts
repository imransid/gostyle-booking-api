import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../generated/prisma/client';
import { NoShowSweeper } from './no-show-sweeper.service';

/**
 * The sweeper and self check-in, with the database faked: that the claim is
 * in the QUERY and asked again in the LOCK. That the query really skips a
 * claimed booking without costing anybody else their sweep is proven on a
 * real Postgres in self-check-in.live.spec.ts.
 */

function sweeper(rows: { id: string; code: string }[]) {
  const prisma = { $queryRaw: vi.fn(() => Promise.resolve(rows)) };
  const lifecycle = {
    transition: vi.fn(() => Promise.resolve({ kind: 'transitioned' })),
  };
  return {
    s: new NoShowSweeper(prisma as never, lifecycle as never),
    prisma,
    lifecycle,
  };
}

describe('NoShowSweeper and self check-in', () => {
  it('filters claimed bookings out in the candidate query, before the LIMIT', async () => {
    const h = sweeper([]);
    await h.s.sweep();
    const sql = Prisma.sql(
      ...(h.prisma.$queryRaw.mock.calls[0] as unknown as [
        TemplateStringsArray,
        ...unknown[],
      ]),
    );
    expect(sql.text).toMatch(
      /AND NOT EXISTS \([\s\S]*check_in_request[\s\S]*\)\s+ORDER BY b\.start_at\s+LIMIT 50/,
    );
  });

  it('asks again inside the row lock, for every candidate', async () => {
    const h = sweeper([
      { id: 'a', code: 'GS-1' },
      { id: 'b', code: 'GS-2' },
    ]);
    await h.s.sweep();
    expect(h.lifecycle.transition).toHaveBeenCalledTimes(2);
    for (const [input] of h.lifecycle.transition.mock.calls as unknown as [
      Record<string, unknown>,
    ][]) {
      expect(input).toMatchObject({
        to: 'no_show',
        actor: 'system',
        unlessArrivalClaimed: true,
      });
    }
  });

  it('carries on past a booking held off in the lock', async () => {
    const h = sweeper([
      { id: 'a', code: 'GS-1' },
      { id: 'b', code: 'GS-2' },
    ]);
    h.lifecycle.transition.mockResolvedValueOnce({
      kind: 'illegal',
      message: 'GS-1: the customer said they arrived, so the desk decides.',
    } as never);
    await h.s.sweep();
    expect(h.lifecycle.transition).toHaveBeenCalledTimes(2);
    expect(h.s.stats().markedTotal).toBe(1);
  });
});
