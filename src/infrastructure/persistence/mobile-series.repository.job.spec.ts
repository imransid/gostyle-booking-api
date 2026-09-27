import { describe, it, expect, vi } from 'vitest';
import { MobileSeriesRepository } from './mobile-series.repository';

function build(claimed = 1) {
  const tx = {
    bookingSeries: {
      updateMany: vi.fn().mockResolvedValue({ count: claimed }),
    },
    eventOutbox: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: vi.fn((work: (t: typeof tx) => Promise<unknown>) => work(tx)),
    bookingSeries: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'S1',
          customerId: 'C',
          status: 'paused',
          pausedUntil: new Date('2026-10-01T00:00:00Z'),
        },
        { id: 'S2', customerId: 'C', status: 'active', pausedUntil: null },
      ]),
      updateMany: vi.fn().mockResolvedValue({ count: 3 }),
    },
    eventOutbox: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  const repo = new MobileSeriesRepository(prisma as never, {} as never);
  return { repo, tx, prisma };
}

describe("the job's writes (step 8)", () => {
  it('lists the open app routines, with the pause date as a day', async () => {
    const { repo, prisma } = build();
    expect(await repo.openRoutines()).toEqual([
      {
        id: 'S1',
        customerId: 'C',
        status: 'paused',
        pausedUntil: '2026-10-01',
      },
      { id: 'S2', customerId: 'C', status: 'active', pausedUntil: null },
    ]);
    expect(prisma.bookingSeries.findMany).toHaveBeenCalledWith({
      where: { source: 'mobile', status: { in: ['active', 'paused'] } },
      select: { id: true, customerId: true, status: true, pausedUntil: true },
      orderBy: { createdAt: 'asc' },
    });
  });

  it('puts the desk job back out of every app routine', async () => {
    const { repo, prisma } = build();
    expect(await repo.keepDeskAway()).toBe(3);
    const far = new Date('9999-12-31T00:00:00Z');
    expect(prisma.bookingSeries.updateMany).toHaveBeenCalledWith({
      where: {
        source: 'mobile',
        OR: [
          { materialisedThrough: null },
          { materialisedThrough: { not: far } },
        ],
      },
      data: { materialisedThrough: far },
    });
  });

  it('ends a pause only if it is still paused past its date, and says so', async () => {
    const { repo, tx } = build(1);
    expect(await repo.resumeByJob('S1', '2026-10-01')).toBe(true);
    expect(tx.bookingSeries.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'S1',
        source: 'mobile',
        status: 'paused',
        pausedUntil: { not: null, lte: new Date('2026-10-01T00:00:00Z') },
      },
      data: {
        status: 'active',
        pausedUntil: null,
        pauseReason: null,
        pauseNote: null,
      },
    });
    expect(tx.eventOutbox.create).toHaveBeenCalledWith({
      data: {
        aggregateType: 'series',
        aggregateId: 'S1',
        eventType: 'series.resumed',
        payload: { source: 'mobile', by: 'job', on: '2026-10-01' },
      },
    });
  });

  it('writes nothing when the other copy got there first', async () => {
    const { repo, tx } = build(0);
    expect(await repo.resumeByJob('S1', '2026-10-01')).toBe(false);
    expect(await repo.completeByJob('S1')).toBe(false);
    expect(tx.eventOutbox.create).not.toHaveBeenCalled();
  });

  it('completes an open routine and says so', async () => {
    const { repo, tx } = build(1);
    expect(await repo.completeByJob('S2')).toBe(true);
    expect(tx.bookingSeries.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'S2',
        source: 'mobile',
        status: { in: ['active', 'paused'] },
      },
      data: { status: 'completed' },
    });
  });

  it('writes events with their own ids, and lets the database skip the ones it has', async () => {
    const { repo, prisma } = build();
    const events = [
      {
        id: '11111111-1111-5111-8111-111111111111',
        eventType: 'series.session_reminder_48h',
        payload: { source: 'mobile', index: 0 },
      },
    ];
    expect(await repo.writeEvents('S2', events)).toBe(1);
    expect(prisma.eventOutbox.createMany).toHaveBeenCalledWith({
      data: [
        {
          id: '11111111-1111-5111-8111-111111111111',
          aggregateType: 'series',
          aggregateId: 'S2',
          eventType: 'series.session_reminder_48h',
          payload: { source: 'mobile', index: 0 },
        },
      ],
      skipDuplicates: true,
    });
    expect(await repo.writeEvents('S2', [])).toBe(0);
    expect(prisma.eventOutbox.createMany).toHaveBeenCalledTimes(1);
  });
});
