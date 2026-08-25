import { describe, it, expect } from 'vitest';
import {
  feasibleSet,
  eligible,
  expandChain,
  alignmentMask,
  staffAvailableAt,
  isEmpty,
  Professional,
  Service,
  FeasibilityRequest,
  DESK_CHANNEL,
  ONLINE_CHANNEL,
  WHOLE_DAY,
} from './feasible';
import { StaffBooking, BufferClaims, Shift } from './staff-mask';
import { ResourceType, ChairOccupation } from './capacity';
import { NONE, popcount, toSlots, bitAt } from './mask';
import { toSlot, toMin, formatMinute } from './grid';

// ---------------------------------------------------------------- the salon

const COLOUR_CLAIMS: BufferClaims = { preMin: 10, postMin: 20 };
const STYLING_CLAIMS: BufferClaims = { preMin: 5, postMin: 10 };
const NAIL_CLAIMS: BufferClaims = { preMin: 5, postMin: 10 };

const TEN_TO_SIX: Shift = { startMin: 600, endMin: 1080 };
const TEN_TO_TEN: Shift = { startMin: 600, endMin: 1320 };

function pro(
  id: string,
  name: string,
  skills: Record<string, number>,
  extra: Partial<Professional> = {},
): Professional {
  return {
    id,
    name,
    skills: new Map(Object.entries(skills)),
    shift: TEN_TO_TEN,
    overlapAllowed: false,
    bookingsToday: 0,
    ...extra,
  };
}

const ANYA = pro(
  'anya',
  'Anya V.',
  { color: 3, hair: 2 },
  { overlapAllowed: true },
);
const MAYA = pro('maya', 'Maya E.', { color: 2, hair: 3 });
const REEM = pro('reem', 'Reem S.', { hair: 2 }, { shift: TEN_TO_SIX });
const LINA = pro('lina', 'Lina K.', { nail: 3 });
const TRAINEE = pro('tara', 'Tara N.', { hair: 1 });

const STAFF = [ANYA, MAYA, REEM, LINA, TRAINEE];

const COLOUR_SERVICE: Service = {
  id: 'svc-colour',
  name: 'Full color and gloss',
  skill: 'color',
  requiredLevel: 2,
  durationMin: 125,
  resourceType: 'color',
  claims: COLOUR_CLAIMS,
  processing: { fromMin: 45, toMin: 85 },
  releasesChairDuringProcessing: true,
};

const BLOWDRY: Service = {
  id: 'svc-blowdry',
  name: 'Signature blow-dry',
  skill: 'hair',
  requiredLevel: 2,
  durationMin: 45,
  resourceType: 'styling',
  claims: STYLING_CLAIMS,
};

const MANICURE: Service = {
  id: 'svc-nail',
  name: 'Gel manicure',
  skill: 'nail',
  requiredLevel: 2,
  durationMin: 60,
  resourceType: 'nail',
  claims: NAIL_CLAIMS,
};

const RESOURCES: ResourceType[] = [
  { id: 'color', units: 2, outOfService: 0, changeoverMin: 5 },
  { id: 'styling', units: 4, outOfService: 1, changeoverMin: 0 },
  { id: 'nail', units: 3, outOfService: 0, changeoverMin: 0 },
];

function request(over: Partial<FeasibilityRequest> = {}): FeasibilityRequest {
  return {
    services: [BLOWDRY],
    professionals: STAFF,
    staffBookings: new Map(),
    resources: RESOURCES,
    occupations: [],
    channel: DESK_CHANNEL,
    window: WHOLE_DAY,
    preferredStaffId: null,
    isToday: false,
    nowMin: 825,
    dailyCap: 8,
    ...over,
  };
}

function firstOffer(mask: bigint): string | null {
  const s = toSlots(mask);
  return s[0] === undefined ? null : formatMinute(toMin(s[0]));
}

// ---------------------------------------------------------------- eligibility

