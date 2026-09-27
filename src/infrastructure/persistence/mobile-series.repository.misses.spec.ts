import { describe, it, expect, vi } from 'vitest';
import { MobileSeriesRepository } from './mobile-series.repository';

function build(claimed = 1, missStreakAfter: Date | null = null) {
  const tx = {
    bookingSeries: {
      updateMany: vi.fn().mockResolvedValue({ count: claimed }),
    },
    eventOutbox: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: vi.fn((work: (t: typeof tx) => Promise<unknown>) => work(tx)),
    bookingSeries: {
      findUnique: vi.fn().mockResolvedValue({ missStreakAfter }),
    },
    seriesOccurrence: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const repo = new MobileSeriesRepository(prisma as never, {} as never);
  return { repo, tx, prisma };
}

describe('two misses in a row, the writes (step 8b)', () => {
  it('reads the day after which misses count, as a day', async () => {
    const { repo } = build(1, new Date('2026-10-13T00:00:00Z'));
    expect(await repo.missStreakAfter('S')).toBe('2026-10-13');
    const none = build(1, null);
    expect(await none.repo.missStreakAfter('S')).toBeNull();
  });

  it('pauses an active routine with no end date, remembers the second miss, and says so', async () => {
    const { repo, tx } = build(1);
    expect(await repo.pauseForMisses('S', '2026-10-13')).toBe(true);
    expect(tx.bookingSeries.updateMany).toHaveBeenCalledWith({
      where: { id: 'S', source: 'mobile', status: 'active' },
      data: {
        status: 'paused',
        pausedUntil: null,
        pauseReason: 'missed_twice',
        pauseNote: null,
        missStreakAfter: new Date('2026-10-13T00:00:00Z'),
      },
    });
    expect(tx.eventOutbox.create).toHaveBeenCalledWith({
      data: {
        aggregateType: 'series',
        aggregateId: 'S',
        eventType: 'series.paused',
        payload: {
          source: 'mobile',
          by: 'job',
          reason: 'missed_twice',
          after: '2026-10-13',
        },
      },
    });
  });

  it('writes nothing when the routine is not active any more', async () => {
    const { repo, tx } = build(0);
    expect(await repo.pauseForMisses('S', '2026-10-13')).toBe(false);
    expect(tx.eventOutbox.create).not.toHaveBeenCalled();
  });

  it('leaves a released visit planned, with nothing booked', async () => {
    const { repo, prisma } = build();
    await repo.unlinkReleased('S', 'O2');
    expect(prisma.seriesOccurrence.updateMany).toHaveBeenCalledWith({
      where: { id: 'O2', seriesId: 'S' },
      data: { state: 'planned', bookingId: null },
    });
  });
});
