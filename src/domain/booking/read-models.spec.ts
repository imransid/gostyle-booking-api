import { describe, expect, it } from 'vitest';
import {
  MINUS,
  formatDelta,
  kpi,
  mergeSpans,
  moneyKpi,
  rankSearch,
  sellableMinutes,
  showUpRate,
  utilisation,
  wholeAed,
  categoryOf,
  conflictKindOf,
  conflictSourceOf,
  type SearchCandidate,
} from './read-models';

describe('sellableMinutes', () => {
  it('is the shift when nothing is off', () => {
    expect(
      sellableMinutes({ shift: { fromMin: 600, toMin: 1320 }, timeOff: [] }),
    ).toBe(720);
  });

  it('subtracts time off inside the shift', () => {
    expect(
      sellableMinutes({
        shift: { fromMin: 600, toMin: 1320 },
        timeOff: [{ fromMin: 960, toMin: 1140 }],
      }),
    ).toBe(720 - 180);
  });

  it('clips time off to the shift rather than over-subtracting', () => {
    // Leave 08:00-12:00 against a 10:00 start removes two hours, not four.
    expect(
      sellableMinutes({
        shift: { fromMin: 600, toMin: 1320 },
        timeOff: [{ fromMin: 480, toMin: 720 }],
      }),
    ).toBe(720 - 120);
  });

  it('ignores time off entirely outside the shift', () => {
    expect(
      sellableMinutes({
        shift: { fromMin: 600, toMin: 840 },
        timeOff: [{ fromMin: 1000, toMin: 1100 }],
      }),
    ).toBe(240);
  });

  it('counts overlapping leave once, never twice', () => {
    // THE BUG THIS EXISTS TO PREVENT: two rows covering the same afternoon
    // subtracted twice give a negative denominator and a utilisation over 1.
    expect(
      sellableMinutes({
        shift: { fromMin: 600, toMin: 1320 },
        timeOff: [
          { fromMin: 900, toMin: 1080 },
          { fromMin: 960, toMin: 1140 },
        ],
      }),
    ).toBe(720 - 240);
  });

  it('never goes negative', () => {
    expect(
      sellableMinutes({
        shift: { fromMin: 600, toMin: 700 },
        timeOff: [{ fromMin: 0, toMin: 2000 }],
      }),
    ).toBe(0);
  });

  it('is zero for a day nobody was rostered', () => {
    expect(
      sellableMinutes({ shift: { fromMin: 600, toMin: 600 }, timeOff: [] }),
    ).toBe(0);
  });
});

describe('mergeSpans', () => {
  it('merges touching and overlapping spans', () => {
    expect(
      mergeSpans([
        { fromMin: 10, toMin: 20 },
        { fromMin: 20, toMin: 30 },
        { fromMin: 25, toMin: 40 },
      ]),
    ).toEqual([{ fromMin: 10, toMin: 40 }]);
  });

  it('keeps disjoint spans apart', () => {
    expect(
      mergeSpans([
        { fromMin: 50, toMin: 60 },
        { fromMin: 10, toMin: 20 },
      ]),
    ).toEqual([
      { fromMin: 10, toMin: 20 },
      { fromMin: 50, toMin: 60 },
    ]);
  });

  it('swallows a span wholly inside another', () => {
    expect(
      mergeSpans([
        { fromMin: 10, toMin: 100 },
        { fromMin: 20, toMin: 30 },
      ]),
    ).toEqual([{ fromMin: 10, toMin: 100 }]);
  });

  it('handles nothing', () => {
    expect(mergeSpans([])).toEqual([]);
  });
});

describe('utilisation', () => {
  it('is booked over sellable', () => {
    expect(utilisation(360, 720)).toBe(0.5);
  });

  it('is 0 rather than NaN when nobody was rostered', () => {
    expect(utilisation(0, 0)).toBe(0);
    expect(Number.isNaN(utilisation(0, 0))).toBe(false);
  });

  it('never exceeds 1, even when overbooked', () => {
    expect(utilisation(900, 720)).toBe(1);
  });

  it('never goes below 0', () => {
    expect(utilisation(-10, 720)).toBe(0);
  });
});

