import { describe, it, expect } from 'vitest';
import {
  fragmentationScore,
  deltaCapacity,
  finalScore,
  selectOffers,
  rankAndSelect,
  sampleForMeasurement,
  FRAGMENTATION,
  SLIVER_MAX_MIN,
  DEMAND_MIX,
  type Candidate,
  type RankedCandidate,
  type ScoringInput,
  type PlannedBooking,
  type SellableStartsProbe,
} from './ranking';
import { type BufferClaims, type StaffBooking } from './staff-mask';
import { toSlot, DAILY_BOOKING_CAP, OFFER_SPACING_MIN } from './grid';

const COLOUR: BufferClaims = { preMin: 10, postMin: 20 };
const STYLING: BufferClaims = { preMin: 5, postMin: 10 };

function score(over: Partial<ScoringInput> = {}): number {
  return fragmentationScore({
    startMin: 900,
    durationMin: 45,
    claims: STYLING,
    bookings: [],
    load: DAILY_BOOKING_CAP,
    ...over,
  }).score;
}

function detail(over: Partial<ScoringInput> = {}) {
  return fragmentationScore({
    startMin: 900,
    durationMin: 45,
    claims: STYLING,
    bookings: [],
    load: DAILY_BOOKING_CAP,
    ...over,
  });
}

describe('the demand mix', () => {
  it('weights sum to one', () => {
    expect(DEMAND_MIX.reduce((a, b) => a + b.weight, 0)).toBeCloseTo(1, 10);
  });
});

describe('flush against existing work is rewarded', () => {
  it('starting the first legal minute after a colour scores +3', () => {
    const prev: StaffBooking = { startMin: 780, endMin: 840, claims: COLOUR };
    const d = detail({ startMin: 860, bookings: [prev] });
    expect(d.flushBefore).toBe(true);
    expect(d.score).toBe(FRAGMENTATION.FLUSH_BEFORE);
  });

  it('ending the last legal minute before the next job scores +3', () => {
    const next: StaffBooking = { startMin: 960, endMin: 1020, claims: COLOUR };
    const d = detail({ startMin: 905, durationMin: 45, bookings: [next] });
    expect(d.flushAfter).toBe(true);
    expect(d.score).toBe(FRAGMENTATION.FLUSH_AFTER);
  });

  it('flush on both sides scores +6', () => {
    const prev: StaffBooking = { startMin: 780, endMin: 840, claims: COLOUR };
    const next: StaffBooking = { startMin: 915, endMin: 1000, claims: COLOUR };
    const d = detail({
      startMin: 860,
      durationMin: 45,
      bookings: [prev, next],
    });
    expect(d.flushBefore).toBe(true);
    expect(d.flushAfter).toBe(true);
    expect(d.score).toBe(6);
  });
});

describe('stranding an unsellable island is punished', () => {
  it('a 15-minute island before the chain scores -4', () => {
    const prev: StaffBooking = { startMin: 780, endMin: 840, claims: COLOUR };
    const d = detail({ startMin: 875, bookings: [prev] });
    expect(d.sliverBeforeMin).toBe(15);
    expect(d.score).toBe(FRAGMENTATION.SLIVER_BEFORE);
  });

  it('19 minutes is still a sliver, 20 is a real gap', () => {
    const prev: StaffBooking = { startMin: 780, endMin: 840, claims: COLOUR };
    expect(
      detail({ startMin: 860 + 19, bookings: [prev] }).sliverBeforeMin,
    ).toBe(19);
    expect(
      detail({ startMin: 860 + 20, bookings: [prev] }).sliverBeforeMin,
    ).toBeNull();
    expect(SLIVER_MAX_MIN).toBe(19);
  });

  it('a 20-minute gap is neither rewarded nor punished', () => {
    const prev: StaffBooking = { startMin: 780, endMin: 840, claims: COLOUR };
    expect(score({ startMin: 880, bookings: [prev] })).toBe(0);
  });

  it('an island on both sides scores -8', () => {
    const prev: StaffBooking = { startMin: 780, endMin: 840, claims: COLOUR };
    const next: StaffBooking = { startMin: 940, endMin: 1000, claims: COLOUR };
    const d = detail({
      startMin: 870,
      durationMin: 45,
      bookings: [prev, next],
    });
    expect(d.sliverBeforeMin).toBe(10);
    expect(d.sliverAfterMin).toBe(15);
    expect(d.score).toBe(-8);
  });
});

