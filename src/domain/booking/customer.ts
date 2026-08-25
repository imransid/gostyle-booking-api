import { Money } from '../shared/money';

/**
 * What the salon knows about a customer, and what it charges them because
 * of it.
 *
 * Two facts drive everything: how reliable they have been, and how much
 * they are worth. Risk raises the deposit; tier lowers it. This file decides
 * which wins when they disagree.
 */

// ---------------------------------------------------------------- risk

export type RiskBand = 'LOW' | 'WATCH' | 'HIGH';

/**
 * Counted over a rolling window, not for all time.
 *
 * Someone who no-showed twice three years ago and has come faithfully since
 * is not a risk. The window is applied by whoever loads this; the rules here
 * only see the counts.
 */
export interface CustomerHistory {
  readonly noShows: number;
  readonly lateCancels: number;
  readonly completedVisits: number;
}

/** A no-show weighs twice a late cancel: no warning, and the chair sat empty. */
export const NO_SHOW_WEIGHT = 2;
export const LATE_CANCEL_WEIGHT = 1;

/** Completed visits earn forgiveness. Five clean visits cancel one no-show. */
export const VISITS_PER_FORGIVENESS = 5;

export const WATCH_THRESHOLD = 2;
export const HIGH_THRESHOLD = 4;

export interface RiskAssessment {
  readonly band: RiskBand;
  readonly score: number;
  /** Plain English, so a customer can be told why without anyone guessing. */
  readonly reason: string;
}

/**
 * A score rather than a set of rules, so REDEMPTION is possible.
 *
 * A pure threshold ("two no-shows means HIGH forever") is unfair and, worse,
 * useless: once a customer can never get out, the band stops predicting
 * anything. Turning up reliably has to count for something, so every five
 * completed visits cancels a no-show.
 */
export function assessRisk(history: CustomerHistory): RiskAssessment {
  const penalties =
    history.noShows * NO_SHOW_WEIGHT + history.lateCancels * LATE_CANCEL_WEIGHT;

  const forgiven =
    Math.floor(history.completedVisits / VISITS_PER_FORGIVENESS) *
    NO_SHOW_WEIGHT;

  const score = Math.max(0, penalties - forgiven);

  if (score >= HIGH_THRESHOLD) {
    return {
      band: 'HIGH',
      score,
      reason: describeHistory(history, 'Prepayment required'),
    };
  }
  if (score >= WATCH_THRESHOLD) {
    return {
      band: 'WATCH',
      score,
      reason: describeHistory(history, 'A deposit is required'),
    };
  }
  return {
    band: 'LOW',
    score,
    reason:
      history.completedVisits > 0
        ? `${history.completedVisits} completed visit(s), no recent problems.`
        : 'No history on file.',
  };
}

function describeHistory(h: CustomerHistory, outcome: string): string {
  const parts: string[] = [];
  if (h.noShows > 0) parts.push(`${h.noShows} no-show(s)`);
  if (h.lateCancels > 0) parts.push(`${h.lateCancels} late cancellation(s)`);
  if (h.completedVisits > 0) parts.push(`${h.completedVisits} completed`);
  return `${parts.join(', ')}. ${outcome}.`;
}

// ---------------------------------------------------------------- tier

export type Tier = 'standard' | 'silver' | 'gold' | 'vip' | 'royal';

/** Tiers that skip the deposit entirely, unless risk overrides it. */
const WAIVED_TIERS: ReadonlySet<Tier> = new Set(['vip', 'royal']);

/** Tiers whose deposit is capped rather than waived. */
const CAPPED_TIERS: ReadonlyMap<Tier, number> = new Map([
  ['gold', 25],
  ['silver', 50],
]);

// ---------------------------------------------------------------- deposits

export type RequirementKind = 'none' | 'deposit' | 'full';

export interface Requirement {
  readonly kind: RequirementKind;
  readonly amountFils: number;
  /**
   * Stored on the booking, so support can answer "why was I charged this"
   * months later without re-deriving February's rules from memory.
   */
  readonly source: string;
}

export interface RequirementInput {
  readonly totalFils: number;
  readonly risk: RiskBand;
  readonly tier: Tier;
  /** From the service. null when the service asks for nothing. */
  readonly serviceDepositPercent: number | null;
  readonly serviceName: string;
  readonly channel: 'desk' | 'online';
  readonly isNewCustomer: boolean;
  /** Beats everything, and must say why. */
  readonly managerOverride?: {
    readonly amountFils: number;
    readonly reason: string;
  };
}

/** Below this a deposit costs more to process than it protects. */
export const DEPOSIT_FLOOR = Money.aed(10);
/** Above this it stops being a deposit and starts being a barrier. */
export const DEPOSIT_CEILING = Money.aed(500);

