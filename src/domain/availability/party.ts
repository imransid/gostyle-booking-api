/**
 * The party planner.
 *
 * Group feasibility is a MATCHING problem, not a single-lane search. Four
 * people needing four different professionals at once is not four
 * independent questions: assigning Maya to the first participant changes the
 * answer for the other three.
 */

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

  // 1. Each participant's eligible pool, minus anyone at their daily cap.
  const pools = new Map<string, string[]>();
  for (const p of participants) {
    const pool = ctx.professionals
      .filter((s) => !s.atCap)
      .filter((s) => p.skills.every((skill) => s.skills.includes(skill)))
      .filter((s) =>
        p.preferredStaffId === null ? true : s.id === p.preferredStaffId,
      )
      .filter((s) => isFree(s.busy, startFor(p), startFor(p) + p.durationMin))
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
    const from = startFor(p);
    const to = from + p.durationMin;

    for (const staffId of pools.get(p.id)!) {
      if (taken.has(staffId)) continue;

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
