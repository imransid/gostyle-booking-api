import { describe, it, expect } from 'vitest';
import {
  ResourceType,
  ChairOccupation,
  ChainSegment,
  effectiveUnits,
  usageTimeline,
  capacityFreeMask,
  unitsFreeAt,
  chainCapacityMask,
  capacityFreeByType,
} from './capacity';
import { Mask, NONE, ALL, bitAt, popcount, toSlots } from './mask';
import { SLOTS, toSlot, toMin } from './grid';

const STYLING: ResourceType = {
  id: 'styling',
  units: 4,
  outOfService: 1,
  changeoverMin: 0,
};
const COLOUR: ResourceType = {
  id: 'color',
  units: 2,
  outOfService: 0,
  changeoverMin: 5,
};
const WASH: ResourceType = {
  id: 'wash',
  units: 2,
  outOfService: 0,
  changeoverMin: 0,
};
const NAIL: ResourceType = {
  id: 'nail',
  units: 3,
  outOfService: 0,
  changeoverMin: 0,
};
const BROW: ResourceType = {
  id: 'brow',
  units: 1,
  outOfService: 0,
  changeoverMin: 0,
};
const ROOM: ResourceType = {
  id: 'room',
  units: 2,
  outOfService: 0,
  changeoverMin: 10,
};

const REGISTRY = [STYLING, COLOUR, WASH, NAIL, BROW, ROOM];

function occ(type: string, from: number, to: number): ChairOccupation {
  return { resourceType: type, startMin: from, endMin: to };
}
function freeAt(m: Mask, minute: number): boolean {
  return bitAt(m, toSlot(minute));
}

describe('the chair registry, not a configuration number', () => {
  it('S4 is out of service, so styling has 3 units not 4', () => {
    expect(effectiveUnits(STYLING)).toBe(3);
  });

  it('the launch branch effective capacity', () => {
    expect(REGISTRY.map((r) => [r.id, effectiveUnits(r)])).toEqual([
      ['styling', 3],
      ['color', 2],
      ['wash', 2],
      ['nail', 3],
      ['brow', 1],
      ['room', 2],
    ]);
  });

  it('a closed floor removes its units and nothing is sellable', () => {
    const closed: ResourceType = { ...COLOUR, outOfService: 2 };
    expect(effectiveUnits(closed)).toBe(0);
    expect(capacityFreeMask(closed, [])).toBe(NONE);
  });

  it('more out of service than exist clamps at zero', () => {
    expect(effectiveUnits({ ...BROW, outOfService: 5 })).toBe(0);
  });
});

describe('capacity is counted, not excluded', () => {
  it('an empty day leaves every slot free', () => {
    expect(popcount(capacityFreeMask(COLOUR, []))).toBe(SLOTS);
  });

  it('one colour booking still leaves the second station free', () => {
    const m = capacityFreeMask(COLOUR, [occ('color', 900, 1005)]);
    expect(freeAt(m, 900)).toBe(true);
    expect(freeAt(m, 960)).toBe(true);
  });

  it('two overlapping colour bookings use both stations, so nothing is free', () => {
    const m = capacityFreeMask(COLOUR, [
      occ('color', 900, 1005),
      occ('color', 900, 1005),
    ]);
    expect(freeAt(m, 900)).toBe(false);
    expect(freeAt(m, 1000)).toBe(false);
    expect(freeAt(m, 1015)).toBe(true);
  });

  it('the brow bar has one unit, so one booking closes it', () => {
    const m = capacityFreeMask(BROW, [occ('brow', 900, 945)]);
    expect(freeAt(m, 900)).toBe(false);
    expect(freeAt(m, 940)).toBe(false);
    expect(freeAt(m, 945)).toBe(true);
  });

  it('a booking on another type does not touch this one', () => {
    const m = capacityFreeMask(COLOUR, [occ('nail', 900, 1005)]);
    expect(popcount(m)).toBe(SLOTS);
  });

  it('unitsFreeAt answers the refusal message', () => {
    const taken = [occ('color', 900, 1005), occ('color', 930, 1020)];
    expect(unitsFreeAt(COLOUR, taken, 870)).toBe(2);
    expect(unitsFreeAt(COLOUR, taken, 910)).toBe(1);
    expect(unitsFreeAt(COLOUR, taken, 950)).toBe(0);
  });
});

