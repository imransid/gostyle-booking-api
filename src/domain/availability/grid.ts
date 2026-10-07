/**
 * The clock day, as a grid, and the trading window that sits on it.
 *
 * Everything in the availability engine works in minutes-from-midnight,
 * never Date objects. 600 is 10:00. 1320 is 22:00. The day is cut into
 * 5-minute slots, so slot 0 is 00:00 and slot 287 is 23:55.
 *
 * Why not Date: a Date carries a timezone, a calendar, and leap seconds,
 * none of which the engine needs. An integer is comparable, hashable,
 * and shiftable. That is the whole job.
 *
 * TWO IDEAS, KEPT APART. The GRID is the space the bit maths runs on, and it
 * is the same for every branch: the whole clock day. The TRADING WINDOW is
 * the hours one branch sells on one date, and it is data (DayContext.window).
 * They used to be one pair of constants, DAY_START_MIN and DAY_END_MIN, which
 * fixed every branch to 10:00-22:00 -- a salon that closes at 23:00 could not
 * sell its last hour. Those constants are gone on purpose rather than given
 * new values: every place that read them had to say which of the two it
 * meant, and the compiler is what made it say.
 */

/** First minute of the grid. Midnight, for every branch. */
export const GRID_START_MIN = 0;

/** End of the grid, exclusive. 1440 = 24:00. */
export const GRID_END_MIN = 1440;

/** Grid resolution. Every mask bit is this many minutes. */
export const SLOT_MIN = 5;

/** (1440 - 0) / 5 = 288 bits per professional per day. */
export const SLOTS = (GRID_END_MIN - GRID_START_MIN) / SLOT_MIN;

/**
 * The hours one branch trades on one date, as minutes of that date.
 *
 * Half-open, like everything else here: a start must be at or after
 * `openMin`, and a chain must END at or before `closeMin`. Both lie on the
 * grid, so 00:00-24:00 is a branch that trades all day.
 *
 * PAST MIDNIGHT IS NOT REPRESENTABLE, deliberately. A Friday that trades
 * 18:00-02:00 needs minutes past 1440 on Friday's trading day, and nothing
 * else in this service (the diary, the minute columns, the day's masks) can
 * hold those yet. Whoever supplies a window caps the close at 24:00.
 */
export interface TradingWindow {
  readonly openMin: number;
  readonly closeMin: number;
}

/**
 * The hours a branch trades when nobody has said otherwise: 10:00-22:00.
 *
 * Every branch, today. Two kinds of reader use it directly, and both are
 * places per-branch hours still have to reach:
 *
 *   - loading a day (the fixture, and DbBookingContext), which puts it on
 *     DayContext.window for the engine to use;
 *   - the edges that do not load a day at all: the request validators,
 *     `/busy`, `/v1/settings`, and the series and group checks that run
 *     before one is loaded.
 *
 * Code that already holds a DayContext must use `day.window`, not this.
 */
export const DEFAULT_TRADING_WINDOW: TradingWindow = {
  openMin: 600,
  closeMin: 1320,
};

/** Guard on each end of a hands-free processing band. */
export const PROCESSING_GUARD_MIN = 5;

/** A gap under this is unsellable and counts as stranded time. */
export const MIN_SELLABLE_MIN = 25;

/**
 * Minimum distance between two offers in the three-offer policy.
 *
 * The three must be genuinely different choices rather than three faces of
 * the same half hour. Ranking uses it to space the offers, and the series
 * ladder uses it to space the alternatives on a needs-attention occurrence:
 * the same reasoning, so the same number, defined once.
 */
export const OFFER_SPACING_MIN = 25;

/** Per-professional daily booking cap. */
export const DAILY_BOOKING_CAP = 8;

/**
 * Minute of day to slot index.
 *
 * Can return a value outside [0, SLOTS). That is deliberate: callers pass
 * the result to rangeMask, which clamps. Returning null here would force
 * a null check at forty call sites for a case the mask handles for free.
 */
export function toSlot(minuteOfDay: number): number {
  return Math.floor((minuteOfDay - GRID_START_MIN) / SLOT_MIN);
}

/** Slot index back to minute of day. toMin(180) === 900, which is 15:00. */
export function toMin(slot: number): number {
  return GRID_START_MIN + SLOT_MIN * slot;
}

/** How many slots a duration occupies. 105 minutes is 21 slots. */
export function durationToSlots(durationMin: number): number {
  return Math.ceil(durationMin / SLOT_MIN);
}

/** True when a START at this minute falls inside the trading window. */
export function isInsideWindow(
  minuteOfDay: number,
  window: TradingWindow,
): boolean {
  return minuteOfDay >= window.openMin && minuteOfDay < window.closeMin;
}

/** 900 -> "15:00". Display only; the engine never reads this back. */
export function formatMinute(minuteOfDay: number): string {
  const h = Math.floor(minuteOfDay / 60);
  const m = minuteOfDay % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- parts of day

/**
 * The clock day in three blocks: before 14:00, before 18:00, and after.
 *
 * "The same part of the day" is rung three of the disruption ladder, and the
 * documentation never defines it. These are the version a customer can be
 * told without explanation: a moved booking is still their morning.
 *
 * FIXED CLOCK TIMES, not thirds of the branch's hours. They are exactly the
 * three four-hour blocks the old fixed 10:00-22:00 day produced, so nothing
 * moved when the day stopped being fixed. And they stay put when a branch's
 * hours change: thirds of the window would make "evening" start at a
 * different time on a late Thursday, and a customer moved "within their
 * evening" would not recognise it.
 *
 * ONE definition, here, because a second one in the ladder would drift.
 */
export type PartOfDay = 'morning' | 'afternoon' | 'evening';

/** Afternoon starts here. 840 = 14:00. */
export const AFTERNOON_FROM_MIN = 840;

/** Evening starts here. 1080 = 18:00. */
export const EVENING_FROM_MIN = 1080;

export function partOfDay(minuteOfDay: number): PartOfDay {
  if (minuteOfDay < AFTERNOON_FROM_MIN) return 'morning';
  if (minuteOfDay < EVENING_FROM_MIN) return 'afternoon';
  return 'evening';
}

export function samePartOfDay(a: number, b: number): boolean {
  return partOfDay(a) === partOfDay(b);
}
