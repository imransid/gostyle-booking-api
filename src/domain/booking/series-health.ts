/**
 * Is this series in trouble?
 *
 * DERIVED, never stored as a judgement someone remembered to write. The same
 * reasoning as the group's status: health computed from the occurrences that
 * exist has one answer, and a stored flag has as many as there were writers.
 *
 * Health is deliberately separate from the series STATUS. A paused series can
 * still be at risk, and an active one is usually not; collapsing the two would
 * mean pausing a series to make a warning go away.
 */

export type SeriesStatus = 'active' | 'paused' | 'ended' | 'completed';

export type SeriesHealth = 'healthy' | 'at_risk';

export type RiskReason =
  /** An occurrence no longer fits and the ladder could not repair it. */
  | 'needs_attention'
  /** Two confirmation requests in a row went unanswered. */
  | 'confirmations_lapsing'
  /** The customer did not turn up. */
  | 'no_show'
  /** Visits are being skipped rather than kept. */
  | 'skipping';

/** Two consecutive expiries flag the series At risk. */
export const CONSECUTIVE_EXPIRIES_AT_RISK = 2;

/**
 * Skips are counted in health but are not, on their own, alarming.
 *
 * One skipped visit is a client with a busy fortnight. Three is a client who
 * has stopped coming and has not said so, which is worth a call while the slot
 * can still be resold.
 */
export const SKIPS_AT_RISK = 3;

export interface SeriesFacts {
  readonly status: SeriesStatus;
  /** Occurrences flagged needs-attention and still unresolved. */
  readonly needsAttentionCount: number;
  /**
   * Confirmation windows that expired back to back, counting from the most
   * recent occurrence backwards. A confirmed visit resets it to zero, which is
   * why the caller passes a streak rather than a total.
   */
  readonly consecutiveConfirmationExpiries: number;
  readonly noShowCount: number;
  readonly skippedCount: number;
}

export interface HealthDerivation {
  readonly health: SeriesHealth;
  readonly reasons: readonly RiskReason[];
  readonly explanation: string;
}

export function deriveSeriesHealth(facts: SeriesFacts): HealthDerivation {
  const reasons: RiskReason[] = [];

  if (facts.needsAttentionCount > 0) reasons.push('needs_attention');
  if (facts.consecutiveConfirmationExpiries >= CONSECUTIVE_EXPIRIES_AT_RISK) {
    reasons.push('confirmations_lapsing');
  }
  // A no-show counts even where the FEE was waived by rule. The waiver is
  // about money; the empty chair happened either way, and the series is what
  // will produce the next one.
  if (facts.noShowCount > 0) reasons.push('no_show');
  if (facts.skippedCount >= SKIPS_AT_RISK) reasons.push('skipping');

  return {
    health: reasons.length === 0 ? 'healthy' : 'at_risk',
    reasons,
    explanation: explain(facts, reasons),
  };
}

function explain(facts: SeriesFacts, reasons: readonly RiskReason[]): string {
  if (reasons.length === 0) return 'The series is running normally.';

  const parts = reasons.map((r) => {
    switch (r) {
      case 'needs_attention':
        return `${facts.needsAttentionCount} ${facts.needsAttentionCount === 1 ? 'occurrence needs' : 'occurrences need'} attention`;
      case 'confirmations_lapsing':
        return `${facts.consecutiveConfirmationExpiries} confirmation requests in a row went unanswered`;
      case 'no_show':
        return `${facts.noShowCount} ${facts.noShowCount === 1 ? 'no-show' : 'no-shows'}`;
      case 'skipping':
        return `${facts.skippedCount} visits skipped`;
    }
  });

  return `At risk: ${parts.join('; ')}.`;
}
