/**
 * A series is a DEFINITION. An occurrence is an ordinary booking with a link
 * back to it.
 *
 * This module answers one question and nothing else: on which trading days
 * does this series want a visit? It does not know whether those days are
 * bookable — that is the availability engine's job at materialisation, and it
 * is the reason the horizon exists at all.
 *
 * Dates are 'YYYY-MM-DD' trading-day strings, the same currency the waitlist
 * and every repository already speak. All arithmetic is UTC: the branch is
 * UTC+4 with no DST, so a trading day is a calendar day and nothing drifts.
 */

/** A trading day, 'YYYY-MM-DD'. */
export type TradingDay = string;

/** 0 = Sunday, 6 = Saturday. Matches Date.getUTCDay. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * How far occurrences are materialised: ten weeks of concrete,
 * conflict-checked bookings, topped up nightly.
 *
 * An open-ended series must never have an infinite tail, and it must never
 * have a short one either — the desk needs to see far enough ahead to spot a
 * clash while there is still time to fix it.
 */
export const SERIES_HORIZON_DAYS = 70;

/** The booking horizon. Starts beyond this are not offered at all. */
export const BOOKING_HORIZON_DAYS = 90;

/**
 * A runaway guard, not a rule.
 *
 * Expansion always walks from the anchor so the ordinal is honest, which
 * means a two-year-old weekly series really does generate a hundred-odd
 * candidates before reaching today. That is cheap. An unbounded loop from a
 * malformed pattern is not, so the walk stops rather than hangs.
 */
const MAX_CANDIDATES = 4000;

export type Pattern =
  /** Every week on selected days. "Tuesday and Thursday at 18:00." */
  | { readonly kind: 'weekly'; readonly weekdays: readonly Weekday[] }
  /**
   * Every N weeks, on the anchor's own weekday.
   *
   * The weekday is NOT a separate field. It is already in the anchor, and two
   * places to say which day it is means one of them eventually disagrees.
   */
  | { readonly kind: 'every_n_weeks'; readonly weeks: number }
  /** The 15th of every month. */
  | { readonly kind: 'monthly_on_date'; readonly dayOfMonth: number }
  /** A hand-picked list, for bridal work and treatment courses. */
  | { readonly kind: 'custom'; readonly dates: readonly TradingDay[] };

export type EndCondition =
  | { readonly kind: 'never' }
  | { readonly kind: 'on_date'; readonly date: TradingDay }
  | { readonly kind: 'after_count'; readonly count: number };

export interface SeriesDefinition {
  /** The first day the series may land on. Also fixes the weekday. */
  readonly anchor: TradingDay;
  /** Minute of day, from the grid. 1080 is 18:00. */
  readonly startMin: number;
  readonly pattern: Pattern;
  readonly end: EndCondition;
}

export interface Occurrence {
  readonly date: TradingDay;
  readonly startMin: number;
  /** 0-based ordinal within the whole series, counted from the anchor. */
  readonly index: number;
  /**
   * The month had no such date and the occurrence fell back to the last day.
   *
   * Carried so the panel can chip it. A monthly series on the 31st silently
   * landing on the 30th is the kind of thing a client notices before the desk
   * does.
   */
  readonly movedFromDayOfMonth: number | null;
}

export interface Expansion {
  readonly occurrences: readonly Occurrence[];
  /** The horizon line the series panel shows. Inclusive. */
  readonly horizonEnd: TradingDay;
  /** The series ran out inside the horizon: there is nothing more to come. */
  readonly complete: boolean;
  readonly explanation: string;
}

export interface ExpansionWindow {
  /** Inclusive lower bound; occurrences before it are counted, not returned. */
  readonly from: TradingDay;
  readonly horizonDays?: number;
}

// ---------------------------------------------------------------- calendar

/** Split a trading day into its parts. Invalid input throws: it is a bug. */
function parts(day: TradingDay): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) {
    throw new Error(`Not a trading day: ${day}`);
  }
  return {
    y: Number(match[1]),
    m: Number(match[2]),
    d: Number(match[3]),
  };
}

function fromUtc(ms: number): TradingDay {
  return new Date(ms).toISOString().slice(0, 10);
}

function utcOf(day: TradingDay): number {
  const { y, m, d } = parts(day);
  return Date.UTC(y, m - 1, d);
}

export function addDays(day: TradingDay, n: number): TradingDay {
  return fromUtc(utcOf(day) + n * 86_400_000);
}

export function weekdayOf(day: TradingDay): Weekday {
  return new Date(utcOf(day)).getUTCDay() as Weekday;
}

/** Whole days from a to b. Negative when b is earlier. */
export function daysBetween(a: TradingDay, b: TradingDay): number {
  return Math.round((utcOf(b) - utcOf(a)) / 86_400_000);
}

/** Day 0 of the next month is the last day of this one. */
export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

// ---------------------------------------------------------------- expansion

/**
 * Every day the series wants, from the anchor up to the horizon.
 *
 * The walk ALWAYS starts at the anchor, even when the caller only wants the
 * next ten weeks. It is the only way "the twelfth of twenty" stays true when
 * the nightly job tops the series up eighteen months later, and it is the
 * only way an `after_count` series stops in the right place.
 */
