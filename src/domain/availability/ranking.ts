import { toMin, DAILY_BOOKING_CAP, PROCESSING_GUARD_MIN } from './grid';
import { BufferClaims, StaffBooking, gapBetween } from './staff-mask';

/**
 * Feasibility decides what MAY be offered. Ranking decides what is WORTH
 * offering. Two layers, then a policy that cuts the list to three.
 */

// ---------------------------------------------------------------- scoring

/** Signal weights. Named so a policy change is a one-line edit. */
export const FRAGMENTATION = {
  /** The chain starts the instant the previous job releases the professional. */
  FLUSH_BEFORE: 3,
  /** The chain ends the instant the next job needs to begin. */
  FLUSH_AFTER: 3,
  /** A stranded island is left before the chain. */
  SLIVER_BEFORE: -4,
  /** A stranded island is left after the chain. */
  SLIVER_AFTER: -4,
  /** The chain fits inside another client's hands-free band. Free capacity. */
  INSIDE_PROCESSING: 6,
  /** Spread work across the team rather than loading one person. */
  PER_FREE_BOOKING: 0.3,
  /** Sitting directly behind a HIGH-risk client. A nudge, never a refusal. */
  BEHIND_HIGH_RISK: -0.5,
} as const;

/** A gap this small or smaller cannot be sold and counts as stranded. */
export const SLIVER_MAX_MIN = 19;

/** How much a destroyed sellable start costs, against the layer-one score. */
export const DELTA_CAPACITY_WEIGHT = 0.5;

/** The three offers must be genuinely different choices, not one half hour. */
export const OFFER_SPACING_MIN = 25;

export interface ScoringInput {
  readonly startMin: number;
  readonly durationMin: number;
  readonly claims: BufferClaims;
  /** What is already on this professional's calendar today. */
  readonly bookings: readonly StaffBooking[];
  /** Bookings this professional already has today. */
  readonly load: number;
  readonly dailyCap?: number;
}

export interface FragmentationBreakdown {
  readonly score: number;
  readonly flushBefore: boolean;
  readonly flushAfter: boolean;
  readonly sliverBeforeMin: number | null;
  readonly sliverAfterMin: number | null;
  readonly insideProcessing: boolean;
  readonly behindHighRisk: boolean;
}

/**
 * Layer one: what does this start do to the SHAPE of the day?
 *
 * Rewards starts that sit flush against existing work. Punishes starts that
 * strand an unsellable island. The breakdown is returned alongside the number
 * so an offer row can explain itself instead of being magical.
 */
export function fragmentationScore(
  input: ScoringInput,
): FragmentationBreakdown {
  const cap = input.dailyCap ?? DAILY_BOOKING_CAP;
  const endMin = input.startMin + input.durationMin;

  let score = 0;
  let flushBefore = false;
  let flushAfter = false;
  let sliverBeforeMin: number | null = null;
  let sliverAfterMin: number | null = null;
  let insideProcessing = false;
  let behindHighRisk = false;

  // The nearest neighbour on each side, ignoring anything we sit inside.
  let prev: StaffBooking | null = null;
  let next: StaffBooking | null = null;

  for (const b of input.bookings) {
    if (b.endMin <= input.startMin) {
      if (prev === null || b.endMin > prev.endMin) prev = b;
    }
    if (b.startMin >= endMin) {
      if (next === null || b.startMin < next.startMin) next = b;
    }

    // Does the whole chain fit inside this booking's guarded hands-free band?
    if (b.processing !== undefined) {
      const open = b.startMin + b.processing.fromMin + PROCESSING_GUARD_MIN;
      const shut = b.startMin + b.processing.toMin - PROCESSING_GUARD_MIN;
      if (input.startMin >= open && endMin <= shut) insideProcessing = true;
    }
  }

  if (prev !== null) {
    // Flush means "the earliest minute the rules actually allow", not the
    // literal end of the previous job. The buffer between them is real work.
    const required = gapBetween(input.claims.preMin, prev.claims.postMin);
    const earliestLegal = prev.endMin + required;
    const idle = input.startMin - earliestLegal;

    if (idle === 0) {
      flushBefore = true;
      score += FRAGMENTATION.FLUSH_BEFORE;
    } else if (idle > 0 && idle <= SLIVER_MAX_MIN) {
      sliverBeforeMin = idle;
      score += FRAGMENTATION.SLIVER_BEFORE;
    }

    if (prev.highRisk === true) {
      behindHighRisk = true;
      score += FRAGMENTATION.BEHIND_HIGH_RISK;
    }
  }

  if (next !== null) {
    const required = gapBetween(input.claims.postMin, next.claims.preMin);
    const latestLegalEnd = next.startMin - required;
    const idle = latestLegalEnd - endMin;

    if (idle === 0) {
      flushAfter = true;
      score += FRAGMENTATION.FLUSH_AFTER;
    } else if (idle > 0 && idle <= SLIVER_MAX_MIN) {
      sliverAfterMin = idle;
      score += FRAGMENTATION.SLIVER_AFTER;
    }
  }

  if (insideProcessing) score += FRAGMENTATION.INSIDE_PROCESSING;

  // Load balancing: the emptier the diary, the more attractive.
  score += FRAGMENTATION.PER_FREE_BOOKING * Math.max(0, cap - input.load);

  return {
    score: round2(score),
    flushBefore,
    flushAfter,
    sliverBeforeMin,
    sliverAfterMin,
    insideProcessing,
    behindHighRisk,
  };
}

