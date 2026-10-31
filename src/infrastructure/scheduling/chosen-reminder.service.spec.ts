import { afterEach, describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { ChosenReminderJob } from './chosen-reminder.service';

const report = {
  candidates: 1,
  sent: 1,
  skipped: 0,
  waiting: 0,
  lost: 0,
  unavailable: false,
};

const saved = {
  choice: process.env.MOBILE_REMINDER_CHOICE,
  hub: process.env.MOBILE_NOTIFY_HUB,
};
afterEach(() => {
  if (saved.choice === undefined) delete process.env.MOBILE_REMINDER_CHOICE;
  else process.env.MOBILE_REMINDER_CHOICE = saved.choice;
  if (saved.hub === undefined) delete process.env.MOBILE_NOTIFY_HUB;
  else process.env.MOBILE_NOTIFY_HUB = saved.hub;
  vi.restoreAllMocks();
});

const build = () => {
  const planner = { run: vi.fn(() => Promise.resolve(report)) };
  return { job: new ChosenReminderJob(planner as never), planner };
};

describe('ChosenReminderJob', () => {
  it.each([
    ['both off', undefined, undefined],
    ['the hub off', 'true', undefined],
    ['the choice off', undefined, 'true'],
  ])('%s: does nothing', async (_n, choice, hub) => {
    if (choice) process.env.MOBILE_REMINDER_CHOICE = choice;
    else delete process.env.MOBILE_REMINDER_CHOICE;
    if (hub) process.env.MOBILE_NOTIFY_HUB = hub;
    else delete process.env.MOBILE_NOTIFY_HUB;
    const { job, planner } = build();
    await job.tick();
    expect(planner.run).not.toHaveBeenCalled();
  });

  it('both on: plans, and counts it for /health', async () => {
    process.env.MOBILE_REMINDER_CHOICE = 'true';
    process.env.MOBILE_NOTIFY_HUB = 'true';
    const { job, planner } = build();
    await job.tick();
    expect(planner.run).toHaveBeenCalledOnce();
    expect(job.stats()).toMatchObject({ on: true, sinceStart: { sent: 1 } });
  });

  it('a failed tick is logged, not thrown', async () => {
    process.env.MOBILE_REMINDER_CHOICE = 'true';
    process.env.MOBILE_NOTIFY_HUB = 'true';
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { job, planner } = build();
    planner.run.mockRejectedValueOnce(new Error('db down'));
    await expect(job.tick()).resolves.toBeUndefined();
    expect(job.stats().consecutiveFailures).toBe(1);
  });
});
