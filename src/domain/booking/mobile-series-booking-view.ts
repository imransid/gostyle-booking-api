/**
 * Step B7 (gostyle-customer-api docs/ROUTINE_FE_CONTRACT_AUDIT.md): a
 * routine read as ONE booking, the app team's contract (draft §3 and §5).
 *
 * PURE: the money rule, nothing else. Who reads what is the handler's.
 *
 * THE MONEY RULE. A routine's figures are the sum of its visits, each
 * exactly as the single read (GET /v1/mobile-booking/:id) reports that
 * visit's booking, so the routine and its visits can never disagree:
 *   - a visit skipped through the routine, or one the single read calls
 *     CANCELLED (cancelled, no-show, expired, rescheduled, skipped), adds
 *     nothing;
 *   - a session with no booking yet (PLANNED or NEEDS_ACTION) adds today's
 *     price, fully due.
 * Whatever the single read gets wrong, the routine shows the same (for
 * example F8 in the audit: a desk capture takes the net price, so a visit
 * paid in full still shows its VAT as due). Fixing the visit fixes both.
 */

import type { MobileStatus } from './mobile-contract';

/** One booking's money, exactly as the single read reports it. */
export interface VisitMoney {
  /** The single read's `status`. */
  readonly status: MobileStatus;
  /** The single read's `pass_qr_code`. */
  readonly code: string;
  readonly subtotalFils: number | null;
  readonly vatFils: number;
  readonly discountFils: number;
  readonly totalFils: number | null;
  /** `advance_paid_amount`: what was captured. */
  readonly capturedFils: number;
  /** `due_amount`. Null when the total is. */
  readonly dueFils: number | null;
  /** Each service line, net, as `services[].amount`. */
  readonly items: readonly {
    readonly serviceId: string;
    readonly priceFils: number;
  }[];
}

/** The figures one session adds to its routine. */
export interface VisitFigures {
  readonly subtotalFils: number | null;
  readonly vatFils: number;
  readonly discountFils: number;
  readonly totalFils: number | null;
  readonly capturedFils: number;
  readonly dueFils: number | null;
}

/**
 * Does this session add nothing to its routine? Skipped through the
 * routine, or its booking is one the single read calls CANCELLED (a no-show
 * included: the single read says CANCELLED for it too).
 */
export function addsNothing(input: {
  readonly skipped: boolean;
  /** The single read's status of its booking; null with no booking. */
  readonly bookingStatus: MobileStatus | null;
}): boolean {
  return input.skipped || input.bookingStatus === 'CANCELLED';
}

/** A session not booked yet: today's price, nothing taken, all of it due. */
export function priceToday(quote: {
  readonly subtotalFils: number;
  readonly vatFils: number;
  readonly discountFils: number;
  readonly totalFils: number;
}): VisitFigures {
  return { ...quote, capturedFils: 0, dueFils: quote.totalFils };
}

export interface RoutineFigures {
  readonly subtotalFils: number | null;
  readonly vatFils: number;
  readonly discountFils: number;
  readonly totalFils: number | null;
  readonly capturedFils: number;
  readonly dueFils: number | null;
}

/**
 * The routine's figures: the sum of the sessions that add something (null
 * for one that adds nothing). A figure one visit cannot give (the single
 * read says null for it) makes the routine's figure null too: a sum with a
 * hole in it would understate what is owed.
 */
export function sumVisits(
  visits: readonly (VisitFigures | null)[],
): RoutineFigures {
  const adding = visits.filter((v): v is VisitFigures => v !== null);
  const sum = (pick: (v: VisitFigures) => number): number =>
    adding.reduce((n, v) => n + pick(v), 0);
  const sumOrNull = (pick: (v: VisitFigures) => number | null) =>
    adding.some((v) => pick(v) === null)
      ? null
      : adding.reduce((n, v) => n + pick(v)!, 0);
  return {
    subtotalFils: sumOrNull((v) => v.subtotalFils),
    vatFils: sum((v) => v.vatFils),
    discountFils: sum((v) => v.discountFils),
    totalFils: sumOrNull((v) => v.totalFils),
    capturedFils: sum((v) => v.capturedFils),
    dueFils: sumOrNull((v) => v.dueFils),
  };
}
