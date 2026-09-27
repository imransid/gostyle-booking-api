import { filsToAed } from './mobile-contract';
import type { CancelSummary } from './mobile-series';
import type { CancelClaim } from './mobile-series-contract';

/**
 * POST /v1/mobile-booking/series/:id/cancel (step 7): the body, as the app
 * sent it, into the contract's claim. As manageClaimFrom does, only the
 * shape is read here, and checkCancel judges the value.
 *
 * A blank reason is no reason (a picker left empty). A reason that is not
 * text is kept as text, so checkCancel refuses it (invalid_cancel_reason)
 * instead of the routine being cancelled without it. dry_run must be
 * exactly true, as for the PATCH.
 */
export function cancelClaimFrom(body: unknown): CancelClaim {
  const b: Record<string, unknown> =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)
      : {};
  let reason: string | null = null;
  if (typeof b.reason === 'string') {
    const word = b.reason.trim();
    reason = word === '' ? null : word;
  } else if (b.reason !== undefined && b.reason !== null) {
    reason = JSON.stringify(b.reason);
  }
  return { dryRun: b.dry_run === true, reason };
}

/** One session the cancel ends, as the app reads it. Money in AED. */
export interface CancelSessionView {
  /** series_occurrence.id: the same id as the session in the hub. */
  readonly id: string;
  readonly index: number;
  /** What was paid for it in the app (the ledger). */
  readonly paid: number;
  readonly refund: number;
  /** What the salon keeps, per the single booking's refund rules. */
  readonly kept: number;
  /** Which of those rules applies (the lifecycle's PolicyBand, in capitals). */
  readonly refund_band: string;
  /** Inside the 24 hour lock: a late cancel under the single booking's rules. */
  readonly late: boolean;
}

/** The refund summary (the Figma's "Cancel & Refund"), as the app reads it. */
export interface CancelSummaryView {
  readonly visits_cancelled: number;
  readonly late_visits: number;
  readonly paid: number;
  readonly refund: number;
  readonly kept: number;
  readonly sessions: readonly CancelSessionView[];
}

/**
 * cancelSummary in the app's words: snake case, and AED as the hub writes
 * money (filsToAed). The totals are cancelSummary's own sums, never added up
 * again here, so the view cannot drift from the rule.
 */
export function cancelSummaryView(summary: CancelSummary): CancelSummaryView {
  return {
    visits_cancelled: summary.sessions.length,
    late_visits: summary.sessions.filter((l) => l.locked).length,
    paid: filsToAed(summary.capturedFils),
    refund: filsToAed(summary.refundFils),
    kept: filsToAed(summary.keptFils),
    sessions: summary.sessions.map((l) => ({
      id: l.id,
      index: l.index,
      paid: filsToAed(l.capturedFils),
      refund: filsToAed(l.refundFils),
      kept: filsToAed(l.keptFils),
      refund_band: l.band.toUpperCase(),
      late: l.locked,
    })),
  };
}
