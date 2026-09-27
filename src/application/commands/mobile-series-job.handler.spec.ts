import { describe, it, expect, vi, afterEach } from 'vitest';
import { MobileSeriesJobHandler } from './mobile-series-job.handler';
import {
  MISSED_RELEASE_REASON,
  NEEDS_ACTION_EVENT,
  REMINDER_EVENT,
  needsActionEventId,
  reminderEventId,
} from '@domain/booking/mobile-series-job';

const NOW = Date.parse('2026-10-01T09:00:00+06:00');
const HOUR = 3_600_000;
const CUSTOMER = 'cccccccc-cccc-4ccc-8ccc-000000000001';

const visit = (
  id: string,
  index: number,
  startAtMs: number,
  bookingStatus: string | null = 'confirmed',
  noShowBy: 'staff' | 'system' | null = null,
) => ({
  id,
  index,
  day: new Date(startAtMs).toISOString().slice(0, 10),
  startAtMs,
  state: bookingStatus === null ? 'planned' : 'materialised',
  bookingStatus,
  noShowBy,
});

const routine = (
  id: string,
  status: 'active' | 'paused' = 'active',
  pausedUntil: string | null = null,
) => ({ id, customerId: CUSTOMER, status, pausedUntil });

/** What one routine looks like to the job: its rows and its facts. */
const loaded = (
  visits: ReturnType<typeof visit>[],
  status: 'active' | 'paused' = 'active',
) => ({
  series: {
    id: 'S',
    status,
    tenantId: 'T1',
    branchId: 'BR',
    customerId: CUSTOMER,
    frequency: 'monthly',
    serviceIds: ['svc'],
    preferredStaffId: 'pref',
    occurrences: visits.map((v) => ({
      id: v.id,
      bookingId: v.bookingStatus === null ? null : `b-${v.id}`,
      plannedStartMin: 660,
    })),
  },
  facts: visits,
});

function build(
  routines: ReturnType<typeof routine>[],
  byId: Record<string, ReturnType<typeof loaded>>,
) {
  const repo = {
    keepDeskAway: vi.fn().mockResolvedValue(0),
    openRoutines: vi.fn().mockResolvedValue(routines),
    resumeByJob: vi.fn().mockResolvedValue(true),
    completeByJob: vi.fn().mockResolvedValue(true),
    missStreakAfter: vi.fn().mockResolvedValue(null),
    pauseForMisses: vi.fn().mockResolvedValue(true),
    unlinkReleased: vi.fn().mockResolvedValue(undefined),
    claimPlanned: vi.fn().mockResolvedValue(true),
    writeEvents: vi.fn((...args: [string, readonly unknown[]]) =>
      Promise.resolve(args[1].length),
    ),
  };
  const reads = {
    factsForJob: vi.fn((id: string) => Promise.resolve(byId[id] ?? null)),
  };
  const lifecycle = {
    transition: vi.fn().mockResolvedValue({ kind: 'transitioned' }),
  };
  const creates = { bookSession: vi.fn().mockResolvedValue('booked') };
  const tenants = {
    run: vi.fn((...args: [string | null, () => unknown]) => args[1]()),
  };
  const job = new MobileSeriesJobHandler(
    repo as never,
    reads as never,
    lifecycle as never,
    creates as never,
    tenants as never,
  );
  return { job, repo, reads, lifecycle, creates, tenants };
}