describe('formatDelta', () => {
  it('renders a rise and a fall as percentages', () => {
    expect(formatDelta(118, 100)).toBe('+18%');
    expect(formatDelta(82, 100)).toBe(`${MINUS}18%`);
  });

  it('uses a real minus sign, not a hyphen', () => {
    expect(formatDelta(82, 100).charAt(0)).toBe('−');
    expect(formatDelta(82, 100)).not.toContain('-');
  });

  it('says 0% for no movement', () => {
    expect(formatDelta(100, 100)).toBe('0%');
  });

  it('refuses to divide by zero', () => {
    expect(formatDelta(5, 0)).toBe('new');
    expect(formatDelta(0, 0)).toBe('0%');
    expect(formatDelta(5, 0)).not.toContain('Infinity');
  });

  it('renders a rate in points', () => {
    expect(formatDelta(0.94, 0.92, 'points')).toBe('+2 pts');
    expect(formatDelta(0.9, 0.94, 'points')).toBe(`${MINUS}4 pts`);
    expect(formatDelta(0.94, 0.94, 'points')).toBe('0 pts');
  });

  it('renders an average as an absolute move', () => {
    expect(formatDelta(227, 209, 'absolute')).toBe('+18');
    expect(formatDelta(8, 11, 'absolute')).toBe(`${MINUS}3`);
    expect(formatDelta(11, 11, 'absolute')).toBe('0');
  });
});

describe('kpi and moneyKpi', () => {
  it('pairs the value with its delta', () => {
    expect(kpi(186, 158)).toEqual({ value: 186, delta: '+18%' });
  });

  it('publishes money in whole AED', () => {
    expect(moneyKpi(4_218_000, 3_456_000).value).toBe(42180);
  });

  it('computes the money delta on fils, before rounding', () => {
    // 1049 fils vs 1000 fils is +5%. Rounded to AED first, both are 10 and
    // the tile would read 0%.
    expect(moneyKpi(1049, 1000).delta).toBe('+5%');
  });

  it('rejects a fractional fil rather than rounding it away', () => {
    expect(() => wholeAed(10.5)).toThrow();
  });
});

describe('showUpRate', () => {
  it('counts only visits that concluded', () => {
    expect(showUpRate({ kept: 94, noShows: 4, lateCancels: 2 })).toBe(0.94);
  });

  it('is 1 before anything has concluded', () => {
    // A morning full of confirmed-but-not-yet-happened bookings must not
    // read as a 0% show-up rate.
    expect(showUpRate({ kept: 0, noShows: 0, lateCancels: 0 })).toBe(1);
  });

  it('is 0 when nobody turned up', () => {
    expect(showUpRate({ kept: 0, noShows: 3, lateCancels: 1 })).toBe(0);
  });
});