describe('changeover extends chair time, never staff time', () => {
  it('a treatment room is held 10 minutes after the visit ends', () => {
    const m = capacityFreeMask({ ...ROOM, units: 1 }, [occ('room', 900, 975)]);
    expect(freeAt(m, 975)).toBe(false);
    expect(freeAt(m, 980)).toBe(false);
    expect(freeAt(m, 985)).toBe(true);
  });

  it('a colour station is held 5 minutes', () => {
    const m = capacityFreeMask({ ...COLOUR, units: 1 }, [
      occ('color', 900, 1005),
    ]);
    expect(freeAt(m, 1005)).toBe(false);
    expect(freeAt(m, 1010)).toBe(true);
  });

  it('a type with no changeover frees the instant the visit ends', () => {
    const m = capacityFreeMask({ ...NAIL, units: 1 }, [occ('nail', 900, 960)]);
    expect(freeAt(m, 960)).toBe(true);
  });
});

describe('the difference array counts concurrency correctly', () => {
  it('three staggered bookings peak at three', () => {
    const t = usageTimeline({ ...NAIL, units: 99 }, [
      occ('nail', 600, 900),
      occ('nail', 700, 900),
      occ('nail', 800, 900),
    ]);
    expect(t[toSlot(650)]).toBe(1);
    expect(t[toSlot(750)]).toBe(2);
    expect(t[toSlot(850)]).toBe(3);
    expect(t[toSlot(905)]).toBe(0);
  });

  it('matches a naive per-slot count across 200 random days', () => {
    for (let trial = 0; trial < 200; trial++) {
      const occs: ChairOccupation[] = [];
      for (let i = 0; i < 8; i++) {
        const s = 600 + 5 * Math.floor(Math.random() * 130);
        const d = 5 * (1 + Math.floor(Math.random() * 24));
        occs.push(occ('nail', s, Math.min(1320, s + d)));
      }
      const type: ResourceType = { ...NAIL, units: 99, changeoverMin: 0 };
      const fast = usageTimeline(type, occs);

      for (let i = 0; i < SLOTS; i++) {
        const t = toMin(i);
        const slow = occs.filter((o) => o.startMin <= t && o.endMin > t).length;
        expect(fast[i]).toBe(slow);
      }
    }
  });

  it('a booking running past closing is clipped, not dropped', () => {
    const t = usageTimeline({ ...NAIL, units: 99 }, [occ('nail', 1300, 1400)]);
    expect(t[SLOTS - 1]).toBe(1);
    expect(t.length).toBe(SLOTS);
  });
});

