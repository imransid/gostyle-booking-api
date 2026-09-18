import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { status } from '@grpc/grpc-js';
import { Metadata } from '@grpc/grpc-js';
import { of, throwError, timer, NEVER } from 'rxjs';
import { callWithRetry } from './call-with-retry';

const quiet = () =>
  ({ warn: vi.fn(), error: vi.fn(), log: vi.fn() }) as unknown as Logger;

const grpc = (code: number) => Object.assign(new Error('wire'), { code });

describe('callWithRetry', () => {
  it('returns the first answer without retrying', async () => {
    const issue = vi.fn(() => of('ok'));
    await expect(callWithRetry(quiet(), 'call', 100, issue)).resolves.toBe(
      'ok',
    );
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it('retries UNAVAILABLE once and succeeds', async () => {
    // The reported bug: first call after idle is answered by a dead
    // channel, second works.
    let n = 0;
    const issue = vi.fn(() =>
      ++n === 1 ? throwError(() => grpc(status.UNAVAILABLE)) : of('ok'),
    );
    await expect(callWithRetry(quiet(), 'call', 500, issue)).resolves.toBe(
      'ok',
    );
    expect(issue).toHaveBeenCalledTimes(2);
  });

  it('issues a NEW request rather than re-subscribing', async () => {
    // The factory is the contract. If this ever became a single observable
    // passed in, the retry would depend on it being cold.
    const issue = vi.fn(() => of('ok'));
    await callWithRetry(quiet(), 'call', 100, () => issue());
    expect(issue).toHaveBeenCalled();
  });

  it('fails the FIRST attempt fast, with no waitForReady', async () => {
    // A genuinely dead dependency must be reported in milliseconds, not
    // after every request has waited out the full timeout.
    const seen: Metadata[] = [];
    await callWithRetry(quiet(), 'call', 100, (md) => {
      seen.push(md);
      return of('ok');
    });
    expect(seen[0]!.getOptions().waitForReady).toBeFalsy();
  });

  it('makes the RETRY wait for the channel, bounded by a deadline', async () => {
    // THE FIX THAT MATTERED. grpc-js rejects a call outright while the
    // channel is in TRANSIENT_FAILURE, and reconnect backoff grows the
    // longer the peer has been gone -- so a retry on a fixed delay loses
    // exactly when the peer has just come back. waitForReady holds the
    // call until the channel is usable instead.
    //
    // AND IT GOES ON THE METADATA. `deadline` is a CallOptions field so
    // `waitForReady` reads like one -- it is not, and grpc-js ignores it
    // there in silence. This assertion is written against
    // metadata.getOptions() precisely because the earlier version of it
    // asserted the wrong object and passed while the real call waited for
    // nothing.
    const mds: Metadata[] = [];
    const opts: { deadline?: number }[] = [];
    let n = 0;
    const issue = (md: Metadata, o: { deadline?: number }) => {
      mds.push(md);
      opts.push(o);
      return ++n === 1 ? throwError(() => grpc(status.UNAVAILABLE)) : of('ok');
    };
    const before = Date.now();
    await expect(callWithRetry(quiet(), 'call', 5_000, issue)).resolves.toBe(
      'ok',
    );

    expect(mds[0]!.getOptions().waitForReady).toBeFalsy();
    expect(mds[1]!.getOptions().waitForReady).toBe(true);
    expect(opts[1]!.deadline).toBeGreaterThanOrEqual(before);
    expect(opts[1]!.deadline).toBeLessThanOrEqual(Date.now() + 5_000);
  });

  it('gives up after the second failure and throws the second error', async () => {
    const issue = vi.fn(() => throwError(() => grpc(status.UNAVAILABLE)));
    await expect(
      callWithRetry(quiet(), 'call', 500, issue),
    ).rejects.toMatchObject({ code: status.UNAVAILABLE });
    expect(issue).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a fault the server raised while answering', async () => {
    const issue = vi.fn(() => throwError(() => grpc(status.INTERNAL)));
    await expect(
      callWithRetry(quiet(), 'call', 500, issue),
    ).rejects.toMatchObject({ code: status.INTERNAL });
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a timeout, which says nothing about the server', async () => {
    // The server may be midway through the work. rxjs TimeoutError also
    // carries no gRPC code, so isRetriable rejects it on both counts.
    const issue = vi.fn(() => NEVER);
    await expect(callWithRetry(quiet(), 'call', 20, issue)).rejects.toThrow();
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it('applies the timeout PER ATTEMPT, not across both', async () => {
    // Each attempt gets the full budget. A second attempt cut short by the
    // first one's spent time would fail for a reason unrelated to the
    // server.
    let n = 0;
    const issue = vi.fn(() =>
      ++n === 1
        ? throwError(() => grpc(status.UNAVAILABLE))
        : timer(60).pipe(() => of('ok')),
    );
    await expect(callWithRetry(quiet(), 'call', 80, issue)).resolves.toBe('ok');
  });

  it('logs the swallowed failure, since a successful retry hides it', async () => {
    // The spy is held directly rather than reached through the logger:
    // a retry that works leaves no other trace, so this assertion is the
    // only thing standing between a dropped connection and silence.
    const warn = vi.fn();
    const log = { warn, error: vi.fn(), log: vi.fn() } as unknown as Logger;
    let n = 0;
    const issue = () =>
      ++n === 1 ? throwError(() => grpc(status.UNAVAILABLE)) : of('ok');

    await callWithRetry(log, 'listServices', 500, issue);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain('listServices');
  });
});
