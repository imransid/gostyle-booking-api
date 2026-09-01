/**
 * Repairing the bookings a professional was going to take.
 *
 * A professional goes off sick, a roster is edited, a floor closes. Every
 * booking that depended on them is collected into a worklist and this ladder
 * runs over each one, least disruptive first.
 *
 * THE DIFFERENCE FROM THE SERIES LADDER is rung one, and it is forced rather
 * than chosen. A series repairs around an incumbent who is still available;
 * here the incumbent is the reason for the repair, so keeping them is not an
 * option and rung one is "the same minute with SOMEBODY ELSE". Rung two is
 * also wider -- 45 minutes as well as 15 and 30 -- because there is no
 * standing arrangement to protect, only a day.
 *
 * Rung four does not fire. It is PROPOSED: cancelling a paying customer is
 * not something a roster edit should do while nobody is looking, and the
 * commit gate of 14.8 only means anything if something is left for a person
 * to clear.
 */

import { samePartOfDay, partOfDay, formatMinute } from './grid';
import type { RepairCandidate } from './repair';

export type DisruptionRung =
  /** The same minute, another eligible professional. No customer impact. */
  | 'same_minute_other_professional'
  /** 15, 30 or 45 minutes either way. They keep their day and roughly their time. */
  | 'small_shift'
  /** Any start inside the same part of the day. They keep their day. */
  | 'same_part_of_day'
  /** Nothing works. Compensated, and put at the front of the queue. */
  | 'salon_cancellation';

/** Rung two, in the order it tries them. */
export const DISRUPTION_SHIFT_STEPS_MIN: readonly number[] = [15, 30, 45];

/**
 * Goodwill on a salon cancellation, as a percentage of the booking.
 *
 * THE SPECIFICATION DOES NOT FIX THIS FIGURE. It says a goodwill credit is
 * given and does not say how much, so this is a placeholder in one place
 * rather than a number scattered through the code, and it needs a decision
 * from the business before it goes anywhere near a real customer.
 *
 * THE SHAPE IS SETTLED, THE RATE IS NOT. Three calls have been made so the
 * outstanding decision is only ever about the number:
 *
 *   A PERCENTAGE, AND ONLY A PERCENTAGE. No flat-amount sibling until
 *   something actually asks for one. A GOODWILL_FLAT_FILS that nothing reads
 *   is dead code that outlives everyone who remembers why it was added.
 *
 *   HARD-CODED, NOT AN ENVIRONMENT VARIABLE. There is no branch
 *   configuration table, so an env var here would be a global switch
 *   impersonating a per-branch rule. That is precisely what the peak-window
 *   flag turned out to be, and why it was deleted rather than promoted. When
 *   goodwill genuinely varies by branch, it varies in the branch table.
 *
 *   APPLIED AUTOMATICALLY, and the ledger reason should say the rate is
 *   provisional. NOT DONE YET, deliberately: postGoodwill() writes the
 *   goodwill row with no `reason` at all, so there is currently nowhere for
 *   that caveat to land. Whoever sets the real rate should add the reason in
 *   the same change, and drop the word "provisional" from it at that point.
 */
export const GOODWILL_PERCENT = 10;

export interface DisruptedBooking {
  readonly bookingId: string;
  readonly code: string;
  readonly startMin: number;
  readonly durationMin: number;
  /** The professional who is going off. Never a landing place. */
  readonly staffId: string;
  readonly priceFils: number;
  readonly capturedFils: number;
}

export interface DisruptionOffer {
  readonly startMin: number;
  readonly staffId: string;
  readonly distanceMin: number;
}

export type DisruptionOutcome =
  | {
      readonly kind: 'repaired';
      readonly rung: DisruptionRung;
      readonly offer: DisruptionOffer;
      readonly explanation: string;
      readonly customerImpact: string;
    }
  | {
      readonly kind: 'propose_cancellation';
      readonly rung: 'salon_cancellation';
      /** Unconditional: the customer did nothing wrong. */
      readonly refundFils: number;
      readonly goodwillFils: number;
      readonly waitlistWindow: {
        readonly fromMin: number;
        readonly toMin: number;
      };
      readonly explanation: string;
      readonly customerImpact: string;
    };