describe('the hourly job, 8a (step 8)', () => {
  it('ends a pause whose date has come, and no other', async () => {
    const future = loaded([visit('o1', 0, NOW + 500 * HOUR)]);
    const { job, repo } = build(
      [
        routine('due', 'paused', '2026-10-01'),
        routine('later', 'paused', '2026-10-09'),
        routine('missed', 'paused', null),
        routine('active'),
      ],
      { due: future, later: future, missed: future, active: future },
    );
    const report = await job.run(NOW);
    expect(repo.resumeByJob).toHaveBeenCalledTimes(1);
    expect(repo.resumeByJob).toHaveBeenCalledWith('due', '2026-10-01');
    expect(report).toMatchObject({ routines: 4, resumed: 1, failed: 0 });
  });

  it('completes a routine whose visits are all closed, and reminds it of nothing', async () => {
    const { job, repo } = build([routine('done')], {
      done: loaded([
        visit('o1', 0, NOW - 300 * HOUR, 'completed'),
        visit('o2', 1, NOW - 100 * HOUR, 'no_show', 'staff'),
      ]),
    });
    const report = await job.run(NOW);
    expect(repo.completeByJob).toHaveBeenCalledWith('done');
    expect(repo.writeEvents).not.toHaveBeenCalled();
    expect(report.completed).toBe(1);
  });

  it('writes one reminder per visit starting within 48 hours, with the id made from the visit', async () => {
    const { job, repo } = build([routine('r')], {
      r: loaded([
        visit('soon', 0, NOW + 30 * HOUR),
        visit('later', 1, NOW + 200 * HOUR),
        visit('far', 2, NOW + 40 * HOUR, null),
      ]),
    });
    const report = await job.run(NOW);
    expect(repo.writeEvents).toHaveBeenCalledWith('r', [
      {
        id: reminderEventId('soon', NOW + 30 * HOUR),
        eventType: REMINDER_EVENT,
        payload: {
          source: 'mobile',
          occurrenceId: 'soon',
          index: 0,
          bookingId: 'b-soon',
          customerId: CUSTOMER,
          startAt: new Date(NOW + 30 * HOUR).toISOString(),
        },
      },
    ]);
    expect(report.reminded).toBe(1);
  });

  it('counts a routine that fails, and still runs the others', async () => {
    const { job, reads, repo } = build([routine('bad'), routine('good')], {});
    reads.factsForJob.mockImplementation((id: string) =>
      id === 'bad'
        ? Promise.reject(new Error('boom'))
        : Promise.resolve(loaded([visit('o1', 0, NOW + 30 * HOUR)])),
    );
    const report = await job.run(NOW);
    expect(report).toMatchObject({ routines: 2, failed: 1, reminded: 1 });
    expect(repo.writeEvents).toHaveBeenCalledTimes(1);
  });

  it('reports the routines it closed to the desk job again', async () => {
    const { job, repo } = build([], {});
    repo.keepDeskAway.mockResolvedValue(2);
    expect((await job.run(NOW)).deskKeptAway).toBe(2);
  });
});

describe('the hourly job, 8b: two misses in a row (D5, D9)', () => {
  const before = process.env.ROUTINE_COUNT_AUTO_NO_SHOWS;
  afterEach(() => {
    process.env.ROUTINE_COUNT_AUTO_NO_SHOWS = before;
  });

  /** Two misses, then a visit in 5 days, one in 12 hours, one far off. */
  const missedTwice = (by: 'staff' | 'system' = 'staff') =>
    loaded([
      visit('m1', 0, NOW - 200 * HOUR, 'no_show', by),
      visit('m2', 1, NOW - 30 * HOUR, 'no_show', by),
      visit('next', 2, NOW + 120 * HOUR),
      visit('locked', 3, NOW + 12 * HOUR),
      visit('far', 4, NOW + 2200 * HOUR, null),
    ]);

  it('pauses the routine and releases each booked visit more than 24 hours away', async () => {
    const { job, repo, lifecycle } = build([routine('r')], {
      r: missedTwice(),
    });
    const report = await job.run(NOW);
    const secondMiss = new Date(NOW - 30 * HOUR).toISOString().slice(0, 10);
    expect(repo.pauseForMisses).toHaveBeenCalledWith('r', secondMiss);
    // Only "next": "locked" stays booked, "far" has nothing booked.
    expect(lifecycle.transition).toHaveBeenCalledTimes(1);
    expect(lifecycle.transition).toHaveBeenCalledWith({
      bookingId: 'b-next',
      to: 'cancelled',
      actor: 'customer',
      actorId: CUSTOMER,
      reason: MISSED_RELEASE_REASON,
      initiatedBy: 'salon',
    });
    expect(repo.unlinkReleased).toHaveBeenCalledWith('r', 'next');
    expect(report).toMatchObject({ pausedForMisses: 1, released: 1 });
  });

  it("the sweeper's own no-shows count only when the switch says so", async () => {
    process.env.ROUTINE_COUNT_AUTO_NO_SHOWS = 'false';
    const off = build([routine('r')], { r: missedTwice('system') });
    await off.job.run(NOW);
    expect(off.repo.pauseForMisses).not.toHaveBeenCalled();

    process.env.ROUTINE_COUNT_AUTO_NO_SHOWS = 'true';
    const on = build([routine('r')], { r: missedTwice('system') });
    await on.job.run(NOW);
    expect(on.repo.pauseForMisses).toHaveBeenCalledTimes(1);
  });

  it('a visit that happened breaks the streak', async () => {
    const { job, repo } = build([routine('r')], {
      r: loaded([
        visit('m1', 0, NOW - 300 * HOUR, 'no_show', 'staff'),
        visit('ok', 1, NOW - 200 * HOUR, 'completed'),
        visit('m2', 2, NOW - 30 * HOUR, 'no_show', 'staff'),
        visit('next', 3, NOW + 120 * HOUR),
      ]),
    });
    await job.run(NOW);
    expect(repo.pauseForMisses).not.toHaveBeenCalled();
  });

  it('two misses already counted do not pause it again after a resume', async () => {
    const { job, repo } = build([routine('r')], { r: missedTwice() });
    repo.missStreakAfter.mockResolvedValue(
      new Date(NOW - 30 * HOUR).toISOString().slice(0, 10),
    );
    await job.run(NOW);
    expect(repo.pauseForMisses).not.toHaveBeenCalled();
  });

  it('checks only an active routine', async () => {
    const { job, repo } = build([routine('r', 'paused', null)], {
      r: {
        ...missedTwice(),
        series: { ...missedTwice().series, status: 'paused' },
      },
    });
    await job.run(NOW);
    expect(repo.missStreakAfter).not.toHaveBeenCalled();
  });

  it('releases nothing when the other copy paused it first', async () => {
    const { job, repo, lifecycle } = build([routine('r')], {
      r: missedTwice(),
    });
    repo.pauseForMisses.mockResolvedValue(false);
    const report = await job.run(NOW);
    expect(lifecycle.transition).not.toHaveBeenCalled();
    expect(report.pausedForMisses).toBe(0);
  });

  it('a booking that could not be released stays linked', async () => {
    const { job, repo, lifecycle } = build([routine('r')], {
      r: missedTwice(),
    });
    lifecycle.transition.mockResolvedValue({
      kind: 'illegal',
      message: 'already cancelled',
    });
    const report = await job.run(NOW);
    expect(repo.unlinkReleased).not.toHaveBeenCalled();
    expect(report).toMatchObject({ pausedForMisses: 1, released: 0 });
  });
});

