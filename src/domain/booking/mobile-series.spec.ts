import { describe, expect, it } from 'vitest';
import {
  EXTEND_MAX,
  LOCK_HOURS,
  MAX_ALTERNATIVES,
  MAX_FUTURE_SESSIONS,
  PAUSE_MAX_DAYS,
  ROUTINE_RULES,
  actionRefusal,
  applyPicks,
  beyondHorizon,
  cancelSummary,
  changeRefusal,
  checkExtend,
  checkPause,
  checkReschedule,
  checkSkip,
  continueDays,
  customDays,
  effectivePause,
  frequencyColumn,
  frequencyFromColumn,
  isLocked,
  paymentPlanColumn,
  pickAlternatives,
  planDays,
  replanFrom,
  resumeDays,
  routineMoney,
  sessionBucket,
  sessionPhase,
  sessionsToMove,
  tally,
  timesFreeOnAll,
  twoMissesInARow,
  type IsOpen,
  type SessionFacts,
  type SlotChoice,
} from './mobile-series';
import { NO_PRODUCTS, type MoneyFigures } from './mobile-products';
import { weekdayOf } from './recurrence';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** 2026-10-01 is a Thursday. The branch clock is irrelevant to pure rules. */
const TODAY = '2026-10-01';
const NOW = Date.UTC(2026, 9, 1, 9, 0);
const at = (day: string, hh = 18) =>
  Date.parse(`${day}T${String(hh).padStart(2, '0')}:00:00Z`);

const allOpen: IsOpen = () => true;
/** Closed on Mondays (1), like many salons. */
const closedMondays: IsOpen = (d) => weekdayOf(d) !== 1;

const days = (planned: { day: string }[]) => planned.map((p) => p.day);

let seq = 0;
function session(over: Partial<SessionFacts> = {}): SessionFacts {
  seq += 1;
  const day = over.day ?? '2026-10-10';
  return {
    id: `occ-${seq}`,
    index: seq,
    day,
    startAtMs: at(day),
    state: 'materialised',
    bookingStatus: 'confirmed',
    noShowBy: null,
    ...over,
  };
}

// ------------------------------------------------------------ the numbers

describe('the fixed numbers (C.1)', () => {
  it('are the decided ones', () => {
    expect(ROUTINE_RULES).toEqual({
      minSessions: 2,
      maxSessions: 6,
      lockHours: 24,
      reminderHours: 48,
      pauseMaxDays: 60,
      extendMax: 6,
      maxFutureSessions: 6,
      rescheduleWithinDays: 90,
      missesToPause: 2,
    });
  });
});

describe('column words', () => {
  it.each([
    ['DAILY', 'daily'],
    ['WEEKLY', 'weekly'],
    ['EVERY_2_WEEKS', 'every_2_weeks'],
    ['MONTHLY', 'monthly'],
    ['CUSTOM', 'custom'],
  ] as const)('%s is stored as %s and read back', (wire, column) => {
    expect(frequencyColumn(wire)).toBe(column);
    expect(frequencyFromColumn(column)).toBe(wire);
  });

  it('a desk series (no frequency) reads back as null', () => {
    expect(frequencyFromColumn(null)).toBeNull();
    expect(frequencyFromColumn('yearly')).toBeNull();
  });

  it('payment plans are stored lower case, as the CHECK wants', () => {
    expect(paymentPlanColumn('PAY_AT_SALON')).toBe('pay_at_salon');
    expect(paymentPlanColumn('PAY_AS_YOU_GO')).toBe('pay_as_you_go');
    expect(paymentPlanColumn('UPFRONT')).toBe('upfront');
  });
});

// ------------------------------------------------------------ days

describe('planDays', () => {
  it('WEEKLY: the same weekday, 7 days apart', () => {
    expect(
      days(
        planDays({
          frequency: 'WEEKLY',
          first: '2026-10-06',
          count: 4,
          isOpen: allOpen,
        }),
      ),
    ).toEqual(['2026-10-06', '2026-10-13', '2026-10-20', '2026-10-27']);
  });

  it('EVERY_2_WEEKS: 14 days apart', () => {
    expect(
      days(
        planDays({
          frequency: 'EVERY_2_WEEKS',
          first: '2026-10-06',
          count: 3,
          isOpen: allOpen,
        }),
      ),
    ).toEqual(['2026-10-06', '2026-10-20', '2026-11-03']);
  });

  it('MONTHLY on the 31st falls back to the last day, and says so', () => {
    const planned = planDays({
      frequency: 'MONTHLY',
      first: '2026-10-31',
      count: 5,
      isOpen: allOpen,
    });
    expect(days(planned)).toEqual([
      '2026-10-31',
      '2026-11-30',
      '2026-12-31',
      '2027-01-31',
      '2027-02-28',
    ]);
    expect(planned.map((p) => p.movedFromDayOfMonth)).toEqual([
      null,
      31,
      null,
      null,
      31,
    ]);
  });

  it('D3: DAILY skips the days the salon is closed, and they do not count', () => {
    // 2026-10-04 is a Sunday, 10-05 a Monday (closed).
    expect(
      days(
        planDays({
          frequency: 'DAILY',
          first: '2026-10-04',
          count: 3,
          isOpen: closedMondays,
        }),
      ),
    ).toEqual(['2026-10-04', '2026-10-06', '2026-10-07']);
  });

  it('D3: a closed first day is skipped too', () => {
    expect(
      days(
        planDays({
          frequency: 'DAILY',
          first: '2026-10-05',
          count: 2,
          isOpen: closedMondays,
        }),
      ),
    ).toEqual(['2026-10-06', '2026-10-07']);
  });

  it('D4, not D3: WEEKLY keeps a closed day (it shows as not free, never moved)', () => {
    expect(
      days(
        planDays({
          frequency: 'WEEKLY',
          first: '2026-10-05',
          count: 2,
          isOpen: closedMondays,
        }),
      ),
    ).toEqual(['2026-10-05', '2026-10-12']);
  });

  it('DAILY at a salon that never opens comes back short, for the caller to refuse', () => {
    expect(
      planDays({
        frequency: 'DAILY',
        first: TODAY,
        count: 3,
        isOpen: () => false,
      }),
    ).toEqual([]);
  });
});