export interface DisruptionRequest {
  readonly booking: DisruptedBooking;
  /**
   * Feasible starts, from the same masks a fresh booking uses.
   *
   * The caller has already removed the departing professional. Passing them
   * in and filtering here would work equally well right up until somebody
   * forgot, and then the ladder would cheerfully reassign a booking to the
   * person who just called in sick.
   */
  readonly candidates: readonly RepairCandidate[];
}

export function repairDisruption(
  request: DisruptionRequest,
): DisruptionOutcome {
  const { booking } = request;

  // Belt and braces. The caller is supposed to have excluded them, and if a
  // future caller does not, this is the line that stops a booking being
  // handed back to the professional who is going off.
  const usable = request.candidates.filter(
    (c) => c.staffId !== booking.staffId,
  );

  const offers = usable.map((c) => ({
    startMin: c.startMin,
    staffId: c.staffId,
    distanceMin: Math.abs(c.startMin - booking.startMin),
  }));

  // Rung 1: the same minute, somebody else.
  const sameMinute = offers
    .filter((o) => o.distanceMin === 0)
    .sort((a, b) => a.staffId.localeCompare(b.staffId))[0];
  if (sameMinute !== undefined) {
    return {
      kind: 'repaired',
      rung: 'same_minute_other_professional',
      offer: sameMinute,
      explanation: `Reassigned to ${sameMinute.staffId} at the same time.`,
      customerImpact: 'None. The customer keeps their time.',
    };
  }

  // Rung 2: a small shift, nearest step first.
  for (const step of DISRUPTION_SHIFT_STEPS_MIN) {
    const shifted = offers
      .filter((o) => o.distanceMin === step)
      .sort((a, b) => a.startMin - b.startMin)[0];
    if (shifted !== undefined) {
      return {
        kind: 'repaired',
        rung: 'small_shift',
        offer: shifted,
        explanation:
          `Moved ${step} minutes ${shifted.startMin > booking.startMin ? 'later' : 'earlier'} ` +
          `to ${formatMinute(shifted.startMin)} with ${shifted.staffId}.`,
        customerImpact:
          'Minimal. The customer keeps their day and roughly their time.',
      };
    }
  }

  // Rung 3: anywhere inside the same part of the day, nearest first.
  const nearby = offers
    .filter((o) => samePartOfDay(o.startMin, booking.startMin))
    .sort(
      (a, b) => a.distanceMin - b.distanceMin || a.startMin - b.startMin,
    )[0];
  if (nearby !== undefined) {
    return {
      kind: 'repaired',
      rung: 'same_part_of_day',
      offer: nearby,
      explanation:
        `Moved to ${formatMinute(nearby.startMin)} with ${nearby.staffId}, ` +
        `still their ${partOfDay(booking.startMin)}.`,
      customerImpact: 'Moderate. The customer keeps their day.',
    };
  }

  // Rung 4: nothing in the day works. PROPOSED, never applied here.
  const goodwill =
    Math.round((booking.priceFils * GOODWILL_PERCENT) / 100 / 100) * 100;

  return {
    kind: 'propose_cancellation',
    rung: 'salon_cancellation',
    // Unconditional and in full. The salon cancelled; timing does not apply.
    refundFils: booking.capturedFils,
    goodwillFils: goodwill,
    // Front of the queue for the window they originally wanted, not for the
    // whole day: they asked for this time and that is what they should be
    // offered first when it frees up.
    waitlistWindow: {
      fromMin: booking.startMin,
      toMin: booking.startMin + booking.durationMin,
    },
    explanation:
      `Nothing in ${partOfDay(booking.startMin)} works. Proposing a salon ` +
      'cancellation with a full refund, a goodwill credit and a waitlist entry.',
    customerImpact:
      'Significant, so it is compensated and the customer goes to the front ' +
      'of the queue for that window.',
  };
}
