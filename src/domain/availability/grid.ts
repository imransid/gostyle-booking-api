/**
 * The trading day, as a grid.
 *
 * Everything in the availability engine works in minutes-from-midnight,
 * never Date objects. 600 is 10:00. 1320 is 22:00. The day is cut into
 * 5-minute slots, so slot 0 is 10:00 and slot 143 is 21:55.
 *
 * Why not Date: a Date carries a timezone, a calendar, and leap seconds,
 * none of which the engine needs. An integer is comparable, hashable,
 * and shiftable. That is the whole job.
 */

/** First bookable minute of the trading day. 600 = 10:00. */
export const DAY_START_MIN = 600;

/** Last minute of the trading day. 1320 = 22:00. Exclusive as a start. */
export const DAY_END_MIN = 1320;

/** Grid resolution. Every mask bit is this many minutes. */
export const SLOT_MIN = 5;

/** (1320 - 600) / 5 = 144 bits per professional per day. */
export const SLOTS = (DAY_END_MIN - DAY_START_MIN) / SLOT_MIN;

/** Guard on each end of a hands-free processing band. */
export const PROCESSING_GUARD_MIN = 5;

/** A gap under this is unsellable and counts as stranded time. */
export const MIN_SELLABLE_MIN = 25;

/** Minimum distance between two offers in the three-offer policy. */
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
  return Math.floor((minuteOfDay - DAY_START_MIN) / SLOT_MIN);
}

/** Slot index back to minute of day. toMin(60) === 900, which is 15:00. */
export function toMin(slot: number): number {
  return DAY_START_MIN + SLOT_MIN * slot;
}

/** How many slots a duration occupies. 105 minutes is 21 slots. */
export function durationToSlots(durationMin: number): number {
  return Math.ceil(durationMin / SLOT_MIN);
}

/** True when the minute falls inside the trading day. */
export function isInsideDay(minuteOfDay: number): boolean {
  return minuteOfDay >= DAY_START_MIN && minuteOfDay < DAY_END_MIN;
}

/** 900 -> "15:00". Display only; the engine never reads this back. */
export function formatMinute(minuteOfDay: number): string {
  const h = Math.floor(minuteOfDay / 60);
  const m = minuteOfDay % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
