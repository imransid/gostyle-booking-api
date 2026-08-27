import { describe, it, expect } from 'vitest';
import {
  matches,
  rank,
  planOffer,
  decline,
  slackMin,
  DECLINE_CAP,
  OFFER_TTL_MS,
  type WaitlistEntry,
  type FreedSlot,
} from './waitlist';

const NOW = 1_800_000_000_000;

function entry(over: Partial<WaitlistEntry> = {}): WaitlistEntry {
  return {
    id: 'w1',
    customerId: 'dana',
    serviceId: 'full-colour',
    tradingDay: '2026-09-10',
    windowFromMin: 840, // 14:00
    windowToMin: 1080, // 18:00
    preferredStaffId: null,
    tier: 'none',
    joinedAtMs: NOW - 10_000,
    declineCount: 0,
    declinedCodes: [],
    ...over,
  };
}

function slot(over: Partial<FreedSlot> = {}): FreedSlot {
  return {
    bookingCode: 'GS-1050',
    serviceId: 'full-colour',
    tradingDay: '2026-09-10',
    startMin: 900, // 15:00
    durationMin: 125,
    staffId: 'maya',
    ...over,
  };
}

describe('matching: all five conditions must hold', () => {
  it('a plain match', () => {
    expect(matches(entry(), slot()).kind).toBe('match');
  });

  it('a different service is not a match', () => {
    const v = matches(entry({ serviceId: 'blow-dry' }), slot());
    expect(v.kind === 'no_match' && v.why).toBe('different_service');
  });

  it('a different day is not a match', () => {
    const v = matches(entry({ tradingDay: '2026-09-11' }), slot());
    expect(v.kind === 'no_match' && v.why).toBe('different_day');
  });

  it('a start before the window is not a match', () => {
    const v = matches(entry(), slot({ startMin: 800 }));
    expect(v.kind === 'no_match' && v.why).toBe('outside_window');
  });

  it('a start after the window is not a match', () => {
    const v = matches(entry(), slot({ startMin: 1100 }));
    expect(v.kind === 'no_match' && v.why).toBe('outside_window');
  });

  it('the window is half-open: the from minute is in, the to minute is out', () => {
    expect(matches(entry(), slot({ startMin: 840 })).kind).toBe('match');
    expect(matches(entry(), slot({ startMin: 1080 })).kind).toBe('no_match');
  });

  it('THE VISIT MAY RUN PAST THE WINDOW', () => {
    // 17:55 start, 125 minutes, ends 20:00. The window says when they can
    // ARRIVE, not when they must be finished.
    expect(matches(entry(), slot({ startMin: 1075 })).kind).toBe('match');
  });

  it('"any professional" takes whoever freed up', () => {
    expect(
      matches(entry({ preferredStaffId: null }), slot({ staffId: 'anya' }))
        .kind,
    ).toBe('match');
  });

  it('a named professional must be exactly that person', () => {
    expect(
      matches(entry({ preferredStaffId: 'maya' }), slot({ staffId: 'maya' }))
        .kind,
    ).toBe('match');
    const v = matches(
      entry({ preferredStaffId: 'maya' }),
      slot({ staffId: 'anya' }),
    );
    expect(v.kind === 'no_match' && v.why).toBe('different_professional');
  });

  it('A SLOT ALREADY DECLINED IS NOT OFFERED AGAIN', () => {
    const v = matches(entry({ declinedCodes: ['GS-1050'] }), slot());
    expect(v.kind === 'no_match' && v.why).toBe('already_declined');
  });

  it('but a different slot still is', () => {
    expect(matches(entry({ declinedCodes: ['GS-9999'] }), slot()).kind).toBe(
      'match',
    );
  });

  it('the decline cap removes them from matching entirely', () => {
    const v = matches(entry({ declineCount: DECLINE_CAP }), slot());
    expect(v.kind === 'no_match' && v.why).toBe('decline_cap_reached');
  });
});

describe('ranking: the queue is a queue', () => {
  it('earliest joiner first', () => {
    const late = entry({ id: 'late', joinedAtMs: NOW });
    const early = entry({ id: 'early', joinedAtMs: NOW - 60_000 });
    expect(rank([late, early], slot()).map((e) => e.id)).toEqual([
      'early',
      'late',
    ]);
  });

  it('JOIN ORDER BEATS TIER, which is the fairness rule', () => {
    const royalLate = entry({ id: 'royal', tier: 'royal', joinedAtMs: NOW });
    const plainEarly = entry({
      id: 'plain',
      tier: 'none',
      joinedAtMs: NOW - 1000,
    });
    expect(rank([royalLate, plainEarly], slot())[0]!.id).toBe('plain');
  });

  it('tier only breaks an exact join-time tie', () => {
    const t = NOW - 5000;
    const plain = entry({ id: 'plain', tier: 'none', joinedAtMs: t });
    const gold = entry({ id: 'gold', tier: 'gold', joinedAtMs: t });
    expect(rank([plain, gold], slot())[0]!.id).toBe('gold');
  });

  it('Royal and VIP rank together, above Gold', () => {
    const t = NOW - 5000;
    const vip = entry({ id: 'vip', tier: 'vip', joinedAtMs: t });
    const gold = entry({ id: 'gold', tier: 'gold', joinedAtMs: t });
    const royal = entry({ id: 'royal', tier: 'royal', joinedAtMs: t });
    const order = rank([gold, vip, royal], slot()).map((e) => e.id);
    expect(order[2]).toBe('gold');
  });

  it('fit tightness breaks a tie in join order AND tier', () => {
    const t = NOW - 5000;
    const loose = entry({
      id: 'loose',
      joinedAtMs: t,
      windowFromMin: 600,
      windowToMin: 1320,
    });
    const tight = entry({
      id: 'tight',
      joinedAtMs: t,
      windowFromMin: 890,
      windowToMin: 1030,
    });
    expect(rank([loose, tight], slot())[0]!.id).toBe('tight');
  });

  it('slack is the window minus the service', () => {
    // 14:00 to 18:00 is 240 minutes; a 125-minute colour leaves 115.
    expect(slackMin(entry(), slot())).toBe(115);
  });

  it('non-matching entries never appear', () => {
    const wrong = entry({ id: 'wrong', serviceId: 'blow-dry' });
    expect(rank([wrong, entry()], slot()).map((e) => e.id)).toEqual(['w1']);
  });

  it('the order is stable when everything ties', () => {
    const t = NOW - 5000;
    const a = entry({ id: 'aaa', joinedAtMs: t });
    const b = entry({ id: 'bbb', joinedAtMs: t });
    expect(rank([b, a], slot()).map((e) => e.id)).toEqual(['aaa', 'bbb']);
  });
});

