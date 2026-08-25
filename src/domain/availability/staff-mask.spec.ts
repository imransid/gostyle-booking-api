import { describe, it, expect } from 'vitest';
import {
  startMask,
  gapBetween,
  chainClaims,
  chainDuration,
  NO_CLAIMS,
  BufferClaims,
  Shift,
  StaffBooking,
  Chain,
} from './staff-mask';
import { toSlots, bitAt, popcount, NONE, Mask } from './mask';
import { toSlot, toMin, formatMinute, SLOTS } from './grid';

const COLOUR: BufferClaims = { preMin: 10, postMin: 20 };
const STYLING: BufferClaims = { preMin: 5, postMin: 10 };
const ROOM: BufferClaims = { preMin: 10, postMin: 15 };

const FULL_DAY: Shift = { startMin: 600, endMin: 1320 };
const MAYA_SHIFT: Shift = { startMin: 600, endMin: 1080 };

const OVERLAP_ON = { overlapAllowed: true };
const OVERLAP_OFF = { overlapAllowed: false };

function starts(m: Mask): string[] {
  return toSlots(m).map(toMin).map(formatMinute);
}
function firstStart(m: Mask): string | null {
  return starts(m)[0] ?? null;
}
function lastStart(m: Mask): string | null {
  const s = starts(m);
  return s[s.length - 1] ?? null;
}

describe('the chain must finish inside the shift', () => {
  it('an empty diary offers the shift, minus the chain AND its buffers', () => {
    const m = startMask(
      MAYA_SHIFT,
      [],
      { durationMin: 105, claims: COLOUR },
      OVERLAP_ON,
    );
    expect(firstStart(m)).toBe('10:10'); // 10:00 + 10 setup
    expect(lastStart(m)).toBe('15:55'); // 15:55 + 105 + 20 = 18:00
  });

  it('the TEARDOWN must finish inside the shift too, not just the service', () => {
    const m = startMask(
      MAYA_SHIFT,
      [],
      { durationMin: 105, claims: COLOUR },
      OVERLAP_ON,
    );
    expect(bitAt(m, toSlot(955))).toBe(true); // 15:55, teardown ends 18:00
    expect(bitAt(m, toSlot(960))).toBe(false); // 16:00, teardown runs to 18:05
    expect(bitAt(m, toSlot(975))).toBe(false); // 16:15, teardown runs to 18:20
  });

  it('a chain longer than the shift offers nothing at all', () => {
    const shortShift: Shift = { startMin: 600, endMin: 660 };
    expect(
      startMask(
        shortShift,
        [],
        { durationMin: 105, claims: COLOUR },
        OVERLAP_ON,
      ),
    ).toBe(NONE);
  });

  it('a chain exactly the length of the shift offers exactly one start', () => {
    const shift: Shift = { startMin: 600, endMin: 705 };
    const m = startMask(
      shift,
      [],
      { durationMin: 105, claims: NO_CLAIMS },
      OVERLAP_ON,
    );
    expect(starts(m)).toEqual(['10:00']);
  });
});

describe('the larger claim wins, never the sum', () => {
  it('20 next to 5 needs 20, not 25', () => {
    expect(gapBetween(20, 5)).toBe(20);
    expect(gapBetween(5, 20)).toBe(20);
    expect(gapBetween(20, 5)).not.toBe(25);
  });

  it('a styling job can start 20 minutes after a colour ends, not 25', () => {
    const colour: StaffBooking = { startMin: 840, endMin: 960, claims: COLOUR };
    const m = startMask(
      FULL_DAY,
      [colour],
      { durationMin: 45, claims: STYLING },
      OVERLAP_OFF,
    );
    expect(bitAt(m, toSlot(980))).toBe(true);
    expect(bitAt(m, toSlot(975))).toBe(false);
  });

  it('and the same rule applies on the near side', () => {
    const colour: StaffBooking = {
      startMin: 900,
      endMin: 1020,
      claims: COLOUR,
    };
    const m = startMask(
      FULL_DAY,
      [colour],
      { durationMin: 45, claims: STYLING },
      OVERLAP_OFF,
    );
    expect(bitAt(m, toSlot(845))).toBe(true);
    expect(bitAt(m, toSlot(850))).toBe(false);
  });

  it('zero claims on both sides means jobs can sit flush', () => {
    const block: StaffBooking = {
      startMin: 900,
      endMin: 960,
      claims: NO_CLAIMS,
    };
    const m = startMask(
      FULL_DAY,
      [block],
      { durationMin: 30, claims: NO_CLAIMS },
      OVERLAP_OFF,
    );
    expect(bitAt(m, toSlot(960))).toBe(true);
    expect(bitAt(m, toSlot(870))).toBe(true);
    expect(bitAt(m, toSlot(875))).toBe(false);
  });

  it('summing would have cost this diary a sellable start', () => {
    const colour: StaffBooking = { startMin: 840, endMin: 960, claims: COLOUR };
    const chain: Chain = { durationMin: 45, claims: STYLING };
    const correct = startMask(FULL_DAY, [colour], chain, OVERLAP_OFF);
    const summed = startMask(
      FULL_DAY,
      [{ ...colour, claims: { preMin: 10, postMin: 25 } }],
      chain,
      OVERLAP_OFF,
    );
    expect(popcount(correct) - popcount(summed)).toBe(1);
  });
});

