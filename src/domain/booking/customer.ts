import { Money } from '../shared/money';

/**
 * What the salon knows about a customer, and what it charges them because
 * of it.
 *
 * Two things live here: the risk ladder and the six-rung precedence engine
 * that resolves a payment requirement.
 */

// ---------------------------------------------------------------- risk

export type RiskBand = 'LOW' | 'WATCH' | 'HIGH';

/** Counted over a rolling window by whoever loads it; the rules see counts. */
export interface CustomerHistory {
  readonly noShows: number;
  readonly lateCancels: number;
  readonly visits: number;
}

/**
 * The score STARTS at 80 and is spent down.
 *
 *   score = 80 - 30 x no_shows - 15 x late_cancels + 2 x min(visits, 10)
 *   clamped to 0..100
 *
 * Higher is better, which is the opposite of the obvious reading, so it is
 * worth stating plainly. The shape encodes a policy: a no-show costs twice
 * what a late cancel costs, and loyalty earns trust back slowly, two points
 * a visit, capped at ten.
 *
 * Two no-shows and four visits scores 28 and lands in HIGH; the same customer
 * needs a long clean run to climb out. The cap is why: turning up cannot buy
 * unlimited forgiveness.
 */
export const BASE_SCORE = 80;
export const NO_SHOW_PENALTY = 30;
export const LATE_CANCEL_PENALTY = 15;
export const VISIT_CREDIT = 2;
export const VISIT_CREDIT_CAP = 10;

export const LOW_MIN_SCORE = 75;
export const WATCH_MIN_SCORE = 45;

export interface RiskAssessment {
  readonly band: RiskBand;
  readonly score: number;
  readonly reason: string;
}

export function assessRisk(history: CustomerHistory): RiskAssessment {
  const raw =
    BASE_SCORE -
    NO_SHOW_PENALTY * history.noShows -
    LATE_CANCEL_PENALTY * history.lateCancels +
    VISIT_CREDIT * Math.min(history.visits, VISIT_CREDIT_CAP);

  const score = Math.max(0, Math.min(100, raw));

  const band: RiskBand =
    score >= LOW_MIN_SCORE
      ? 'LOW'
      : score >= WATCH_MIN_SCORE
        ? 'WATCH'
        : 'HIGH';

  return { band, score, reason: describe(history, score, band) };
}

function describe(h: CustomerHistory, score: number, band: RiskBand): string {
  const parts: string[] = [];
  if (h.noShows > 0) parts.push(`${h.noShows} no-show(s)`);
  if (h.lateCancels > 0) parts.push(`${h.lateCancels} late cancellation(s)`);
  if (h.visits > 0) parts.push(`${h.visits} visit(s)`);
  const detail = parts.length > 0 ? parts.join(', ') : 'no history on file';

  const outcome =
    band === 'HIGH'
      ? 'at least a 30% deposit is required'
      : band === 'WATCH'
        ? 'monitored, reminder intensity rises, no deposit forced'
        : 'no deposit forced';

  return `Score ${score}, ${band} band (${detail}). ${outcome}.`;
}

// ---------------------------------------------------------------- tier

export type Tier = 'none' | 'silver' | 'gold' | 'vip' | 'royal';

/**
 * TIER DOES NOT TOUCH THE DEPOSIT.
 *
 * "The deposit is computed on the pre-discount service total. A tier discount
 * and a package bundle both reduce what is finally due at checkout, but
 * neither reduces the money that protects the slot."
 *
 * A tier is a reward. A deposit protects the slot against a no-show. Letting
 * the reward shrink the protection is backwards: the customers with the most
 * standing would end up with the least skin in the game.
 *
 * The discount belongs at CHECKOUT, on the service subtotal, never on retail.
 */
export function tierDiscountPercent(tier: Tier): number {
  return tier === 'gold' ? 10 : 0;
}

// ---------------------------------------------------------------- rungs

export type RequirementKind = 'none' | 'deposit' | 'full';

/** One row of the "Why this requirement?" trace. */
export interface RungEvaluation {
  readonly rung: string;
  readonly evaluation: string;
  readonly fired: boolean;
}

export interface Requirement {
  readonly kind: RequirementKind;
  readonly amountFils: number;
  /** Stored on the booking, so the answer survives the draft. */
  readonly source: string;
  /**
   * Every rung, what it evaluated to, and which one won.
   *
   * NOT a debugging affordance. It is the answer to the single most common
   * support question in any booking product, which is "why was I charged
   * this", and the wizard shows it on demand.
   */
  readonly trace: readonly RungEvaluation[];
  /** Set when a clamp moved the amount, so the wizard can say so. */
  readonly clampNote?: string;
}

