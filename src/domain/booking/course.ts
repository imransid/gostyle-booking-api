/**
 * A course is sold once and drawn down per visit.
 *
 * Six keratin visits are taken as a single advance receipt. Each visit draws a
 * fixed amount as a "Course credit applied" tender, and the final draw ends
 * the series at a zero balance.
 *
 * TWO RULES DO ALL THE WORK HERE.
 *
 * The draws must sum back to exactly what was sold. A course that leaves three
 * fils on the table after its last visit is a course that never closes, and a
 * series that cannot end is a series someone has to close by hand. So the
 * split is the largest-remainder allocation from Money, not a division.
 *
 * VAT is recognised PER DRAW, not at the point of sale. The salon has not
 * earned the sixth visit's revenue on the day the course is bought. So the
 * total VAT is computed once on the whole net and allocated across the visits
 * the same way the net is, which keeps the recognised parts summing to the
 * figure on the original receipt.
 */

import { Money } from '../shared/money';
import { VAT_PERCENT } from './quote';

export interface CourseDefinition {
  /** What was sold, net of VAT. */
  readonly totalNetFils: number;
  /** How many visits it buys. */
  readonly visits: number;
}

export interface CourseDraw {
  /** 0-based visit number. */
  readonly index: number;
  readonly netFils: number;
  readonly vatFils: number;
  /** What the ticket shows as "Course credit applied". */
  readonly grossFils: number;
  /** Gross still on the meter after this draw. Zero on the last one. */
  readonly remainingAfterFils: number;
  /** The last draw. The series ends here. */
  readonly endsCourse: boolean;
}

export interface CourseState {
  readonly visits: number;
  readonly drawnCount: number;
  readonly drawnGrossFils: number;
  readonly remainingGrossFils: number;
  readonly totalGrossFils: number;
  readonly exhausted: boolean;
  readonly explanation: string;
}

/**
 * The whole draw-down schedule, computed up front.
 *
 * Up front rather than one at a time, because "what is left on the meter" has
 * to be answerable before the second visit happens, and because a schedule
 * that is derived once cannot drift from the receipt it came from.
 */
export function planDraws(def: CourseDefinition): readonly CourseDraw[] {
  if (!Number.isInteger(def.visits) || def.visits < 1) {
    throw new Error(`A course needs at least one visit, got ${def.visits}`);
  }

  const net = Money.fils(def.totalNetFils);
  if (net.isNegative()) {
    throw new Error('A course cannot be sold for a negative amount');
  }

  // Round the VAT ONCE, on the whole sale, then share it out. Charging 5% on
  // each part separately rounds six times and lands somewhere near the right
  // answer instead of on it.
  const vat = net.percent(VAT_PERCENT);

  const netParts = net.split(def.visits);
  const vatParts = vat.allocate(netParts.map(() => 1));

  const draws: CourseDraw[] = [];
  let remaining = net.plus(vat);

  for (let i = 0; i < def.visits; i += 1) {
    const n = netParts[i] ?? Money.ZERO;
    const v = vatParts[i] ?? Money.ZERO;
    const gross = n.plus(v);
    remaining = remaining.minus(gross);

    draws.push({
      index: i,
      netFils: n.fils,
      vatFils: v.fils,
      grossFils: gross.fils,
      remainingAfterFils: remaining.fils,
      endsCourse: i === def.visits - 1,
    });
  }

  return draws;
}

/** The next draw, or null when the course is spent. */
export function nextDraw(
  def: CourseDefinition,
  drawnCount: number,
): CourseDraw | null {
  const draws = planDraws(def);
  return draws[drawnCount] ?? null;
}

/** What the meter on the series panel shows. */
export function courseState(
  def: CourseDefinition,
  drawnCount: number,
): CourseState {
  const draws = planDraws(def);
  const taken = draws.slice(0, Math.max(0, Math.min(drawnCount, draws.length)));

  const totalGross = Money.sum(draws.map((d) => Money.fils(d.grossFils)));
  const drawnGross = Money.sum(taken.map((d) => Money.fils(d.grossFils)));
  const remaining = totalGross.minus(drawnGross);
  const exhausted = taken.length >= draws.length;

  return {
    visits: def.visits,
    drawnCount: taken.length,
    drawnGrossFils: drawnGross.fils,
    remainingGrossFils: remaining.fils,
    totalGrossFils: totalGross.fils,
    exhausted,
    explanation: exhausted
      ? `All ${def.visits} visits drawn. The course is closed at a zero balance.`
      : `${taken.length} of ${def.visits} visits drawn. ${remaining.toString()} remaining.`,
  };
}