describe('who may take this chain', () => {
  it('only people holding every required skill at the required level', () => {
    const r = eligible(STAFF, [BLOWDRY], null, 8);
    expect(r.pool).toEqual(['anya', 'maya', 'reem']);
  });

  it('a trainee at level 1 is refused a level 2 service, and it says why', () => {
    const r = eligible(STAFF, [BLOWDRY], null, 8);
    expect(r.excluded.get('tara')).toEqual({
      kind: 'missing_skills',
      skills: ['hair'],
    });
  });

  it('a two-service chain needs BOTH skills, not either', () => {
    const r = eligible(STAFF, [COLOUR_SERVICE, BLOWDRY], null, 8);
    expect(r.pool).toEqual(['anya', 'maya']);
    expect(r.excluded.get('reem')).toEqual({
      kind: 'missing_skills',
      skills: ['color'],
    });
  });

  it('nobody covering the chain is an empty pool, not a crash', () => {
    const impossible: Service = { ...MANICURE, skill: 'falconry' };
    expect(eligible(STAFF, [impossible], null, 8).pool).toEqual([]);
  });

  it('the daily cap drops a professional out of the pool', () => {
    const busy = [{ ...MAYA, bookingsToday: 8 }, ANYA];
    const r = eligible(busy, [BLOWDRY], null, 8);
    expect(r.pool).toEqual(['anya']);
    expect(r.excluded.get('maya')).toEqual({ kind: 'daily_cap', cap: 8 });
  });

  it('a preference narrows the pool to one', () => {
    const r = eligible(STAFF, [BLOWDRY], 'maya', 8);
    expect(r.pool).toEqual(['maya']);
    expect(r.excluded.get('anya')).toEqual({ kind: 'not_preferred' });
  });

  it('a preference for someone unqualified reports the skill, not the preference', () => {
    const r = eligible(STAFF, [COLOUR_SERVICE], 'reem', 8);
    expect(r.pool).toEqual([]);
    expect(r.excluded.get('reem')).toEqual({
      kind: 'missing_skills',
      skills: ['color'],
    });
  });
});

// ---------------------------------------------------------------- the chain

describe('laying the chain out', () => {
  it('a plain service is one segment', () => {
    expect(expandChain([BLOWDRY])).toEqual([
      { offsetMin: 0, durationMin: 45, resourceType: 'styling' },
    ]);
  });

  it('a colour that releases the chair becomes three segments', () => {
    expect(expandChain([COLOUR_SERVICE])).toEqual([
      { offsetMin: 0, durationMin: 45, resourceType: 'color' },
      { offsetMin: 45, durationMin: 40, resourceType: null },
      { offsetMin: 85, durationMin: 40, resourceType: 'color' },
    ]);
  });

  it('a colour that KEEPS the chair stays one segment', () => {
    const held: Service = {
      ...COLOUR_SERVICE,
      releasesChairDuringProcessing: false,
    };
    expect(expandChain([held])).toEqual([
      { offsetMin: 0, durationMin: 125, resourceType: 'color' },
    ]);
  });

  it('services are laid end to end with running offsets', () => {
    const segs = expandChain([COLOUR_SERVICE, BLOWDRY]);
    expect(segs[segs.length - 1]).toEqual({
      offsetMin: 125,
      durationMin: 45,
      resourceType: 'styling',
    });
  });
});

// ---------------------------------------------------------------- alignment

