import { describe, it, expect } from 'vitest';
import {
  planCompaction,
  slivers,
  strandedMinutes,
  isSliver,
  MAX_MOVES,
  MAX_MOVE_MIN,
  MIN_STRANDED_GAIN_MIN,
  type DiaryBooking,
} from './compaction';
import { MIN_SELLABLE_MIN } from './grid';

const b = (
  code: string,
  startMin: number,
  durationMin: number,
  over: Partial<DiaryBooking> = {},
): DiaryBooking => ({
  bookingId: code,
  code,
  staffId: 'maya',
  startMin,
  endMin: startMin + durationMin,
  ...over,
});

describe('what counts as a sliver', () => {
  it('is a gap under the sellable minimum', () => {
    expect(isSliver(MIN_SELLABLE_MIN - 1)).toBe(true);
    expect(isSliver(MIN_SELLABLE_MIN)).toBe(false);
    expect(isSliver(0)).toBe(false);
  });

  it('uses the same 25 minutes the rest of the engine uses', () => {
    expect(MIN_SELLABLE_MIN).toBe(25);
  });
});

describe('finding slivers', () => {
  it('finds a gap between two bookings', () => {
    const day = [b('A', 600, 45), b('B', 665, 45)]; // 20-minute gap
    expect(slivers(day)).toEqual([
      { staffId: 'maya', fromMin: 645, toMin: 665, minutes: 20 },
    ]);
  });

  it('ignores a sellable gap', () => {
    const day = [b('A', 600, 45), b('B', 700, 45)]; // 55 minutes
    expect(slivers(day)).toEqual([]);
  });

  it('ignores back-to-back bookings', () => {
    const day = [b('A', 600, 45), b('B', 645, 45)];
    expect(slivers(day)).toEqual([]);
  });

  it('keeps professionals apart', () => {
    // Maya's end and Anya's start are not a gap in anybody's day.
    const day = [b('A', 600, 45), b('B', 665, 45, { staffId: 'anya' })];
    expect(slivers(day)).toEqual([]);
  });

  it('totals stranded minutes across the diary', () => {
    const day = [
      b('A', 600, 45),
      b('B', 665, 45), // 20 stranded
      b('C', 730, 45), // 20 stranded
    ];
    expect(strandedMinutes(day)).toBe(40);
  });
});