describe('the offer', () => {
  it('goes to the top candidate and holds for fifteen minutes', () => {
    const plan = planOffer([entry()], slot(), NOW);
    expect(plan.offerTo?.id).toBe('w1');
    expect(plan.expiresAtMs).toBe(NOW + OFFER_TTL_MS);
  });

  it('with nobody matching there is no offer', () => {
    const plan = planOffer([entry({ serviceId: 'blow-dry' })], slot(), NOW);
    expect(plan.offerTo).toBeNull();
    expect(plan.expiresAtMs).toBeNull();
  });

  it('EVERY MISS IS EXPLAINED, so an operator can answer "why not me"', () => {
    const plan = planOffer(
      [
        entry({ id: 'a', serviceId: 'blow-dry' }),
        entry({ id: 'b', tradingDay: '2026-09-11' }),
        entry({ id: 'c', preferredStaffId: 'anya' }),
        entry({ id: 'd' }),
      ],
      slot(),
      NOW,
    );
    expect(plan.offerTo?.id).toBe('d');
    expect(plan.passedOver).toEqual([
      { id: 'a', why: 'different_service' },
      { id: 'b', why: 'different_day' },
      { id: 'c', why: 'different_professional' },
    ]);
  });

  it('the whole queue is kept, so a decline can pass straight down', () => {
    const first = entry({ id: 'first', joinedAtMs: NOW - 3000 });
    const second = entry({ id: 'second', joinedAtMs: NOW - 2000 });
    const third = entry({ id: 'third', joinedAtMs: NOW - 1000 });
    const plan = planOffer([third, first, second], slot(), NOW);
    expect(plan.candidates.map((e) => e.id)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });
});

describe('THE FAIRNESS CAP', () => {
  it('the first two declines pass the offer down', () => {
    expect(decline(entry({ declineCount: 0 })).kind).toBe('passes_down');
    expect(decline(entry({ declineCount: 1 })).kind).toBe('passes_down');
  });

  it('the third removes them from the list', () => {
    const out = decline(entry({ declineCount: 2 }));
    expect(out.kind).toBe('leaves_list');
    expect(out.declineCount).toBe(3);
  });

  it('and the message reads as a pause, not a punishment', () => {
    const out = decline(entry({ declineCount: 2 }));
    expect(out.kind === 'leaves_list' && out.message).toContain('rejoin');
  });

  it('THE POINT: one holdout cannot absorb every offer', () => {
    // A customer waiting for one specific hour declines everything else.
    // After three, the people who would have taken those slots get them.
    let holdout = entry({ id: 'holdout', joinedAtMs: NOW - 99_999 });
    const other = entry({ id: 'other', joinedAtMs: NOW });

    for (let i = 0; i < DECLINE_CAP; i++) {
      const plan = planOffer(
        [holdout, other],
        slot({ bookingCode: `GS-${i}` }),
        NOW,
      );
      expect(plan.offerTo!.id).toBe('holdout');
      const out = decline(holdout);
      holdout = { ...holdout, declineCount: out.declineCount };
    }

    const after = planOffer(
      [holdout, other],
      slot({ bookingCode: 'GS-X' }),
      NOW,
    );
    expect(after.offerTo!.id).toBe('other');
  });
});

describe('invariants', () => {
  it('a ranked entry always matches', () => {
    const pool = [
      entry({ id: '1' }),
      entry({ id: '2', serviceId: 'blow-dry' }),
      entry({ id: '3', declineCount: 5 }),
      entry({ id: '4', preferredStaffId: 'anya' }),
      entry({ id: '5', declinedCodes: ['GS-1050'] }),
    ];
    for (const e of rank(pool, slot())) {
      expect(matches(e, slot()).kind).toBe('match');
    }
  });

  it('ranked plus passed-over always equals the pool', () => {
    const pool = [
      entry({ id: '1' }),
      entry({ id: '2', serviceId: 'blow-dry' }),
      entry({ id: '3', declineCount: 5 }),
    ];
    const plan = planOffer(pool, slot(), NOW);
    expect(plan.candidates.length + plan.passedOver.length).toBe(pool.length);
  });

  it('nobody is ever offered a slot they declined', () => {
    const declined = entry({
      id: 'd',
      declinedCodes: ['GS-1050'],
      joinedAtMs: 0,
    });
    const plan = planOffer([declined, entry()], slot(), NOW);
    expect(plan.offerTo!.id).not.toBe('d');
  });

  it('an empty list produces no offer and no crash', () => {
    const plan = planOffer([], slot(), NOW);
    expect(plan.offerTo).toBeNull();
    expect(plan.candidates).toEqual([]);
  });
});
