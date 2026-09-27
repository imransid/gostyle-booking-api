import { describe, it, expect } from 'vitest';
import { cancelClaimFrom, cancelSummaryView } from './mobile-series-cancel';
import { cancelSummary } from './mobile-series';
import { checkCancel } from './mobile-series-contract';

type SessionIn = Parameters<typeof cancelSummary>[0][number];

const NOW = Date.parse('2026-10-01T09:00:00+06:00');
const HOUR = 3_600_000;

/** A booked session still to come, with what was paid for it (fils). */
const booked = (
  id: string,
  index: number,
  day: string,
  startAtMs: number,
  capturedFils = 0,
): SessionIn =>
  ({
    id,
    index,
    day,
    startAtMs,
    state: 'materialised',
    bookingStatus: 'confirmed',
    noShowBy: null,
    capturedFils,
  }) as unknown as SessionIn;

describe('cancelClaimFrom: the cancel body into the contract claim (step 7)', () => {
  it('reads dry_run and the reason', () => {
    expect(cancelClaimFrom({ dry_run: true, reason: 'MOVING' })).toEqual({
      dryRun: true,
      reason: 'MOVING',
    });
  });

  it('an empty body is a real cancel with no reason', () => {
    expect(cancelClaimFrom({})).toEqual({ dryRun: false, reason: null });
    expect(cancelClaimFrom(null)).toEqual({ dryRun: false, reason: null });
  });

  it('a blank reason is no reason', () => {
    expect(cancelClaimFrom({ reason: '  ' }).reason).toBeNull();
  });

  it('a reason that is not text is refused, never dropped', () => {
    const claim = cancelClaimFrom({ reason: 3 });
    expect(claim.reason).toBe('3');
    expect(checkCancel(claim).kind).toBe('refused');
  });

  it('only a real true is a dry run', () => {
    expect(cancelClaimFrom({ dry_run: 'true' }).dryRun).toBe(false);
  });
});

describe('cancelSummaryView: the refund summary as the app reads it (step 7)', () => {
  it('pay at salon: every session still to come, nothing paid, nothing refunded', () => {
    const view = cancelSummaryView(
      cancelSummary(
        [
          booked('a', 0, '2026-10-20', Date.parse('2026-10-20T11:00:00+06:00')),
          booked('b', 1, '2026-10-01', NOW + 5 * HOUR),
        ],
        NOW,
      ),
    );
    expect(view).toMatchObject({
      visits_cancelled: 2,
      late_visits: 1,
      paid: 0,
      refund: 0,
      kept: 0,
    });
    expect(view.sessions.map((s) => [s.id, s.late, s.refund_band])).toEqual([
      ['b', true, 'NOTHING_CAPTURED'],
      ['a', false, 'NOTHING_CAPTURED'],
    ]);
  });

  it('paid in the app: a full refund past 24 hours, the deposit kept inside them', () => {
    const view = cancelSummaryView(
      cancelSummary(
        [
          booked(
            'a',
            0,
            '2026-10-20',
            Date.parse('2026-10-20T11:00:00+06:00'),
            2000,
          ),
          booked('b', 1, '2026-10-01', NOW + 5 * HOUR, 1000),
        ],
        NOW,
      ),
    );
    expect(view).toMatchObject({ paid: 30, refund: 20, kept: 10 });
    expect(
      view.sessions.map((s) => [s.id, s.refund, s.kept, s.refund_band]),
    ).toEqual([
      ['b', 0, 10, '24H_TO_2H'],
      ['a', 20, 0, 'MORE_THAN_24H'],
    ]);
  });
});
