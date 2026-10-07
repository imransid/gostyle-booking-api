import { describe, it, expect } from 'vitest';
import {
  ALL,
  NONE,
  Mask,
  rangeMask,
  rangeMaskMinutes,
  bitAt,
  setBit,
  clearBit,
  popcount,
  runsAtLeast,
  runsAtLeastMinutes,
  toSlots,
  fromSlots,
  firstSlot,
  render,
} from './mask';
import {
  SLOTS,
  GRID_START_MIN,
  GRID_END_MIN,
  DEFAULT_TRADING_WINDOW,
  toSlot,
  toMin,
  durationToSlots,
  isInsideWindow,
  formatMinute,
} from './grid';

// ---------------------------------------------------------------- the oracle
// A deliberately stupid boolean-array implementation. Obviously correct and
// far too slow to ship. Every fast function is checked against it.

type Oracle = boolean[];

function oracleFromMask(m: Mask): Oracle {
  return Array.from({ length: SLOTS }, (_, i) => bitAt(m, i));
}

function oracleRange(from: number, to: number): Oracle {
  const a = Math.max(0, Math.trunc(from));
  const b = Math.min(SLOTS, Math.trunc(to));
  return Array.from({ length: SLOTS }, (_, i) => i >= a && i < b);
}

function oracleRunsAtLeast(o: Oracle, n: number): Oracle {
  return o.map((_, i) => {
    for (let k = 0; k < n; k++) {
      if (i + k >= SLOTS) return false;
      if (!o[i + k]) return false;
    }
    return true;
  });
}

function oraclePopcount(o: Oracle): number {
  return o.filter(Boolean).length;
}

function sameAsOracle(m: Mask, o: Oracle): boolean {
  for (let i = 0; i < SLOTS; i++) {
    if (bitAt(m, i) !== o[i]) return false;
  }
  return true;
}

describe('grid: minutes and slots', () => {
  it('the grid is the whole clock day, exactly 288 slots', () => {
    expect(SLOTS).toBe(288);
    expect(GRID_START_MIN).toBe(0);
    expect(GRID_END_MIN).toBe(1440);
  });

  it('00:00 is slot 0, 10:00 is slot 120, 15:00 is slot 180, 23:55 is slot 287', () => {
    expect(toSlot(0)).toBe(0);
    expect(toSlot(600)).toBe(120);
    expect(toSlot(900)).toBe(180);
    expect(toSlot(1435)).toBe(287);
  });

  it('round-trips', () => {
    for (let s = 0; s < SLOTS; s++) expect(toSlot(toMin(s))).toBe(s);
  });

  it('Dana at 15:00 renders as 15:00', () => {
    expect(formatMinute(toMin(180))).toBe('15:00');
  });

  it('the default trading window is still 10:00-22:00', () => {
    expect(DEFAULT_TRADING_WINDOW).toEqual({ openMin: 600, closeMin: 1320 });
  });

  it('a 105-minute colour is 21 slots', () => {
    expect(durationToSlots(105)).toBe(21);
  });

  it('rounds a ragged duration up, never down', () => {
    expect(durationToSlots(23)).toBe(5);
  });

  it('knows what falls outside the trading window', () => {
    const w = DEFAULT_TRADING_WINDOW;
    expect(isInsideWindow(599, w)).toBe(false);
    expect(isInsideWindow(600, w)).toBe(true);
    expect(isInsideWindow(1319, w)).toBe(true);
    expect(isInsideWindow(1320, w)).toBe(false);
  });

  it('a window open all day takes every minute of the grid', () => {
    const w = { openMin: GRID_START_MIN, closeMin: GRID_END_MIN };
    expect(isInsideWindow(0, w)).toBe(true);
    expect(isInsideWindow(1439, w)).toBe(true);
    expect(isInsideWindow(1440, w)).toBe(false);
  });
});

describe('mask: single bits', () => {
  it('ALL has every slot, NONE has none', () => {
    expect(popcount(ALL)).toBe(SLOTS);
    expect(popcount(NONE)).toBe(0);
  });

  it('ALL does not spill past slot 287', () => {
    expect(bitAt(ALL, 287)).toBe(true);
    expect(ALL >> BigInt(SLOTS)).toBe(0n);
  });

  it('set then clear returns to empty', () => {
    const m = setBit(NONE, 60);
    expect(bitAt(m, 60)).toBe(true);
    expect(bitAt(clearBit(m, 60), 60)).toBe(false);
  });

  it('ignores slots outside the day instead of corrupting the mask', () => {
    expect(setBit(NONE, -1)).toBe(NONE);
    expect(setBit(NONE, 288)).toBe(NONE);
    expect(bitAt(ALL, 288)).toBe(false);
  });
});

describe('mask: rangeMask', () => {
  it('is half-open, so back-to-back does not overlap', () => {
    const first = rangeMask(0, 21);
    const second = rangeMask(21, 30);
    expect(first & second).toBe(NONE);
  });

  it('Dana 15:00 to 16:45 is slots 180 to 200', () => {
    const m = rangeMaskMinutes(900, 1005);
    expect(popcount(m)).toBe(21);
    expect(bitAt(m, 180)).toBe(true);
    expect(bitAt(m, 200)).toBe(true);
    expect(bitAt(m, 201)).toBe(false);
  });

  it('clamps instead of throwing', () => {
    expect(rangeMask(-50, 5)).toBe(rangeMask(0, 5));
    expect(rangeMask(140, 999)).toBe(rangeMask(140, SLOTS));
  });

  it('an inverted or empty range is empty', () => {
    expect(rangeMask(50, 50)).toBe(NONE);
    expect(rangeMask(80, 20)).toBe(NONE);
  });

  it('matches the oracle across 300 random ranges', () => {
    for (let t = 0; t < 300; t++) {
      const a = Math.floor(Math.random() * 200) - 30;
      const b = a + Math.floor(Math.random() * 200) - 30;
      expect(sameAsOracle(rangeMask(a, b), oracleRange(a, b))).toBe(true);
    }
  });
});

