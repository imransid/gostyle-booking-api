import type { BookingError } from '@application/contract/errors';
import type { LaneOutcome } from '@application/commands/group-check-in-lanes';

/**
 * The whole party's answer, from every lane's outcome.
 *
 *   created  at least one lane RAISED: the desk has something new (201)
 *   waiting  nothing new, but at least one lane is WAITING (200)
 *   refused  nothing to do, and every lane REFUSED with one same code: that
 *            refusal, the first lane's, so the app reads "check-in opens at"
 *            exactly as it does for one booking (its own status, 409)
 *   none     nothing to do, for mixed reasons (one already in, one cancelled,
 *            one refused): BOOKING_GROUP_CHECKIN_NONE, built by the caller,
 *            which alone knows each lane's booking to list in the details
 */
export type PartyAnswer =
  | { readonly kind: 'created' }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'refused'; readonly error: BookingError }
  | { readonly kind: 'none' };

export function partyAnswer(lanes: readonly LaneOutcome[]): PartyAnswer {
  if (lanes.some((l) => l.outcome === 'RAISED')) return { kind: 'created' };
  if (lanes.some((l) => l.outcome === 'WAITING')) return { kind: 'waiting' };

  const errors = lanes.flatMap((l) =>
    l.outcome === 'REFUSED' ? [l.error] : [],
  );
  const first = errors[0];
  if (
    first !== undefined &&
    errors.length === lanes.length &&
    errors.every((e) => e.code === first.code)
  ) {
    return { kind: 'refused', error: first };
  }
  return { kind: 'none' };
}
