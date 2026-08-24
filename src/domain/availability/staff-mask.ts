import { Mask, NONE, rangeMask } from './mask';
import { SLOT_MIN, PROCESSING_GUARD_MIN, toSlot } from './grid';

/**
 * Setup time before a job and teardown time after it. Real reservations on
 * the calendar, not display padding.
 *
 * Colour station: 10 before, 20 after.
 * Styling chair:   5 before, 10 after.
 */
export interface BufferClaims {
  readonly preMin: number;
  readonly postMin: number;
}

export const NO_CLAIMS: BufferClaims = { preMin: 0, postMin: 0 };

/**
 * A hands-free window inside a service, measured from the service's own start.
 * A 125-minute colour with a band of { fromMin: 45, toMin: 85 } leaves the
 * professional free for 40 minutes in the middle while the dye develops.
 */
export interface ProcessingBand {
  readonly fromMin: number;
  readonly toMin: number;
}

/** Something already on this professional's calendar. */
export interface StaffBooking {
  readonly startMin: number;
  readonly endMin: number;
  readonly claims: BufferClaims;
  readonly processing?: ProcessingBand;
  /**
   * Set when the customer sits in the HIGH risk band. Ignored by availability
   * entirely; it only nudges ranking, so a risky client never blocks a slot.
   */
  readonly highRisk?: boolean;
}

/** A published working window. Breaks and time off are passed as bookings. */
export interface Shift {
  readonly startMin: number;
  readonly endMin: number;
}

/** The visit we are trying to place. */
export interface Chain {
  readonly durationMin: number;
  readonly claims: BufferClaims;
}

/**
 * THE LARGER CLAIM WINS.
 *
 * When two jobs sit next to each other on the same professional, the gap
 * between them is the larger of the two neighbouring claims, never the sum.
 *
 * A colour teardown of 20 minutes next to a styling setup of 5 minutes needs
 * 20 minutes of separation, not 25.
 *
 * Summing invents five minutes nobody needs. Repeated across a full diary it
 * quietly removes sellable capacity, and the loss is invisible because every
 * individual booking still looks correct.
 */
export function gapBetween(claimA: number, claimB: number): number {
  return Math.max(claimA, claimB);
}

/** Minutes to slots, rounding up. Never offers a slot the job cannot fit. */
function slotsFor(minutes: number): number {
  return Math.ceil(minutes / SLOT_MIN);
}

/**
 * Minute to slot, rounding UP.
 *
 * Used for the far edge of a blocked region. If a booking ends at 16:02,
 * flooring would give the 16:00 slot and allow a start before the booking
 * has actually finished. Rounding up blocks slightly more, which is the
 * safe direction. On grid-aligned data the two agree exactly.
 */
function toSlotCeil(minuteOfDay: number): number {
  return Math.ceil((minuteOfDay - 600) / SLOT_MIN);
}

/**
 * Every legal START for one chain, on one professional, for one day.
 *
 * The result is a mask of START POSITIONS, not free time. Anything ANDed
 * with it afterwards (capacity, channel grain, lead time) must also be a
 * start-position mask.
 *
 * Three parts, in this order:
 *   1. base    : starts inside the shift where the whole chain still finishes
 *   2. blocked : starts that would collide with existing work, widened by
 *                the larger neighbouring claim
 *   3. carve   : starts given back inside a hands-free processing band
 */
export function startMask(
  shift: Shift,
  bookings: readonly StaffBooking[],
  chain: Chain,
  options: { readonly overlapAllowed: boolean },
): Mask {
  const chainSlots = slotsFor(chain.durationMin);

  // 1. The chain must FINISH before the shift ends, not merely start inside it.
  //    +1 because rangeMask is exclusive at the far end and the last legal
  //    start is exactly shiftEnd minus the chain.
  const base = rangeMask(
    toSlot(shift.startMin),
    toSlotCeil(shift.endMin) - chainSlots + 1,
  );
  if (base === NONE) return NONE;

  let blocked: Mask = NONE;

  for (const b of bookings) {
    // 2a. Starts too late: our chain plus our teardown would run into their setup.
    //     We need  t + duration + gap <= their start.
    const gapBefore = gapBetween(chain.claims.postMin, b.claims.preMin);
    const lo = toSlot(b.startMin) - chainSlots - slotsFor(gapBefore) + 1;

    // 2b. Starts too early: their teardown would run into our setup.
    //     We need  t >= their end + gap. rangeMask is exclusive at hi, so hi
    //     is the first legal start again.
    const gapAfter = gapBetween(chain.claims.preMin, b.claims.postMin);
    const hi = toSlotCeil(b.endMin) + slotsFor(gapAfter);

    let blockedByThis = rangeMask(lo, hi);

    // 3. Carve the hands-free band back out, PER BOOKING, before the union.
    //    Doing it after the union would let this booking's band wrongly
    //    unblock time that a different booking legitimately occupies.
    if (b.processing !== undefined && options.overlapAllowed) {
      const bandOpen = b.startMin + b.processing.fromMin + PROCESSING_GUARD_MIN;
      const bandShut = b.startMin + b.processing.toMin - PROCESSING_GUARD_MIN;

      const first = toSlotCeil(bandOpen);
      const last = toSlot(bandShut) - chainSlots;

      if (last >= first) {
        blockedByThis &= ~rangeMask(first, last + 1);
      }
    }

    blocked |= blockedByThis;
  }

  return base & ~blocked;
}

/** Total staff-busy minutes for an ordered chain of services. */
export function chainDuration(durations: readonly number[]): number {
  return durations.reduce((a, b) => a + b, 0);
}

/**
 * The claims a whole chain presents to its neighbours: the setup of the
 * first service in front, the teardown of the last service behind.
 * Interior claims are internal to the chain and never face outward.
 */
export function chainClaims(claims: readonly BufferClaims[]): BufferClaims {
  const first = claims[0];
  const last = claims[claims.length - 1];
  if (first === undefined || last === undefined) return NO_CLAIMS;
  return { preMin: first.preMin, postMin: last.postMin };
}