describe('what the channel is willing to offer', () => {
  it('the desk offers every 5 minutes', () => {
    const m = alignmentMask(DESK_CHANNEL, WHOLE_DAY, 45, false, 0);
    expect(bitAt(m, toSlot(905))).toBe(true);
  });

  it('online offers only every 15 minutes', () => {
    const m = alignmentMask(ONLINE_CHANNEL, WHOLE_DAY, 45, false, 0);
    expect(bitAt(m, toSlot(900))).toBe(true);
    expect(bitAt(m, toSlot(905))).toBe(false);
    expect(bitAt(m, toSlot(915))).toBe(true);
  });

  it('the chain must finish before the branch closes', () => {
    const m = alignmentMask(DESK_CHANNEL, WHOLE_DAY, 45, false, 0);
    expect(toSlots(m).map(toMin).pop()).toBe(1275);
  });

  it('today, the desk lead time is 15 minutes', () => {
    const m = alignmentMask(DESK_CHANNEL, WHOLE_DAY, 45, true, 825);
    expect(firstOffer(m)).toBe('14:00');
  });

  it('today, online lead time is 60 minutes and rounds up to the grain', () => {
    const m = alignmentMask(ONLINE_CHANNEL, WHOLE_DAY, 45, true, 825);
    expect(firstOffer(m)).toBe('14:45');
  });

  it('a future day ignores the lead time entirely', () => {
    const m = alignmentMask(DESK_CHANNEL, WHOLE_DAY, 45, false, 825);
    expect(firstOffer(m)).toBe('10:00');
  });

  it('a day part narrows the window on both sides', () => {
    const m = alignmentMask(
      DESK_CHANNEL,
      { fromMin: 840, toMin: 1020 },
      45,
      false,
      0,
    );
    expect(firstOffer(m)).toBe('14:00');
    expect(toSlots(m).map(toMin).pop()).toBe(1015);
  });
});

// ---------------------------------------------------------------- the union

describe('the feasible set', () => {
  it('an empty salon offers the whole day to three professionals', () => {
    const r = feasibleSet(request());
    expect(r.pool).toEqual(['anya', 'maya', 'reem']);
    // 10:05, not 10:00: a styling setup is 5 minutes and the whole chain,
    // buffers included, has to fit inside the shift.
    expect(firstOffer(r.union)).toBe('10:05');
    expect(isEmpty(r)).toBe(false);
  });

  it('the union is what can be offered, per-staff is who could take it', () => {
    const r = feasibleSet(request());
    expect(staffAvailableAt(r, toSlot(900)).sort()).toEqual([
      'anya',
      'maya',
      'reem',
    ]);
  });

  it('Reem finishes at 18:00, so late starts belong to the others only', () => {
    const r = feasibleSet(request());
    expect(staffAvailableAt(r, toSlot(1200)).sort()).toEqual(['anya', 'maya']);
    expect(bitAt(r.perStaff.get('reem') ?? NONE, toSlot(1200))).toBe(false);
  });

  it('one busy professional does not close the slot while others are free', () => {
    const mayaBusy: StaffBooking[] = [
      { startMin: 900, endMin: 1005, claims: COLOUR_CLAIMS },
    ];
    const r = feasibleSet(
      request({
        staffBookings: new Map([['maya', mayaBusy]]),
      }),
    );
    expect(bitAt(r.perStaff.get('maya') ?? NONE, toSlot(900))).toBe(false);
    expect(bitAt(r.union, toSlot(900))).toBe(true);
    expect(staffAvailableAt(r, toSlot(900)).sort()).toEqual(['anya', 'reem']);
  });

  it('when EVERY eligible professional is busy, the slot closes', () => {
    const busy: StaffBooking[] = [
      { startMin: 900, endMin: 1005, claims: COLOUR_CLAIMS },
    ];
    const r = feasibleSet(
      request({
        staffBookings: new Map([
          ['anya', busy],
          ['maya', busy],
          ['reem', busy],
        ]),
      }),
    );
    expect(bitAt(r.union, toSlot(900))).toBe(false);
  });

  it('no chair means no offer, however free the staff are', () => {
    const allStations: ChairOccupation[] = [
      { resourceType: 'nail', startMin: 600, endMin: 1320 },
      { resourceType: 'nail', startMin: 600, endMin: 1320 },
      { resourceType: 'nail', startMin: 600, endMin: 1320 },
    ];
    const r = feasibleSet(
      request({
        services: [MANICURE],
        occupations: allStations,
      }),
    );
    expect(r.pool).toEqual(['lina']);
    expect(r.capacityMask).toBe(NONE);
    expect(isEmpty(r)).toBe(true);
  });

  it('an empty pool short-circuits to an empty union', () => {
    const r = feasibleSet(
      request({ services: [{ ...MANICURE, skill: 'falconry' }] }),
    );
    expect(r.pool).toEqual([]);
    expect(r.union).toBe(NONE);
  });

  it('a closed day offers nothing and says so through an empty window', () => {
    const r = feasibleSet(request({ window: { fromMin: 600, toMin: 600 } }));
    expect(r.alignmentMask).toBe(NONE);
    expect(isEmpty(r)).toBe(true);
  });

  it('online sees roughly a third of what the desk sees', () => {
    const desk = feasibleSet(request({ channel: DESK_CHANNEL }));
    const online = feasibleSet(request({ channel: ONLINE_CHANNEL }));
    expect(popcount(online.union) * 3).toBeGreaterThanOrEqual(
      popcount(desk.union) - 3,
    );
    expect(popcount(online.union)).toBeLessThan(popcount(desk.union));
  });
});

