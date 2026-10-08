import { describe, expect, it, vi } from 'vitest';
import { CheckInRequestSweeper } from './check-in-request-sweeper.service';

describe('CheckInRequestSweeper', () => {
  it('lapses at the clock it is given', async () => {
    const requests = { lapseWaiting: vi.fn(() => Promise.resolve([])) };
    await new CheckInRequestSweeper(requests as never).sweep(1234);
    expect(requests.lapseWaiting).toHaveBeenCalledWith(1234);
  });

  it('survives a failed sweep and runs again next time', async () => {
    const requests = {
      lapseWaiting: vi
        .fn()
        .mockRejectedValueOnce(new Error('db down'))
        .mockResolvedValueOnce([]),
    };
    const s = new CheckInRequestSweeper(requests as never);
    await expect(s.sweep(1)).resolves.toBeUndefined();
    await expect(s.sweep(2)).resolves.toBeUndefined();
    expect(requests.lapseWaiting).toHaveBeenCalledTimes(2);
  });
});