/** New customers booking online, who the salon has never met. */
export const NEW_ONLINE_PERCENT = 50;

interface Rung {
  readonly amount: Money;
  readonly source: string;
}

/**
 * How much must be taken before this booking is confirmed.
 *
 * THE ORDER MATTERS AND IT IS NOT THE OBVIOUS ONE.
 *
 *   1. a manager override wins absolutely, whatever anything else says
 *   2. otherwise the STRICTEST applicable rung wins, not the first matching
 *      one, so a HIGH-risk customer booking a service with a small deposit
 *      still prepays
 *   3. tier can then only REDUCE, never raise
 *   4. except that risk beats tier: a VIP who no-shows twice still pays
 *
 * Point 2 is why this is a max() rather than a chain of ifs. With a chain,
 * whoever adds the next rule has to work out where in the order it goes, and
 * eventually somebody puts it in the wrong place and a risky customer walks
 * away without a deposit.
 */
export function requirementFor(input: RequirementInput): Requirement {
  const total = Money.fils(input.totalFils);

  // 1. A manager said so. Nothing else is consulted.
  if (input.managerOverride !== undefined) {
    const amount = Money.fils(input.managerOverride.amountFils);
    return {
      kind: kindOf(amount, total),
      amountFils: amount.fils,
      source: `Manager override: ${input.managerOverride.reason}`,
    };
  }

  // 2. Every rung that applies. The strictest one wins.
  const rungs: Rung[] = [];

  if (input.serviceDepositPercent !== null && input.serviceDepositPercent > 0) {
    rungs.push({
      amount: total.percent(input.serviceDepositPercent),
      source: `Service rule ${input.serviceDepositPercent}% (${input.serviceName})`,
    });
  }

  if (input.risk === 'HIGH') {
    rungs.push({ amount: total, source: 'High risk: prepayment required' });
  } else if (input.risk === 'WATCH') {
    rungs.push({
      amount: total.percent(50),
      source: 'Watch list: 50% deposit',
    });
  }

  if (input.isNewCustomer && input.channel === 'online') {
    rungs.push({
      amount: total.percent(NEW_ONLINE_PERCENT),
      source: `New customer booking online: ${NEW_ONLINE_PERCENT}%`,
    });
  }

  if (rungs.length === 0) {
    return { kind: 'none', amountFils: 0, source: 'No deposit required' };
  }

  const strictest = rungs.reduce((a, b) =>
    b.amount.greaterThan(a.amount) ? b : a,
  );

  // 3 and 4. Tier can reduce, but never below what risk demands.
  const afterTier = applyTier(strictest, input.tier, input.risk, total);

  if (afterTier.amount.isZero()) {
    return { kind: 'none', amountFils: 0, source: afterTier.source };
  }

  // A deposit smaller than the floor is not worth taking; one above the
  // ceiling stops being a deposit. Full prepayment is exempt from both:
  // it is the price, not a deposit.
  //
  // Both bounds are themselves capped at the total. Without that, a AED 5
  // service with a 10% rule produces a 50-fil deposit, gets raised to the
  // AED 10 floor, and the salon asks for twice the price of the service.
  // Found by the invariant test, not by any of the hand-written cases.
  const floor = Money.min(DEPOSIT_FLOOR, total);
  const ceiling = Money.min(DEPOSIT_CEILING, total);

  const final = afterTier.amount.equals(total)
    ? afterTier.amount
    : afterTier.amount.clamp(floor, ceiling);

  return {
    kind: kindOf(final, total),
    amountFils: final.fils,
    source: afterTier.source,
  };
}

function applyTier(rung: Rung, tier: Tier, risk: RiskBand, total: Money): Rung {
  // Risk beats tier. A VIP who has not turned up twice is still a risk, and
  // waiving their deposit is exactly how the salon keeps losing the slot.
  if (risk === 'HIGH') return rung;

  if (WAIVED_TIERS.has(tier)) {
    return {
      amount: Money.ZERO,
      source: `${titleCase(tier)} member: deposit waived`,
    };
  }

  const cap = CAPPED_TIERS.get(tier);
  if (cap !== undefined) {
    const capped = total.percent(cap);
    if (capped.lessThan(rung.amount)) {
      return {
        amount: capped,
        source: `${titleCase(tier)} member: capped at ${cap}% (${rung.source})`,
      };
    }
  }

  return rung;
}

function kindOf(amount: Money, total: Money): RequirementKind {
  if (amount.isZero()) return 'none';
  return amount.greaterThan(total) || amount.equals(total) ? 'full' : 'deposit';
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** What is still owed when the customer arrives. */
export function dueAtCheckout(
  totalFils: number,
  requirement: Requirement,
): number {
  return Math.max(0, totalFils - requirement.amountFils);
}
