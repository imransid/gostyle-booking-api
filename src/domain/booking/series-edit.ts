/**
 * Editing, pausing and ending a series.
 *
 * TWO RULES, both about not destroying something the customer is counting on.
 *
 * Scope is asked for EVERY TIME and never defaulted. "Change the time" against
 * a standing booking is ambiguous in a way that only the person typing it can
 * resolve, and guessing wrong either strands one visit or silently rewrites a
 * year of them. So scope is a required argument here, not an optional one with
 * a sensible-looking default.
 *
 * Cancelling in bulk stops at the 48-hour protection window. Beyond it, a
 * cancellation is administration. Inside it, the client has arranged their day
 * around the appointment, so the desk confirms each one explicitly rather than
 * a pause quietly emptying tomorrow morning.
 */

import type { BookingStatus } from './lifecycle';
import type { TradingDay } from './recurrence';

export type EditScope =
  /** Detaches this occurrence from the series and edits it alone. */
  | 'this_occurrence'
  /** This one and every later one. The usual answer for a new time. */
  | 'this_and_future'
  /** Every occurrence, past ones excepted: history is not rewritten. */
  | 'entire_series';

/** Inside this many hours, each cancellation is confirmed by hand. */
export const CANCELLATION_PROTECTION_HOURS = 48;

export interface SeriesOccurrence {
  readonly id: string;
  readonly date: TradingDay;
  readonly startMin: number;
  readonly status: BookingStatus;
  /**
   * Hours from now until this occurrence starts. Negative once it has begun.
   *
   * Passed in rather than computed: turning a trading day into an instant
   * needs the branch's offset, which lives in the persistence layer, and the
   * domain does not reach sideways for it.
   */
  readonly startsInHours: number;
}

/** Statuses where the visit is under way or done. These are never touched. */
const STARTED: ReadonlySet<BookingStatus> = new Set<BookingStatus>([
  'checked_in',
  'in_service',
  'completed',
  'settled',
]);

/** Already closed, one way or another. Nothing to cancel. */
const CLOSED: ReadonlySet<BookingStatus> = new Set<BookingStatus>([
  'cancelled',
  'no_show',
  'rescheduled',
  'expired',
  'skipped',
]);

export interface EditPlan {
  readonly scope: EditScope;
  /** Occurrences the edit applies to. */
  readonly affected: readonly string[];
  /** Occurrences that leave the series and stand alone. */
  readonly detached: readonly string[];
  /** Not part of this edit: out of scope, or started, or closed. */
  readonly untouched: readonly string[];
  /**
   * IN scope, but not editable: the visit has started or is already closed.
   *
   * Kept apart from `untouched` because the two mean different things to the
   * person reading the confirmation. "Twenty left alone" is reassuring when
   * they chose one occurrence and alarming when they chose the whole series,
   * and lumping them together said the second thing in both cases.
   */
  readonly ineligible: readonly string[];
  readonly explanation: string;
}

/**
 * Which occurrences does this edit actually touch?
 *
 * A started or closed occurrence is never touched by any scope. Rewriting the
 * time of a visit the customer is currently sitting through is not an edit,
 * it is a falsification of the diary.
 */
export function planEdit(
  scope: EditScope,
  occurrences: readonly SeriesOccurrence[],
  targetId: string,
): EditPlan {
  const target = occurrences.find((o) => o.id === targetId);
  if (target === undefined) {
    throw new Error(`Occurrence ${targetId} is not part of this series`);
  }

  const editable = (o: SeriesOccurrence): boolean =>
    !STARTED.has(o.status) && !CLOSED.has(o.status);

  const isLaterOrSame = (o: SeriesOccurrence): boolean =>
    o.date > target.date ||
    (o.date === target.date && o.startMin >= target.startMin);

  let candidates: SeriesOccurrence[];
  switch (scope) {
    case 'this_occurrence':
      candidates = [target];
      break;
    case 'this_and_future':
      candidates = occurrences.filter(isLaterOrSame);
      break;
    case 'entire_series':
      // "Entire series" still means everything still to come. A finished visit
      // is a fact about the past.
      candidates = [...occurrences];
      break;
  }

  const affected = candidates.filter(editable);
  const affectedIds = new Set(affected.map((o) => o.id));
  const ineligible = candidates.filter((o) => !editable(o)).map((o) => o.id);
  const untouched = occurrences
    .filter((o) => !affectedIds.has(o.id))
    .map((o) => o.id);

  return {
    scope,
    affected: affected.map((o) => o.id),
    // Only "this occurrence only" detaches. The other two scopes are edits to
    // the series itself, so its occurrences stay members of it.
    detached: scope === 'this_occurrence' ? affected.map((o) => o.id) : [],
    untouched,
    ineligible,
    explanation: explainEdit(scope, affected.length, ineligible.length),
  };
}

export interface CancellationPlan {
  /** Cancelled outright: far enough out to be administration. */
  readonly cancel: readonly string[];
  /** Inside the protection window; the desk confirms each one. */
  readonly needsExplicitConfirmation: readonly string[];
  /** Started, or already closed. Left alone. */
  readonly untouched: readonly string[];
  readonly explanation: string;
}

/**
 * What pausing or ending a series does to the visits still on the calendar.
 *
 * Pause and end plan identically. They differ in what happens to the
 * DEFINITION afterwards, which is not this function's business.
 */
export function planPauseOrEnd(
  occurrences: readonly SeriesOccurrence[],
  protectionHours: number = CANCELLATION_PROTECTION_HOURS,
): CancellationPlan {
  const cancel: string[] = [];
  const confirm: string[] = [];
  const untouched: string[] = [];

  for (const o of occurrences) {
    if (STARTED.has(o.status) || CLOSED.has(o.status)) {
      untouched.push(o.id);
      continue;
    }
    // A visit already in the past that never started is not a future
    // occurrence, so bulk cancellation does not reach for it either.
    if (o.startsInHours < 0) {
      untouched.push(o.id);
      continue;
    }
    if (o.startsInHours < protectionHours) {
      confirm.push(o.id);
    } else {
      cancel.push(o.id);
    }
  }

  return {
    cancel,
    needsExplicitConfirmation: confirm,
    untouched,
    explanation:
      confirm.length === 0
        ? `${cancel.length} future ${cancel.length === 1 ? 'occurrence' : 'occurrences'} cancelled.`
        : `${cancel.length} cancelled. ${confirm.length} inside the ` +
          `${protectionHours}-hour window ${confirm.length === 1 ? 'needs' : 'need'} ` +
          'the desk to confirm each one.',
  };
}

function explainEdit(
  scope: EditScope,
  affected: number,
  ineligible: number,
): string {
  // Only the IN-SCOPE ones that cannot be touched are worth mentioning.
  // Occurrences outside the chosen scope were never candidates, and saying
  // "20 left alone" about them reads as a warning when it is just arithmetic.
  const tail =
    ineligible === 0
      ? ''
      : ` ${ineligible} left alone: already started, or already closed.`;

  switch (scope) {
    case 'this_occurrence':
      return affected === 0
        ? `This occurrence cannot be edited.${tail}`
        : `This occurrence only. It detaches from the series.${tail}`;
    case 'this_and_future':
      return `This and ${affected - 1} later ${affected - 1 === 1 ? 'occurrence' : 'occurrences'}.${tail}`;
    case 'entire_series':
      return `The entire series: ${affected} ${affected === 1 ? 'occurrence' : 'occurrences'}.${tail}`;
  }
}
