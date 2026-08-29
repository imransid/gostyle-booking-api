/**
 * The party planner.
 *
 * Group feasibility is a MATCHING problem, not a single-lane search. Four
 * people needing four different professionals at once is not four
 * independent questions: assigning Maya to the first participant changes the
 * answer for the other three.
 */

import { SLOT_MIN } from './grid';

export type GroupMode = 'arrive_together' | 'finish_together';

export interface PartyParticipant {
  readonly id: string;
  readonly label: string;
  /** Skills the whole chain needs. */
  readonly skills: readonly string[];
  readonly durationMin: number;
  /** The chair or room type, per five-minute slice. */
  readonly resourceType: string;
  readonly preferredStaffId: string | null;
}

export interface PartyContext {
  /** Professionals who can work at all today. */
  readonly professionals: readonly {
    readonly id: string;
    readonly name: string;
    readonly skills: readonly string[];
    /** Already at their daily cap. */
    readonly atCap: boolean;
    /** Minutes this professional is already busy. */
    readonly busy: readonly {
      readonly fromMin: number;
      readonly toMin: number;
    }[];
  }[];
  /** How many of each chair type the branch owns. */
  readonly resourceCounts: Readonly<Record<string, number>>;
  /** Chairs already taken, per type, as spans. */
  readonly occupied: readonly {
    readonly resourceType: string;
    readonly fromMin: number;
    readonly toMin: number;
  }[];
}

/**
 * How much slack the party is allowed.
 *
 * Both default to today's behaviour, so a caller that says nothing gets
 * exactly the plan it got before these existed.
 */
export interface PartyOptions {
  /**
   * How many minutes apart the party may FINISH and still count as finishing
   * together. Zero means exactly together, which is what the planner did
   * before this option existed.
   *
   * Only meaningful for finish_together. In arrive_together everyone starts
   * on the anchor, so their finishes are spread by their own durations and a
   * finish window would describe nothing.
   *
   * The slack buys FEASIBILITY: a lane allowed to end ten minutes early can
   * start ten minutes early, which may be the only place its colourist is
   * free. Nobody waits longer for it -- the party still leaves by the anchor.
   */
  readonly finishWindowMin?: number;

  /**
   * The largest allowed spread between the earliest and the latest lane
   * START.
   *
   * This is the rule that stops "finishing together" from meaning "the first
   * person arrives at ten and the last at one". A party of a fringe trim and
   * a balayage finishing together are staggered by 130 minutes whatever the
   * planner does; a branch that considers that not-a-group-outing sets a cap
   * and gets a clear refusal instead of a plan nobody wanted.
   */
  readonly maxStaggerMin?: number;
}

/** Exactly together, as the planner has always done it. */
export const DEFAULT_FINISH_WINDOW_MIN = 0;

/**
 * The whole trading day: 1320 - 600. In other words, no practical cap.
 *
 * A real number rather than Infinity, because it is a duration in the same
 * units as everything else here and it prints in an explanation. The point of
 * the default is that no party that planned yesterday fails today.
 */
export const DEFAULT_MAX_STAGGER_MIN = 720;

export interface Lane {
  readonly participantId: string;
  readonly staffId: string;
  readonly startMin: number;
  readonly endMin: number;
  readonly resourceType: string;
}

export type PartyPlan =
  | { readonly kind: 'planned'; readonly lanes: readonly Lane[] }
  | {
      readonly kind: 'infeasible';
      readonly reason: string;
      /** What the desk can actually do about it. */
      readonly remedy: string;
    };

/**
 * Can this party be seated at this time?
 *
 * The order of the steps matters, and the scarcity sort is the one that makes
 * it finish. Matching the MOST CONSTRAINED participant first means a doomed
 * branch fails immediately rather than after the search has happily assigned
 * everyone else and only then discovered that the one person who needed a
 * colourist cannot be seated.
 */
