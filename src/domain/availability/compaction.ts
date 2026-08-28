/**
 * Closing the slivers a day accumulates.
 *
 * Cancellations and moves leave gaps too small to sell. Twenty minutes
 * between two colours is not a booking anybody can take; it is time the
 * salon has already paid for and cannot use. The planner finds those gaps
 * and proposes a small number of moves that close them.
 *
 * EVERY MOVE IS A CONSENT MOVE. Nothing here applies anything: it produces a
 * proposal a human takes to the customer, and each move is re-validated at
 * apply time because the diary will have moved on by then.
 *
 * The acceptance rule is what keeps this honest. A move is kept only if it
 * reduces stranded minutes by MORE than four, so the planner cannot justify
 * ringing a customer to save ninety seconds.
 */

import {
  MIN_SELLABLE_MIN,
  SLOT_MIN,
  DAY_START_MIN,
  DAY_END_MIN,
  formatMinute,
} from './grid';

/** At most half an hour, in five-minute steps. */
export const MAX_MOVE_MIN = 30;

/** Moves land on the grid, like everything else. */
export const MOVE_STEP_MIN = SLOT_MIN;

/** At most three moves per plan. */
export const MAX_MOVES = 3;

/** A move must beat this to be worth making. Strictly greater. */
export const MIN_STRANDED_GAIN_MIN = 4;

/**
 * Why a booking may not be moved.
 *
 * Group and recurring occurrences are excluded because their timing carries
 * meaning beyond the diary: a party arrives together, and a standing client
 * built their week around the hour. Compaction is a convenience for the
 * salon, and it does not get to outrank either.
 */
export type Ineligibility =
  'not_confirmed' | 'group_lane' | 'series_occurrence';

export interface DiaryBooking {
  readonly bookingId: string;
  readonly code: string;
  readonly staffId: string;
  readonly startMin: number;
  readonly endMin: number;
  /** Set when this booking may not be moved, and why. */
  readonly ineligible?: Ineligibility;
}

export interface Gap {
  readonly staffId: string;
  readonly fromMin: number;
  readonly toMin: number;
  readonly minutes: number;
}

export interface ProposedMove {
  readonly bookingId: string;
  readonly code: string;
  readonly staffId: string;
  readonly fromStartMin: number;
  readonly toStartMin: number;
  readonly deltaMin: number;
  /** Stranded minutes removed from this professional's day. */
  readonly gainMin: number;
  /** What the desk reads to the customer. */
  readonly note: string;
}

export interface CompactionPlan {
  readonly moves: readonly ProposedMove[];
  readonly strandedBeforeMin: number;
  readonly strandedAfterMin: number;
  readonly gainMin: number;
  readonly slivers: readonly Gap[];
  readonly explanation: string;
}

/** A gap this small cannot be sold. */
export function isSliver(minutes: number): boolean {
  return minutes > 0 && minutes < MIN_SELLABLE_MIN;
}

/**
 * Every unsellable gap between consecutive bookings.
 *
 * Between bookings only. The run before the first booking and after the last
 * are the shift's own edges, and nothing the planner does to one booking can
 * close them without simply moving the edge somewhere else.
 */
export function slivers(bookings: readonly DiaryBooking[]): Gap[] {
  const byStaff = new Map<string, DiaryBooking[]>();
  for (const b of bookings) {
    const list = byStaff.get(b.staffId) ?? [];
    list.push(b);
    byStaff.set(b.staffId, list);
  }

  const found: Gap[] = [];
  for (const [staffId, list] of byStaff) {
    const sorted = [...list].sort((a, b) => a.startMin - b.startMin);
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      const next = sorted[i];
      if (prev === undefined || next === undefined) continue;
      const minutes = next.startMin - prev.endMin;
      if (isSliver(minutes)) {
        found.push({
          staffId,
          fromMin: prev.endMin,
          toMin: next.startMin,
          minutes,
        });
      }
    }
  }
  return found.sort(
    (a, b) => a.fromMin - b.fromMin || a.staffId.localeCompare(b.staffId),
  );
}

/** Total unsellable minutes across the whole diary. */
export function strandedMinutes(bookings: readonly DiaryBooking[]): number {
  return slivers(bookings).reduce((n, g) => n + g.minutes, 0);
}

/**
 * Propose the moves that close the most stranded time.
 *
 * Greedy and re-measured after every pick, because closing one gap changes
 * every gap around it. Trying to choose all three at once against the
 * original diary would propose three moves that each looked good alone and
 * fought each other in practice.
 */
export function planCompaction(
  bookings: readonly DiaryBooking[],
): CompactionPlan {
  const before = strandedMinutes(bookings);

  let working = [...bookings];
  const moves: ProposedMove[] = [];
  const alreadyMoved = new Set<string>();

  while (moves.length < MAX_MOVES) {
    const best = bestMove(working, alreadyMoved);
    if (best === null) break;

    moves.push(best);
    alreadyMoved.add(best.bookingId);
    working = applyMove(working, best);
  }

  const after = strandedMinutes(working);

  return {
    moves,
    strandedBeforeMin: before,
    strandedAfterMin: after,
    gainMin: before - after,
    slivers: slivers(bookings),
    explanation: explain(before, after, moves.length),
  };
}

