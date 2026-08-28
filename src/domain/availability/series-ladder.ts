/**
 * Repairing an occurrence that no longer fits.
 *
 * This mirrors the disruption ladder of §14.6 but respects the series
 * relationship, and the difference is rung two. Disruption repair keeps the
 * MINUTE and swaps the professional as its first move; so does this, and for
 * a standing client that is the right instinct made explicit: THE HOUR IS
 * USUALLY THE COMMITMENT. Someone who comes every Tuesday at six has built
 * their week around six o'clock, not around Maya.
 *
 * The ladder does not search. It is handed the candidate starts the
 * availability engine already found and decides which of them the series
 * should take. Feasibility stays in feasible.ts, ranking stays in ranking.ts,
 * and this module stays a policy about order.
 */

import { OFFER_SPACING_MIN } from './grid';
import type { RepairCandidate } from './repair';

export type { RepairCandidate };

/** The shifts rung three will accept, in the order it tries them. */
export const SHIFT_STEPS_MIN: readonly number[] = [15, 30];

/** How many alternatives a needs-attention occurrence carries. */
export const MAX_ALTERNATIVES = 3;

export type RepairRung =
  /** The same time with the incumbent. Nothing else is considered. */
  | 'same_time_same_professional'
  /** The same time with anyone eligible. The series yields the person. */
  | 'same_time_any_professional'
  /** 15 or 30 minutes either way, with anyone eligible. */
  | 'small_shift'
  /** The nearest feasible starts anywhere in the day. */
  | 'nearest_in_day';

export interface RepairRequest {
  readonly originalStartMin: number;
  readonly incumbentStaffId: string;
  readonly candidates: readonly RepairCandidate[];
  /**
   * Days from today to the occurrence.
   *
   * Beyond the booking horizon the ladder is not run at all: the diary that
   * far out is not real yet, so a repair now would be a guess that the nightly
   * materialiser would have to make again.
   */
  readonly daysAhead: number;
  readonly bookingHorizonDays: number;
  readonly spacingMin?: number;
}

export interface RepairOffer {
  readonly startMin: number;
  readonly staffId: string;
  readonly rung: RepairRung;
  /** Minutes from the original start. 0 when the hour is kept. */
  readonly distanceMin: number;
  readonly keepsTime: boolean;
  readonly keepsProfessional: boolean;
}

export type RepairOutcome =
  /** A rung held. The occurrence moves and the series carries on. */
  | {
      readonly kind: 'repaired';
      readonly offer: RepairOffer;
      readonly rung: RepairRung;
      readonly explanation: string;
    }
  /**
   * Nothing held. The occurrence needs attention, with up to three nearest
   * alternatives attached for a human to choose from.
   */
  | {
      readonly kind: 'needs_attention';
      readonly alternatives: readonly RepairOffer[];
      readonly explanation: string;
    }
  /** Too far out to be worth repairing now. */
  | {
      readonly kind: 'deferred';
      readonly explanation: string;
    };

/**
 * Run the ladder.
 *
 * Rungs one and two are tried in strict order and return immediately: "if it
 * holds, nothing else is considered" is the whole point of a ladder, and
 * scoring the alternatives to a perfect match would only invite the engine to
 * talk a standing client out of their own hour.
 */
export function repairOccurrence(request: RepairRequest): RepairOutcome {
  if (request.daysAhead > request.bookingHorizonDays) {
    return {
      kind: 'deferred',
      explanation:
        `This occurrence is ${request.daysAhead} days out, beyond the ` +
        `${request.bookingHorizonDays}-day booking horizon. The nightly ` +
        'materialiser will repair it when the diary reaches it.',
    };
  }

  const offers = request.candidates.map((c) => toOffer(c, request));

  // Rung 1: the same time with the incumbent.
  const rung1 = offers.find(
    (o) => o.keepsTime && o.staffId === request.incumbentStaffId,
  );
  if (rung1 !== undefined) {
    return {
      kind: 'repaired',
      offer: { ...rung1, rung: 'same_time_same_professional' },
      rung: 'same_time_same_professional',
      explanation:
        'The original time and professional both still work. Nothing changes.',
    };
  }

  // Rung 2: the same time with anyone else. The series yields the person.
  const rung2 = offers
    .filter((o) => o.keepsTime)
    .sort((a, b) => a.staffId.localeCompare(b.staffId))[0];
  if (rung2 !== undefined) {
    return {
      kind: 'repaired',
      offer: { ...rung2, rung: 'same_time_any_professional' },
      rung: 'same_time_any_professional',
      explanation:
        `The hour is kept and the professional changes to ${rung2.staffId}. ` +
        'For a standing client the time is usually the commitment.',
    };
  }

  // Rung 3: a small shift either way, nearest first, with anyone eligible.
  for (const step of SHIFT_STEPS_MIN) {
    // Earlier and later are equally acceptable, so the tie breaks on the
    // professional rather than on the direction: neither is more disruptive.
    const shifted = offers
      .filter((o) => o.distanceMin === step)
      .sort(
        (a, b) =>
          Number(b.keepsProfessional) - Number(a.keepsProfessional) ||
          a.startMin - b.startMin,
      )[0];
    if (shifted !== undefined) {
      return {
        kind: 'repaired',
        offer: { ...shifted, rung: 'small_shift' },
        rung: 'small_shift',
        explanation:
          `Moved ${step} minutes ${shifted.startMin > request.originalStartMin ? 'later' : 'earlier'}` +
          `, keeping the day.`,
      };
    }
  }

  // Rung 4: no automatic repair. Attach the nearest starts and raise a flag.
  return {
    kind: 'needs_attention',
    alternatives: nearestAlternatives(offers, request.spacingMin),
    explanation:
      offers.length === 0
        ? 'Nothing in the day fits this occurrence. The series is at risk.'
        : 'No small move works. The nearest alternatives need a human choice.',
  };
}

function toOffer(c: RepairCandidate, request: RepairRequest): RepairOffer {
  const distance = Math.abs(c.startMin - request.originalStartMin);
  return {
    startMin: c.startMin,
    staffId: c.staffId,
    rung: 'nearest_in_day',
    distanceMin: distance,
    keepsTime: distance === 0,
    keepsProfessional: c.staffId === request.incumbentStaffId,
  };
}

/**
 * The three nearest feasible starts, ordered by distance from the original.
 *
 * Spaced, for the same reason the three offers are spaced: three alternatives
 * inside one half hour are one alternative wearing three hats, and the desk
 * has to ring the client either way.
 */
export function nearestAlternatives(
  offers: readonly RepairOffer[],
  spacingMin: number = OFFER_SPACING_MIN,
): RepairOffer[] {
  const byDistance = [...offers].sort(
    (a, b) =>
      a.distanceMin - b.distanceMin ||
      Number(b.keepsProfessional) - Number(a.keepsProfessional) ||
      a.startMin - b.startMin,
  );

  const chosen: RepairOffer[] = [];
  for (const o of byDistance) {
    if (chosen.length >= MAX_ALTERNATIVES) break;
    const tooClose = chosen.some(
      (c) => Math.abs(c.startMin - o.startMin) < spacingMin,
    );
    if (!tooClose) chosen.push(o);
  }
  return chosen.sort((a, b) => a.startMin - b.startMin);
}