export function planParty(
  participants: readonly PartyParticipant[],
  startMin: number,
  mode: GroupMode,
  ctx: PartyContext,
  options: PartyOptions = {},
): PartyPlan {
  if (participants.length < 2) {
    return {
      kind: 'infeasible',
      reason: 'A group needs at least two participants.',
      remedy: 'Book this as a single appointment instead.',
    };
  }

  // FINISH TOGETHER staggers the starts backwards from a shared finish, so
  // the party leaves as one. It is usually what a group actually wants: four
  // people who arrive together but finish an hour apart have not had a group
  // outing, they have had a queue.
  //
  // It does NOT ease chair pressure. Arriving together overlaps everyone at
  // the start; finishing together overlaps everyone at the end. Both peak at
  // one chair per participant. What it buys is professionals who are busy
  // earlier in the day.
  const finishAt =
    mode === 'finish_together'
      ? startMin + Math.max(...participants.map((p) => p.durationMin))
      : 0;

  const startFor = (p: PartyParticipant): number =>
    mode === 'arrive_together' ? startMin : finishAt - p.durationMin;

  const finishWindow = Math.max(
    0,
    options.finishWindowMin ?? DEFAULT_FINISH_WINDOW_MIN,
  );
  const maxStagger = Math.max(
    0,
    options.maxStaggerMin ?? DEFAULT_MAX_STAGGER_MIN,
  );

  /**
   * The starts this participant may take, earliest last.
   *
   * A finish window lets a lane end up to that many minutes BEFORE the
   * anchor, never after: the anchor is when the party leaves, and a lane
   * allowed to run past it would make the others wait. Offset 0 is tried
   * first so a party that fits exactly together still finishes exactly
   * together.
   */
  const startsFor = (p: PartyParticipant): number[] => {
    if (mode === 'arrive_together' || finishWindow === 0) return [startFor(p)];
    const out: number[] = [];
    for (let d = 0; d <= finishWindow; d += SLOT_MIN) out.push(startFor(p) - d);
    return out;
  };

  // 1. Each participant's eligible pool, minus anyone at their daily cap.
  //    Free at ANY of the allowed starts, not just the anchor one: excluding
  //    a colourist here because she is busy at the exact finish would throw
  //    away the very slack the window was added to buy. The specific start is
  //    re-checked inside the search.
  const pools = new Map<string, string[]>();
  for (const p of participants) {
    const starts = startsFor(p);
    const pool = ctx.professionals
      .filter((s) => !s.atCap)
      .filter((s) => p.skills.every((skill) => s.skills.includes(skill)))
      .filter((s) =>
        p.preferredStaffId === null ? true : s.id === p.preferredStaffId,
      )
      .filter((s) =>
        starts.some((from) => isFree(s.busy, from, from + p.durationMin)),
      )
      .map((s) => s.id);

    if (pool.length === 0) {
      return {
        kind: 'infeasible',
        reason: `Nobody available covers ${p.label}'s services at this time.`,
        remedy:
          p.preferredStaffId === null
            ? 'Change that service, or try another time.'
            : 'Relax the professional preference, or try another time.',
      };
    }
    pools.set(p.id, pool);
  }

  // The whole party needs DISTINCT professionals, so the union matters as
  // much as each pool. Saying this before the search runs turns a long
  // fruitless backtrack into one clear sentence.
  const union = new Set([...pools.values()].flat());
  if (union.size < participants.length) {
    return {
      kind: 'infeasible',
      reason: `Only ${union.size} professional${union.size === 1 ? '' : 's'} can cover this party, and each of the ${participants.length} participants needs their own.`,
      remedy: 'Reduce the party, change a service, or try another time.',
    };
  }

  // THE STAGGER CAP, ARITHMETICALLY. Finishing together spreads the starts by
  // exactly the difference between the longest and shortest service, and the
  // finish window is the only thing that can close that gap -- a short lane
  // allowed to end early starts earlier too. When even the full window cannot
  // get under the cap, no assignment of professionals or chairs will, so say
  // that in one sentence instead of exhausting the search and blaming chairs.
  if (mode === 'finish_together') {
    const durations = participants.map((p) => p.durationMin);
    const spread = Math.max(...durations) - Math.min(...durations);
    const best = Math.max(0, spread - finishWindow);
    if (best > maxStagger) {
      return {
        kind: 'infeasible',
        reason:
          `Finishing together staggers this party's arrivals by ${best} ` +
          `minutes, more than the ${maxStagger} allowed: the longest service ` +
          `runs ${spread} minutes longer than the shortest.`,
        remedy:
          finishWindow === 0
            ? 'Allow the party to finish a few minutes apart, switch to arriving together, or even up the services.'
            : 'Widen the finish window, raise the stagger cap, switch to arriving together, or even up the services.',
      };
    }
  }

  // 2. SCARCITY ORDER. Smallest pool first; ties break toward the longest
  //    service, because a long service is the harder thing to place.
  const ordered = [...participants].sort(
    (a, b) =>
      pools.get(a.id)!.length - pools.get(b.id)!.length ||
      b.durationMin - a.durationMin ||
      (a.id < b.id ? -1 : 1),
  );

  // 3 and 4. Walk recursively, one professional each, checking chairs as we
  //          go rather than at the end: a plan that seats four people and
  //          then discovers a missing chair has wasted the whole search.
  const lanes: Lane[] = [];
  const taken = new Set<string>();

  const place = (i: number): boolean => {
    if (i === ordered.length) return true;
    const p = ordered[i]!;
    const busyOf = new Map(ctx.professionals.map((s) => [s.id, s.busy]));

    // Starts first, professionals inside: offset 0 is the exact finish, and
    // trying it for every professional before giving any of them a slack
    // start keeps the tightest party the planner can find.
    for (const from of startsFor(p)) {
      const to = from + p.durationMin;

      // THE STAGGER CAP, checked as we go rather than at the end. A branch
      // that has already spread the party too wide cannot be rescued by the
      // participants after it, so there is no point walking them.
      const starts = [...lanes.map((l) => l.startMin), from];
      if (Math.max(...starts) - Math.min(...starts) > maxStagger) continue;

      for (const staffId of pools.get(p.id)!) {
        if (taken.has(staffId)) continue;
        // Re-checked for THIS start: the pool only promised free at one of
        // the allowed starts, not at this one.
        if (!isFree(busyOf.get(staffId) ?? [], from, to)) continue;

        const lane: Lane = {
          participantId: p.id,
          staffId,
          startMin: from,
          endMin: to,
          resourceType: p.resourceType,
        };

        if (!chairsFit([...lanes, lane], ctx)) continue;

        taken.add(staffId);
        lanes.push(lane);
        if (place(i + 1)) return true;
        lanes.pop();
        taken.delete(staffId);
      }
    }
    return false;
  };

  if (!place(0)) {
    // The search exhausted every assignment. With the pool and union checks
    // already passed, the remaining cause is almost always chairs.
    const short = shortestResource(participants, ctx);
    return short === null
      ? {
          kind: 'infeasible',
          reason:
            'No arrangement of professionals covers the whole party at this time.',
          remedy: 'Try another time, or switch to finish-together.',
        }
      : {
          kind: 'infeasible',
          reason: `The party needs ${short.needed} ${short.type} stations at once and the branch has ${short.has}.`,
          remedy:
            'Reduce the party, change a service, or switch to finish-together.',
        };
  }

  // Back into the caller's order, not the scarcity order.
  const byId = new Map(lanes.map((l) => [l.participantId, l]));
  return {
    kind: 'planned',
    lanes: participants.map((p) => byId.get(p.id)!),
  };
}