/**
 * The single best move available right now, or null when none is worth it.
 *
 * DIRECTIONAL, and that is the whole design. For each sliver there are
 * exactly two ways to close it: pull the later booking earlier, or push the
 * earlier booking later. Searching every offset in range instead found a
 * third option nobody asked for -- widening a 20-minute gap to 25 so it
 * became sellable, which removes the stranded minutes on paper while moving
 * a customer for a gap that is still there. Compaction closes gaps.
 */
function bestMove(
  bookings: readonly DiaryBooking[],
  alreadyMoved: ReadonlySet<string>,
): ProposedMove | null {
  const baseline = strandedMinutes(bookings);
  let best: ProposedMove | null = null;

  for (const gap of slivers(bookings)) {
    const before = bookings.find(
      (b) => b.staffId === gap.staffId && b.endMin === gap.fromMin,
    );
    const after = bookings.find(
      (b) => b.staffId === gap.staffId && b.startMin === gap.toMin,
    );

    // The later booking pulled earlier, then the earlier one pushed later.
    // Both close the same gap; the order here is the order the rule lists.
    const options: { booking: DiaryBooking | undefined; sign: number }[] = [
      { booking: after, sign: -1 },
      { booking: before, sign: +1 },
    ];

    for (const { booking, sign } of options) {
      if (booking === undefined) continue;
      // NEVER MORE THAN ONE MOVE PER BOOKING. Two moves on one booking is
      // two conversations with the same customer about the same appointment.
      if (alreadyMoved.has(booking.bookingId)) continue;
      if (booking.ineligible !== undefined) continue;

      // Never further than the gap itself: past that it stops closing
      // anything and starts eating into the neighbour.
      const reach = Math.min(MAX_MOVE_MIN, gap.minutes);

      for (let step = MOVE_STEP_MIN; step <= reach; step += MOVE_STEP_MIN) {
        const delta = sign * step;
        const candidate = shift(booking, delta);

        // INSIDE THE TRADING DAY. Without this the planner happily proposed
        // 09:55 for a 10:00 booking, because moving it earlier closed the
        // gap and nothing said the salon was shut. A move out of the day is
        // not a smaller move, it is a wrong one.
        if (candidate.startMin < DAY_START_MIN) continue;
        if (candidate.endMin > DAY_END_MIN) continue;
        if (overlapsAnything(bookings, candidate)) continue;

        const gain = baseline - strandedMinutes(replace(bookings, candidate));
        // STRICTLY greater than four. Cosmetic shuffling is rejected.
        if (gain <= MIN_STRANDED_GAIN_MIN) continue;

        const better =
          best === null ||
          gain > best.gainMin ||
          (gain === best.gainMin && Math.abs(delta) < Math.abs(best.deltaMin));

        if (better) {
          best = {
            bookingId: booking.bookingId,
            code: booking.code,
            staffId: booking.staffId,
            fromStartMin: booking.startMin,
            toStartMin: candidate.startMin,
            deltaMin: delta,
            gainMin: gain,
            note:
              `${booking.code}: ${formatMinute(booking.startMin)} to ` +
              `${formatMinute(candidate.startMin)} (${delta > 0 ? '+' : ''}${delta} min), ` +
              `freeing ${gain} stranded minutes.`,
          };
        }
      }
    }
  }

  return best;
}

function shift(b: DiaryBooking, delta: number): DiaryBooking {
  return { ...b, startMin: b.startMin + delta, endMin: b.endMin + delta };
}

function replace(
  bookings: readonly DiaryBooking[],
  moved: DiaryBooking,
): DiaryBooking[] {
  return bookings.map((b) => (b.bookingId === moved.bookingId ? moved : b));
}

function applyMove(
  bookings: readonly DiaryBooking[],
  move: ProposedMove,
): DiaryBooking[] {
  return bookings.map((b) =>
    b.bookingId === move.bookingId
      ? {
          ...b,
          startMin: move.toStartMin,
          endMin: move.toStartMin + (b.endMin - b.startMin),
        }
      : b,
  );
}

/**
 * Would this land on top of the same professional's other work?
 *
 * The planner only checks the professional's own diary. Chairs, buffers and
 * shifts are the engine's business, and every move is re-validated against
 * the real masks before it is applied.
 */
function overlapsAnything(
  bookings: readonly DiaryBooking[],
  candidate: DiaryBooking,
): boolean {
  return bookings.some(
    (b) =>
      b.bookingId !== candidate.bookingId &&
      b.staffId === candidate.staffId &&
      candidate.startMin < b.endMin &&
      b.startMin < candidate.endMin,
  );
}

function explain(before: number, after: number, moves: number): string {
  if (before === 0) return 'No stranded time. Nothing to compact.';
  if (moves === 0) {
    return `${before} stranded minutes, but no move clears more than ${MIN_STRANDED_GAIN_MIN}. Left alone.`;
  }
  return (
    `${moves} consent ${moves === 1 ? 'move' : 'moves'} ` +
    `${moves === 1 ? 'turns' : 'turn'} ${before} stranded minutes into ${after}.`
  );
}