describe('a start inside a hands-free band is worth the most', () => {
  const colour: StaffBooking = {
    startMin: 840,
    endMin: 965,
    claims: COLOUR,
    processing: { fromMin: 45, toMin: 85 },
  };

  it('fitting inside the guarded interior scores +6', () => {
    const d = detail({ startMin: 890, durationMin: 20, bookings: [colour] });
    expect(d.insideProcessing).toBe(true);
    expect(d.score).toBeGreaterThanOrEqual(FRAGMENTATION.INSIDE_PROCESSING);
  });

  it('running past the guard does not count', () => {
    const d = detail({ startMin: 905, durationMin: 20, bookings: [colour] });
    expect(d.insideProcessing).toBe(false);
  });

  it('it beats a merely flush start', () => {
    const inside = detail({
      startMin: 890,
      durationMin: 20,
      bookings: [colour],
    }).score;
    const prev: StaffBooking = { startMin: 780, endMin: 840, claims: COLOUR };
    const flush = detail({
      startMin: 860,
      durationMin: 20,
      bookings: [prev],
    }).score;
    expect(inside).toBeGreaterThan(flush);
  });
});

describe('load balancing spreads the work', () => {
  it('an empty diary is worth 2.4 more than a full one', () => {
    const empty = score({ load: 0 });
    const full = score({ load: DAILY_BOOKING_CAP });
    expect(empty - full).toBeCloseTo(
      FRAGMENTATION.PER_FREE_BOOKING * DAILY_BOOKING_CAP,
      5,
    );
  });

  it('being over the cap never scores negative for load', () => {
    expect(score({ load: 20 })).toBe(0);
  });
});

describe('a HIGH-risk neighbour is a nudge, never a refusal', () => {
  it('sitting behind one costs half a point', () => {
    const risky: StaffBooking = {
      startMin: 780,
      endMin: 840,
      claims: COLOUR,
      highRisk: true,
    };
    const safe: StaffBooking = { startMin: 780, endMin: 840, claims: COLOUR };
    const d = detail({ startMin: 860, bookings: [risky] });
    expect(d.behindHighRisk).toBe(true);
    expect(score({ startMin: 860, bookings: [safe] }) - d.score).toBeCloseTo(
      -FRAGMENTATION.BEHIND_HIGH_RISK,
      5,
    );
  });

  it('the slot is still offered, only ranked lower', () => {
    const risky: StaffBooking = {
      startMin: 780,
      endMin: 840,
      claims: COLOUR,
      highRisk: true,
    };
    expect(detail({ startMin: 860, bookings: [risky] }).score).toBeGreaterThan(
      0,
    );
  });
});

describe('delta capacity prices what each start destroys', () => {
  it('a start that eats a long clear run costs more than one tucked away', () => {
    const probe: SellableStartsProbe = (extra) => {
      if (extra.length === 0) return 61.8;
      const b = extra[0];
      if (b === undefined) return 61.8;
      return b.startMin === 810 ? 61.8 - 3.6 : 61.8 - 0.4;
    };
    const mid: PlannedBooking = {
      staffId: 'maya',
      startMin: 810,
      endMin: 855,
      claims: STYLING,
      resourceType: 'styling',
    };
    const edge: PlannedBooking = {
      staffId: 'maya',
      startMin: 660,
      endMin: 705,
      claims: STYLING,
      resourceType: 'styling',
    };
    expect(deltaCapacity(probe, 61.8, mid)).toBeCloseTo(3.6, 5);
    expect(deltaCapacity(probe, 61.8, edge)).toBeCloseTo(0.4, 5);
  });

  it('score = fragmentation minus half the delta', () => {
    expect(finalScore(6.0, 0.4)).toBeCloseTo(5.8, 5);
    expect(finalScore(4.2, 3.6)).toBeCloseTo(2.4, 5);
  });

  it('a better-shaped start can still lose on capacity cost', () => {
    expect(finalScore(4.2, 3.6)).toBeLessThan(finalScore(6.0, 0.4));
  });
});

