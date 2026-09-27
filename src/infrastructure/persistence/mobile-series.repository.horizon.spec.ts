import { describe, it, expect, vi } from 'vitest';
import { MobileSeriesRepository } from './mobile-series.repository';

function build(occurrenceCount = 1, bookingCount = 1) {
  const tx = {
    seriesOccurrence: {
      updateMany: vi.fn().mockResolvedValue({ count: occurrenceCount }),
      findMany: vi
        .fn()
        .mockResolvedValue([{ plannedDay: new Date('2026-12-20T00:00:00Z') }]),
    },
    booking: {
      updateMany: vi.fn().mockResolvedValue({ count: bookingCount }),
    },
    bookingSeries: { update: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: vi.fn((work: (t: typeof tx) => Promise<unknown>) => work(tx)),
    seriesOccurrence: {
      updateMany: vi.fn().mockResolvedValue({ count: occurrenceCount }),
    },
  };
  const repo = new MobileSeriesRepository(prisma as never, {} as never);
  return { repo, tx, prisma };
}

const LINK = {
  seriesId: 'S',
  customerId: 'cccccccc-cccc-4ccc-8ccc-000000000001',
  occurrenceId: 'O4',
  day: '2026-12-20',
  startMin: 660,
  bookingId: 'B4',
};

describe('far-off visits, the writes (step 8c)', () => {
  it('claims a planned visit by marking it "needs action", once', async () => {
    const { repo, prisma } = build(1);
    expect(await repo.claimPlanned('S', 'O4')).toBe(true);
    expect(prisma.seriesOccurrence.updateMany).toHaveBeenCalledWith({
      where: { id: 'O4', seriesId: 'S', state: 'planned', bookingId: null },
      data: { state: 'needs_attention' },
    });
    expect(await build(0).repo.claimPlanned('S', 'O4')).toBe(false);
  });

  it('links the booking to a visit that still has none, and the routine to its dates', async () => {
    const { repo, tx } = build(1, 1);
    expect(await repo.linkSession(LINK)).toBe(true);
    expect(tx.seriesOccurrence.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'O4',
        seriesId: 'S',
        bookingId: null,
        state: { in: ['planned', 'needs_attention'] },
      },
      data: {
        state: 'materialised',
        bookingId: 'B4',
        plannedDay: new Date('2026-12-20T00:00:00Z'),
        plannedStartMin: 660,
      },
    });
    expect(tx.booking.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.bookingSeries.update).toHaveBeenCalledWith({
      where: { id: 'S' },
      data: { customDates: [new Date('2026-12-20T00:00:00Z')] },
    });
  });

  it('writes nothing when the visit got a booking in the meantime', async () => {
    const { repo, tx } = build(0);
    expect(await repo.linkSession(LINK)).toBe(false);
    expect(tx.booking.updateMany).not.toHaveBeenCalled();
    expect(tx.bookingSeries.update).not.toHaveBeenCalled();
  });

  it('undoes it all when the booking cannot be linked', async () => {
    const { repo } = build(1, 0);
    await expect(repo.linkSession(LINK)).rejects.toThrow('could not be linked');
  });
});
