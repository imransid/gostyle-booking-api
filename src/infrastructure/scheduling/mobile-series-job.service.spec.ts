import { describe, it, expect, vi, afterEach } from 'vitest';
import { MobileSeriesJob } from './mobile-series-job.service';

const REPORT = {
  routines: 1,
  deskKeptAway: 0,
  resumed: 0,
  completed: 0,
  reminded: 1,
  failed: 0,
};

function build() {
  const handler = { run: vi.fn().mockResolvedValue(REPORT) };
  return { job: new MobileSeriesJob(handler as never), handler };
}

describe('MobileSeriesJob: the hourly tick (step 8)', () => {
  const before = process.env.MOBILE_SERIES_BOOKING;
  afterEach(() => {
    process.env.MOBILE_SERIES_BOOKING = before;
  });

  it('does nothing while the switch is off', async () => {
    process.env.MOBILE_SERIES_BOOKING = 'false';
    const { job, handler } = build();
    await job.tick();
    expect(handler.run).not.toHaveBeenCalled();
  });

  it('runs, and keeps what the run did for health', async () => {
    process.env.MOBILE_SERIES_BOOKING = 'true';
    const { job } = build();
    await job.tick();
    expect(job.stats()).toMatchObject({
      runs: 1,
      last: REPORT,
      consecutiveFailures: 0,
    });
  });

  it('counts a failed run instead of throwing it', async () => {
    process.env.MOBILE_SERIES_BOOKING = 'true';
    const { job, handler } = build();
    handler.run.mockRejectedValue(new Error('database down'));
    await job.tick();
    expect(job.stats()).toMatchObject({ runs: 0, consecutiveFailures: 1 });
  });

  it('never overlaps itself', async () => {
    process.env.MOBILE_SERIES_BOOKING = 'true';
    const { job, handler } = build();
    let finish: () => void = () => undefined;
    handler.run.mockReturnValue(
      new Promise((resolve) => {
        finish = () => resolve(REPORT);
      }),
    );
    const first = job.tick();
    await job.tick();
    finish();
    await first;
    expect(handler.run).toHaveBeenCalledTimes(1);
  });
});
