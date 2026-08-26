import { describe, it, expect } from 'vitest';
import { due, pending, LADDER, type BookingClock } from './reminders';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const NOW = 1_800_000_000_000;

function booking(over: Partial<BookingClock> = {}): BookingClock {
  return {
    startAtMs: NOW + 48 * HOUR,
    reminded24hAt: null,
    reminded3hAt: null,
    nudged15mAt: null,
    ...over,
  };
}

describe('the ladder', () => {
  it('is three rungs, furthest out first', () => {
    expect(LADDER.map((s) => s.rung)).toEqual([
      'confirm_24h',
      'day_of_3h',
      'running_late_15m',
    ]);
  });

  it('nothing is due two days out', () => {
    expect(due(booking(), NOW).kind).toBe('nothing');
  });

  it('the 24h rung fires inside its window', () => {
    const v = due(booking({ startAtMs: NOW + 20 * HOUR }), NOW);
    expect(v.kind).toBe('send');
    expect(v.kind === 'send' && v.spec.rung).toBe('confirm_24h');
  });

  it('exactly 24 hours out is inside, not too early', () => {
    expect(due(booking({ startAtMs: NOW + 24 * HOUR }), NOW).kind).toBe('send');
  });

  it('a minute past 24 hours is too early', () => {
    expect(due(booking({ startAtMs: NOW + 24 * HOUR + MIN }), NOW).kind).toBe(
      'nothing',
    );
  });

  it('the 3h rung fires once the 24h one is done', () => {
    const v = due(
      booking({ startAtMs: NOW + 2 * HOUR, reminded24hAt: NOW - HOUR }),
      NOW,
    );
    expect(v.kind === 'send' && v.spec.rung).toBe('day_of_3h');
  });

  it('the 15m nudge fires last', () => {
    const v = due(
      booking({
        startAtMs: NOW + 10 * MIN,
        reminded24hAt: NOW - HOUR,
        reminded3hAt: NOW - HOUR,
      }),
      NOW,
    );
    expect(v.kind === 'send' && v.spec.rung).toBe('running_late_15m');
  });

  it('a sent rung is never sent twice', () => {
    const b = booking({ startAtMs: NOW + 20 * HOUR, reminded24hAt: NOW });
    expect(due(b, NOW).kind).toBe('nothing');
  });

  it('all three sent means nothing left', () => {
    const b = booking({
      startAtMs: NOW + 5 * MIN,
      reminded24hAt: NOW,
      reminded3hAt: NOW,
      nudged15mAt: NOW,
    });
    expect(due(b, NOW).kind).toBe('nothing');
    expect(pending(b)).toEqual([]);
  });
});

describe('A LATE BOOKING DOES NOT FIRE THE WHOLE LADDER AT ONCE', () => {
  it('booked two hours out: the 24h rung is skipped, not sent', () => {
    const v = due(booking({ startAtMs: NOW + 2 * HOUR }), NOW);
    expect(v.kind).toBe('skip');
    expect(v.kind === 'skip' && v.spec.rung).toBe('confirm_24h');
    expect(v.kind === 'skip' && v.why).toContain('a later rung covers it');
  });

  it('and the 3h rung then fires properly', () => {
    // After the skip is recorded, the same booking is due its 3h nudge.
    const v = due(
      booking({ startAtMs: NOW + 2 * HOUR, reminded24hAt: NOW }),
      NOW,
    );
    expect(v.kind === 'send' && v.spec.rung).toBe('day_of_3h');
  });

  it('booked ten minutes out: both earlier rungs skip', () => {
    let b = booking({ startAtMs: NOW + 10 * MIN });
    expect(due(b, NOW).kind).toBe('skip');

    b = { ...b, reminded24hAt: NOW };
    expect(due(b, NOW).kind).toBe('skip');

    b = { ...b, reminded3hAt: NOW };
    expect(due(b, NOW).kind === 'send').toBe(true);
  });

  it('THE POINT: the customer gets one message, not three', () => {
    let b = booking({ startAtMs: NOW + 10 * MIN });
    let sent = 0;
    for (let i = 0; i < 5; i++) {
      const v = due(b, NOW);
      if (v.kind === 'nothing') break;
      if (v.kind === 'send') sent += 1;
      b = { ...b, [v.spec.column]: NOW };
    }
    expect(sent).toBe(1);
  });
});

describe('a visit that has already started', () => {
  it('sends nothing, and says why', () => {
    const v = due(booking({ startAtMs: NOW - 5 * MIN }), NOW);
    expect(v.kind).toBe('skip');
    expect(v.kind === 'skip' && v.why).toBe('the visit has already started');
  });

  it('the ladder drains rather than looping forever', () => {
    let b = booking({ startAtMs: NOW - HOUR });
    for (let i = 0; i < 3; i++) {
      const v = due(b, NOW);
      expect(v.kind).toBe('skip');
      b = { ...b, [(v as { spec: { column: string } }).spec.column]: NOW };
    }
    expect(due(b, NOW).kind).toBe('nothing');
  });
});

describe('invariants', () => {
  it('every rung fires at most once, whatever the start time', () => {
    for (const offset of [
      -HOUR,
      0,
      5 * MIN,
      30 * MIN,
      2 * HOUR,
      20 * HOUR,
      48 * HOUR,
    ]) {
      let b = booking({ startAtMs: NOW + offset });
      const seen = new Set<string>();
      for (let i = 0; i < 10; i++) {
        const v = due(b, NOW);
        if (v.kind === 'nothing') break;
        expect(seen.has(v.spec.rung)).toBe(false);
        seen.add(v.spec.rung);
        b = { ...b, [v.spec.column]: NOW };
      }
    }
  });

  it('the ladder always terminates in at most three steps', () => {
    for (const offset of [-HOUR, 0, 90 * MIN, 25 * HOUR]) {
      let b = booking({ startAtMs: NOW + offset });
      let steps = 0;
      while (due(b, NOW).kind !== 'nothing' && steps < 10) {
        const v = due(b, NOW);
        b = { ...b, [(v as { spec: { column: string } }).spec.column]: NOW };
        steps += 1;
      }
      expect(steps).toBeLessThanOrEqual(3);
    }
  });

  it('at most one message is ever sent for a same-day booking', () => {
    for (const offset of [5 * MIN, 30 * MIN, 2 * HOUR]) {
      let b = booking({ startAtMs: NOW + offset });
      let sent = 0;
      for (let i = 0; i < 5; i++) {
        const v = due(b, NOW);
        if (v.kind === 'nothing') break;
        if (v.kind === 'send') sent += 1;
        b = { ...b, [v.spec.column]: NOW };
      }
      expect(sent).toBe(1);
    }
  });
});
