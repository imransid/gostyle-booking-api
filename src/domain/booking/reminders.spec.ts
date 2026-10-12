import { describe, it, expect } from 'vitest';
import {
  due,
  pending,
  claimable,
  claimVerdict,
  earlierColumns,
  rungSpec,
  windowCloseMs,
  LADDER,
  type BookingClock,
  type Rung,
} from './reminders';

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

describe('where each rung goes', () => {
  it('24h and 3h go by push and email, the 15m nudge by push only', () => {
    expect(LADDER.map((s) => [s.rung, s.channels])).toEqual([
      ['confirm_24h', ['push', 'email']],
      ['day_of_3h', ['push', 'email']],
      ['running_late_15m', ['push']],
    ]);
  });

  it("a rung's window closes where the next rung's opens", () => {
    const start = NOW + 30 * HOUR;
    expect(windowCloseMs(rungSpec('confirm_24h'), start)).toBe(
      start - 3 * HOUR,
    );
    expect(windowCloseMs(rungSpec('day_of_3h'), start)).toBe(start - 15 * MIN);
    expect(windowCloseMs(rungSpec('running_late_15m'), start)).toBe(start);
  });
});

describe('THE CLAIM IS FOR ONE RUNG, AND ONLY THAT RUNG', () => {
  it('a rung waits for every earlier rung to be stamped', () => {
    expect(earlierColumns(rungSpec('confirm_24h'))).toEqual([]);
    expect(earlierColumns(rungSpec('day_of_3h'))).toEqual(['reminded24hAt']);
    expect(earlierColumns(rungSpec('running_late_15m'))).toEqual([
      'reminded24hAt',
      'reminded3hAt',
    ]);
  });

  it('a booking moved to two hours out is not claimable by the 3h pass first', () => {
    // A reschedule clears all three stamps. If it lands between the 24h pass
    // and the 3h pass of one tick, the 3h pass sees an open 24h rung.
    const moved = booking({ startAtMs: NOW + 2 * HOUR });
    expect(claimable(rungSpec('day_of_3h'), moved, NOW)).toBe(false);
    expect(claimable(rungSpec('confirm_24h'), moved, NOW)).toBe(true);
  });

  it('a claim that is not its turn is released, never marked handled', () => {
    // The bug, reproduced: the 3h claim stamped its column, and `due` judged
    // the open 24h rung instead. Before the fix that counted as handled.
    const moved = booking({ startAtMs: NOW + 2 * HOUR, reminded3hAt: NOW });
    const v = claimVerdict(rungSpec('day_of_3h'), moved, NOW);
    expect(v.kind).toBe('release');
    expect(v.kind === 'release' && v.why).toContain('confirm_24h');
  });

  it.each([
    ['confirm_24h', 20 * HOUR, {}],
    ['day_of_3h', 2 * HOUR, { reminded24hAt: NOW }],
    ['running_late_15m', 10 * MIN, { reminded24hAt: NOW, reminded3hAt: NOW }],
  ] as const)('a %s claim answers only for %s', (rung, until, stamps) => {
    const spec = rungSpec(rung);
    const v = claimVerdict(
      spec,
      booking({ startAtMs: NOW + until, ...stamps, [spec.column]: NOW }),
      NOW,
    );
    expect(v.kind).toBe('send');
    expect(v.kind !== 'release' && v.spec.rung).toBe(rung);
  });

  it('a claim inside its own window but past it skips, for that rung', () => {
    const v = claimVerdict(
      rungSpec('confirm_24h'),
      booking({ startAtMs: NOW + 2 * HOUR, reminded24hAt: NOW }),
      NOW,
    );
    expect(v.kind).toBe('skip');
    expect(v.kind === 'skip' && v.spec.rung).toBe('confirm_24h');
  });
});

/**
 * The scheduler, minute by minute, with nothing but the domain: every tick
 * runs the rungs furthest out first, claims what is claimable, and stamps
 * what was claimed unless the verdict released it. Exactly what
 * ReminderRepository.runLadder does against the database.
 */
function simulate(
  b: BookingClock,
  fromMs: number,
  toMs: number,
  between?: (tickMs: number, afterRung: Rung, b: BookingClock) => BookingClock,
): { rung: Rung; atMs: number }[] {
  const sent: { rung: Rung; atMs: number }[] = [];
  let clock = b;
  for (let t = fromMs; t <= toMs; t += MIN) {
    for (const spec of LADDER) {
      if (claimable(spec, clock, t)) {
        const v = claimVerdict(spec, { ...clock, [spec.column]: t }, t);
        if (v.kind !== 'release') clock = { ...clock, [spec.column]: t };
        if (v.kind === 'send') sent.push({ rung: spec.rung, atMs: t });
      }
      if (between) clock = between(t, spec.rung, clock);
    }
  }
  return sent;
}

describe('a booking five days out (October 6, for October 11 at 10:00)', () => {
  const start = NOW + 5 * 24 * HOUR;
  const sent = simulate(booking({ startAtMs: start }), NOW, start);

  it('hears exactly three times, once per rung', () => {
    expect(sent.map((s) => s.rung)).toEqual([
      'confirm_24h',
      'day_of_3h',
      'running_late_15m',
    ]);
  });

  it('at 24 hours, 3 hours and 15 minutes before the start', () => {
    expect(sent.map((s) => (start - s.atMs) / MIN)).toEqual([24 * 60, 180, 15]);
  });
});

describe('a booking made close to its start', () => {
  it('two hours out: one message, the 3h one', () => {
    const start = NOW + 2 * HOUR;
    const sent = simulate(booking({ startAtMs: start }), NOW, start);
    expect(sent.map((s) => s.rung)).toEqual(['day_of_3h', 'running_late_15m']);
    expect(sent[0]!.atMs).toBe(NOW);
  });

  it('ten minutes out: one message, the 15m nudge', () => {
    const start = NOW + 10 * MIN;
    const sent = simulate(booking({ startAtMs: start }), NOW, start);
    expect(sent.map((s) => s.rung)).toEqual(['running_late_15m']);
  });

  it('moved inside the tick, between the 24h and 3h passes: the 3h message still goes', () => {
    // Starts tomorrow; already had its 24h reminder. At NOW the desk moves it
    // to two hours out, and the move commits right after the 24h pass.
    const sent = simulate(
      booking({ startAtMs: NOW + 26 * HOUR, reminded24hAt: NOW - 2 * HOUR }),
      NOW,
      NOW + 2 * HOUR,
      (t, afterRung, b) =>
        t === NOW && afterRung === 'confirm_24h'
          ? {
              startAtMs: NOW + 2 * HOUR,
              reminded24hAt: null,
              reminded3hAt: null,
              nudged15mAt: null,
            }
          : b,
    );
    expect(sent.map((s) => s.rung)).toEqual(['day_of_3h', 'running_late_15m']);
    // One tick late, never lost.
    expect(sent[0]!.atMs).toBe(NOW + MIN);
  });
});