/** What a service asks for. Either, both, or neither. */
export interface ServiceRequirement {
  readonly name: string;
  readonly percent: number | null;
  readonly fixedFils: number | null;
}

export interface BranchRules {
  readonly onlineDefaultPercent: number | null;
  readonly defaultPercent: number | null;
  readonly peakFromMin: number;
  readonly peakToMin: number;
  readonly peakEscalation: boolean;
}

export const DEFAULT_BRANCH: BranchRules = {
  onlineDefaultPercent: null,
  defaultPercent: null,
  peakFromMin: 1020, // 17:00
  peakToMin: 1200, // 20:00
  peakEscalation: false,
};

export interface RequirementInput {
  /** PRE-DISCOUNT service total. Discounts never shrink the deposit. */
  readonly totalFils: number;
  readonly risk: RiskBand;
  readonly riskScore: number;
  /** Set by a manager on the customer record. Forces at least 50%. */
  readonly requireDepositFlag: boolean;
  readonly service: ServiceRequirement;
  readonly isNewCustomer: boolean;
  readonly channel: 'desk' | 'online' | 'walk_in';
  readonly startMin: number;
  readonly branch: BranchRules;
  readonly managerOverride?: {
    readonly amountFils: number;
    readonly reason: string;
  };
}

export const DEPOSIT_FLOOR = Money.aed(10);
export const DEPOSIT_CEILING = Money.aed(500);

export const RISK_FLAG_PERCENT = 50;
export const HIGH_RISK_PERCENT = 30;
export const FIRST_VISIT_PERCENT = 20;
export const PEAK_ESCALATION_PERCENT = 20;

interface Rung {
  readonly amount: Money;
  readonly kind: RequirementKind;
  readonly source: string;
}

const LATER_RUNGS = [
  '2 Customer risk',
  '3 Service-level setting',
  '4a First-visit rule',
  '4b Peak window',
  '5 Channel default',
  '6 Branch default',
];

/**
 * The six rungs.
 *
 * "The requirement is resolved deterministically by evaluating six rungs and
 * letting the STRICTEST result win. Full beats deposit beats none; between
 * two deposits the larger amount wins."
 *
 * Strictest, not first. A rung can fire AND LOSE, which is the whole point:
 * with a first-match chain, whoever adds the next rule has to work out where
 * in the order it goes, and eventually somebody puts it in the wrong place
 * and a risky customer walks away without a deposit.
 *
 * Two rungs are not amounts:
 *   1  a manager override replaces the answer outright, in either direction
 *   4b the peak window ESCALATES whatever the others produced by one level
 */
