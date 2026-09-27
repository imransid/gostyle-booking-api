import { describe, it, expect, vi } from 'vitest';
import { MobileSeriesJobHandler } from './mobile-series-job.handler';
import {
  REMINDER_EVENT,
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
) => ({
  id,
  index,
  day: new Date(startAtMs).toISOString().slice(0, 10),
  startAtMs,
  state: bookingStatus === null ? 'planned' : 'materialised',
  bookingStatus,
  noShowBy: null,
});

const routine = (
  id: string,
  status: 'active' | 'paused' = 'active',
  pausedUntil: string | null = null,
) => ({ id, customerId: CUSTOMER, status, pausedUntil });

/** What one routine looks like to the job: its rows and its facts. */
const loaded = (visits: ReturnType<typeof visit>[]) => ({
  series: {
    occurrences: visits.map((v) => ({
      id: v.id,
      bookingId: v.bookingStatus === null ? null : `b-${v.id}`,
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
    writeEvents: vi.fn((...args: [string, readonly unknown[]]) =>
      Promise.resolve(args[1].length),
    ),
  };
  const reads = {
    factsForJob: vi.fn((id: string) => Promise.resolve(byId[id] ?? null)),
  };
  const job = new MobileSeriesJobHandler(repo as never, reads as never);
  return { job, repo, reads };
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
        visit('o2', 1, NOW - 100 * HOUR, 'no_show'),
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
    const { job, reads, repo } = build([routine('bad'), routine('good')], {
      good: loaded([visit('o1', 0, NOW + 30 * HOUR)]),
    });
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