describe('the plan', () => {
  it('closes a sliver by pulling the later booking earlier', () => {
    const day = [b('A', 600, 45), b('B', 665, 45)];
    const plan = planCompaction(day);
    expect(plan.moves.length).toBe(1);
    expect(plan.moves[0]?.code).toBe('B');
    expect(plan.moves[0]?.toStartMin).toBe(645);
    expect(plan.strandedAfterMin).toBe(0);
  });

  it('never proposes a start before the salon opens', () => {
    // A 10:00 booking can only go later. Moving it earlier closes the gap
    // just as well on paper and the salon is shut.
    const day = [b('A', 600, 45), b('B', 665, 45)];
    for (const m of planCompaction(day).moves) {
      expect(m.toStartMin).toBeGreaterThanOrEqual(600);
    }
  });

  it('never proposes an end after the salon closes', () => {
    const day = [b('A', 1200, 45), b('B', 1265, 45)]; // last one ends 21:50
    for (const m of planCompaction(day).moves) {
      expect(m.toStartMin + 45).toBeLessThanOrEqual(1320);
    }
  });

  it('reports the gain', () => {
    const plan = planCompaction([b('A', 600, 45), b('B', 665, 45)]);
    expect(plan.strandedBeforeMin).toBe(20);
    expect(plan.gainMin).toBe(20);
  });

  it('rejects a move that saves four minutes or fewer', () => {
    // A four-minute gain is cosmetic shuffling, and the rule says more than
    // four, not at least four.
    const day = [b('A', 600, 45), b('B', 649, 45)]; // 4-minute gap
    const plan = planCompaction(day);
    expect(plan.moves).toEqual([]);
    expect(plan.strandedBeforeMin).toBe(MIN_STRANDED_GAIN_MIN);
    expect(plan.explanation).toMatch(
      new RegExp(`no move clears more than ${MIN_STRANDED_GAIN_MIN}`),
    );
  });

  it('never moves a booking more than thirty minutes', () => {
    const day = [b('A', 600, 45), b('B', 665, 45), b('C', 900, 45)];
    for (const m of planCompaction(day).moves) {
      expect(Math.abs(m.deltaMin)).toBeLessThanOrEqual(MAX_MOVE_MIN);
    }
  });

  it('moves in five-minute steps', () => {
    // The STEP is five minutes. Real starts are always on the grid already,
    // so a grid-aligned booking moved by a multiple of five stays on it.
    const day = [b('A', 600, 45), b('B', 665, 45)];
    for (const m of planCompaction(day).moves) {
      expect(Math.abs(m.deltaMin) % 5).toBe(0);
      expect(m.toStartMin % 5).toBe(0);
    }
  });

  it('proposes at most three moves', () => {
    const day = [
      b('A', 600, 30),
      b('B', 650, 30),
      b('C', 700, 30),
      b('D', 750, 30),
      b('E', 800, 30),
      b('F', 850, 30),
    ];
    expect(planCompaction(day).moves.length).toBeLessThanOrEqual(MAX_MOVES);
  });

  it('never moves the same booking twice', () => {
    const day = [
      b('A', 600, 30),
      b('B', 650, 30),
      b('C', 700, 30),
      b('D', 750, 30),
    ];
    const ids = planCompaction(day).moves.map((m) => m.bookingId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never lands a booking on top of another', () => {
    const day = [b('A', 600, 45), b('B', 665, 45), b('C', 720, 45)];
    const plan = planCompaction(day);
    const after = day.map((x) => {
      const m = plan.moves.find((mv) => mv.bookingId === x.bookingId);
      return m === undefined
        ? x
        : {
            ...x,
            startMin: m.toStartMin,
            endMin: m.toStartMin + (x.endMin - x.startMin),
          };
    });
    for (let i = 0; i < after.length; i += 1) {
      for (let j = i + 1; j < after.length; j += 1) {
        const p = after[i]!;
        const q = after[j]!;
        if (p.staffId !== q.staffId) continue;
        expect(p.startMin < q.endMin && q.startMin < p.endMin).toBe(false);
      }
    }
  });

  it('leaves a clean day alone', () => {
    const plan = planCompaction([b('A', 600, 45), b('B', 645, 45)]);
    expect(plan.moves).toEqual([]);
    expect(plan.explanation).toMatch(/Nothing to compact/);
  });
});

describe('eligibility', () => {
  it('will not move a group lane', () => {
    // A party arrives together. Its timing means something beyond the diary.
    const day = [
      b('A', 600, 45),
      b('B', 665, 45, { ineligible: 'group_lane' }),
    ];
    expect(planCompaction(day).moves.map((m) => m.code)).not.toContain('B');
  });

  it('will not move a recurring occurrence', () => {
    const day = [
      b('A', 600, 45),
      b('B', 665, 45, { ineligible: 'series_occurrence' }),
    ];
    expect(planCompaction(day).moves.map((m) => m.code)).not.toContain('B');
  });

  it('will not move anything that is not plainly confirmed', () => {
    const day = [
      b('A', 600, 45),
      b('B', 665, 45, { ineligible: 'not_confirmed' }),
    ];
    expect(planCompaction(day).moves.map((m) => m.code)).not.toContain('B');
  });

  it('proposes nothing at all when BOTH ends are frozen', () => {
    const day = [
      b('A', 600, 45, { ineligible: 'group_lane' }),
      b('B', 665, 45, { ineligible: 'series_occurrence' }),
    ];
    expect(planCompaction(day).moves).toEqual([]);
  });

  it('still moves the eligible neighbour when one end is frozen', () => {
    // A is movable, B is not: push A later to close the gap.
    const day = [
      b('A', 600, 45, {}),
      b('B', 665, 45, { ineligible: 'series_occurrence' }),
    ];
    const plan = planCompaction(day);
    expect(plan.moves.map((m) => m.code)).toEqual(['A']);
    expect(plan.moves[0]?.deltaMin).toBe(20);
    expect(plan.strandedAfterMin).toBe(0);
  });
});

describe('the note the desk reads out', () => {
  it('records the original and the new time', () => {
    const plan = planCompaction([b('A', 600, 45), b('B', 665, 45)]);
    expect(plan.moves[0]?.note).toMatch(/11:05 to 10:45/);
    expect(plan.moves[0]?.note).toMatch(/stranded minutes/);
  });
});

describe('a realistic afternoon', () => {
  it('turns 35 stranded minutes into one sellable block', () => {
    // Figure 21: two consent moves.
    const day = [
      b('A', 840, 45), // 14:00-14:45
      b('B', 900, 45), // 15:00-15:45, 15 stranded
      b('C', 965, 45), // 16:05-16:50, 20 stranded
    ];
    expect(strandedMinutes(day)).toBe(35);
    const plan = planCompaction(day);
    expect(plan.strandedAfterMin).toBe(0);
    expect(plan.moves.length).toBeLessThanOrEqual(2);
    expect(plan.explanation).toMatch(
      /consent move(s?) turns? 35 stranded minutes into 0/,
    );
  });
});