export function requirementFor(input: RequirementInput): Requirement {
  const total = Money.fils(input.totalFils);
  const trace: RungEvaluation[] = [];

  // ---- rung 1: manual override -------------------------------------------
  if (input.managerOverride !== undefined) {
    const amount = Money.fils(input.managerOverride.amountFils);
    trace.push({
      rung: '1 Manual override',
      evaluation: `${amount.toString()} (${input.managerOverride.reason})`,
      fired: true,
    });
    for (const r of LATER_RUNGS) {
      trace.push({ rung: r, evaluation: 'not consulted', fired: false });
    }
    return {
      kind: kindOf(amount, total),
      amountFils: amount.fils,
      source: `Manager override: ${input.managerOverride.reason}`,
      trace,
    };
  }
  trace.push({
    rung: '1 Manual override',
    evaluation: 'not set',
    fired: false,
  });

  const rungs: Rung[] = [];

  // ---- rung 2: customer risk ---------------------------------------------
  if (input.requireDepositFlag) {
    rungs.push(
      percentRung(
        total,
        RISK_FLAG_PERCENT,
        `Require-deposit flag: ${RISK_FLAG_PERCENT}%`,
      ),
    );
    trace.push({
      rung: '2 Customer risk',
      evaluation: `Require-deposit flag set, ${RISK_FLAG_PERCENT}%`,
      fired: true,
    });
  } else if (input.risk === 'HIGH') {
    rungs.push(
      percentRung(total, HIGH_RISK_PERCENT, `High risk: ${HIGH_RISK_PERCENT}%`),
    );
    trace.push({
      rung: '2 Customer risk',
      evaluation: `score ${input.riskScore}, HIGH band, ${HIGH_RISK_PERCENT}%`,
      fired: true,
    });
  } else {
    // A WATCH band is monitored but forces nothing. It raises reminder
    // intensity, not money.
    trace.push({
      rung: '2 Customer risk',
      evaluation: `score ${input.riskScore}, ${input.risk} band`,
      fired: false,
    });
  }

  // ---- rung 3: service-level setting -------------------------------------
  const svc = serviceRung(total, input.service);
  if (svc !== null) {
    rungs.push(svc);
    trace.push({
      rung: '3 Service-level setting',
      evaluation: svc.source,
      fired: true,
    });
  } else {
    trace.push({
      rung: '3 Service-level setting',
      evaluation: `none (${input.service.name})`,
      fired: false,
    });
  }

  // ---- rung 4a: first visit ----------------------------------------------
  if (input.isNewCustomer) {
    rungs.push(
      percentRung(
        total,
        FIRST_VISIT_PERCENT,
        `First visit: ${FIRST_VISIT_PERCENT}%`,
      ),
    );
    trace.push({
      rung: '4a First-visit rule',
      evaluation: `new customer, ${FIRST_VISIT_PERCENT}%`,
      fired: true,
    });
  } else {
    trace.push({
      rung: '4a First-visit rule',
      evaluation: 'returning customer',
      fired: false,
    });
  }

  // ---- rung 5: channel default -------------------------------------------
  const channelPercent =
    input.channel === 'online' ? input.branch.onlineDefaultPercent : null;
  if (channelPercent !== null && channelPercent > 0) {
    rungs.push(
      percentRung(total, channelPercent, `Online default: ${channelPercent}%`),
    );
    trace.push({
      rung: '5 Channel default',
      evaluation: `online, ${channelPercent}%`,
      fired: true,
    });
  } else {
    trace.push({
      rung: '5 Channel default',
      evaluation: `${input.channel}, none`,
      fired: false,
    });
  }

  // ---- rung 6: branch default --------------------------------------------
  const branchPercent = input.branch.defaultPercent;
  if (branchPercent !== null && branchPercent > 0) {
    rungs.push(
      percentRung(total, branchPercent, `Branch default: ${branchPercent}%`),
    );
    trace.push({
      rung: '6 Branch default',
      evaluation: `${branchPercent}%`,
      fired: true,
    });
  } else {
    trace.push({ rung: '6 Branch default', evaluation: 'none', fired: false });
  }

  // ---- the strictest wins -------------------------------------------------
  let winner: Rung =
    rungs.length === 0
      ? { amount: Money.ZERO, kind: 'none', source: 'No deposit required' }
      : rungs.reduce((a, b) => (stricter(b, a) ? b : a));

  // ---- rung 4b: peak window escalates ------------------------------------
  // Not an amount of its own. It takes whatever the others produced and moves
  // it up one level: none becomes a 20% deposit, a deposit becomes full.
  const inPeak =
    input.startMin >= input.branch.peakFromMin &&
    input.startMin < input.branch.peakToMin;

  if (input.branch.peakEscalation && inPeak) {
    const before = winner.kind;
    winner = escalate(winner, total, input.branch);
    trace.push({
      rung: '4b Peak window',
      evaluation: `peak start, ${before} escalated to ${winner.kind}`,
      fired: true,
    });
  } else {
    trace.push({
      rung: '4b Peak window',
      evaluation: input.branch.peakEscalation ? 'off-peak start' : 'disabled',
      fired: false,
    });
  }

  if (winner.kind === 'none') {
    return { kind: 'none', amountFils: 0, source: winner.source, trace };
  }

  // ---- the amount, clamped ------------------------------------------------
  const { amount, note } = clamp(winner.amount, total, winner.kind);

  return {
    kind: kindOf(amount, total),
    amountFils: amount.fils,
    source: winner.source,
    trace,
    ...(note !== null ? { clampNote: note } : {}),
  };
}

/** Percentages are rounded to whole dirhams, not whole fils. */
function percentRung(total: Money, percent: number, source: string): Rung {
  const amount = total.percent(percent).roundToDirhams();
  return { amount, kind: kindOf(amount, total), source };
}

/**
 * A service may define a percentage, a fixed amount, or both. The larger wins,
 * and the source names the comparison. This is how a keratin treatment charges
 * AED 400 rather than a percentage that would under-protect it.
 */
