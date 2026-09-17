import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
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

    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: 500,
      code: 'BOOKING_STATE_INVALID' satisfies ErrorCode,
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
