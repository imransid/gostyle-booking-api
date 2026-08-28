import { describe, it, expect } from 'vitest';
import {
  deriveSeriesHealth,
  CONSECUTIVE_EXPIRIES_AT_RISK,
  SKIPS_AT_RISK,
  type SeriesFacts,
} from './series-health';

const facts = (over: Partial<SeriesFacts> = {}): SeriesFacts => ({
  status: 'active',
  needsAttentionCount: 0,
  consecutiveConfirmationExpiries: 0,
  noShowCount: 0,
  skippedCount: 0,
  ...over,
});

describe('a healthy series', () => {
  it('is healthy with no reasons', () => {
    const got = deriveSeriesHealth(facts());
    expect(got.health).toBe('healthy');
    expect(got.reasons).toEqual([]);
    expect(got.explanation).toMatch(/running normally/);
  });

  it('stays healthy when paused', () => {
    expect(deriveSeriesHealth(facts({ status: 'paused' })).health).toBe(
      'healthy',
    );
  });
});

describe('an occurrence that needs attention', () => {
  it('puts the series at risk', () => {
    const got = deriveSeriesHealth(facts({ needsAttentionCount: 1 }));
    expect(got.health).toBe('at_risk');
    expect(got.reasons).toContain('needs_attention');
  });

  it('counts them in the explanation', () => {
    expect(
      deriveSeriesHealth(facts({ needsAttentionCount: 3 })).explanation,
    ).toMatch(/3 occurrences need attention/);
  });
});

describe('lapsing confirmations', () => {
  it('tolerates a single unanswered request', () => {
    expect(
      deriveSeriesHealth(facts({ consecutiveConfirmationExpiries: 1 })).health,
    ).toBe('healthy');
  });

  it('flags two in a row', () => {
    const got = deriveSeriesHealth(
      facts({ consecutiveConfirmationExpiries: CONSECUTIVE_EXPIRIES_AT_RISK }),
    );
    expect(got.health).toBe('at_risk');
    expect(got.reasons).toContain('confirmations_lapsing');
  });
});

describe('no-shows', () => {
  it('one is enough', () => {
    const got = deriveSeriesHealth(facts({ noShowCount: 1 }));
    expect(got.health).toBe('at_risk');
    expect(got.reasons).toContain('no_show');
  });

  it('counts even where the fee was waived by rule', () => {
    // A standing VIP has the fee waived. The empty chair still happened.
    const got = deriveSeriesHealth(facts({ noShowCount: 1, status: 'active' }));
    expect(got.health).toBe('at_risk');
  });
});

describe('skipping', () => {
  it('tolerates the odd busy fortnight', () => {
    expect(deriveSeriesHealth(facts({ skippedCount: 2 })).health).toBe(
      'healthy',
    );
  });

  it('flags a client who has quietly stopped coming', () => {
    const got = deriveSeriesHealth(facts({ skippedCount: SKIPS_AT_RISK }));
    expect(got.health).toBe('at_risk');
    expect(got.reasons).toContain('skipping');
  });
});

describe('several problems at once', () => {
  it('reports every reason, not just the first', () => {
    const got = deriveSeriesHealth(
      facts({
        needsAttentionCount: 1,
        consecutiveConfirmationExpiries: 2,
        noShowCount: 1,
        skippedCount: 4,
      }),
    );
    expect(got.reasons).toEqual([
      'needs_attention',
      'confirmations_lapsing',
      'no_show',
      'skipping',
    ]);
  });

  it('lists them all in one line for the panel', () => {
    const got = deriveSeriesHealth(
      facts({ needsAttentionCount: 1, noShowCount: 2 }),
    );
    expect(got.explanation).toMatch(/^At risk:/);
    expect(got.explanation).toMatch(/1 occurrence needs attention/);
    expect(got.explanation).toMatch(/2 no-shows/);
  });
});