describe('rankSearch', () => {
  const rows: SearchCandidate[] = [
    {
      kind: 'BOOKING',
      id: 'bk_1',
      label: 'Amira Kassem · GS-1041',
      detail: '',
      code: 'GS-1041',
      haystack: ['Amira Kassem'],
    },
    {
      kind: 'CUSTOMER',
      id: 'cus_1',
      label: 'Amira Kassem',
      detail: '',
      haystack: ['Amira Kassem', '+971 55 310 4421'],
    },
    {
      kind: 'SERVICE',
      id: 'svc_1',
      label: 'Balayage',
      detail: '',
      haystack: ['Balayage'],
    },
    {
      kind: 'BOOKING',
      id: 'bk_2',
      label: 'Sara · GS-1042',
      detail: '',
      code: 'GS-1042',
      haystack: ['Sara Mahmoud', '1041 Marina Tower'],
    },
  ];

  it('puts an exact code match first', () => {
    // THE REQUIREMENT. bk_2's address contains 1041; bk_1's CODE is GS-1041.
    const out = rankSearch(rows, 'GS-1041');
    expect(out[0]?.id).toBe('bk_1');
  });

  it('matches a code regardless of case', () => {
    expect(rankSearch(rows, 'gs-1041')[0]?.id).toBe('bk_1');
  });

  it('finds a customer by name', () => {
    expect(rankSearch(rows, 'Amira').map((r) => r.id)).toContain('cus_1');
  });

  it('finds a customer by phone typed without the spaces', () => {
    expect(rankSearch(rows, '553104421').map((r) => r.id)).toContain('cus_1');
  });

  it('does not match a two-digit fragment against every phone number', () => {
    expect(rankSearch(rows, '55').map((r) => r.id)).not.toContain('cus_1');
  });

  it('finds a service by name', () => {
    expect(rankSearch(rows, 'balay')[0]?.id).toBe('svc_1');
  });

  it('returns nothing for a blank query rather than everything', () => {
    expect(rankSearch(rows, '')).toEqual([]);
    expect(rankSearch(rows, '   ')).toEqual([]);
  });

  it('returns nothing when nothing matches', () => {
    expect(rankSearch(rows, 'zzzzz')).toEqual([]);
  });

  it('honours the limit', () => {
    expect(rankSearch(rows, 'a', 2).length).toBe(2);
  });

  it('is stable: the same query twice gives the same order', () => {
    expect(rankSearch(rows, 'a').map((r) => r.id)).toEqual(
      rankSearch(rows, 'a').map((r) => r.id),
    );
  });
});

describe('categoryOf', () => {
  it('reads the obvious ones', () => {
    expect(categoryOf(['styling'])).toBe('Hair');
    expect(categoryOf(['nail'])).toBe('Nails');
    expect(categoryOf(['facial'])).toBe('Skin');
    expect(categoryOf(['brow'])).toBe('Brows');
  });

  it('keeps colour and styling in the same band', () => {
    // They are different chairs and the same category. The calendar needs
    // one colour for hair, not one per resource class.
    expect(categoryOf(['color'])).toBe('Hair');
    expect(categoryOf(['wash'])).toBe('Hair');
  });

  it('takes the first match for a mixed basket, not the first element', () => {
    // A colour plus a manicure must not flip band depending on which row
    // the query happened to return first.
    expect(categoryOf(['nail', 'color'])).toBe('Hair');
    expect(categoryOf(['color', 'nail'])).toBe('Hair');
  });

  it('is case-insensitive', () => {
    expect(categoryOf(['COLOR'])).toBe('Hair');
  });

  it('falls back rather than throwing on something new', () => {
    expect(categoryOf(['massage-room'])).toBe('Other');
    expect(categoryOf([])).toBe('Other');
  });
});

describe('conflictKindOf', () => {
  it('maps a closure and a chair directly', () => {
    expect(conflictKindOf('closure_sweep', false)).toBe('BRANCH_CLOSURE');
    expect(conflictKindOf('chair_out_of_service', false)).toBe('RESOURCE_OOS');
  });

  it('splits a shift conflict on whether a professional was named', () => {
    // The only interesting part: a rota edit naming nobody is a shift
    // change; one naming somebody is that person being away.
    expect(conflictKindOf('shift_conflict', true)).toBe('STAFF_OFF');
    expect(conflictKindOf('shift_conflict', false)).toBe('SHIFT_CHANGE');
  });

  it('falls back rather than returning undefined for an unknown kind', () => {
    expect(conflictKindOf('something_new', false)).toBe('SHIFT_CHANGE');
  });
});

describe('conflictSourceOf', () => {
  it('names the upstream event, not our table', () => {
    expect(conflictSourceOf('closure_sweep')).toBe('branch.closed');
    expect(conflictSourceOf('chair_out_of_service')).toBe(
      'resource.out_of_service',
    );
    expect(conflictSourceOf('shift_conflict')).toBe('staff.shift_published');
  });
});