// ---------------------------------------------------------------- worked case

describe('Dana books Full color and gloss', () => {
  const dana = () => request({ services: [COLOUR_SERVICE] });

  it('only the colourists are eligible', () => {
    expect(feasibleSet(dana()).pool).toEqual(['anya', 'maya']);
  });

  it('the chain is 125 minutes with a 10 in front and 20 behind', () => {
    const r = feasibleSet(dana());
    expect(r.durationMin).toBe(125);
    expect(r.claims).toEqual({ preMin: 10, postMin: 20 });
  });

  it('the last start leaves room for the TEARDOWN before closing', () => {
    // 19:55 + 125 lands exactly on 22:00, but the colour station is then
    // being cleaned until 22:20, twenty minutes after the salon shut.
    const r = feasibleSet(dana());
    expect(toSlots(r.union).map(toMin).pop()).toBe(1175);
    expect(1175 + 125 + 20).toBe(1320);
  });

  it('Anya own colour opens a fringe-trim window for her, not for Maya', () => {
    const anyaColour: StaffBooking = {
      startMin: 840,
      endMin: 965,
      claims: COLOUR_CLAIMS,
      processing: { fromMin: 45, toMin: 85 },
    };
    const trim: Service = {
      id: 'svc-trim',
      name: 'Fringe trim',
      skill: 'hair',
      requiredLevel: 2,
      durationMin: 20,
      resourceType: 'styling',
      claims: STYLING_CLAIMS,
    };

    const r = feasibleSet(
      request({
        services: [trim],
        staffBookings: new Map([
          ['anya', [anyaColour]],
          ['maya', [anyaColour]],
        ]),
      }),
    );

    expect(bitAt(r.perStaff.get('anya') ?? NONE, toSlot(890))).toBe(true);
    expect(bitAt(r.perStaff.get('maya') ?? NONE, toSlot(890))).toBe(false);
  });

  it('every offered start survives all four filters, across 100 random days', () => {
    for (let trial = 0; trial < 100; trial++) {
      const bookings = new Map<string, StaffBooking[]>();
      for (const id of ['anya', 'maya']) {
        const list: StaffBooking[] = [];
        let cursor = 600;
        for (let i = 0; i < 3; i++) {
          cursor += 5 * Math.floor(Math.random() * 20);
          const dur = 5 * (6 + Math.floor(Math.random() * 12));
          if (cursor + dur > 1320) break;
          list.push({
            startMin: cursor,
            endMin: cursor + dur,
            claims: COLOUR_CLAIMS,
          });
          cursor += dur;
        }
        bookings.set(id, list);
      }

      const r = feasibleSet(
        request({ services: [COLOUR_SERVICE], staffBookings: bookings }),
      );

      for (const slot of toSlots(r.union)) {
        const t = toMin(slot);
        expect(t + r.durationMin).toBeLessThanOrEqual(1320);
        expect(t % 5).toBe(0);
        expect(staffAvailableAt(r, slot).length).toBeGreaterThan(0);
        for (const id of staffAvailableAt(r, slot)) {
          for (const b of bookings.get(id) ?? []) {
            expect(t < b.endMin && t + r.durationMin > b.startMin).toBe(false);
          }
        }
      }
    }
  });
});