describe('customDays', () => {
  it('sorts the days', () => {
    expect(
      days(customDays(['2026-10-20', '2026-10-03', '2026-10-09'])),
    ).toEqual(['2026-10-03', '2026-10-09', '2026-10-20']);
  });
});

describe('continueDays (EXTEND)', () => {
  it('WEEKLY carries on from the last session', () => {
    expect(
      days(
        continueDays({
          frequency: 'WEEKLY',
          anchor: '2026-10-06',
          last: '2026-10-27',
          count: 2,
          isOpen: allOpen,
        }),
      ),
    ).toEqual(['2026-11-03', '2026-11-10']);
  });

  it('EVERY_2_WEEKS carries on 14 days apart', () => {
    expect(
      days(
        continueDays({
          frequency: 'EVERY_2_WEEKS',
          anchor: '2026-10-06',
          last: '2026-11-03',
          count: 2,
          isOpen: allOpen,
        }),
      ),
    ).toEqual(['2026-11-17', '2026-12-01']);
  });

  it('MONTHLY goes back to the 31st after a short month', () => {
    const planned = continueDays({
      frequency: 'MONTHLY',
      anchor: '2026-10-31',
      last: '2026-11-30',
      count: 2,
      isOpen: allOpen,
    });
    expect(days(planned)).toEqual(['2026-12-31', '2027-01-31']);
  });

  it('DAILY carries on with open days only', () => {
    // 10-04 Sunday is the last; Monday is closed.
    expect(
      days(
        continueDays({
          frequency: 'DAILY',
          anchor: '2026-10-01',
          last: '2026-10-04',
          count: 2,
          isOpen: closedMondays,
        }),
      ),
    ).toEqual(['2026-10-06', '2026-10-07']);
  });
});

describe('replanFrom (D6: pause moves the sessions, the count is kept)', () => {
  it('WEEKLY restarts on the routine weekday, on or after the resume day', () => {
    // Routine on Tuesdays; resume on Thursday 2026-11-05.
    const planned = replanFrom({
      frequency: 'WEEKLY',
      anchor: '2026-10-06',
      remaining: ['2026-10-20', '2026-10-27', '2026-11-03'],
      from: '2026-11-05',
      isOpen: allOpen,
    });
    expect(days(planned)).toEqual(['2026-11-10', '2026-11-17', '2026-11-24']);
    expect(planned.every((p) => weekdayOf(p.day) === 2)).toBe(true);
  });

  it('a resume day on the routine weekday is used as it is', () => {
    expect(
      days(
        replanFrom({
          frequency: 'EVERY_2_WEEKS',
          anchor: '2026-10-06',
          remaining: ['2026-10-20', '2026-11-03'],
          from: '2026-11-10',
          isOpen: allOpen,
        }),
      ),
    ).toEqual(['2026-11-10', '2026-11-24']);
  });

  it('MONTHLY keeps its day of the month', () => {
    expect(
      days(
        replanFrom({
          frequency: 'MONTHLY',
          anchor: '2026-10-15',
          remaining: ['2026-11-15', '2026-12-15'],
          from: '2026-11-20',
          isOpen: allOpen,
        }),
      ),
    ).toEqual(['2026-12-15', '2027-01-15']);
  });

  it('DAILY takes the next open days', () => {
    expect(
      days(
        replanFrom({
          frequency: 'DAILY',
          anchor: '2026-10-01',
          remaining: ['2026-10-02', '2026-10-03'],
          from: '2026-10-05',
          isOpen: closedMondays,
        }),
      ),
    ).toEqual(['2026-10-06', '2026-10-07']);
  });

  it('CUSTOM shifts every day by the same amount, keeping the gaps', () => {
    expect(
      days(
        replanFrom({
          frequency: 'CUSTOM',
          anchor: '2026-10-02',
          remaining: ['2026-10-09', '2026-10-12', '2026-10-30'],
          from: '2026-10-20',
          isOpen: allOpen,
        }),
      ),
    ).toEqual(['2026-10-20', '2026-10-23', '2026-11-10']);
  });

  it('keeps the count, whatever the frequency', () => {
    for (const frequency of [
      'DAILY',
      'WEEKLY',
      'EVERY_2_WEEKS',
      'MONTHLY',
      'CUSTOM',
    ] as const) {
      const remaining = [
        '2026-10-10',
        '2026-10-17',
        '2026-10-24',
        '2026-10-31',
      ];
      expect(
        replanFrom({
          frequency,
          anchor: '2026-10-03',
          remaining,
          from: '2026-11-02',
          isOpen: allOpen,
        }),
      ).toHaveLength(4);
    }
  });

  it('nothing to move, nothing planned', () => {
    expect(
      replanFrom({
        frequency: 'WEEKLY',
        anchor: TODAY,
        remaining: [],
        from: TODAY,
        isOpen: allOpen,
      }),
    ).toEqual([]);
  });
});

