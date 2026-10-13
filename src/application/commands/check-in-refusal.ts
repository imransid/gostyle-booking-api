import { bookingError, type BookingError } from '@application/contract/errors';
import { shout } from '@application/contract/wire';
import type { RaiseOutcome } from '@infrastructure/persistence/check-in-request.repository';

/** A raise the booking's own rules refused (raiseVerdict). */
export type RaiseRefused = Extract<RaiseOutcome, { kind: 'refused' }>;

/**
 * THE ONE MAPPING from a refused raise to the error the customer is shown.
 *
 * Returns the error, never throws it. The single route throws it (one
 * booking, one answer); the group route keeps it on the lane and goes on to
 * the next lane. So a party lane is refused in exactly the words a single
 * booking is, and the two can never drift apart.
 */
export function raiseRefusalError(out: RaiseRefused): BookingError {
  switch (out.why) {
    case 'not_confirmed':
      return bookingError(
        'BOOKING_STATE_INVALID',
        `A ${out.bookingStatus} booking cannot be checked in.`,
        { status: shout(out.bookingStatus) },
      );
    case 'rejected_before':
      return bookingError(
        'BOOKING_CHECKIN_REJECTED',
        'The desk could not confirm your arrival. Please speak to ' +
          'the desk.',
      );
    case 'too_early': {
      // The desk check-in's own sentence and detail
      // (lifecycle.handler.ts), so the app reads one shape for both.
      const opensAt = new Date(out.opensAtMs ?? 0).toISOString();
      return bookingError(
        'BOOKING_CHECKIN_WINDOW',
        `Check-in opens at ${opensAt}.`,
        { windowOpensAt: opensAt },
      );
    }
    case 'too_late':
      return bookingError(
        'BOOKING_CHECKIN_WINDOW',
        'Check-in for this booking has closed.',
        { windowClosed: true },
      );
  }
}