// ---------------------------------------------------------------- delta capacity

/** A booking the engine is imagining, so it can measure what it would cost. */
export interface PlannedBooking {
  readonly staffId: string;
  readonly startMin: number;
  readonly endMin: number;
  readonly claims: BufferClaims;
  readonly resourceType: string;
}

/**
 * Weighted sellable starts across the salon's demand mix, given some extra
 * bookings on the diary.
 *
 * Injected rather than computed here, because measuring it needs the whole
 * request context (roster, chairs, channel) and this module must stay pure.
 */
export type SellableStartsProbe = (extra: readonly PlannedBooking[]) => number;

/** Demand mix. Weights sum to 1. */
export const DEMAND_MIX: readonly {
  readonly serviceIds: readonly string[];
  readonly weight: number;
}[] = [
  { serviceIds: ['haircut-finish'], weight: 0.26 },
  { serviceIds: ['blow-dry'], weight: 0.16 },
  { serviceIds: ['full-colour'], weight: 0.18 },
  { serviceIds: ['gel-manicure'], weight: 0.14 },
  { serviceIds: ['luxury-facial'], weight: 0.1 },
  { serviceIds: ['full-colour', 'blow-dry'], weight: 0.16 },
];

/**
 * How much sellable capacity this start destroys. Lower is better.
 *
 * Measure the salon, simulate the booking, measure again, take the
 * difference. A start that eats the only long clear run of the day costs
 * far more than one tucked against existing work, even when both look
 * equally convenient in isolation.
 */
export function deltaCapacity(
  probe: SellableStartsProbe,
  baseline: number,
  candidate: PlannedBooking,
): number {
  return round2(baseline - probe([candidate]));
}

// ---------------------------------------------------------------- candidates

export type Badge = 'EARLIEST' | 'SMART_PICK' | 'OVERLAP' | 'FLUSH';

export interface Candidate {
  readonly slot: number;
  readonly startMin: number;
  readonly endMin: number;
  readonly staffId: string;
  readonly alsoAvailable: readonly string[];
  readonly fragmentation: FragmentationBreakdown;
}

export interface RankedCandidate extends Candidate {
  readonly deltaCapacity: number;
  /** score = fragmentation − 0.5 × deltaCapacity */
  readonly score: number;
  readonly badges: readonly Badge[];
}

/** score = fragmentation_score − 0.5 × delta capacity */
export function finalScore(fragmentation: number, delta: number): number {
  return round2(fragmentation - DELTA_CAPACITY_WEIGHT * delta);
}

// ---------------------------------------------------------------- the policy

export interface ThreeOfferOptions {
  readonly spacingMin?: number;
  readonly count?: number;
}

/**
 * The order of these three rules is the whole point.
 *
 *   1. Offer one is ALWAYS the earliest feasible start. It is the promise the
 *      interface makes, and it is never traded away for a better score.
 *   2. The rest come off the top of the score shortlist, each at least 25
 *      minutes from every offer already chosen, so the three are genuinely
 *      different choices rather than three faces of the alf hour.
 *   3. Display in time order. The highest-scoring of the three carries
 *      SMART PICK.
 */
export function selectOffers(
  ranked: readonly RankedCandidate[],
  options: ThreeOfferOptions = {},
): RankedCandidate[] {
  const spacing = options.spacingMin ?? OFFER_SPACING_MIN;
  const want = options.count ?? 3;
  if (ranked.length === 0) return [];

  const byTime = [...ranked].sort((a, b) => a.startMin - b.startMin);
  const earliest = byTime[0];
  if (earliest === undefined) return [];

  const chosen: RankedCandidate[] = [earliest];
  const taken = new Set<RankedCandidate>([earliest]);

  // Greedy, one at a time, because "how far is this from what we already
  // chose" changes after every pick.
  //
  // Tie-break on distance, not on time. Score ties are common (load balancing
  // is constant per professional, so a quiet diary produces long runs of
  // identical scores) and breaking those by earliest-first would hand the
  // customer 10:00, 10:25 and 10:50 instead of morning, afternoon, evening.
  while (chosen.length < want) {
    let best: RankedCandidate | null = null;
    let bestScore = -Infinity;
    let bestDistance = -Infinity;

    for (const c of byTime) {
      if (taken.has(c)) continue;

      let nearest = Infinity;
      for (const picked of chosen) {
        nearest = Math.min(nearest, Math.abs(picked.startMin - c.startMin));
      }
      if (nearest < spacing) continue;

      const better =
        c.score > bestScore ||
        (c.score === bestScore && nearest > bestDistance);
      if (better) {
        best = c;
        bestScore = c.score;
        bestDistance = nearest;
      }
    }

    if (best === null) break;
    chosen.push(best);
    taken.add(best);
  }

  // The badge goes on the best of the three, which is not always the earliest.
  const bestOverall = chosen.reduce((a, b) => (b.score > a.score ? b : a));

  return chosen
    .sort((a, b) => a.startMin - b.startMin)
    .map((c) => ({
      ...c,
      badges: buildBadges(c, c === earliest, c === bestOverall, chosen.length > 1),
    }));
}