describe('resumeDays (RESUME, "Customize first")', () => {
  const weeklyTuesdays = {
    frequency: 'WEEKLY' as const,
    anchor: '2026-10-06',
    remaining: ['2026-10-20', '2026-10-27', '2026-11-03'],
    from: '2026-11-05',
    isOpen: allOpen,
  };

  it('nothing switched: the same days as the pause re-plan', () => {
    const plain = resumeDays({ ...weeklyTuesdays, newFrequency: null });
    expect(days(plain)).toEqual(['2026-11-10', '2026-11-17', '2026-11-24']);
    expect(plain).toEqual(replanFrom(weeklyTuesdays));
  });

  it('switching to the frequency it already has is no switch', () => {
    expect(resumeDays({ ...weeklyTuesdays, newFrequency: 'WEEKLY' })).toEqual(
      resumeDays({ ...weeklyTuesdays, newFrequency: null }),
    );
  });

  it('WEEKLY to EVERY_2_WEEKS keeps the weekday: a Tuesday routine stays on Tuesdays', () => {
    const planned = resumeDays({
      ...weeklyTuesdays,
      newFrequency: 'EVERY_2_WEEKS',
    });
    expect(days(planned)).toEqual(['2026-11-10', '2026-11-24', '2026-12-08']);
    expect(planned.every((p) => weekdayOf(p.day) === 2)).toBe(true);
  });

  it('the Figma: "Same time slot: 4:30 PM, Sunday" stays on Sundays, both ways', () => {
    const sundays = {
      anchor: '2026-10-04',
      remaining: ['2026-10-18', '2026-11-01'],
      from: '2026-11-04',
      isOpen: allOpen,
    };
    expect(
      days(
        resumeDays({
          ...sundays,
          frequency: 'WEEKLY',
          newFrequency: 'EVERY_2_WEEKS',
        }),
      ),
    ).toEqual(['2026-11-08', '2026-11-22']);
    expect(
      days(
        resumeDays({
          ...sundays,
          frequency: 'EVERY_2_WEEKS',
          newFrequency: 'WEEKLY',
        }),
      ),
    ).toEqual(['2026-11-08', '2026-11-15']);
  });

  it('any other switch starts its cadence on the resume day itself', () => {
    expect(
      days(resumeDays({ ...weeklyTuesdays, newFrequency: 'MONTHLY' })),
    ).toEqual(['2026-11-05', '2026-12-05', '2027-01-05']);
    expect(
      days(resumeDays({ ...weeklyTuesdays, newFrequency: 'DAILY' })),
    ).toEqual(['2026-11-05', '2026-11-06', '2026-11-07']);
    expect(
      days(
        resumeDays({
          frequency: 'MONTHLY',
          anchor: '2026-10-15',
          newFrequency: 'WEEKLY',
          remaining: ['2026-11-15', '2026-12-15'],
          from: '2026-11-05',
          isOpen: allOpen,
        }),
      ),
    ).toEqual(['2026-11-05', '2026-11-12']);
  });

  it('a CUSTOM routine may switch to DAILY, which skips closed days (D3)', () => {
    expect(
      days(
        resumeDays({
          frequency: 'CUSTOM',
          anchor: '2026-10-02',
          newFrequency: 'DAILY',
          remaining: ['2026-10-09', '2026-10-30'],
          from: '2026-10-05',
          isOpen: closedMondays,
        }),
      ),
    ).toEqual(['2026-10-06', '2026-10-07']);
  });

  it('keeps the count whatever is switched (D6)', () => {
    for (const newFrequency of [
      null,
      'DAILY',
      'WEEKLY',
      'EVERY_2_WEEKS',
      'MONTHLY',
    ] as const) {
      expect(resumeDays({ ...weeklyTuesdays, newFrequency })).toHaveLength(3);
    }
  });
});

