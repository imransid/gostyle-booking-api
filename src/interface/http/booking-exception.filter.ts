import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { isMobileContractError } from '@application/commands/mobile-booking.error';
import {
  inferCode,
  isBookingError,
  statusText,
  type ErrorBody,
  type ErrorCode,
} from '@application/contract/errors';

/**
 * One shape for every refusal.
 *
 * Nest's default body is `{ statusCode, message, error }`. That is three
 * facts, none of them switchable: `message` is prose and `error` is the
 * status name repeated. A front end handling nine different 409s has nothing
 * to branch on.
 *
 * This filter adds `code` and, where the handler supplied one, `details`. It
 * does NOT remove `statusCode`, `message` or `error`, so nothing that reads
 * the old shape breaks -- the change is purely additive and can ship before
 * the client is ready for it.
 *
 * THREE KINDS OF THROWN THING arrive here:
 *
 *   1. BookingError    -- already carries a code and details. Used as-is.
 *   2. HttpException   -- the ~40 legacy `throw new ConflictException(prose)`
 *                         sites. inferCode() gives them a code from the
 *                         status and the prose, so they improve immediately
 *                         and can be converted one at a time.
 *   3. anything else   -- a bug. 500, logged with the stack, and the client
 *                         is told nothing about our internals.
 *
 * VALIDATION ERRORS ARE LEFT ALONE. ValidationPipe throws a 400 whose
 * `message` is an array of field errors, and that array is the useful part.
 * Flattening it into one sentence to fit this envelope would lose the field
 * names, so a 400 keeps its own shape and gains only the code.
 */
@Catch()
export class BookingExceptionFilter implements ExceptionFilter {
  private static readonly log = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    /**
     * The mobile contract has its own envelope (booking-create.md §9) and
     * gets to keep it. Its `errors[]` carry a per-field code and the
     * server's correct figure, which is what lets the app show the customer
     * what changed instead of a dead "prices moved".
     */
    if (isMobileContractError(exception)) {
      res.status(exception.status).json(exception.toBody());
      return;
    }

    if (isBookingError(exception)) {
      res.status(exception.status).json(exception.toBody());
      return;
    }

    if (exception instanceof HttpException) {
      res.status(exception.getStatus()).json(fromHttp(exception));
      return;
    }

    // Nothing below here is expected. Log it with the stack: a 500 the client
    // sees as "Something went wrong" has to be findable in the log, or rule 9
    // ("read the log before theorising") has nothing to read.
    BookingExceptionFilter.log.error(
      exception instanceof Error ? exception.stack : String(exception),
    );

    /**
     * AN UPSTREAM gRPC FAILURE IS NOT OUR 500.
     *
     * A raw gRPC error reaching here means a dependency failed and nobody
     * translated it. Reporting that as "Something went wrong" sends whoever
     * is on call to read THIS codebase for a fault in another one -- which
     * is what happened: a consumer API whose database dropped mid-call was
     * reported as a booking-service bug.
     *
     * The right fix is at the throw site, and the auth path now does that.
     * This is the backstop for every call that does not, and it names the
     * status so the log and the response agree.
     */
    const grpc = grpcStatusOf(exception);
    if (grpc !== null) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        statusCode: 503,
        code: 'DEPENDENCY_UNAVAILABLE' satisfies ErrorCode,
        message: 'An upstream service failed.',
        details: { grpcStatus: grpc },
        error: statusText(503),
      });
      return;
    }

    /**
     * NO BOOKING CODE ON AN UNKNOWN ERROR.
     *
     * This hardcoded BOOKING_STATE_INVALID, which told the client its
     * booking was in the wrong state for what was actually an unhandled
     * exception. `inferCode` maps every 5xx to DEPENDENCY_UNAVAILABLE and
     * this branch never called it -- so the one place a code was invented
     * from nothing was the one place with no evidence for it.
     */
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: 500,
      code: inferCode(500, message(exception)) satisfies ErrorCode,
      message: 'Something went wrong.',
      error: 'Internal Server Error',
    });
  }
}

/** A legacy Nest exception, given a code without changing what it said. */
function fromHttp(e: HttpException): ErrorBody | Record<string, unknown> {
  const status = e.getStatus();
  const payload = e.getResponse();

  // ValidationPipe: `message` is an array of field errors. Keep it whole.
  if (
    typeof payload === 'object' &&
    payload !== null &&
    Array.isArray((payload as { message?: unknown }).message)
  ) {
    return {
      ...(payload as Record<string, unknown>),
      statusCode: status,
      code: 'BOOKING_REASON_REQUIRED' satisfies ErrorCode,
    };
  }

  const message =
    typeof payload === 'string'
      ? payload
      : (((payload as { message?: unknown }).message as string | undefined) ??
        e.message);

  // A handler that already knew its code can attach one to the response body
  // it throws; honour it rather than guessing from the prose.
  const declared =
    typeof payload === 'object' && payload !== null
      ? ((payload as { code?: unknown }).code as ErrorCode | undefined)
      : undefined;

  const details =
    typeof payload === 'object' && payload !== null
      ? ((payload as { details?: unknown }).details as
          Record<string, unknown> | undefined)
      : undefined;

  return {
    statusCode: status,
    code: declared ?? inferCode(status, message),
    message,
    ...(details === undefined ? {} : { details }),
    error: statusText(status),
  };
}

/**
 * The gRPC status on an error, if it is one.
 *
 * grpc-js puts a numeric `code` on its errors. Anything without one came
 * from our side of the wire and is not an upstream failure.
 */
function grpcStatusOf(e: unknown): number | null {
  if (typeof e !== 'object' || e === null) return null;
  const code = (e as { code?: unknown }).code;
  // A Nest/Node error can also carry a string `code` ('ENOENT'); only a
  // number is a gRPC status.
  return typeof code === 'number' ? code : null;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