describe('existing work blocks the starts that would collide', () => {
  const booking: StaffBooking = { startMin: 900, endMin: 1005, claims: COLOUR };

  it('cannot start on top of it', () => {
    const m = startMask(
      FULL_DAY,
      [booking],
      { durationMin: 45, claims: NO_CLAIMS },
      OVERLAP_OFF,
    );
    expect(bitAt(m, toSlot(900))).toBe(false);
    expect(bitAt(m, toSlot(930))).toBe(false);
    expect(bitAt(m, toSlot(1000))).toBe(false);
  });

  it('the morning before it and the evening after it survive', () => {
    const m = startMask(
      FULL_DAY,
      [booking],
      { durationMin: 45, claims: NO_CLAIMS },
      OVERLAP_OFF,
    );
    expect(bitAt(m, toSlot(600))).toBe(true);
    expect(bitAt(m, toSlot(1200))).toBe(true);
  });

  it('two bookings leave a hole between them, sellable if big enough', () => {
    const a: StaffBooking = { startMin: 660, endMin: 720, claims: NO_CLAIMS };
    const b: StaffBooking = { startMin: 840, endMin: 900, claims: NO_CLAIMS };
    const m = startMask(
      FULL_DAY,
      [a, b],
      { durationMin: 60, claims: NO_CLAIMS },
      OVERLAP_OFF,
    );
    expect(bitAt(m, toSlot(720))).toBe(true);
    expect(bitAt(m, toSlot(780))).toBe(true);
    expect(bitAt(m, toSlot(785))).toBe(false);
  });

  it('a hole smaller than the chain offers nothing inside it', () => {
    const a: StaffBooking = { startMin: 900, endMin: 960, claims: NO_CLAIMS };
    const b: StaffBooking = { startMin: 990, endMin: 1050, claims: NO_CLAIMS };
    const m = startMask(
      FULL_DAY,
      [a, b],
      { durationMin: 60, claims: NO_CLAIMS },
      OVERLAP_OFF,
    );
    for (let t = 960; t < 990; t += 5) {
      expect(bitAt(m, toSlot(t))).toBe(false);
    }
  });

  it('time off is just a booking with no claims', () => {
    const lunch: StaffBooking = {
      startMin: 780,
      endMin: 840,
      claims: NO_CLAIMS,
    };
    const m = startMask(
      FULL_DAY,
      [lunch],
      { durationMin: 30, claims: NO_CLAIMS },
      OVERLAP_OFF,
    );
    expect(bitAt(m, toSlot(780))).toBe(false);
    expect(bitAt(m, toSlot(840))).toBe(true);
  });
});

describe('the hands-free processing band (Figure 5)', () => {
  const anyaColour: StaffBooking = {
    startMin: 840,
    endMin: 965,
    claims: COLOUR,
    processing: { fromMin: 45, toMin: 85 },
  };
  const fringeTrim: Chain = { durationMin: 20, claims: STYLING };

  it('a 20-minute trim fits inside the guarded interior', () => {
    const m = startMask(FULL_DAY, [anyaColour], fringeTrim, OVERLAP_ON);
    expect(starts(m).filter((t) => t >= '13:35' && t < '16:25')).toEqual([
      '14:50',
      '14:55',
      '15:00',
    ]);
  });

  it('and 16:25 is free again, 20 minutes after the colour ends', () => {
    const m = startMask(FULL_DAY, [anyaColour], fringeTrim, OVERLAP_ON);
    expect(bitAt(m, toSlot(985))).toBe(true);
    expect(bitAt(m, toSlot(980))).toBe(false);
  });

  it('15:05 is refused because the trim would run past the guard', () => {
    const m = startMask(FULL_DAY, [anyaColour], fringeTrim, OVERLAP_ON);
    expect(bitAt(m, toSlot(905))).toBe(false);
  });

  it('the flag is per person: a trainee gets nothing back', () => {
    const on = startMask(FULL_DAY, [anyaColour], fringeTrim, OVERLAP_ON);
    const off = startMask(FULL_DAY, [anyaColour], fringeTrim, OVERLAP_OFF);
    expect(popcount(on) - popcount(off)).toBe(3);
    expect(bitAt(off, toSlot(890))).toBe(false);
  });

  it('a job too long for the guarded interior is not offered there', () => {
    const longJob: Chain = { durationMin: 45, claims: STYLING };
    const on = startMask(FULL_DAY, [anyaColour], longJob, OVERLAP_ON);
    const off = startMask(FULL_DAY, [anyaColour], longJob, OVERLAP_OFF);
    expect(popcount(on)).toBe(popcount(off));
  });

  it('a band with no room after the guards carves nothing', () => {
    const tinyBand: StaffBooking = {
      startMin: 840,
      endMin: 965,
      claims: COLOUR,
      processing: { fromMin: 45, toMin: 52 },
    };
    const on = startMask(FULL_DAY, [tinyBand], fringeTrim, OVERLAP_ON);
    const off = startMask(FULL_DAY, [tinyBand], fringeTrim, OVERLAP_OFF);
    expect(popcount(on)).toBe(popcount(off));
  });

  it('carving is per booking, so a second booking still blocks its own time', () => {
    const inTheBand: StaffBooking = {
      startMin: 890,
      endMin: 910,
      claims: NO_CLAIMS,
    };
    const m = startMask(
      FULL_DAY,
      [anyaColour, inTheBand],
      fringeTrim,
      OVERLAP_ON,
    );
    expect(bitAt(m, toSlot(890))).toBe(false);
    expect(bitAt(m, toSlot(895))).toBe(false);
    expect(bitAt(m, toSlot(910))).toBe(false);
  });
});