export function expandSeries(
  def: SeriesDefinition,
  window: ExpansionWindow,
): Expansion {
  const horizonDays = window.horizonDays ?? SERIES_HORIZON_DAYS;
  const horizonEnd = addDays(window.from, horizonDays);

  const occurrences: Occurrence[] = [];
  let index = 0;
  let complete = false;
  let exhausted = false;

  for (const candidate of candidates(def)) {
    if (index >= MAX_CANDIDATES) {
      exhausted = true;
      break;
    }

    // The end condition is checked against the ORDINAL and the DATE, before
    // the horizon, because a series that has ended has ended everywhere.
    if (def.end.kind === 'after_count' && index >= def.end.count) {
      complete = true;
      break;
    }
    if (def.end.kind === 'on_date' && candidate.date > def.end.date) {
      complete = true;
      break;
    }

    if (candidate.date > horizonEnd) break;

    if (candidate.date >= window.from) {
      occurrences.push({
        date: candidate.date,
        startMin: def.startMin,
        index,
        movedFromDayOfMonth: candidate.movedFromDayOfMonth,
      });
    }
    index += 1;
  }

  // A custom or counted series can run out mid-walk without tripping either
  // branch above, so completion is also "the generator stopped first".
  if (!complete && !exhausted) {
    const last = occurrences[occurrences.length - 1];
    if (last !== undefined && lastPossible(def, index)) complete = true;
  }

  return {
    occurrences,
    horizonEnd,
    complete,
    explanation: explain(def, occurrences, horizonEnd, complete),
  };
}

/** Did the pattern itself run dry, rather than the horizon cutting it off? */
function lastPossible(def: SeriesDefinition, produced: number): boolean {
  if (def.pattern.kind === 'custom') {
    return produced >= def.pattern.dates.length;
  }
  return def.end.kind === 'after_count' && produced >= def.end.count;
}

interface Candidate {
  readonly date: TradingDay;
  readonly movedFromDayOfMonth: number | null;
}

/** The pattern as a lazy stream of dates, ascending, starting at the anchor. */
function* candidates(def: SeriesDefinition): Generator<Candidate> {
  const p = def.pattern;

  switch (p.kind) {
    case 'weekly': {
      if (p.weekdays.length === 0) return;
      const wanted = [...new Set(p.weekdays)].sort((a, b) => a - b);
      // Back up to the Sunday of the anchor's week, then walk weeks. Dates
      // before the anchor are skipped rather than emitted.
      let weekStart = addDays(def.anchor, -weekdayOf(def.anchor));
      for (let guard = 0; guard < MAX_CANDIDATES; guard += 1) {
        for (const wd of wanted) {
          const date = addDays(weekStart, wd);
          if (date >= def.anchor) yield { date, movedFromDayOfMonth: null };
        }
        weekStart = addDays(weekStart, 7);
      }
      return;
    }

    case 'every_n_weeks': {
      const step = Math.trunc(p.weeks);
      if (step < 1) return;
      let date = def.anchor;
      for (let guard = 0; guard < MAX_CANDIDATES; guard += 1) {
        yield { date, movedFromDayOfMonth: null };
        date = addDays(date, step * 7);
      }
      return;
    }

    case 'monthly_on_date': {
      const wanted = Math.trunc(p.dayOfMonth);
      if (wanted < 1 || wanted > 31) return;
      const start = parts(def.anchor);
      let y = start.y;
      let m = start.m;
      for (let guard = 0; guard < MAX_CANDIDATES; guard += 1) {
        const available = daysInMonth(y, m);
        // MONTH-END FALLBACK. The 31st of a 30-day month is the 30th, not a
        // skipped visit: a client on a monthly cadence expects twelve visits
        // a year, not seven.
        const landed = Math.min(wanted, available);
        const date = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(landed).padStart(2, '0')}`;
        if (date >= def.anchor) {
          yield {
            date,
            movedFromDayOfMonth: landed === wanted ? null : wanted,
          };
        }
        m += 1;
        if (m > 12) {
          m = 1;
          y += 1;
        }
      }
      return;
    }

    case 'custom': {
      const dates = [...new Set(p.dates)].filter((d) => d >= def.anchor).sort();
      for (const date of dates) yield { date, movedFromDayOfMonth: null };
      return;
    }
  }
}

function explain(
  def: SeriesDefinition,
  occurrences: readonly Occurrence[],
  horizonEnd: TradingDay,
  complete: boolean,
): string {
  if (occurrences.length === 0) {
    return complete
      ? 'The series has ended; there are no further occurrences.'
      : `Nothing falls inside the horizon, which runs to ${horizonEnd}.`;
  }

  const moved = occurrences.filter(
    (o) => o.movedFromDayOfMonth !== null,
  ).length;
  const movedNote =
    moved === 0
      ? ''
      : ` ${moved} ${moved === 1 ? 'occurrence was' : 'occurrences were'} moved to the last day of a shorter month.`;

  const tail = complete
    ? 'That is the whole of the remaining series.'
    : `The calendar is real to ${horizonEnd}.`;

  const noun = occurrences.length === 1 ? 'occurrence' : 'occurrences';
  return `${occurrences.length} ${noun} from ${def.anchor}. ${tail}${movedNote}`;
}