describe('applyPicks (D4)', () => {
  const slot = (index: number, day: string) => ({
    index,
    day,
    startMin: 1080,
    staffId: 'maya',
    picked: false,
  });
  const planned = [
    slot(0, '2026-10-06'),
    slot(1, '2026-10-13'),
    slot(2, '2026-10-20'),
  ];

  it('no picks: the plan as it is', () => {
    expect(applyPicks(planned, [])).toEqual({ kind: 'ok', slots: planned });
  });

  it('a pick replaces that session, and keeps its stylist unless it names one', () => {
    const r = applyPicks(planned, [
      { index: 1, day: '2026-10-14', startMin: 990, stylistId: null },
      { index: 2, day: '2026-10-20', startMin: 1080, stylistId: 'rana' },
    ]);
    expect(r.kind === 'ok' && r.slots).toEqual([
      planned[0],
      {
        index: 1,
        day: '2026-10-14',
        startMin: 990,
        staffId: 'maya',
        picked: true,
      },
      {
        index: 2,
        day: '2026-10-20',
        startMin: 1080,
        staffId: 'rana',
        picked: true,
      },
    ]);
  });

  it('works on the numbers an action plans (EXTEND: sessions 6 and 7)', () => {
    const extend = [slot(6, '2026-11-17'), slot(7, '2026-11-24')];
    const r = applyPicks(
      extend,
      [{ index: 7, day: '2026-11-25', startMin: 1080, stylistId: null }],
      ['2026-10-06', '2026-11-10'],
    );
    expect(r.kind === 'ok' && r.slots.map((s) => s.day)).toEqual([
      '2026-11-17',
      '2026-11-25',
    ]);
  });

  it('refuses a pick for a session the action does not plan', () => {
    const r = applyPicks(planned, [
      { index: 5, day: '2026-10-21', startMin: 1080, stylistId: null },
    ]);
    expect(r.kind === 'refused' && r.refusal).toMatchObject({
      field: 'picks[0].index',
      code: 'invalid_pick',
    });
  });

  it('refuses a pick onto the day of another session of the routine', () => {
    const r = applyPicks(planned, [
      { index: 2, day: '2026-10-13', startMin: 900, stylistId: null },
    ]);
    expect(r.kind === 'refused' && r.refusal.code).toBe('session_day_taken');
  });

  it('refuses a pick onto a day a session outside the action holds', () => {
    const r = applyPicks(
      [slot(6, '2026-11-17')],
      [{ index: 6, day: '2026-11-10', startMin: 1080, stylistId: null }],
      ['2026-11-10'],
    );
    expect(r.kind === 'refused' && r.refusal).toMatchObject({
      field: 'picks[0].date',
      code: 'session_day_taken',
    });
  });
});

describe('beyondHorizon', () => {
  it('90 days out is inside; 91 is planned for the job', () => {
    expect(beyondHorizon('2026-12-30', TODAY)).toBe(false);
    expect(beyondHorizon('2026-12-31', TODAY)).toBe(true);
  });
});

// ------------------------------------------------------------ the lock

describe('the 24h lock', () => {
  it('locks inside 24 hours, not at 24 hours exactly', () => {
    expect(isLocked(NOW + LOCK_HOURS * HOUR, NOW)).toBe(false);
    expect(isLocked(NOW + LOCK_HOURS * HOUR - 1, NOW)).toBe(true);
    expect(isLocked(NOW - HOUR, NOW)).toBe(true);
  });

  it('SCHEDULED before the lock, CONFIRMED inside it (derived from the clock)', () => {
    expect(sessionPhase(NOW + 2 * DAY, NOW)).toBe('SCHEDULED');
    expect(sessionPhase(NOW + 3 * HOUR, NOW)).toBe('CONFIRMED');
  });
});

// ------------------------------------------------------------ sessions

describe('sessionBucket and tally', () => {
  it('puts every session in exactly one bucket', () => {
    expect(sessionBucket(session({ bookingStatus: 'completed' }))).toBe('done');
    expect(sessionBucket(session({ bookingStatus: 'settled' }))).toBe('done');
    expect(sessionBucket(session({ bookingStatus: 'checked_in' }))).toBe(
      'done',
    );
    expect(
      sessionBucket(session({ bookingStatus: 'no_show', noShowBy: 'staff' })),
    ).toBe('done');
    expect(sessionBucket(session({ bookingStatus: 'confirmed' }))).toBe(
      'remaining',
    );
    expect(
      sessionBucket(session({ state: 'planned', bookingStatus: null })),
    ).toBe('remaining');
    expect(
      sessionBucket(session({ state: 'needs_attention', bookingStatus: null })),
    ).toBe('remaining');
    expect(
      sessionBucket(session({ state: 'skipped', bookingStatus: 'cancelled' })),
    ).toBe('skipped');
    expect(
      sessionBucket(session({ state: 'skipped', bookingStatus: null })),
    ).toBe('skipped');
    expect(sessionBucket(session({ bookingStatus: 'cancelled' }))).toBe(
      'cancelled',
    );
  });

  it('"1 of 5 done, 4 remaining", a skip shown apart', () => {
    const sessions = [
      session({
        day: '2026-09-24',
        startAtMs: at('2026-09-24'),
        bookingStatus: 'completed',
      }),
      session({
        day: '2026-10-08',
        state: 'skipped',
        bookingStatus: 'cancelled',
      }),
      session({ day: '2026-10-15' }),
      session({ day: '2026-10-22' }),
      session({ day: '2026-10-29' }),
      session({ day: '2027-01-05', state: 'planned', bookingStatus: null }),
    ];
    const t = tally(sessions, NOW);
    expect(t).toMatchObject({
      total: 5,
      done: 1,
      remaining: 4,
      skipped: 1,
      cancelled: 0,
    });
    expect(t.next?.day).toBe('2026-10-15');
  });

  it('a session cancelled at the desk is cancelled, not remaining', () => {
    const t = tally([session({ bookingStatus: 'cancelled' }), session()], NOW);
    expect(t).toMatchObject({ total: 1, remaining: 1, cancelled: 1 });
  });

  it('next is null when nothing is still to come', () => {
    expect(
      tally([session({ bookingStatus: 'completed' })], NOW).next,
    ).toBeNull();
  });
});