describe('the hourly job, 8c: far-off visits the diary now reaches (R8)', () => {
  /** A monthly routine: one visit booked, one planned 80 days out, one 106. */
  const monthly = (status: 'active' | 'paused' = 'active') =>
    loaded(
      [
        visit('booked', 0, Date.parse('2026-11-20T11:00:00+06:00')),
        visit('near', 1, Date.parse('2026-12-20T11:00:00+06:00'), null),
        visit('far', 2, Date.parse('2027-01-15T11:00:00+06:00'), null),
      ],
      status,
    );

  it("books the one now within 90 days, at its own day, time and stylist, in the routine's tenant", async () => {
    const { job, repo, creates, tenants } = build([routine('r')], {
      r: monthly(),
    });
    const report = await job.run(NOW);
    expect(repo.claimPlanned).toHaveBeenCalledTimes(1);
    expect(repo.claimPlanned).toHaveBeenCalledWith('r', 'near');
    expect(tenants.run).toHaveBeenCalledWith('T1', expect.any(Function));
    expect(creates.bookSession).toHaveBeenCalledWith({
      routine: {
        id: 'S',
        branchId: 'BR',
        frequency: 'monthly',
        serviceIds: ['svc'],
      },
      occurrenceId: 'near',
      day: '2026-12-20',
      startMin: 660,
      stylistId: 'pref',
      customerId: CUSTOMER,
      dryRun: false,
      depositPercent: 20,
      nowMs: NOW,
    });
    expect(report).toMatchObject({ booked: 1, needsAction: 0, failed: 0 });
  });

  it('leaves it "needs action", with one event, when its time is not free', async () => {
    const { job, repo, creates } = build([routine('r')], { r: monthly() });
    creates.bookSession.mockResolvedValue('not_free');
    const report = await job.run(NOW);
    expect(repo.writeEvents).toHaveBeenCalledWith('r', [
      {
        id: needsActionEventId('near', '2026-12-20'),
        eventType: NEEDS_ACTION_EVENT,
        payload: {
          source: 'mobile',
          occurrenceId: 'near',
          index: 1,
          day: '2026-12-20',
          customerId: CUSTOMER,
        },
      },
    ]);
    expect(report).toMatchObject({ booked: 0, needsAction: 1 });
  });

  it('an error while booking is "needs action" too, never a failed run', async () => {
    const { job, creates } = build([routine('r')], { r: monthly() });
    creates.bookSession.mockRejectedValue(new Error('session_not_free'));
    const report = await job.run(NOW);
    expect(report).toMatchObject({ needsAction: 1, failed: 0 });
  });

  it('books nothing the other copy of the job claimed first', async () => {
    const { job, repo, creates } = build([routine('r')], { r: monthly() });
    repo.claimPlanned.mockResolvedValue(false);
    await job.run(NOW);
    expect(creates.bookSession).not.toHaveBeenCalled();
  });

  it('a paused routine books nothing: the resume does', async () => {
    const { job, repo } = build([routine('r', 'paused', null)], {
      r: monthly('paused'),
    });
    await job.run(NOW);
    expect(repo.claimPlanned).not.toHaveBeenCalled();
  });
});
