/**
 * The walk-in queue.
 *
 * A walk-in is a booking created against REAL GAPS, in the same engine, with
 * the same holds. Nothing here is a shortcut around availability: the queue
 * is a list of people waiting and a live answer to "what could I offer them
 * right now", and seating one goes through the ordinary confirm path.
 *
 * The queue is ordered by arrival and nothing else. A salon that reorders its
 * waiting room by service value is a salon where the person who has been
 * standing there for forty minutes watches somebody else go first.
 */

import { formatMinute } from '../availability/grid';

export interface WalkIn {
  readonly id: string;
  readonly label: string;
  readonly serviceIds: readonly string[];
  readonly durationMin: number;
  /** Minute of day they joined the queue. */
  readonly joinedMin: number;
}

/** A feasible start the engine has already found. */
export interface WalkInCandidate {
  readonly startMin: number;
  readonly staffId: string;
  readonly staffName: string;
}

export type NearestOption =
  /** "Maya is free now." */
  | {
      readonly kind: 'now';
      readonly staffId: string;
      readonly staffName: string;
      readonly startMin: number;
      readonly label: string;
    }
  /** "Lina free from 14:15." */
  | {
      readonly kind: 'from';
      readonly staffId: string;
      readonly staffName: string;
      readonly startMin: number;
      readonly label: string;
    }
  /** "Next gap 16:20." */
  | {
      readonly kind: 'next_gap';
      readonly startMin: number;
      readonly label: string;
    };

/**
 * How soon counts as "now".
 *
 * A start inside the next quarter hour is one the person in front of you can
 * simply be walked to. Beyond that they are being asked to wait, and saying
 * "now" about a twenty-minute wait is the kind of small lie a desk gets
 * blamed for.
 */
export const NOW_WINDOW_MIN = 15;

/** How many options the queue row shows. */
export const OPTIONS_SHOWN = 3;

/**
 * The nearest options for one person, as the queue row shows them.
 *
 * One per professional first, cheapest promise first, then a bare next gap if
 * there is still room. Showing three starts from the same professional would
 * fill the row with one answer.
 */
export function nearestOptions(
  candidates: readonly WalkInCandidate[],
  nowMin: number,
): NearestOption[] {
  const usable = candidates
    .filter((c) => c.startMin >= nowMin)
    .sort(
      (a, b) => a.startMin - b.startMin || a.staffId.localeCompare(b.staffId),
    );

  const options: NearestOption[] = [];
  const seen = new Set<string>();

  for (const c of usable) {
    if (options.length >= OPTIONS_SHOWN) break;
    if (seen.has(c.staffId)) continue;
    seen.add(c.staffId);

    if (c.startMin - nowMin <= NOW_WINDOW_MIN) {
      options.push({
        kind: 'now',
        staffId: c.staffId,
        staffName: c.staffName,
        startMin: c.startMin,
        label: `${c.staffName} is free now`,
      });
    } else {
      options.push({
        kind: 'from',
        staffId: c.staffId,
        staffName: c.staffName,
        startMin: c.startMin,
        label: `${c.staffName} free from ${formatMinute(c.startMin)}`,
      });
    }
  }

  // A bare gap, when there are fewer professionals than places to fill and a
  // later start exists that no listed professional is already offering.
  if (options.length < OPTIONS_SHOWN && options.length > 0) {
    const latest = options[options.length - 1];
    const gap = usable.find(
      (c) => latest !== undefined && c.startMin > latest.startMin,
    );
    if (gap !== undefined) {
      options.push({
        kind: 'next_gap',
        startMin: gap.startMin,
        label: `Next gap ${formatMinute(gap.startMin)}`,
      });
    }
  }

  return options;
}

export interface QueueRow {
  readonly walkIn: WalkIn;
  readonly position: number;
  readonly waitingMin: number;
  readonly options: readonly NearestOption[];
  readonly explanation: string;
}

/**
 * The queue, in arrival order, each row with its own live quote.
 *
 * The options are computed per person because they want different services:
 * the colourist being free is no use to somebody waiting for a manicure.
 */
export function queue(
  walkIns: readonly WalkIn[],
  nowMin: number,
  candidatesFor: (walkIn: WalkIn) => readonly WalkInCandidate[],
): QueueRow[] {
  return [...walkIns]
    .sort((a, b) => a.joinedMin - b.joinedMin || a.id.localeCompare(b.id))
    .map((walkIn, i) => {
      const options = nearestOptions(candidatesFor(walkIn), nowMin);
      const waitingMin = Math.max(0, nowMin - walkIn.joinedMin);
      return {
        walkIn,
        position: i + 1,
        waitingMin,
        options,
        explanation:
          options.length === 0
            ? `Nothing today fits ${walkIn.label}. Offer the waitlist.`
            : `${walkIn.label}, waiting ${waitingMin} min: ${options.map((o) => o.label).join('; ')}.`,
      };
    });
}