describe('chain composition', () => {
  it('duration is the sum of the parts', () => {
    expect(chainDuration([105, 45])).toBe(150);
    expect(chainDuration([])).toBe(0);
  });

  it('only the outer claims face the neighbours', () => {
    expect(chainClaims([COLOUR, STYLING])).toEqual({ preMin: 10, postMin: 10 });
  });

  it('a single service presents its own claims', () => {
    expect(chainClaims([ROOM])).toEqual(ROOM);
  });

  it('an empty chain claims nothing', () => {
    expect(chainClaims([])).toEqual(NO_CLAIMS);
  });
});

describe('invariants that must hold for any diary', () => {
  function randomBookings(n: number): StaffBooking[] {
    const out: StaffBooking[] = [];
    let cursor = 600;
    for (let i = 0; i < n; i++) {
      cursor += 5 * Math.floor(Math.random() * 12);
      const dur = 5 * (3 + Math.floor(Math.random() * 20));
      if (cursor + dur > 1320) break;
      out.push({
        startMin: cursor,
        endMin: cursor + dur,
        claims: Math.random() < 0.5 ? COLOUR : STYLING,
      });
      cursor += dur;
    }
    return out;
  }

  it('no offered start ever overlaps an existing booking, across 300 diaries', () => {
    for (let t = 0; t < 300; t++) {
      const bookings = randomBookings(6);
      const dur = 5 * (3 + Math.floor(Math.random() * 12));
      const m = startMask(
        FULL_DAY,
        bookings,
        { durationMin: dur, claims: STYLING },
        OVERLAP_OFF,
      );
      for (const slot of toSlots(m)) {
        const start = toMin(slot);
        const end = start + dur;
        for (const b of bookings) {
          expect(start < b.endMin && end > b.startMin).toBe(false);
        }
      }
    }
  });

  it('adding a booking never adds a start, across 200 diaries', () => {
    for (let t = 0; t < 200; t++) {
      const bookings = randomBookings(4);
      const chain: Chain = { durationMin: 30, claims: STYLING };
      const before = popcount(
        startMask(FULL_DAY, bookings, chain, OVERLAP_OFF),
      );
      const extra: StaffBooking = {
        startMin: 1100,
        endMin: 1160,
        claims: STYLING,
      };
      const after = popcount(
        startMask(FULL_DAY, [...bookings, extra], chain, OVERLAP_OFF),
      );
      expect(after).toBeLessThanOrEqual(before);
    }
  });

  it('every offered start lies inside the shift', () => {
    for (let t = 0; t < 100; t++) {
      const bookings = randomBookings(5);
      const dur = 5 * (3 + Math.floor(Math.random() * 10));
      const m = startMask(
        MAYA_SHIFT,
        bookings,
        { durationMin: dur, claims: COLOUR },
        OVERLAP_OFF,
      );
      for (const slot of toSlots(m)) {
        expect(toMin(slot)).toBeGreaterThanOrEqual(MAYA_SHIFT.startMin);
        expect(toMin(slot) + dur).toBeLessThanOrEqual(MAYA_SHIFT.endMin);
      }
    }
  });

  it('a mask never sets a bit outside the 144-slot day', () => {
    const m = startMask(
      FULL_DAY,
      [],
      { durationMin: 5, claims: NO_CLAIMS },
      OVERLAP_ON,
    );
    expect(m >> BigInt(SLOTS)).toBe(0n);
  });
});