describe('changeRefusal', () => {
  it('a session still to come, past the lock, may change', () => {
    expect(
      changeRefusal(session({ startAtMs: NOW + 2 * DAY }), NOW),
    ).toBeNull();
  });

  it('inside the lock: session_locked', () => {
    expect(
      changeRefusal(session({ startAtMs: NOW + 5 * HOUR }), NOW)?.code,
    ).toBe('session_locked');
  });

  it('a done, skipped or cancelled session: session_not_changeable (not K7)', () => {
    for (const s of [
      session({ bookingStatus: 'checked_in' }),
      session({ bookingStatus: 'completed' }),
      session({ state: 'skipped' }),
      session({ bookingStatus: 'cancelled' }),
    ]) {
      expect(changeRefusal(s, NOW)?.code).toBe('session_not_changeable');
    }
  });
});

describe('actionRefusal', () => {
  it.each(['SKIP', 'RESCHEDULE', 'EXTEND', 'PAUSE'] as const)(
    '%s needs an active routine',
    (action) => {
      expect(actionRefusal(action, 'active')).toBeNull();
      for (const status of ['paused', 'ended', 'completed'] as const) {
        expect(actionRefusal(action, status)?.code).toBe('routine_not_active');
      }
    },
  );

  it('RESUME needs a paused routine', () => {
    expect(actionRefusal('RESUME', 'paused')).toBeNull();
    expect(actionRefusal('RESUME', 'active')?.code).toBe('routine_not_active');
    expect(actionRefusal('RESUME', 'ended')?.code).toBe('routine_not_active');
  });
});

describe('checkSkip', () => {
  const a = session({ day: '2026-10-10' });
  const b = session({ day: '2026-10-17' });
  const locked = session({ day: '2026-10-01', startAtMs: NOW + 3 * HOUR });

  it('passes several sessions still to come', () => {
    expect(checkSkip([a, b, locked], [a.id, b.id], NOW)).toBeNull();
  });

  it('refuses an empty list, a repeat and a stranger', () => {
    expect(checkSkip([a, b], [], NOW)?.code).toBe('invalid_sessions');
    expect(checkSkip([a, b], [a.id, a.id], NOW)?.code).toBe('invalid_sessions');
    expect(checkSkip([a, b], ['occ-of-someone-else'], NOW)?.code).toBe(
      'invalid_sessions',
    );
  });

  it('refuses a session inside the lock', () => {
    expect(checkSkip([a, locked], [a.id, locked.id], NOW)?.code).toBe(
      'session_locked',
    );
  });
});

describe('checkReschedule', () => {
  const a = session({ day: '2026-10-10' });
  const b = session({ day: '2026-10-17' });
  const base = {
    sessions: [a, b],
    sessionId: a.id,
    newDay: '2026-10-12',
    newStartAtMs: at('2026-10-12'),
    today: TODAY,
    nowMs: NOW,
  };

  it('passes a free move inside the rules', () => {
    expect(checkReschedule(base)).toBeNull();
  });

  it('refuses a session that is not in the routine', () => {
    expect(checkReschedule({ ...base, sessionId: 'nope' })?.code).toBe(
      'invalid_sessions',
    );
  });

  it('refuses moving a locked session', () => {
    const soon = session({ day: '2026-10-01', startAtMs: NOW + HOUR });
    expect(
      checkReschedule({ ...base, sessions: [soon, b], sessionId: soon.id })
        ?.code,
    ).toBe('session_locked');
  });

  it('refuses a new time inside the next 24 hours', () => {
    expect(
      checkReschedule({ ...base, newDay: TODAY, newStartAtMs: NOW + 5 * HOUR })
        ?.code,
    ).toBe('reschedule_out_of_range');
  });

  it('refuses a day more than 90 days out', () => {
    expect(
      checkReschedule({
        ...base,
        newDay: '2026-12-31',
        newStartAtMs: at('2026-12-31'),
      })?.code,
    ).toBe('reschedule_out_of_range');
    expect(
      checkReschedule({
        ...base,
        newDay: '2026-12-30',
        newStartAtMs: at('2026-12-30'),
      }),
    ).toBeNull();
  });

  it('refuses the day of another session', () => {
    expect(
      checkReschedule({ ...base, newDay: b.day, newStartAtMs: at(b.day, 11) })
        ?.code,
    ).toBe('session_day_taken');
  });

  it('a skipped session does not hold its day', () => {
    const skipped = session({
      day: '2026-10-24',
      state: 'skipped',
      bookingStatus: 'cancelled',
    });
    expect(
      checkReschedule({
        ...base,
        sessions: [a, skipped],
        newDay: skipped.day,
        newStartAtMs: at(skipped.day),
      }),
    ).toBeNull();
  });
});

