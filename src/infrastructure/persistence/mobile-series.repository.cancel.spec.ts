import { describe, it, expect, vi } from 'vitest';
import { MobileSeriesRepository } from './mobile-series.repository';

function build(endedCount: number) {
  const tx = {
    bookingSeries: {
      updateMany: vi.fn().mockResolvedValue({ count: endedCount }),
    },
    seriesOccurrence: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    eventOutbox: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: vi.fn((work: (t: typeof tx) => Promise<unknown>) => work(tx)),
  };
  const repo = new MobileSeriesRepository(prisma as never, {} as never);
  return { repo, tx };
}

describe("endByCustomer: a routine ends at the customer's request (step 7)", () => {
  it('ends it, skips its never-booked sessions, and writes series.cancelled with the reason', async () => {
    const { repo, tx } = build(1);
    const ended = await repo.endByCustomer({
      seriesId: 'S',
      unbookedIds: ['O4'],
      reason: 'MOVING',
      cancelled: 2,
    });
    expect(ended).toBe(true);
    expect(tx.bookingSeries.updateMany).toHaveBeenCalledWith({
      where: { id: 'S', status: { in: ['active', 'paused'] } },
      data: { status: 'ended' },
    });
    expect(tx.seriesOccurrence.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['O4'] }, seriesId: 'S', bookingId: null },
      data: { state: 'skipped' },
    });
    expect(tx.eventOutbox.create).toHaveBeenCalledWith({
      data: {
        aggregateType: 'series',
        aggregateId: 'S',
        eventType: 'series.cancelled',
        payload: {
          source: 'mobile',
          status: 'ended',
          reason: 'MOVING',
          cancelled: 2,
          skipped: 1,
        },
      },
    });
  });

  it('writes nothing more when the routine was no longer active or paused', async () => {
    const { repo, tx } = build(0);
    const ended = await repo.endByCustomer({
      seriesId: 'S',
      unbookedIds: ['O4'],
      reason: null,
      cancelled: 0,
    });
    expect(ended).toBe(false);
    expect(tx.seriesOccurrence.updateMany).not.toHaveBeenCalled();
    expect(tx.eventOutbox.create).not.toHaveBeenCalled();
  });
});
