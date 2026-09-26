import { describe, it, expect } from 'vitest';
import { manageClaimFrom } from './mobile-series-manage';

describe('manageClaimFrom: the PATCH body into the contract claim', () => {
  it('reads a SKIP', () => {
    const claim = manageClaimFrom({
      action: 'SKIP',
      session_ids: ['a', 'b'],
      dry_run: true,
    });
    expect(claim.action).toBe('SKIP');
    expect(claim.sessionIds).toEqual(['a', 'b']);
    expect(claim.dryRun).toBe(true);
  });

  it('leaves a field of the wrong type out, for checkManage to answer', () => {
    const claim = manageClaimFrom({
      action: 7,
      session_ids: 'a',
      sessions: '2',
    });
    expect(claim.action).toBe('');
    expect(claim.sessionIds).toBeNull();
    expect(claim.sessions).toBeNull();
    expect(claim.dryRun).toBe(false);
  });

  it('reads picks, and keeps only well formed ones', () => {
    const claim = manageClaimFrom({
      action: 'EXTEND',
      picks: [
        { index: 1, date: '2026-10-27', time: '12:00', stylist_id: 's' },
        { index: 'x', date: '2026-10-27', time: '12:00' },
      ],
    });
    expect(claim.picks).toEqual([
      { index: 1, date: '2026-10-27', time: '12:00', stylistId: 's' },
    ]);
  });

  it('treats a body that is not an object as empty', () => {
    expect(manageClaimFrom(null).action).toBe('');
  });
});