describe('checkExtend', () => {
  const future = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      session({ day: `2026-10-${String(10 + i).padStart(2, '0')}` }),
    );

  it('adds 1 to 6', () => {
    expect(checkExtend(future(0), 1, NOW)).toBeNull();
    expect(checkExtend(future(0), EXTEND_MAX, NOW)).toBeNull();
    expect(checkExtend(future(0), 0, NOW)?.code).toBe('invalid_extend');
    expect(checkExtend(future(0), 7, NOW)?.code).toBe('invalid_extend');
    expect(checkExtend(future(0), 1.5, NOW)?.code).toBe('invalid_extend');
  });

  it('never more than 6 sessions still to come', () => {
    expect(checkExtend(future(4), 2, NOW)).toBeNull();
    const refused = checkExtend(future(4), 3, NOW);
    expect(refused?.code).toBe('too_many_sessions');
    expect(refused?.message).toContain('at most 2');
    expect(checkExtend(future(MAX_FUTURE_SESSIONS), 1, NOW)?.code).toBe(
      'too_many_sessions',
    );
  });

  it('done and skipped sessions do not count against the 6', () => {
    const sessions = [
      ...future(5),
      session({ bookingStatus: 'completed' }),
      session({ state: 'skipped' }),
    ];
    expect(checkExtend(sessions, 1, NOW)).toBeNull();
  });
});

describe('checkPause', () => {
  it('until is after today, and at most 60 days away', () => {
    expect(checkPause('2026-10-02', TODAY)).toBeNull();
    expect(checkPause('2026-11-30', TODAY)).toBeNull(); // 60 days
    expect(checkPause('2026-12-01', TODAY)?.code).toBe('pause_too_long');
    expect(checkPause(TODAY, TODAY)?.code).toBe('invalid_pause');
    expect(checkPause('2026-09-30', TODAY)?.code).toBe('invalid_pause');
    expect(PAUSE_MAX_DAYS).toBe(60);
  });
});

describe('sessionsToMove', () => {
  it('moves what is still to come, and leaves the locked and the done alone', () => {
    const locked = session({ day: TODAY, startAtMs: NOW + 2 * HOUR });
    const done = session({ day: '2026-09-24', bookingStatus: 'completed' });
    const later = session({ day: '2026-10-22' });
    const soon = session({ day: '2026-10-08' });
    expect(
      sessionsToMove([later, locked, done, soon], NOW).map((s) => s.id),
    ).toEqual([soon.id, later.id]);
  });
});

describe('effectivePause', () => {
  const row = {
    pausedUntil: '2026-10-30',
    pauseReason: 'travel',
    pauseNote: 'Away',
  };

  it('shows the pause while paused', () => {
    expect(effectivePause({ ...row, status: 'paused' })).toEqual({
      until: '2026-10-30',
      reason: 'travel',
      note: 'Away',
    });
  });

  it('ignores what the desk resume left behind', () => {
    expect(effectivePause({ ...row, status: 'active' })).toBeNull();
    expect(effectivePause({ ...row, status: 'ended' })).toBeNull();
  });
});

// ------------------------------------------------------------ two misses

describe('twoMissesInARow (D5, D9)', () => {
  const miss = (day: string, by: 'staff' | 'system') =>
    session({
      day,
      startAtMs: at(day),
      bookingStatus: 'no_show',
      noShowBy: by,
    });
  const visit = (day: string) =>
    session({ day, startAtMs: at(day), bookingStatus: 'completed' });
  const off = { countAutoNoShows: false, after: null };
  const on = { countAutoNoShows: true, after: null };

  it('two staff no-shows in a row pause, naming the later one', () => {
    expect(
      twoMissesInARow(
        [
          visit('2026-09-03'),
          miss('2026-09-10', 'staff'),
          miss('2026-09-17', 'staff'),
        ],
        off,
      ),
    ).toEqual({ pause: true, lastMissDay: '2026-09-17' });
  });

  it('one miss does not', () => {
    expect(
      twoMissesInARow([visit('2026-09-03'), miss('2026-09-10', 'staff')], off)
        .pause,
    ).toBe(false);
  });

  it('a visit between them breaks the streak', () => {
    expect(
      twoMissesInARow(
        [
          miss('2026-09-03', 'staff'),
          visit('2026-09-10'),
          miss('2026-09-17', 'staff'),
        ],
        off,
      ).pause,
    ).toBe(false);
  });

  it('D9 off: the sweeper no-show does not count', () => {
    expect(
      twoMissesInARow(
        [miss('2026-09-10', 'system'), miss('2026-09-17', 'staff')],
        off,
      ).pause,
    ).toBe(false);
  });

  it('D9 on: it does', () => {
    expect(
      twoMissesInARow(
        [miss('2026-09-10', 'system'), miss('2026-09-17', 'staff')],
        on,
      ),
    ).toEqual({ pause: true, lastMissDay: '2026-09-17' });
  });

  it('D9 off: a sweeper no-show between two staff ones is passed over, not a visit', () => {
    expect(
      twoMissesInARow(
        [
          miss('2026-09-03', 'staff'),
          miss('2026-09-10', 'system'),
          miss('2026-09-17', 'staff'),
        ],
        off,
      ).pause,
    ).toBe(true);
  });

  it('skipped, cancelled and future sessions are passed over', () => {
    expect(
      twoMissesInARow(
        [
          miss('2026-09-03', 'staff'),
          session({
            day: '2026-09-10',
            state: 'skipped',
            bookingStatus: 'cancelled',
          }),
          session({ day: '2026-09-12', bookingStatus: 'cancelled' }),
          miss('2026-09-17', 'staff'),
          session({ day: '2026-10-10' }),
        ],
        off,
      ).pause,
    ).toBe(true);
  });

  it('misses on or before miss_streak_after never pause again after a resume', () => {
    const sessions = [miss('2026-09-10', 'staff'), miss('2026-09-17', 'staff')];
    expect(
      twoMissesInARow(sessions, {
        countAutoNoShows: false,
        after: '2026-09-17',
      }).pause,
    ).toBe(false);
    expect(
      twoMissesInARow([...sessions, miss('2026-09-24', 'staff')], {
        countAutoNoShows: false,
        after: '2026-09-17',
      }).pause,
    ).toBe(false);
    expect(
      twoMissesInARow(
        [...sessions, miss('2026-09-24', 'staff'), miss('2026-10-01', 'staff')],
        { countAutoNoShows: false, after: '2026-09-17' },
      ),
    ).toEqual({ pause: true, lastMissDay: '2026-10-01' });
  });
});