function serviceRung(total: Money, svc: ServiceRequirement): Rung | null {
  const pct =
    svc.percent !== null && svc.percent > 0
      ? total.percent(svc.percent).roundToDirhams()
      : null;
  const fixed =
    svc.fixedFils !== null && svc.fixedFils > 0
      ? Money.fils(svc.fixedFils)
      : null;

  if (pct === null && fixed === null) return null;

  if (pct !== null && fixed !== null) {
    return fixed.greaterThan(pct)
      ? {
          amount: fixed,
          kind: kindOf(fixed, total),
          source: `Service fixed ${fixed.toString()} beats ${svc.percent}% (${svc.name})`,
        }
      : {
          amount: pct,
          kind: kindOf(pct, total),
          source: `Service rule ${svc.percent}% (${svc.name})`,
        };
  }

  if (fixed !== null) {
    return {
      amount: fixed,
      kind: kindOf(fixed, total),
      source: `Service fixed ${fixed.toString()} (${svc.name})`,
    };
  }

  const amount = pct as Money;
  return {
    amount,
    kind: kindOf(amount, total),
    source: `Service rule ${svc.percent}% (${svc.name})`,
  };
}

/** none -> 20% deposit -> full. Already full stays full. */
function escalate(rung: Rung, total: Money, branch: BranchRules): Rung {
  if (rung.kind === 'full') return rung;
  if (rung.kind === 'none') {
    const amount = total.percent(PEAK_ESCALATION_PERCENT).roundToDirhams();
    return {
      amount,
      kind: kindOf(amount, total),
      source: `Peak window ${formatMin(branch.peakFromMin)} to ${formatMin(branch.peakToMin)}: ${PEAK_ESCALATION_PERCENT}%`,
    };
  }
  return {
    amount: total,
    kind: 'full',
    source: `Peak window escalation: full payment (${rung.source})`,
  };
}

/** Full beats deposit beats none; between two deposits the larger wins. */
function stricter(a: Rung, b: Rung): boolean {
  const rank = (k: RequirementKind): number =>
    k === 'full' ? 2 : k === 'deposit' ? 1 : 0;
  if (rank(a.kind) !== rank(b.kind)) return rank(a.kind) > rank(b.kind);
  return a.amount.greaterThan(b.amount);
}

/**
 * Raised to the branch floor, capped at the branch ceiling, and the wizard is
 * told when a clamp bites.
 *
 * Full payment is exempt from the ceiling: it is the price, not a deposit,
 * and capping AED 5,000 of prepayment at AED 500 would leave the salon
 * carrying the rest.
 */
function clamp(
  amount: Money,
  total: Money,
  kind: RequirementKind,
): { amount: Money; note: string | null } {
  // Nothing can ever exceed the price. A fixed service deposit of AED 400 on
  // a AED 5 service would otherwise sail straight through: kindOf calls it
  // 'full' because it meets the total, and full is exempt from the clamp, so
  // the salon asks eighty times the price. Found by the invariant test, not
  // by any of the hand-written cases.
  if (amount.greaterThan(total)) {
    return { amount: total, note: 'capped at the service total' };
  }

  if (kind === 'full') return { amount, note: null };

  // Both bounds are themselves capped at the total, or a AED 5 service with a
  // 10% rule would be raised to a AED 10 "deposit" costing twice the service.
  const floor = Money.min(DEPOSIT_FLOOR, total);
  const ceiling = Money.min(DEPOSIT_CEILING, total);

  if (amount.lessThan(floor)) {
    return { amount: floor, note: 'raised to the branch floor' };
  }
  if (amount.greaterThan(ceiling)) {
    return { amount: ceiling, note: 'capped at the branch ceiling' };
  }
  return { amount, note: null };
}

function kindOf(amount: Money, total: Money): RequirementKind {
  if (amount.isZero()) return 'none';
  return amount.lessThan(total) ? 'deposit' : 'full';
}

function formatMin(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- checkout

/**
 * What is still owed when the customer arrives.
 *
 * The tier discount applies HERE, on the service subtotal, and never to the
 * deposit. The Due now line says so explicitly: "on pre-discount total".
 */
export function dueAtCheckout(input: {
  readonly totalFils: number;
  readonly tier: Tier;
  readonly depositFils: number;
}): { discountFils: number; dueFils: number } {
  const total = Money.fils(input.totalFils);
  const discount = total.percent(tierDiscountPercent(input.tier));
  const due = total.minus(discount).minus(Money.fils(input.depositFils));
  return { discountFils: discount.fils, dueFils: Math.max(0, due.fils) };
}
