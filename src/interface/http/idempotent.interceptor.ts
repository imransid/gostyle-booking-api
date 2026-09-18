import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, from, switchMap } from 'rxjs';
import {
  IdempotencyRepository,
  hashRequestBody,
} from '@infrastructure/persistence/idempotency.repository';

/**
 * Makes any write route replay-safe.
 *
 * WHY AN INTERCEPTOR. The front end mints an `Idempotency-Key` per tap on
 * `move`, `reschedule`, `check-in`, `shorten`, `waiver`, the queue writes and
 * the scans. Only `POST /v1/bookings`, `POST /v1/series` and the four money
 * routes read one -- every other route ignored the header, so a retry on a
 * flaky connection wrote twice. Wiring the store into eleven more handlers
 * would be eleven more places to forget; wrapping the route is one.
 *
 * WHAT IT DOES NOT DO. It does not make a handler transactional. A retry that
 * arrives while the first request is still running finds nothing stored and
 * proceeds -- the two race exactly as they do today. This closes the common
 * case (the client gave up and tried again) and not the rare one; the money
 * routes handle that themselves, inside their transaction, because there the
 * rare case is somebody being charged twice.
 *
 * NO KEY, NO PROTECTION, AND NO COMPLAINT. These routes shipped without the
 * header and some callers do not send one. Refusing them would break working
 * clients to protect them from a retry they may never make.
 */
@Injectable()
export class IdempotentInterceptor implements NestInterceptor {
  constructor(private readonly store: IdempotencyRepository) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<{
      method: string;
      route?: { path?: string };
      url: string;
      headers: Record<string, unknown>;
      params: Record<string, unknown>;
      body: unknown;
    }>();

    const raw = req.headers['idempotency-key'];
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (key === '') return next.handle();

    const operation = `${req.method} ${req.route?.path ?? req.url}`;
    // The PARAMS are part of the request too. Without them the same key on
    // two different bookings would look like a retry of the first, and the
    // second booking would silently not be moved.
    const fingerprint = hashRequestBody({
      operation,
      params: req.params,
      body: req.body,
    });

    return from(this.store.replay<object>(key, operation, fingerprint)).pipe(
      switchMap((stored) => {
        if (stored !== null) return from(Promise.resolve(stored));

        return next
          .handle()
          .pipe(
            switchMap((result: unknown) =>
              from(this.rememberQuietly(key, operation, fingerprint, result)),
            ),
          );
      }),
    );
  }

  /**
   * Store the response, and hand it back either way.
   *
   * REMEMBERING IS BEST-EFFORT. The write already happened and is correct;
   * failing the response because the receipt could not be filed would turn a
   * success into an error, which the client would then retry -- causing the
   * exact double-write this exists to prevent.
   */
  private async rememberQuietly(
    key: string,
    operation: string,
    requestHash: string,
    result: unknown,
  ): Promise<unknown> {
    try {
      await this.store.remember({
        key,
        operation,
        requestHash,
        status: 200,
        body: result,
      });
    } catch {
      // Deliberately swallowed. See above.
    }
    return result;
  }
}
