import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  ERROR_STATUS,
  BookingError,
  bookingError,
  isBookingError,
  inferCode,
  statusText,
} from './errors';

describe('the error catalogue', () => {
  it('gives every code a status', () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_STATUS[code], code).toBeTypeOf('number');
    }
  });

  it('has no status outside the four the contract lists', () => {
    const allowed = new Set([401, 402, 403, 404, 409, 422]);
    for (const code of ERROR_CODES) {
      expect(allowed.has(ERROR_STATUS[code]), `${code}`).toBe(true);
    }
  });

  it('carries the seventeen contract codes, plus the two we needed', () => {
    // Spelled out rather than counted, so a rename is caught as a rename.
    expect([...ERROR_CODES].sort()).toEqual(
      [
        'BOOKING_CAPACITY_BLOCKED',
        'BOOKING_CHECKIN_WINDOW',
        'BOOKING_GATE_BLOCKED',
        'BOOKING_HOLD_EXPIRED',
        'BOOKING_LEAD_HORIZON',
        'BOOKING_NOT_FOUND',
        'BOOKING_NO_SLOT',
        'BOOKING_REASON_REQUIRED',
        'BOOKING_SCAN_PENDING',
        'BOOKING_SERIAL_RESCHEDULE',
        'BOOKING_SKILL_MISSING',
        'BOOKING_SLOT_TAKEN',
        'BOOKING_STAFF_UNAVAILABLE',
        'BOOKING_STATE_INVALID',
        'BOOKING_WITHIN_GRACE',
        'FORBIDDEN_ROLE',
        'IDEMPOTENCY_KEY_REUSED',
        'UNAUTHENTICATED',
        'BOOKING_PAYMENT_REQUIRED',
      ].sort(),
    );
  });
});

describe('BookingError', () => {
  it('takes its status from the code, not from the caller', () => {
    expect(bookingError('BOOKING_NOT_FOUND', 'no').status).toBe(404);
    expect(bookingError('FORBIDDEN_ROLE', 'no').status).toBe(403);
    expect(bookingError('BOOKING_LEAD_HORIZON', 'no').status).toBe(422);
  });

  it('omits details entirely rather than sending null', () => {
    const body = bookingError('BOOKING_SLOT_TAKEN', 'gone').toBody();
    expect('details' in body).toBe(false);
  });

  it('carries details through when there are any', () => {
    const body = bookingError('BOOKING_SLOT_TAKEN', 'gone', {
      offers: [{ startMin: 600 }],
    }).toBody();
    expect(body.details).toEqual({ offers: [{ startMin: 600 }] });
  });

  it('keeps Nest’s own error field so existing readers do not break', () => {
    expect(bookingError('BOOKING_SLOT_TAKEN', 'gone').toBody().error).toBe(
      'Conflict',
    );
  });

  it('is recognisable after being thrown and caught', () => {
    try {
      throw bookingError('BOOKING_WITHIN_GRACE', 'too early');
    } catch (e) {
      expect(isBookingError(e)).toBe(true);
      expect((e as BookingError).code).toBe('BOOKING_WITHIN_GRACE');
    }
  });

  it('is not confused with an ordinary Error', () => {
    expect(isBookingError(new Error('boom'))).toBe(false);
  });
});

describe('inferCode, the migration aid', () => {
  it('reads status before prose for the four unambiguous ones', () => {
    expect(inferCode(404, 'anything at all')).toBe('BOOKING_NOT_FOUND');
    expect(inferCode(403, 'anything at all')).toBe('FORBIDDEN_ROLE');
    // "Missing bearer token" is a 401, not a booking in a bad state.
    expect(inferCode(401, 'Missing bearer token')).toBe('UNAUTHENTICATED');
    // "AED 240.00 is required before this booking can be confirmed."
    expect(inferCode(402, 'AED 240.00 is required')).toBe(
      'BOOKING_PAYMENT_REQUIRED',
    );
  });

  it.each([
    ['The hold expired before confirm', 'BOOKING_HOLD_EXPIRED'],
    [
      'That Idempotency-Key was used with a different body',
      'IDEMPOTENCY_KEY_REUSED',
    ],
    ['does not hold the required skills: color', 'BOOKING_SKILL_MISSING'],
    [
      'Every styling station is taken at 12:40 (3 of 3 in use)',
      'BOOKING_CAPACITY_BLOCKED',
    ],
    ['Nobody is free for that start any more.', 'BOOKING_STAFF_UNAVAILABLE'],
    ['Choose a reason', 'BOOKING_REASON_REQUIRED'],
  ] as const)('maps %j to %s', (message, code) => {
    expect(inferCode(409, message)).toBe(code);
  });

  it('falls through to a code the client already handles', () => {
    expect(inferCode(409, 'something nobody anticipated')).toBe(
      'BOOKING_STATE_INVALID',
    );
    expect(inferCode(422, 'something nobody anticipated')).toBe(
      'BOOKING_REASON_REQUIRED',
    );
  });

  it('never invents a code outside the catalogue', () => {
    const codes = new Set<string>(ERROR_CODES);
    const messages = [
      'hold expired',
      'chair',
      'taken',
      'gone',
      'horizon',
      '',
      'zzz',
    ];
    for (const status of [400, 401, 402, 403, 404, 409, 422, 500]) {
      for (const m of messages) {
        expect(codes.has(inferCode(status, m)), `${status} ${m}`).toBe(true);
      }
    }
  });
});

describe('statusText', () => {
  it('names the six statuses the catalogue uses', () => {
    expect(statusText(401)).toBe('Unauthorized');
    expect(statusText(402)).toBe('Payment Required');
    expect(statusText(403)).toBe('Forbidden');
    expect(statusText(404)).toBe('Not Found');
    expect(statusText(409)).toBe('Conflict');
    expect(statusText(422)).toBe('Unprocessable Entity');
  });

  it('does not throw on one it has never seen', () => {
    expect(statusText(418)).toBe('Error');
  });
});
