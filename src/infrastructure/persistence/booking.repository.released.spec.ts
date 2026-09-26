import { describe, it, expect, vi } from 'vitest';
import { BookingRepository } from './booking.repository';
import { RELEASED_SESSION_REASON } from '@domain/booking/mobile-series-list';

describe('customerPage: a visit released by a routine that could not be booked in full', () => {
  it('is left out of the page count and of both badges', async () => {
    const count = vi.fn().mockResolvedValue(0);
    const repo = Object.create(
      BookingRepository.prototype,
    ) as BookingRepository;
    Object.assign(repo, { prisma: { booking: { count } } });

    await repo.customerPage({
      customerId: '11111111-1111-4111-8111-111111111111',
      shelf: 'archive',
      now: new Date('2026-09-26T12:00:00Z'),
      page: 1,
      pageSize: 0,
    });

    const calls = count.mock.calls as [{ where: { NOT: unknown[] } }][];
    expect(calls).toHaveLength(3);
    for (const [args] of calls) {
      expect(args.where.NOT).toContainEqual({
        status: 'cancelled',
        seriesId: null,
        statusHistory: { some: { reason: RELEASED_SESSION_REASON } },
      });
    }
  });
});