describe('mask: runsAtLeast, the doubling trick', () => {
  it('a run of 1 is the mask itself', () => {
    const m = fromSlots([3, 10, 11, 12]);
    expect(runsAtLeast(m, 1)).toBe(m);
    expect(runsAtLeast(m, 0)).toBe(m);
  });

  it('finds where a run of 3 begins', () => {
    const m = fromSlots([10, 11, 12, 20, 21]);
    expect(toSlots(runsAtLeast(m, 3))).toEqual([10]);
  });

  it('a run of 2 begins at 10, 11 and 20', () => {
    const m = fromSlots([10, 11, 12, 20, 21]);
    expect(toSlots(runsAtLeast(m, 2))).toEqual([10, 11, 20]);
  });

  it('a gap kills the run', () => {
    const m = fromSlots([10, 11, 13, 14]);
    expect(runsAtLeast(m, 3)).toBe(NONE);
  });

  it('a run cannot start where it would fall off the end of the day', () => {
    const m = rangeMask(SLOTS - 4, SLOTS);
    expect(toSlots(runsAtLeast(m, 4))).toEqual([SLOTS - 4]);
    expect(runsAtLeast(m, 5)).toBe(NONE);
  });

  it('Dana: a 105-minute colour needs 21 slots', () => {
    const openAfternoon = rangeMaskMinutes(900, 1020);
    const starts = runsAtLeastMinutes(openAfternoon, 105);
    expect(toSlots(starts).map(toMin).map(formatMinute)).toEqual([
      '15:00',
      '15:05',
      '15:10',
      '15:15',
    ]);
  });

  it('matches the oracle across 400 random masks and lengths', () => {
    for (let t = 0; t < 400; t++) {
      let m: Mask = NONE;
      for (let i = 0; i < SLOTS; i++) {
        if (Math.random() < 0.6) m = setBit(m, i);
      }
      const n = 1 + Math.floor(Math.random() * 30);
      const fast = runsAtLeast(m, n);
      const slow = oracleRunsAtLeast(oracleFromMask(m), n);
      expect(sameAsOracle(fast, slow)).toBe(true);
    }
  });

  it('matches the oracle on a fully free day, every length 1 to 40', () => {
    for (let n = 1; n <= 40; n++) {
      expect(
        sameAsOracle(
          runsAtLeast(ALL, n),
          oracleRunsAtLeast(oracleFromMask(ALL), n),
        ),
      ).toBe(true);
    }
  });
});

describe('mask: popcount', () => {
  it('counts a range', () => {
    expect(popcount(rangeMask(10, 31))).toBe(21);
  });

  it('matches the oracle across 200 random masks', () => {
    for (let t = 0; t < 200; t++) {
      let m: Mask = NONE;
      for (let i = 0; i < SLOTS; i++) {
        if (Math.random() < 0.5) m = setBit(m, i);
      }
      expect(popcount(m)).toBe(oraclePopcount(oracleFromMask(m)));
    }
  });
});

describe('mask: composing an answer, the way the engine will', () => {
  it('free slots first, THEN runs, THEN alignment', () => {
    const shift = rangeMaskMinutes(600, 1080);
    const capacity = rangeMaskMinutes(840, 1020);
    let alignment: Mask = NONE;
    for (let i = 0; i < SLOTS; i++) {
      if (toMin(i) % 15 === 0) alignment = setBit(alignment, i);
    }

    const free = shift & capacity;
    const validStarts = runsAtLeastMinutes(free, 15);
    const offered = validStarts & alignment;

    const starts = toSlots(offered).map(toMin);
    expect(starts.length).toBeGreaterThan(0);
    for (const t of starts) {
      expect(t % 15).toBe(0);
      expect(t).toBeGreaterThanOrEqual(840);
      expect(t + 15).toBeLessThanOrEqual(1020);
    }
    expect(starts[0]).toBe(840);
  });

  it('ANDing alignment BEFORE runsAtLeast returns nothing, and that is the trap', () => {
    const free = rangeMaskMinutes(840, 1020);
    let alignment: Mask = NONE;
    for (let i = 0; i < SLOTS; i++) {
      if (toMin(i) % 15 === 0) alignment = setBit(alignment, i);
    }
    expect(runsAtLeastMinutes(free & alignment, 15)).toBe(NONE);
    expect(popcount(runsAtLeastMinutes(free, 15) & alignment)).toBeGreaterThan(
      0,
    );
  });

  it('an empty window is a legitimate answer, not a crash', () => {
    const shift = rangeMaskMinutes(600, 720);
    const capacity = rangeMaskMinutes(1000, 1100);
    expect(shift & capacity).toBe(NONE);
    expect(firstSlot(shift & capacity)).toBeNull();
  });

  it('firstSlot finds the EARLIEST offer', () => {
    expect(firstSlot(fromSlots([200, 180, 220]))).toBe(180);
    expect(toMin(firstSlot(fromSlots([200, 180, 220])) ?? -1)).toBe(900);
  });
});

describe('mask: render', () => {
  it('draws 288 characters', () => {
    expect(render(ALL)).toHaveLength(SLOTS);
    expect(render(NONE)).toBe('.'.repeat(SLOTS));
    expect(render(rangeMask(0, 3)).slice(0, 5)).toBe('###..');
  });
});
