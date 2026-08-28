import { describe, it, expect } from 'vitest';
import {
  planEdit,
  planPauseOrEnd,
  CANCELLATION_PROTECTION_HOURS,
  type SeriesOccurrence,
} from './series-edit';

const occ = (
  id: string,
  date: string,
  over: Partial<SeriesOccurrence> = {},
): SeriesOccurrence => ({
  id,
  date,
  startMin: 1080,
  status: 'confirmed',
  startsInHours: 200,
  ...over,
});

// A weekly series: two visits done, one today, three still to come.
const SERIES: SeriesOccurrence[] = [
  occ('o1', '2026-09-01', { status: 'settled', startsInHours: -400 }),
  occ('o2', '2026-09-08', { status: 'completed', startsInHours: -232 }),
  occ('o3', '2026-09-15', { status: 'confirmed', startsInHours: 3 }),
  occ('o4', '2026-09-22', { status: 'confirmed', startsInHours: 171 }),
  occ('o5', '2026-09-29', { status: 'confirmed', startsInHours: 339 }),
  occ('o6', '2026-10-06', {
    status: 'pending_confirmation',
    startsInHours: 507,
  }),
];

describe('this occurrence only', () => {
  it('affects exactly one', () => {
    const got = planEdit('this_occurrence', SERIES, 'o4');
    expect(got.affected).toEqual(['o4']);
  });

  it('detaches it from the series', () => {
    const got = planEdit('this_occurrence', SERIES, 'o4');
    expect(got.detached).toEqual(['o4']);
    expect(got.explanation).toMatch(/detaches/);
  });

  it('leaves everything else untouched', () => {
    const got = planEdit('this_occurrence', SERIES, 'o4');
    expect(got.untouched).toEqual(['o1', 'o2', 'o3', 'o5', 'o6']);
  });

  it('does not call the out-of-scope ones started or closed', () => {
    // They were never candidates. Reporting them as ineligible reads as a
    // warning about the edit when it is only arithmetic about the scope.
    const got = planEdit('this_occurrence', SERIES, 'o4');
    expect(got.ineligible).toEqual([]);
    expect(got.explanation).not.toMatch(/left alone/);
  });
});

describe('this and all future', () => {
  it('takes the target and everything after it', () => {
    const got = planEdit('this_and_future', SERIES, 'o4');
    expect(got.affected).toEqual(['o4', 'o5', 'o6']);
  });

  it('does not detach: the series itself is being edited', () => {
    expect(planEdit('this_and_future', SERIES, 'o4').detached).toEqual([]);
  });

  it('leaves the past alone', () => {
    const got = planEdit('this_and_future', SERIES, 'o4');
    expect(got.untouched).toEqual(['o1', 'o2', 'o3']);
  });

  it('breaks the tie on start minute when two land on one day', () => {
    const sameDay = [
      occ('a', '2026-09-22', { startMin: 600 }),
      occ('b', '2026-09-22', { startMin: 1080 }),
    ];
    expect(planEdit('this_and_future', sameDay, 'b').affected).toEqual(['b']);
  });
});

describe('the entire series', () => {
  it('takes every occurrence that can still be edited', () => {
    const got = planEdit('entire_series', SERIES, 'o4');
    expect(got.affected).toEqual(['o3', 'o4', 'o5', 'o6']);
  });

  it('never rewrites a finished visit', () => {
    const got = planEdit('entire_series', SERIES, 'o4');
    expect(got.untouched).toEqual(['o1', 'o2']);
  });

  it('reports the finished ones as ineligible, and says so', () => {
    const got = planEdit('entire_series', SERIES, 'o4');
    expect(got.ineligible).toEqual(['o1', 'o2']);
    expect(got.explanation).toMatch(/2 left alone/);
  });
});

describe('occurrences no scope may touch', () => {
  it('skips one already in service', () => {
    const live = [occ('x', '2026-09-15', { status: 'in_service' })];
    const got = planEdit('entire_series', live, 'x');
    expect(got.affected).toEqual([]);
    expect(got.untouched).toEqual(['x']);
    expect(got.ineligible).toEqual(['x']);
  });

  it('skips one already cancelled', () => {
    const dead = [occ('x', '2026-09-15', { status: 'cancelled' })];
    expect(planEdit('entire_series', dead, 'x').affected).toEqual([]);
  });

  it('refuses a target that is not in the series', () => {
    expect(() => planEdit('this_occurrence', SERIES, 'nope')).toThrow(
      /not part of this series/,
    );
  });
});

describe('pausing or ending the series', () => {
  it('cancels future occurrences beyond the protection window', () => {
    const got = planPauseOrEnd(SERIES);
    expect(got.cancel).toEqual(['o4', 'o5', 'o6']);
  });

  it('holds back the one inside 48 hours for the desk to confirm', () => {
    const got = planPauseOrEnd(SERIES);
    expect(got.needsExplicitConfirmation).toEqual(['o3']);
    expect(got.explanation).toMatch(/48-hour window needs the desk/);
  });

  it('leaves started and closed occurrences alone', () => {
    const got = planPauseOrEnd(SERIES);
    expect(got.untouched).toEqual(['o1', 'o2']);
  });

  it('puts an occurrence exactly on the boundary outside the window', () => {
    // 48 hours away is not "inside 48 hours".
    const edge = [
      occ('e', '2026-09-20', { startsInHours: CANCELLATION_PROTECTION_HOURS }),
    ];
    expect(planPauseOrEnd(edge).cancel).toEqual(['e']);
  });

  it('protects one a minute inside the boundary', () => {
    const edge = [
      occ('e', '2026-09-20', {
        startsInHours: CANCELLATION_PROTECTION_HOURS - 0.02,
      }),
    ];
    expect(planPauseOrEnd(edge).needsExplicitConfirmation).toEqual(['e']);
  });

  it('does not reach for an unstarted occurrence in the past', () => {
    const stale = [occ('s', '2026-08-01', { startsInHours: -5 })];
    const got = planPauseOrEnd(stale);
    expect(got.cancel).toEqual([]);
    expect(got.untouched).toEqual(['s']);
  });

  it('reports a clean bulk cancellation in one line', () => {
    const clean = [occ('a', '2026-10-01'), occ('b', '2026-10-08')];
    expect(planPauseOrEnd(clean).explanation).toBe(
      '2 future occurrences cancelled.',
    );
  });

  it('takes a custom protection window', () => {
    const got = planPauseOrEnd(SERIES, 400);
    expect(got.needsExplicitConfirmation).toEqual(['o3', 'o4', 'o5']);
    expect(got.explanation).toMatch(/window need the desk/);
  });
});
