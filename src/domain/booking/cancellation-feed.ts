import {
  FREE_CANCEL_WINDOW_HOURS,
  LATE_CANCEL_WINDOW_HOURS,
} from './lifecycle';

/**
 * The cancellations screen, as rules rather than as SQL.
 *
 * WHAT WAS WRONG. Three separate things, all of them this file's subject:
 *
 *   1. A LATE CANCEL WAS INDISTINGUISHABLE from any other cancel. No row
 *      carried a flag and no row carried a date, so the client could not even
 *      derive one; and `kind=LATE_CANCEL` was silently coerced to CANCELLED
 *      and answered 200 with the same 105 rows. A filter that quietly means
 *      something else is worse than one that refuses.
 *
 *   2. THE "POLICY WINDOW" ROW ON THE DETAIL PAYLOAD read the free-text
 *      cancellation REASON. `GS-1264` showed a labelled row saying
 *      "Policy window: qa backfill test". The window is a fact about two
 *      timestamps and was never derivable from prose.
 *
 *   3. The summary was computed over the PAGE. It is the KPI strip for the
 *      period, so it has to be computed over the period -- see
 *      `summarise` below, which takes window totals, not rows.
 *
 * All three are decisions, so they live here with a spec instead of inside a
 * query or a mapper.
 */

const HOUR_MS = 60 * 60 * 1000;