describe('the chain needs a chair for every segment, at the right moment', () => {
  const free = () => capacityFreeByType(REGISTRY, []);

  it('a single-segment chain is just that resource', () => {
    const segs: ChainSegment[] = [
      { offsetMin: 0, durationMin: 60, resourceType: 'nail' },
    ];
    expect(popcount(chainCapacityMask(free(), segs))).toBe(SLOTS - 12 + 1);
  });

  it('a chain with no chair at all is always capacity-feasible', () => {
    const segs: ChainSegment[] = [
      { offsetMin: 0, durationMin: 60, resourceType: null },
    ];
    expect(chainCapacityMask(free(), segs)).toBe(ALL);
  });

  it('an unknown resource type is never sellable', () => {
    const segs: ChainSegment[] = [
      { offsetMin: 0, durationMin: 30, resourceType: 'helipad' },
    ];
    expect(chainCapacityMask(free(), segs)).toBe(NONE);
  });

  it('the OFFSET is what makes this hard, and it is respected', () => {
    const segs: ChainSegment[] = [
      { offsetMin: 0, durationMin: 45, resourceType: 'color' },
      { offsetMin: 45, durationMin: 15, resourceType: 'wash' },
    ];
    const busy = capacityFreeByType(REGISTRY, [
      occ('wash', 945, 960),
      occ('wash', 945, 960),
    ]);
    const m = chainCapacityMask(busy, segs);

    expect(freeAt(m, 900)).toBe(false);
    expect(freeAt(m, 840)).toBe(true);
    expect(freeAt(m, 915)).toBe(true);
  });

  it('a processing segment holds no chair, so the middle returns to capacity', () => {
    const withRelease: ChainSegment[] = [
      { offsetMin: 0, durationMin: 45, resourceType: 'color' },
      { offsetMin: 45, durationMin: 40, resourceType: null },
      { offsetMin: 85, durationMin: 40, resourceType: 'color' },
    ];
    const held: ChainSegment[] = [
      { offsetMin: 0, durationMin: 125, resourceType: 'color' },
    ];
    const busy = capacityFreeByType(REGISTRY, [
      occ('color', 945, 980),
      occ('color', 945, 980),
    ]);

    expect(freeAt(chainCapacityMask(busy, withRelease), 900)).toBe(true);
    expect(freeAt(chainCapacityMask(busy, held), 900)).toBe(false);
  });

  it('the last segment must also finish before closing', () => {
    const segs: ChainSegment[] = [
      { offsetMin: 0, durationMin: 60, resourceType: 'nail' },
      { offsetMin: 60, durationMin: 60, resourceType: 'nail' },
    ];
    const m = chainCapacityMask(free(), segs);
    expect(toSlots(m).map(toMin).pop()).toBe(1200);
  });

  it('a busier salon can only lose starts, never gain them', () => {
    const segs: ChainSegment[] = [
      { offsetMin: 0, durationMin: 45, resourceType: 'color' },
      { offsetMin: 45, durationMin: 15, resourceType: 'wash' },
    ];
    for (let trial = 0; trial < 100; trial++) {
      const base: ChairOccupation[] = [];
      for (let i = 0; i < 4; i++) {
        const s = 600 + 5 * Math.floor(Math.random() * 120);
        base.push(occ(Math.random() < 0.5 ? 'color' : 'wash', s, s + 60));
      }
      const before = popcount(
        chainCapacityMask(capacityFreeByType(REGISTRY, base), segs),
      );
      const extra = occ('color', 700, 800);
      const after = popcount(
        chainCapacityMask(capacityFreeByType(REGISTRY, [...base, extra]), segs),
      );
      expect(after).toBeLessThanOrEqual(before);
    }
  });
});

describe('Figure 7: the worked example', () => {
  it('with one colour station instead of two, 10:00 and 10:30 also drop', () => {
    const segs: ChainSegment[] = [
      { offsetMin: 0, durationMin: 105, resourceType: 'color' },
    ];
    const taken = [occ('color', 600, 705)];

    const twoStations = chainCapacityMask(
      capacityFreeByType([COLOUR], taken),
      segs,
    );
    const oneStation = chainCapacityMask(
      capacityFreeByType([{ ...COLOUR, units: 1 }], taken),
      segs,
    );

    expect(freeAt(twoStations, 600)).toBe(true);
    expect(freeAt(twoStations, 630)).toBe(true);
    expect(freeAt(oneStation, 600)).toBe(false);
    expect(freeAt(oneStation, 630)).toBe(false);
    expect(popcount(oneStation)).toBeLessThan(popcount(twoStations));
  });

  it('every offered start really does have a chair, across 60 random days', () => {
    const segs: ChainSegment[] = [
      { offsetMin: 0, durationMin: 60, resourceType: 'color' },
    ];

    for (let trial = 0; trial < 60; trial++) {
      const occs: ChairOccupation[] = [];
      for (let i = 0; i < 5; i++) {
        const s = 600 + 5 * Math.floor(Math.random() * 130);
        occs.push(occ('color', s, Math.min(1320, s + 60)));
      }
      const m = chainCapacityMask(capacityFreeByType([COLOUR], occs), segs);

      for (const slot of toSlots(m)) {
        for (let t = toMin(slot); t < toMin(slot) + 60; t += 5) {
          const inUse = occs.filter(
            (o) => o.startMin <= t && o.endMin + COLOUR.changeoverMin > t,
          ).length;
          expect(inUse).toBeLessThan(effectiveUnits(COLOUR));
        }
      }
    }
  });
});
