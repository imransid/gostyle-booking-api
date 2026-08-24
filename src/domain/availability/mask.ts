import { SLOTS, toSlot, durationToSlots } from './grid';

/**
 * A day of availability for one professional, as a 144-bit integer.
 *
 * Bit i set means "slot i is available". Asking "is this professional free
 * for a 105-minute chain starting at 15:00" becomes a handful of shifts and
 * ANDs instead of a scan or a query per slot. That is what keeps a full day
 * of offers inside the 800ms budget.
 */
export type Mask = bigint;

const ONE = 1n;

/** Every slot set. The universe. */
export const ALL: Mask = (ONE << BigInt(SLOTS)) - ONE;

/** No slot set. */
export const NONE: Mask = 0n;

/**
 * Bits [from, to), clamped to the trading day.
 *
 * Half-open on purpose, matching the '[)' bound on the exclusion constraint.
 * A booking ending at slot 21 and one starting at slot 21 do not overlap.
 */
export function rangeMask(from: number, to: number): Mask {
  const a = Math.max(0, Math.trunc(from));
  const b = Math.min(SLOTS, Math.trunc(to));
  if (b <= a) return NONE;
  return ((ONE << BigInt(b - a)) - ONE) << BigInt(a);
}

/** Bits covering [fromMinute, toMinute) of the trading day. */
export function rangeMaskMinutes(fromMinute: number, toMinute: number): Mask {
  return rangeMask(toSlot(fromMinute), toSlot(toMinute));
}

/** Is slot i available in this mask? */
export function bitAt(mask: Mask, slot: number): boolean {
  if (slot < 0 || slot >= SLOTS) return false;
  return ((mask >> BigInt(slot)) & ONE) === ONE;
}

/** Set slot i. */
export function setBit(mask: Mask, slot: number): Mask {
  if (slot < 0 || slot >= SLOTS) return mask;
  return mask | (ONE << BigInt(slot));
}

/** Clear slot i. */
export function clearBit(mask: Mask, slot: number): Mask {
  if (slot < 0 || slot >= SLOTS) return mask;
  return mask & ~(ONE << BigInt(slot));
}

/** How many slots are available. Brian Kernighan: one iteration per set bit. */
export function popcount(mask: Mask): number {
  let m = mask;
  let count = 0;
  while (m !== 0n) {
    m &= m - ONE;
    count += 1;
  }
  return count;
}

/**
 * Where a free run of at least `slots` consecutive slots BEGINS.
 *
 * Naive approach: for each of 144 slots, walk forward counting free slots.
 * That is 144 x 21 = ~3000 checks for a 105-minute chain, per professional.
 *
 * The trick: `mask & (mask >> 1)` sets bit i only when slots i AND i+1 are
 * both free. So one AND turns "runs of 1" into "runs of 2". Do it again
 * with a shift of 2 and you have runs of 4. Then 8. Then 16.
 *
 * Doubling means a 21-slot run takes 5 operations, not 3000.
 *
 * The Math.min(step, slots - step) guard stops it overshooting: for
 * slots = 3 it does 1 then 1, never 1 then 2.
 */
export function runsAtLeast(mask: Mask, slots: number): Mask {
  if (slots <= 1) return mask;
  let result = mask;
  let covered = 1;
  while (covered < slots) {
    const step = Math.min(covered, slots - covered);
    result &= result >> BigInt(step);
    covered += step;
  }
  return result;
}

/** Same, expressed in minutes. 105 minutes becomes 21 slots. */
export function runsAtLeastMinutes(mask: Mask, durationMin: number): Mask {
  return runsAtLeast(mask, durationToSlots(durationMin));
}

/** Every set slot, ascending. Use for turning a feasible set into offers. */
export function toSlots(mask: Mask): number[] {
  const out: number[] = [];
  for (let i = 0; i < SLOTS; i++) {
    if (bitAt(mask, i)) out.push(i);
  }
  return out;
}

/** Build a mask from explicit slot indices. Test helper, mostly. */
export function fromSlots(slots: readonly number[]): Mask {
  let m = NONE;
  for (const s of slots) m = setBit(m, s);
  return m;
}

/** The lowest set slot, or null when the mask is empty. */
export function firstSlot(mask: Mask): number | null {
  if (mask === NONE) return null;
  for (let i = 0; i < SLOTS; i++) {
    if (bitAt(mask, i)) return i;
  }
  return null;
}

/** Debug view: 144 characters of '#' and '.'. Never used in production paths. */
export function render(mask: Mask): string {
  let out = '';
  for (let i = 0; i < SLOTS; i++) out += bitAt(mask, i) ? '#' : '.';
  return out;
}
