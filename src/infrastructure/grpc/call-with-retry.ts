import { Logger } from '@nestjs/common';
import { Metadata } from '@grpc/grpc-js';
import { firstValueFrom, timeout, type Observable } from 'rxjs';
import { describeGrpcFailure, isRetriable } from './grpc-failure';

/**
 * Per-call options handed to the second attempt.
 *
 * These are grpc-js CallOptions, forwarded by Nest's client proxy: it
 * passes every argument straight through to the generated method, whose
 * signature is (request, metadata, options, callback).
 */
export interface GrpcCallOptions {
  readonly waitForReady?: boolean;
  readonly deadline?: number;
}

/**
 * One gRPC call, retried once if it never reached the server.
 *
 * `issue` is a FACTORY, not an observable. The second attempt must be a new
 * request: re-subscribing to the first would be relying on the observable
 * being cold, which is true of Nest's gRPC client today and is not a
 * property worth depending on silently.
 *
 * ONLY UNAVAILABLE IS RETRIED -- see isRetriable. That status means the
 * request never arrived, so repeating it cannot duplicate work. Everything
 * else is re-thrown untouched, including an rxjs timeout, which carries no
 * gRPC code and means we stopped waiting rather than that nothing happened.
 *
 * ---------------------------------------------------------------------
 * THE RETRY WAITS FOR THE CHANNEL. IT DOES NOT JUST TRY AGAIN.
 *
 * This first shipped as "sleep 250ms, call again", and against the real
 * failure it did nothing at all. Both attempts failed identically:
 *
 *   UNAVAILABLE: No connection established. Last error: Failed to connect
 *   ... -- never reached the server, retrying once
 *   ... retry ALSO failed: UNAVAILABLE: No connection established
 *
 * Because when a channel is in TRANSIENT_FAILURE, grpc-js FAILS A CALL
 * IMMEDIATELY rather than queueing it, and reconnect backoff grows the
 * longer the peer has been gone. A retry on any fixed delay is therefore a
 * race against a timer that is actively moving away from it -- it would
 * win for a connection dropped a moment ago and lose for a peer that just
 * came back, which is the case people actually notice.
 *
 * `waitForReady` is the answer: the call is held until the channel becomes
 * READY instead of being rejected on sight, bounded by a deadline so it
 * cannot hang. No sleep, and nothing to tune.
 *
 * IT GOES ON THE METADATA, NOT THE CALL OPTIONS. This is the one piece of
 * it that cannot be guessed. `deadline` is a CallOptions field, so
 * `waitForReady` looks like one too -- it is not, and passing it there is
 * silently ignored, which is the worst possible failure for a resilience
 * feature. grpc-js reads it from `metadata.getOptions().waitForReady`
 * (load-balancing-call.js), set by `new Metadata({ waitForReady: true })`.
 * Measured, not assumed: with it on CallOptions a request against a dead
 * peer returned in 0.43s instead of waiting out its 5s budget.
 *
 * ONLY ON THE RETRY. The first attempt still fails fast, so a genuinely
 * dead dependency is reported in milliseconds rather than making every
 * request wait out the full timeout. Fast path fast, recovery path patient.
 *
 * THE TIMEOUT IS PER ATTEMPT, so two attempts at 5s is a 10s worst case.
 * That is deliberate -- an attempt cut short by the first attempt's spent
 * budget would fail for a reason that has nothing to do with the server --
 * but anything with its own deadline above this needs to know.
 */
export async function callWithRetry<T>(
  log: Logger,
  label: string,
  timeoutMs: number,
  issue: (metadata: Metadata, options: GrpcCallOptions) => Observable<T>,
): Promise<T> {
  try {
    return await firstValueFrom(
      issue(new Metadata(), {}).pipe(timeout(timeoutMs)),
    );
  } catch (first) {
    if (!isRetriable(first)) throw first;

    // At WARN, and always. A connection silently dropped while idle is
    // invisible from the outside once the retry succeeds -- which is the
    // whole complaint -- so the one place it can be counted is here.
    log.warn(
      `${label}: ${describeGrpcFailure(first)} -- never reached the server, ` +
        'retrying once, waiting for the channel',
    );

    try {
      const out = await firstValueFrom(
        issue(new Metadata({ waitForReady: true }), {
          deadline: Date.now() + timeoutMs,
        }).pipe(
          // Belt and braces. The deadline is enforced by grpc-js and this
          // by us; whichever fires first, the call cannot outlive the
          // budget. They are set to the same instant, so in practice the
          // deadline wins and the error carries a gRPC status.
          timeout(timeoutMs),
        ),
      );
      log.log(`${label}: retry succeeded`);
      return out;
    } catch (second) {
      // Said plainly, because "it failed twice" and "it failed once" are
      // different operational facts and the first one is not a blip.
      log.error(`${label}: retry ALSO failed: ${describeGrpcFailure(second)}`);
      throw second;
    }
  }
}