function buildBadges(
  c: RankedCandidate,
  isEarliest: boolean,
  isBest: boolean,
  hasRivals: boolean,
): Badge[] {
  const badges: Badge[] = [];
  if (isEarliest) badges.push('EARLIEST');
  // SMART PICK only means something when there is a choice. On a single
  // offer it is EARLIEST and SMART PICK at once, which says nothing.
  if (isBest && hasRivals) badges.push('SMART_PICK');
  if (c.fragmentation.insideProcessing) badges.push('OVERLAP');
  if (c.fragmentation.flushBefore || c.fragmentation.flushAfter)
    badges.push('FLUSH');
  return badges;
}

// ---------------------------------------------------------------- the pipeline

export interface RankingRequest {
  readonly candidates: readonly Candidate[];
  readonly durationMin: number;
  readonly claims: BufferClaims;
  readonly resourceType: string;
  readonly probe: SellableStartsProbe;
  /**
   * Delta capacity is measured for the top slice of the layer-one ranking
   * rather than every feasible start. A full day can offer 130 starts, and
   * six demand baskets each is 780 kernel runs for a difference that only
   * ever changes the order near the top.
   */
  readonly deltaSampleSize?: number;
  readonly options?: ThreeOfferOptions;
}

export interface RankingResult {
  readonly ranked: readonly RankedCandidate[];
  readonly offers: readonly RankedCandidate[];
  readonly baselineSellable: number;
  readonly measuredCount: number;
}

/**
 * Which candidates get their delta capacity measured.
 *
 * The offers must end up at least 25 minutes apart, so candidates inside the
 * same 25-minute band are competing for one position and only one of them can
 * ever be offered. Measure the BEST of each band and you get a sample that is
 * both spread across the day and made of the strongest contender in each part
 * of it.
 *
 * Sampling by raw layer-one rank instead clusters badly: load balancing is
 * constant per professional, so on a quiet diary the top twelve are simply
 * the first twelve minutes of the day, and all three offers come out inside
 * the same hour.
 */
export function sampleForMeasurement(
  candidates: readonly Candidate[],
  spacingMin: number,
  limit: number,
): Set<number> {
  const chosen = new Set<number>();
  if (candidates.length === 0) return chosen;

  const byTime = [...candidates].sort((a, b) => a.startMin - b.startMin);
  const first = byTime[0];
  if (first === undefined) return chosen;

  // The earliest is always offered, so its number must be real.
  chosen.add(first.slot);

  // One representative per band: the best-shaped start inside it.
  const bands = new Map<number, Candidate>();
  for (const c of byTime) {
    const band = Math.floor((c.startMin - first.startMin) / spacingMin);
    const held = bands.get(band);
    if (
      held === undefined ||
      c.fragmentation.score > held.fragmentation.score
    ) {
      bands.set(band, c);
    }
  }

  for (const c of [...bands.values()].sort((a, b) => a.startMin - b.startMin)) {
    if (chosen.size >= limit) break;
    chosen.add(c.slot);
  }

  return chosen;
}

export function rankAndSelect(request: RankingRequest): RankingResult {
  if (request.candidates.length === 0) {
    return { ranked: [], offers: [], baselineSellable: 0, measuredCount: 0 };
  }

  const baseline = request.probe([]);
  const spacing = request.options?.spacingMin ?? OFFER_SPACING_MIN;
  const measured = sampleForMeasurement(
    request.candidates,
    spacing,
    request.deltaSampleSize ?? 24,
  );

  const ranked: RankedCandidate[] = request.candidates.map((c) => {
    if (!measured.has(c.slot)) {
      return {
        ...c,
        deltaCapacity: 0,
        score: c.fragmentation.score,
        badges: [],
      };
    }
    const delta = deltaCapacity(request.probe, baseline, {
      staffId: c.staffId,
      startMin: c.startMin,
      endMin: c.endMin,
      claims: request.claims,
      resourceType: request.resourceType,
    });
    return {
      ...c,
      deltaCapacity: delta,
      score: finalScore(c.fragmentation.score, delta),
      badges: [],
    };
  });

  const measurable = ranked.filter((c) => measured.has(c.slot));

  return {
    ranked,
    offers: selectOffers(measurable, request.options),
    baselineSellable: baseline,
    measuredCount: measured.size,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Convenience for tests and callers holding slot indices. */
export function slotToMinute(slot: number): number {
  return toMin(slot);
}