function cand(startMin: number, frag: number, delta = 0): RankedCandidate {
  return {
    slot: toSlot(startMin),
    startMin,
    endMin: startMin + 45,
    staffId: 'maya',
    alsoAvailable: [],
    fragmentation: {
      score: frag,
      flushBefore: false,
      flushAfter: false,
      sliverBeforeMin: null,
      sliverAfterMin: null,
      insideProcessing: false,
      behindHighRisk: false,
    },
    deltaCapacity: delta,
    score: finalScore(frag, delta),
    badges: [],
  };
}

describe('the three-offer policy', () => {
  it('offer one is always the earliest, even when it scores worst', () => {
    const offers = selectOffers([cand(660, 0), cand(900, 9), cand(1080, 8)]);
    expect(offers[0]?.startMin).toBe(660);
    expect(offers[0]?.badges).toContain('EARLIEST');
  });

  it('SMART PICK goes to the best of the three, not the earliest', () => {
    const offers = selectOffers([cand(660, 0), cand(900, 9), cand(1080, 8)]);
    const smart = offers.find((o) => o.badges.includes('SMART_PICK'));
    expect(smart?.startMin).toBe(900);
    expect(offers[0]?.badges).not.toContain('SMART_PICK');
  });

  it('offers are at least 25 minutes apart', () => {
    const offers = selectOffers([
      cand(900, 1),
      cand(905, 9),
      cand(910, 8),
      cand(1000, 7),
      cand(1100, 6),
    ]);
    for (let i = 1; i < offers.length; i++) {
      const a = offers[i - 1];
      const b = offers[i];
      if (a === undefined || b === undefined) continue;
      expect(b.startMin - a.startMin).toBeGreaterThanOrEqual(OFFER_SPACING_MIN);
    }
  });

  it('three faces of the same half hour collapse to one offer', () => {
    expect(
      selectOffers([cand(900, 5), cand(905, 9), cand(910, 8)]),
    ).toHaveLength(1);
  });

  it('the result is displayed in time order', () => {
    const offers = selectOffers([cand(1080, 9), cand(660, 1), cand(900, 5)]);
    expect(offers.map((o) => o.startMin)).toEqual([660, 900, 1080]);
  });

  it('fewer than three feasible starts returns what exists', () => {
    expect(selectOffers([cand(900, 5)])).toHaveLength(1);
    expect(selectOffers([])).toEqual([]);
  });

  it('never returns more than three', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      cand(660 + i * 30, i % 7),
    );
    expect(selectOffers(many)).toHaveLength(3);
  });

  it('the spacing and count are configurable for the reschedule grid', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      cand(660 + i * 30, i % 7),
    );
    expect(selectOffers(many, { count: 6, spacingMin: 60 })).toHaveLength(6);
  });
});

