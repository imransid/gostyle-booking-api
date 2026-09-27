import { describe, it, expect, vi } from 'vitest';
import { MobileSeriesRepository } from './mobile-series.repository';

function build(changedCount: number) {
  const tx = {
    bookingSeries: {
      updateMany: vi.fn().mockResolvedValue({ count: changedCount }),
      update: vi.fn().mockResolvedValue({}),
    },
    seriesOccurrence: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi
        .fn()
        .mockResolvedValue([
          { plannedDay: new Date('2026-09-22T00:00:00Z') },
          { plannedDay: new Date('2026-11-10T00:00:00Z') },
        ]),
    },
    booking: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    eventOutbox: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: vi.fn((work: (t: typeof tx) => Promise<unknown>) => work(tx)),
  };
  const repo = new MobileSeriesRepository(prisma as never, {} as never);
  return { repo, tx };
}

const SESSIONS = [
  {
    occurrenceId: 'O1',
    day: '2026-11-10',
    startMin: 660,
    movedFromDayOfMonth: null,
    bookingId: 'NEW1',
  },
  {
    occurrenceId: 'O3',
    day: '2026-11-17',
    startMin: 660,
    movedFromDayOfMonth: null,
    bookingId: 'KEPT',
  },
  {
    occurrenceId: 'O4',
    day: '2027-02-02',
    startMin: 660,
    movedFromDayOfMonth: null,
    bookingId: null,
  },
];

describe('moveSessions: a PAUSE or RESUME saved in one go (step 7)', () => {
  it('pauses the routine, parks then moves each session, links the new bookings, and says so', async () => {
    const { repo, tx } = build(1);
    const saved = await repo.moveSessions({
      seriesId: 'S',
      customerId: 'cccccccc-cccc-4ccc-8ccc-000000000001',
      fromStatus: 'active',
      sessions: SESSIONS,
      linkIds: ['NEW1'],
      after: {
        status: 'paused',
        pausedUntil: '2026-11-10',
        pauseReason: 'travel',
        pauseNote: null,
      },
      summary: { moved: 2, kept: 1, booked: 1, released: 1 },
    });
    expect(saved).toBe(true);
    expect(tx.bookingSeries.updateMany).toHaveBeenCalledWith({
      where: { id: 'S', status: 'active' },
      data: {
        status: 'paused',
        pausedUntil: new Date('2026-11-10T00:00:00Z'),
        pauseReason: 'travel',
        pauseNote: null,
      },
    });
    // Three parked, then three moved.
    expect(tx.seriesOccurrence.updateMany).toHaveBeenCalledTimes(6);
    expect(tx.seriesOccurrence.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'O1', seriesId: 'S' },
      data: {
        plannedDay: new Date(Date.UTC(2999, 0, 1)),
        bookingId: null,
        state: 'planned',
      },
    });
    expect(tx.seriesOccurrence.updateMany).toHaveBeenNthCalledWith(5, {
      where: { id: 'O3', seriesId: 'S' },
      data: {
        plannedDay: new Date('2026-11-17T00:00:00Z'),
        plannedStartMin: 660,
        movedFromDayOfMonth: null,
        state: 'materialised',
        bookingId: 'KEPT',
      },
    });
    expect(tx.seriesOccurrence.updateMany).toHaveBeenNthCalledWith(6, {
      where: { id: 'O4', seriesId: 'S' },
      data: {
        plannedDay: new Date('2027-02-02T00:00:00Z'),
        plannedStartMin: 660,
        movedFromDayOfMonth: null,
        state: 'planned',
        bookingId: null,
      },
    });
    expect(tx.booking.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.bookingSeries.update).toHaveBeenCalledWith({
      where: { id: 'S' },
      data: {
        customDates: [
          new Date('2026-09-22T00:00:00Z'),
          new Date('2026-11-10T00:00:00Z'),
        ],
      },
    });
    expect(tx.eventOutbox.create).toHaveBeenCalledWith({
      data: {
        aggregateType: 'series',
        aggregateId: 'S',
        eventType: 'series.paused',
        payload: {
          source: 'mobile',
          until: '2026-11-10',
          reason: 'travel',
          moved: 2,
          kept: 1,
          booked: 1,
          released: 1,
        },
      },
    });
  });

  it('writes what "Customize first" changed on a resume', async () => {
    const { repo, tx } = build(1);
    await repo.moveSessions({
      seriesId: 'S',
      customerId: 'cccccccc-cccc-4ccc-8ccc-000000000001',
      fromStatus: 'paused',
      sessions: [],
      linkIds: [],
      after: {
        status: 'active',
        pausedUntil: null,
        pauseReason: null,
        pauseNote: null,
        startMin: 900,
        preferredStaffId: 'maya',
        frequency: 'every_2_weeks',
        anchorDay: '2026-10-06',
      },
      summary: { moved: 0, kept: 0, booked: 0, released: 0 },
    });
    expect(tx.bookingSeries.updateMany).toHaveBeenCalledWith({
      where: { id: 'S', status: 'paused' },
      data: {
        status: 'active',
        pausedUntil: null,
        pauseReason: null,
        pauseNote: null,
        startMin: 900,
        preferredStaffId: 'maya',
        frequency: 'every_2_weeks',
        anchorDay: new Date('2026-10-06T00:00:00Z'),
      },
    });
    const [event] = tx.eventOutbox.create.mock.calls[0] as unknown as [
      { data: { eventType: string } },
    ];
    expect(event.data.eventType).toBe('series.resumed');
  });

  it('writes nothing more when the routine no longer has the status', async () => {
    const { repo, tx } = build(0);
    const saved = await repo.moveSessions({
      seriesId: 'S',
      customerId: 'cccccccc-cccc-4ccc-8ccc-000000000001',
      fromStatus: 'active',
      sessions: SESSIONS,
      linkIds: ['NEW1'],
      after: {
        status: 'paused',
        pausedUntil: '2026-11-10',
        pauseReason: null,
        pauseNote: null,
      },
      summary: { moved: 2, kept: 1, booked: 1, released: 1 },
    });
    expect(saved).toBe(false);
    expect(tx.seriesOccurrence.updateMany).not.toHaveBeenCalled();
    expect(tx.booking.updateMany).not.toHaveBeenCalled();
    expect(tx.eventOutbox.create).not.toHaveBeenCalled();
  });
});