// ------------------------------------------------------------ cancel

describe('cancelSummary', () => {
  it('pay at salon: nothing taken, nothing refunded, the late ones named', () => {
    const summary = cancelSummary(
      [
        { ...session({ day: TODAY, startAtMs: NOW + HOUR }), capturedFils: 0 },
        { ...session({ day: '2026-10-08' }), capturedFils: 0 },
        {
          ...session({ day: '2026-09-24', bookingStatus: 'completed' }),
          capturedFils: 0,
        },
      ],
      NOW,
    );
    expect(summary.sessions).toHaveLength(2);
    expect(summary).toMatchObject({
      capturedFils: 0,
      refundFils: 0,
      keptFils: 0,
      lateCount: 0,
    });
    expect(summary.sessions.map((l) => [l.band, l.locked])).toEqual([
      ['nothing_captured', true],
      ['nothing_captured', false],
    ]);
  });

  it('with deposits: each session by the single booking bands, then added up', () => {
    const summary = cancelSummary(
      [
        {
          ...session({ day: TODAY, startAtMs: NOW + HOUR }),
          capturedFils: 2000,
        },
        {
          ...session({ day: TODAY, startAtMs: NOW + 5 * HOUR }),
          capturedFils: 2000,
        },
        { ...session({ day: '2026-10-08' }), capturedFils: 2000 },
      ],
      NOW,
    );
    expect(summary.sessions.map((l) => l.band)).toEqual([
      'under_2h',
      '24h_to_2h',
      'more_than_24h',
    ]);
    expect(summary).toMatchObject({
      capturedFils: 6000,
      refundFils: 2000,
      keptFils: 4000,
      lateCount: 1,
    });
    expect(summary.refundFils + summary.keptFils).toBe(summary.capturedFils);
  });

  it('a session that already started is not cancelled', () => {
    const summary = cancelSummary(
      [{ ...session({ day: TODAY, startAtMs: NOW - HOUR }), capturedFils: 0 }],
      NOW,
    );
    expect(summary.sessions).toEqual([]);
  });
});

// ------------------------------------------------------------ money