describe('the whole pipeline', () => {
  function candidate(
    startMin: number,
    bookings: StaffBooking[] = [],
    load = 4,
  ): Candidate {
    return {
      slot: toSlot(startMin),
      startMin,
      endMin: startMin + 45,
      staffId: 'maya',
      alsoAvailable: [],
      fragmentation: fragmentationScore({
        startMin,
        durationMin: 45,
        claims: STYLING,
        bookings,
        load,
      }),
    };
  }

  const flatProbe: SellableStartsProbe = (extra) =>
    extra.length === 0 ? 60 : 59;

  it('returns at most three offers, with one EARLIEST and one SMART PICK', () => {
    const r = rankAndSelect({
      candidates: [
        candidate(660),
        candidate(900),
        candidate(1080),
        candidate(1200),
      ],
      durationMin: 45,
      claims: STYLING,
      resourceType: 'styling',
      probe: flatProbe,
    });
    expect(r.offers.length).toBeLessThanOrEqual(3);
    expect(r.offers.filter((o) => o.badges.includes('EARLIEST'))).toHaveLength(
      1,
    );
    expect(
      r.offers.filter((o) => o.badges.includes('SMART_PICK')),
    ).toHaveLength(1);
    expect(r.baselineSellable).toBe(60);
  });

  it('the earliest start is always measured, even outside the sample', () => {
    const candidates = Array.from({ length: 30 }, (_, i) =>
      candidate(660 + i * 20),
    );
    let probes = 0;
    const counting: SellableStartsProbe = (extra) => {
      probes += 1;
      return extra.length === 0 ? 60 : 59;
    };
    const r = rankAndSelect({
      candidates,
      durationMin: 45,
      claims: STYLING,
      resourceType: 'styling',
      probe: counting,
      deltaSampleSize: 5,
    });
    expect(r.measuredCount).toBeLessThanOrEqual(6);
    expect(probes).toBeLessThanOrEqual(7);
    expect(r.offers[0]?.startMin).toBe(660);
  });

  it('an empty candidate list is a legitimate answer', () => {
    const r = rankAndSelect({
      candidates: [],
      durationMin: 45,
      claims: STYLING,
      resourceType: 'styling',
      probe: flatProbe,
    });
    expect(r.offers).toEqual([]);
    expect(r.ranked).toEqual([]);
  });

  it('a flush start beats a stranding one on the same diary', () => {
    const prev: StaffBooking = { startMin: 780, endMin: 840, claims: COLOUR };
    const flush = candidate(860, [prev]);
    const strands = candidate(875, [prev]);
    expect(flush.fragmentation.score).toBeGreaterThan(
      strands.fragmentation.score,
    );
  });

  it('an overlap start wins the SMART PICK badge over a plain one', () => {
    const colour: StaffBooking = {
      startMin: 840,
      endMin: 965,
      claims: COLOUR,
      processing: { fromMin: 45, toMin: 85 },
    };
    const inside: Candidate = {
      slot: toSlot(890),
      startMin: 890,
      endMin: 910,
      staffId: 'anya',
      alsoAvailable: [],
      fragmentation: fragmentationScore({
        startMin: 890,
        durationMin: 20,
        claims: STYLING,
        bookings: [colour],
        load: 4,
      }),
    };
    const plain = candidate(1200);

    const r = rankAndSelect({
      candidates: [plain, inside],
      durationMin: 20,
      claims: STYLING,
      resourceType: 'styling',
      probe: flatProbe,
    });
    const smart = r.offers.find((o) => o.badges.includes('SMART_PICK'));
    expect(smart?.startMin).toBe(890);
    expect(smart?.badges).toContain('OVERLAP');
  });
});

describe('sampling picks the best of each band, spread across the day', () => {
  function at(startMin: number, frag: number): Candidate {
    return {
      slot: toSlot(startMin),
      startMin,
      endMin: startMin + 20,
      staffId: 'tara',
      alsoAvailable: [],
      fragmentation: {
        score: frag,
        flushBefore: false,
        flushAfter: false,
        sliverBeforeMin: null,
        sliverAfterMin: null,
        insideProcessing: false,
        behindHighRisk: false,
      },
    };
  }

  it('does not cluster three offers into the first hour', () => {
    // 140 identical starts, five minutes apart, all the same score.
    const candidates = Array.from({ length: 140 }, (_, i) =>
      at(600 + i * 5, 2.4),
    );
    const r = rankAndSelect({
      candidates,
      durationMin: 20,
      claims: { preMin: 5, postMin: 10 },
      resourceType: 'styling',
      probe: (extra) => (extra.length === 0 ? 60 : 59),
    });
    const starts = r.offers.map((o) => o.startMin);
    expect(starts).toHaveLength(3);
    expect(Math.max(...starts) - Math.min(...starts)).toBeGreaterThan(120);
  });

  it('takes the best-shaped start inside each band', () => {
    const candidates = [at(600, 1), at(610, 9), at(620, 2), at(700, 5)];
    const measured = sampleForMeasurement(candidates, 25, 24);
    expect(measured.has(toSlot(610))).toBe(true);
    expect(measured.has(toSlot(620))).toBe(false);
    expect(measured.has(toSlot(700))).toBe(true);
  });

  it('always measures the earliest, even when its band has a better start', () => {
    const candidates = [at(600, 1), at(610, 9)];
    expect(sampleForMeasurement(candidates, 25, 24).has(toSlot(600))).toBe(
      true,
    );
  });

  it('respects the measurement limit', () => {
    const candidates = Array.from({ length: 140 }, (_, i) =>
      at(600 + i * 5, 1),
    );
    expect(sampleForMeasurement(candidates, 25, 8).size).toBeLessThanOrEqual(8);
  });
});