function isFree(
  busy: readonly { fromMin: number; toMin: number }[],
  fromMin: number,
  toMin: number,
): boolean {
  return !busy.some((b) => b.fromMin < toMin && fromMin < b.toMin);
}

/**
 * Chair capacity per slice.
 *
 * Counting the EXISTING diary and the lanes already assigned in this same
 * plan is what stops a party of four being sold three nail stations. A check
 * that looked only at the diary would approve every lane individually and
 * produce a plan that cannot happen.
 */
function chairsFit(lanes: readonly Lane[], ctx: PartyContext): boolean {
  const types = new Set(lanes.map((l) => l.resourceType));

  for (const type of types) {
    const capacity = ctx.resourceCounts[type] ?? 0;
    const mine = lanes.filter((l) => l.resourceType === type);
    const theirs = ctx.occupied.filter((o) => o.resourceType === type);

    // Only the lane boundaries can change the count, so those are the only
    // instants worth checking.
    const edges = new Set<number>();
    for (const l of mine) {
      edges.add(l.startMin);
      edges.add(l.endMin);
    }

    for (const at of edges) {
      const used =
        mine.filter((l) => l.startMin <= at && at < l.endMin).length +
        theirs.filter((o) => o.fromMin <= at && at < o.toMin).length;
      if (used > capacity) return false;
    }
  }
  return true;
}

/** Which chair type the party is short of, for the explanation. */
function shortestResource(
  participants: readonly PartyParticipant[],
  ctx: PartyContext,
): { type: string; needed: number; has: number } | null {
  const needed = new Map<string, number>();
  for (const p of participants) {
    needed.set(p.resourceType, (needed.get(p.resourceType) ?? 0) + 1);
  }
  for (const [type, n] of needed) {
    const has = ctx.resourceCounts[type] ?? 0;
    if (n > has) return { type, needed: n, has };
  }
  return null;
}
