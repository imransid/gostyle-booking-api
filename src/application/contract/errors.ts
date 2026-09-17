/**
 * The machine-readable refusal vocabulary.
 *
 * WHY THIS EXISTS. Every refusal in this service used to be a Nest exception
 * carrying a sentence: "Every styling station is taken at 12:40 (3 of 3 in
 * use)." The sentence is genuinely good — an operator can read it aloud — but
 * a front end cannot branch on prose. It either string-matches, which breaks
 * the first time someone fixes a typo, or it treats every 409 the same, which
 * turns "someone took your slot" and "you may not do that" into one dialog.
 *
 * So the prose stays and a CODE travels beside it. The code is what the client
 * switches on; the message is what the human reads; `details` carries whatever
 * the client needs to recover without asking again — refreshed offers, the
 * gates that failed, the conflicting constraint.
 *
 * ONE TABLE, HERE. The status belongs to the code, not to the throw site: a
 * BOOKING_SLOT_TAKEN is a 409 wherever it happens, and letting each handler
 * pick would eventually produce two. `errors.spec.ts` walks the table.
 */

/**
 * The closed set. Adding a member is a contract change and should be made
 * deliberately, not by passing a new string at a call site — which is why
 * `bookingError()` takes this union rather than a `string`.
 */
export const ERROR_CODES = [
  'BOOKING_NOT_FOUND',
  'BOOKING_STATE_INVALID',
  'BOOKING_HOLD_EXPIRED',
  'BOOKING_SLOT_TAKEN',
  'BOOKING_CAPACITY_BLOCKED',
  'BOOKING_STAFF_UNAVAILABLE',
  'BOOKING_SKILL_MISSING',
  'BOOKING_GATE_BLOCKED',
  'BOOKING_CHECKIN_WINDOW',
  'BOOKING_WITHIN_GRACE',
  'BOOKING_SERIAL_RESCHEDULE',
  'BOOKING_NO_SLOT',
  'BOOKING_SCAN_PENDING',
  'BOOKING_REASON_REQUIRED',
  'BOOKING_LEAD_HORIZON',
  'FORBIDDEN_ROLE',
  'IDEMPOTENCY_KEY_REUSED',
  /**
   * NOT IN THE FRONT-END CONTRACT, and added anyway.
   *
   * §19 has FORBIDDEN_ROLE for 403 and nothing for 401, but the guard is
   * global and closed by default, so 401 is the single most common refusal
   * this service emits. Forcing it into BOOKING_STATE_INVALID told a client
   * its booking was in the wrong state when the real answer was "sign in".
   */
  'UNAUTHENTICATED',
  /**
   * ALSO NOT IN THE CONTRACT. The deposit ladder refuses a confirm that
   * arrives with less money than the requirement -- "AED 240.00 is required
   * before this booking can be confirmed" -- and answers 402. That is a
   * different branch for the client than "you may not do that": it means
   * take more money and try again, and the amount is in `details`.
   */
  'BOOKING_PAYMENT_REQUIRED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Code to HTTP status.
 *
 * NOTE ON BOOKING_HOLD_EXPIRED. We answered 410 Gone for a lapsed hold, and
 * 410 is arguably the better word: the slot existed, and it is gone. The
 * front-end contract specifies 409, and a client branching on `code` gets the
 * same information either way, so the contract wins and the divergence is
 * recorded here rather than argued in two places.
 */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  BOOKING_NOT_FOUND: 404,
  BOOKING_STATE_INVALID: 409,
  BOOKING_HOLD_EXPIRED: 409,
  BOOKING_SLOT_TAKEN: 409,
  BOOKING_CAPACITY_BLOCKED: 409,
  BOOKING_STAFF_UNAVAILABLE: 409,
  BOOKING_SKILL_MISSING: 409,
  BOOKING_GATE_BLOCKED: 409,
  BOOKING_CHECKIN_WINDOW: 409,
  BOOKING_WITHIN_GRACE: 409,
  BOOKING_SERIAL_RESCHEDULE: 409,
  BOOKING_NO_SLOT: 409,
  BOOKING_SCAN_PENDING: 409,
  BOOKING_REASON_REQUIRED: 422,
  BOOKING_LEAD_HORIZON: 422,
  FORBIDDEN_ROLE: 403,
  IDEMPOTENCY_KEY_REUSED: 409,
  UNAUTHENTICATED: 401,
  BOOKING_PAYMENT_REQUIRED: 402,
};

/** What the client receives. `details` is absent rather than null when empty. */
export interface ErrorBody {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  /** Nest's own field, kept so nothing that reads it today breaks. */
  readonly error: string;
}

/**
 * The carrier.
 *
 * Deliberately NOT a Nest HttpException subclass: the domain and the
 * application layer throw these, and neither may import from @nestjs/common
 * (CLAUDE.md: the layers point one way). The filter at the edge turns it into
 * a response.
 */
export class BookingError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BookingError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }

  toBody(): ErrorBody {
    return {
      statusCode: this.status,
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
      error: statusText(this.status),
    };
  }
}

/** Sugar, so a throw site reads as one line. */
export function bookingError(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): BookingError {
  return new BookingError(code, message, details);
}

export function isBookingError(e: unknown): e is BookingError {
  return e instanceof BookingError;
}

const STATUS_TEXT: Readonly<Record<number, string>> = {
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
};

export function statusText(status: number): string {
  return STATUS_TEXT[status] ?? 'Error';
}

/**
 * The bridge for everything not yet converted.
 *
 * There are ~40 `throw new ConflictException('prose')` sites in this service.
 * Rewriting all of them in one change would be a large diff with no test that
 * could prove it did not change behaviour. Instead the filter asks this
 * function what code a legacy exception should carry, so every response gains
 * a `code` immediately and the throw sites migrate one at a time.
 *
 * MATCHED ON THE PROSE, which is exactly the fragility this whole file exists
 * to remove — so it is a MIGRATION AID with a shelf life, not the design. A
 * miss costs a generic code, never a wrong one: the fall-through is by status,
 * and both fall-throughs are codes the client already handles.
 */
export function inferCode(status: number, message: string): ErrorCode {
  const m = message.toLowerCase();

  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 402) return 'BOOKING_PAYMENT_REQUIRED';
  if (status === 404) return 'BOOKING_NOT_FOUND';
  if (status === 403) return 'FORBIDDEN_ROLE';

  if (m.includes('hold') && (m.includes('expired') || m.includes('lapsed'))) {
    return 'BOOKING_HOLD_EXPIRED';
  }
  if (m.includes('idempotency')) return 'IDEMPOTENCY_KEY_REUSED';
  if (m.includes('skill')) return 'BOOKING_SKILL_MISSING';
  if (m.includes('station') || m.includes('chair') || m.includes('capacity')) {
    return 'BOOKING_CAPACITY_BLOCKED';
  }
  if (m.includes('nobody is free') || m.includes('unavailable')) {
    return 'BOOKING_STAFF_UNAVAILABLE';
  }
  if (m.includes('taken') || m.includes('gone')) return 'BOOKING_SLOT_TAKEN';
  if (m.includes('reason')) return 'BOOKING_REASON_REQUIRED';
  if (m.includes('horizon') || m.includes('too far')) {
    return 'BOOKING_LEAD_HORIZON';
  }

  return status === 422 ? 'BOOKING_REASON_REQUIRED' : 'BOOKING_STATE_INVALID';
}
