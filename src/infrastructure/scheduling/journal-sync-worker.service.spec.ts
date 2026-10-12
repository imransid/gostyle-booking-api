import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { JournalSyncWorker } from './journal-sync-worker.service';

const REPORT = {
  sendingEnabled: true,
  posted: 2,
  skipped: 0,
  unmapped: 0,
  refused: 0,
  retried: 0,
};

function build() {
  const handler = { run: vi.fn().mockResolvedValue(REPORT) };
  return { worker: new JournalSyncWorker(handler as never), handler };
}

let logError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logError = vi
    .spyOn(Logger.prototype, 'error')
    .mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('JournalSyncWorker: the tick', () => {
  it('runs, and keeps what the run did for health', async () => {
    const { worker } = build();
    await worker.tick();
    expect(worker.stats()).toMatchObject({
      runs: 1,
      last: REPORT,
      consecutiveFailures: 0,
    });
  });

  it('counts a failed run instead of throwing it', async () => {
    const { worker, handler } = build();
    handler.run.mockRejectedValue(new Error('database down'));
    await worker.tick();
    await worker.tick();
    expect(worker.stats()).toMatchObject({ runs: 0, consecutiveFailures: 2 });
    // At ERROR the first time, not on every tick after.
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it('a good run clears the failure count', async () => {
    const { worker, handler } = build();
    handler.run.mockRejectedValueOnce(new Error('database down'));
    await worker.tick();
    await worker.tick();
    expect(worker.stats()).toMatchObject({ runs: 1, consecutiveFailures: 0 });
  });

  it('never overlaps itself', async () => {
    const { worker, handler } = build();
    let finish: () => void = () => undefined;
    handler.run.mockReturnValue(
      new Promise((resolve) => {
        finish = () => resolve(REPORT);
      }),
    );
    const first = worker.tick();
    await worker.tick();
    finish();
    await first;
    expect(handler.run).toHaveBeenCalledTimes(1);
  });
});