describe('routineMoney', () => {
  const plain: MoneyFigures = {
    subtotalFils: 10000,
    discountFils: 0,
    vatFils: 500,
    totalFils: 10500,
  };
  const products = { netFils: 2000, vatFils: 100, totalFils: 2100 };

  it('D7: products go on the first session only', () => {
    const m = routineMoney({
      sessions: [plain, plain, plain],
      products,
      depositPercent: 20,
    });
    expect(m.sessions.map((s) => s.totalFils)).toEqual([12600, 10500, 10500]);
  });

  it('PAY_AT_SALON: the sum of the sessions, nothing now, bookable in v1', () => {
    const m = routineMoney({
      sessions: [plain, plain, plain],
      products,
      depositPercent: 20,
    });
    expect(m.plans.PAY_AT_SALON).toMatchObject({
      available: true,
      subtotalFils: 32000,
      discountFils: 0,
      vatFils: 1600,
      totalFils: 33600,
      payNowFils: 0,
      percent: null,
    });
  });

  it('PAY_AS_YOU_GO: 20% of each session now, the rest at each visit; shown, not bookable (D2)', () => {
    const m = routineMoney({
      sessions: [plain, plain, plain],
      products,
      depositPercent: 20,
    });
    expect(m.plans.PAY_AS_YOU_GO).toMatchObject({
      available: false,
      totalFils: 33600,
      payNowFils: 2520 + 2100 + 2100,
      percent: 20,
    });
    expect(m.plans.PAY_AS_YOU_GO.sessions.map((s) => s.atVisitFils)).toEqual([
      10080, 8400, 8400,
    ]);
  });

  it('PAY_AS_YOU_GO rounds per session, because each session is its own booking', () => {
    const odd = {
      subtotalFils: 9999,
      discountFils: 0,
      vatFils: 500,
      totalFils: 10499,
    };
    const m = routineMoney({
      sessions: [odd, odd, odd],
      products: NO_PRODUCTS,
      depositPercent: 20,
    });
    // 2099.8 rounds to 2100 each; 20% of the whole would be 6299.
    expect(m.plans.PAY_AS_YOU_GO.payNowFils).toBe(6300);
  });

  it('D8 UPFRONT: 10% off the services only, before VAT; products not discounted', () => {
    const m = routineMoney({
      sessions: [plain, plain, plain],
      products,
      depositPercent: 20,
    });
    const up = m.plans.UPFRONT;
    // services 30000, less 3000 = 27000, VAT 1350; products 2100 with their own VAT.
    expect(up).toMatchObject({
      available: false,
      subtotalFils: 32000,
      discountFils: 3000,
      vatFils: 1350 + 100,
      totalFils: 27000 + 1350 + 2100,
      payNowFils: 30450,
      percent: 10,
    });
    expect(up.subtotalFils - up.discountFils + up.vatFils).toBe(up.totalFils);
    const shares = up.sessions.map((s) => s.totalFils);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(up.totalFils);
    expect(up.sessions.every((s) => s.atVisitFils === 0)).toBe(true);
  });

  it('D8 UPFRONT: the 10% is on the services after a tier discount', () => {
    const gold = {
      subtotalFils: 10000,
      discountFils: 1000,
      vatFils: 450,
      totalFils: 9450,
    };
    const up = routineMoney({
      sessions: [gold, gold],
      products: NO_PRODUCTS,
      depositPercent: 20,
    }).plans.UPFRONT;
    // 18000 after tier, less 1800 = 16200, VAT 810.
    expect(up).toMatchObject({
      discountFils: 2000 + 1800,
      vatFils: 810,
      totalFils: 17010,
    });
  });

  it('refuses a routine with no sessions and a nonsense percent, as bugs', () => {
    expect(() =>
      routineMoney({ sessions: [], products: NO_PRODUCTS, depositPercent: 20 }),
    ).toThrow();
    expect(() =>
      routineMoney({
        sessions: [plain],
        products: NO_PRODUCTS,
        depositPercent: 120,
      }),
    ).toThrow();
  });

  it('a free routine costs nothing under every plan', () => {
    const free = { subtotalFils: 0, discountFils: 0, vatFils: 0, totalFils: 0 };
    const m = routineMoney({
      sessions: [free, free],
      products: NO_PRODUCTS,
      depositPercent: 20,
    });
    expect(Object.values(m.plans).map((p) => p.totalFils)).toEqual([0, 0, 0]);
  });
});

// ------------------------------------------------------------ times

describe('timesFreeOnAll', () => {
  it('keeps only the times free on every day', () => {
    expect(
      timesFreeOnAll([
        [600, 660, 720, 1080],
        [660, 720, 1080],
        [540, 660, 1080, 1320],
      ]),
    ).toEqual([660, 1080]);
  });

  it('one full day means nothing is free on all of them', () => {
    expect(timesFreeOnAll([[600, 660], []])).toEqual([]);
    expect(timesFreeOnAll([])).toEqual([]);
  });

  it('drops times a series row cannot store (outside 10:00 to 21:55)', () => {
    expect(timesFreeOnAll([[540, 600, 1320]])).toEqual([600]);
  });
});

describe('pickAlternatives (D4)', () => {
  const wanted: SlotChoice = {
    day: '2026-10-13',
    startMin: 1080,
    staffId: 'maya',
  };
  const c = (day: string, startMin: number, staffId: string): SlotChoice => ({
    day,
    startMin,
    staffId,
  });

  it('same stylist first, then same time with another, then another day', () => {
    const picked = pickAlternatives({
      wanted,
      free: [
        c('2026-10-14', 1080, 'maya'),
        c('2026-10-13', 1080, 'rana'),
        c('2026-10-13', 1140, 'maya'),
        c('2026-10-13', 900, 'maya'),
      ],
      otherSessionDays: [],
    });
    expect(picked).toEqual([
      c('2026-10-13', 1140, 'maya'),
      c('2026-10-13', 900, 'maya'),
      c('2026-10-13', 1080, 'rana'),
    ]);
  });

  it('never more than 3, and never the wanted slot itself', () => {
    const free = [
      wanted,
      ...[900, 960, 1020, 1140, 1200].map((m) => c('2026-10-13', m, 'maya')),
    ];
    const picked = pickAlternatives({ wanted, free, otherSessionDays: [] });
    expect(picked).toHaveLength(MAX_ALTERNATIVES);
    expect(picked).not.toContainEqual(wanted);
  });

  it('spaces the offers so they are real choices', () => {
    const picked = pickAlternatives({
      wanted,
      free: [1085, 1090, 1095, 1110, 1140].map((m) =>
        c('2026-10-13', m, 'maya'),
      ),
      otherSessionDays: [],
    });
    expect(picked.map((p) => p.startMin)).toEqual([1085, 1110, 1140]);
  });

  it('never offers a day another session already has', () => {
    const picked = pickAlternatives({
      wanted,
      free: [c('2026-10-20', 1080, 'maya'), c('2026-10-12', 1080, 'maya')],
      otherSessionDays: ['2026-10-20'],
    });
    expect(picked).toEqual([c('2026-10-12', 1080, 'maya')]);
  });

  it('another stylist on another day is too far from what was asked', () => {
    expect(
      pickAlternatives({
        wanted,
        free: [c('2026-10-14', 1000, 'rana')],
        otherSessionDays: [],
      }),
    ).toEqual([]);
  });
});