/** What the feed can be narrowed to. ALL is both kinds. */
export const EVENT_KINDS = [
  'ALL',
  'CANCELLED',
  'LATE_CANCEL',
  'NO_SHOW',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export function isEventKind(raw: string): raw is EventKind {
  return (EVENT_KINDS as readonly string[]).includes(raw);
}

/**
 * The timing half of the cancellation policy, with no money in it.
 *
 * `cancellationOutcome` answers what happened to the deposit and needs to
 * know what was captured. The feed only needs to know WHEN, for every row,
 * including rows where nothing was captured at all. Same thresholds, one
 * definition: this function is the one both read.
 */
export type CancelBand = 'more_than_24h' | '24h_to_2h' | 'under_2h';

export interface CancelTiming {
  /** Positive when the visit was still ahead. Negative after the start. */
  readonly hoursBeforeStart: number;
  readonly band: CancelBand;
  /** Inside the late window. Weighs more in the risk score. */
  readonly lateCancel: boolean;
}

export function cancelTiming(input: {
  readonly occurredAtMs: number;
  readonly startAtMs: number;
}): CancelTiming {
  const hoursBeforeStart = (input.startAtMs - input.occurredAtMs) / HOUR_MS;

  if (hoursBeforeStart > FREE_CANCEL_WINDOW_HOURS) {
    return { hoursBeforeStart, band: 'more_than_24h', lateCancel: false };
  }
  // >= not >, matching cancellationOutcome: exactly T-2h is inside the middle
  // band, not past it. The two would be a rounding apart otherwise, and the
  // screen would disagree with the refund the customer was given.
  if (hoursBeforeStart >= LATE_CANCEL_WINDOW_HOURS) {
    return { hoursBeforeStart, band: '24h_to_2h', lateCancel: false };
  }
  return { hoursBeforeStart, band: 'under_2h', lateCancel: true };
}

/**
 * The "Policy window" row on the detail drawer, in words a desk can read down
 * a phone.
 *
 * A no-show has no band -- nobody cancelled anything -- so it says what
 * actually happened instead of borrowing a cancellation's vocabulary.
 */
export function policyWindow(input: {
  readonly kind: 'CANCELLED' | 'NO_SHOW';
  readonly timing: CancelTiming;
}): string {
  if (input.kind === 'NO_SHOW') return 'start + grace passed';

  const hours = input.timing.hoursBeforeStart;
  switch (input.timing.band) {
    case 'more_than_24h':
      return `more than ${FREE_CANCEL_WINDOW_HOURS}h before start (${describe(hours)})`;
    case '24h_to_2h':
      return `${FREE_CANCEL_WINDOW_HOURS}h to ${LATE_CANCEL_WINDOW_HOURS}h before start (${describe(hours)})`;
    case 'under_2h':
      return hours < 0
        ? `after the start (${describe(hours)})`
        : `under ${LATE_CANCEL_WINDOW_HOURS}h before start (${describe(hours)})`;
  }
}

/** "3.5h before start" / "20m after start". Never a bare signed number. */
function describe(hours: number): string {
  const ahead = hours >= 0;
  const abs = Math.abs(hours);
  const text = abs < 1 ? `${Math.round(abs * 60)}m` : `${round1(abs)}h`;
  return `${text} ${ahead ? 'before' : 'after'} start`;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * What the money did on one event.
 *
 * DEPOSIT_KEPT is the only outcome where the salon is left holding anything,
 * so it is the only one that reduces the lost value.
 */
export type EventOutcome =
  'DEPOSIT_KEPT' | 'PARTIALLY_REFUNDED' | 'REFUNDED' | 'NO_CHARGE' | 'LOST';

export interface WindowTotals {
  readonly events: number;
  readonly noShows: number;
  /** Service value, in fils, of every event in the window. */
  readonly serviceValueFils: number;
  /** Deposits actually forfeited, in fils. */
  readonly depositsKeptFils: number;
  /** Cancelled or no-showed slots that a waitlist acceptance refilled. */
  readonly recovered: number;
}

export interface FeedSummary {
  readonly events: number;
  readonly noShows: number;
  readonly lostValueFils: number;
  readonly depositsKeptFils: number;
  readonly recovered: number;
}

/**
 * The KPI strip for the WHOLE window.
 *
 * `lostValue` is stated rather than assumed: it is the service value the
 * salon did not get, which is everything the events were worth LESS whatever
 * was kept. The previous definition summed `servicePrice` over rows whose
 * payment status was not `forfeited`, which counted a fully refunded booking
 * as a loss of its entire price while a forfeited one contributed nothing at
 * all -- both wrong, and in opposite directions.
 */
export function summarise(totals: WindowTotals): FeedSummary {
  return {
    events: totals.events,
    noShows: totals.noShows,
    lostValueFils: Math.max(
      0,
      totals.serviceValueFils - totals.depositsKeptFils,
    ),
    depositsKeptFils: totals.depositsKeptFils,
    recovered: totals.recovered,
  };
}

/**
 * The reasons breakdown, biggest first.
 *
 * Free text, so it is grouped on the trimmed, case-folded value and reported
 * with the spelling that occurred most. A reason nobody gave is absent rather
 * than a zero row.
 */
export interface ReasonRow {
  readonly reason: string;
  readonly count: number;
  /** Service value of the events given this reason, in fils. */
  readonly valueFils: number;
}

export function groupReasons(
  rows: readonly {
    readonly reason: string | null;
    readonly priceFils: number;
  }[],
): ReasonRow[] {
  const byKey = new Map<
    string,
    { spellings: Map<string, number>; count: number; valueFils: number }
  >();

  for (const r of rows) {
    const text = (r.reason ?? '').trim();
    const shown = text === '' ? 'No reason given' : text;
    const key = shown.toLowerCase();
    const bucket = byKey.get(key) ?? {
      spellings: new Map<string, number>(),
      count: 0,
      valueFils: 0,
    };
    bucket.spellings.set(shown, (bucket.spellings.get(shown) ?? 0) + 1);
    bucket.count += 1;
    bucket.valueFils += r.priceFils;
    byKey.set(key, bucket);
  }

  return [...byKey.values()]
    .map((b) => ({
      reason: commonest(b.spellings),
      count: b.count,
      valueFils: b.valueFils,
    }))
    .sort((a, b) => b.count - a.count || b.valueFils - a.valueFils);
}

function commonest(spellings: ReadonlyMap<string, number>): string {
  let best = '';
  let bestN = -1;
  for (const [text, n] of spellings) {
    if (n > bestN) {
      best = text;
      bestN = n;
    }
  }
  return best;
}
