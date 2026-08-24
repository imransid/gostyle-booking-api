import { describe, it, expect } from 'vitest';
import {
  BLOCKING_STATES,
  RELEASING_STATES,
  TRANSITIONS,
  isBlocking,
  releasesCapacity,
  isTerminal,
  canTransition,
  nextStates,
  findTransition,
  checkTransition,
  arrivalWindow,
  canCheckIn,
  cancellationOutcome,
  noShowOutcome,
  balances,
  CHECK_IN_OPENS_MIN,
  ARRIVAL_GRACE_MIN,
  VIP_ARRIVAL_GRACE_MIN,
  AUTO_NO_SHOW_MIN,
  type BookingStatus,
  type CheckInGates,
} from './lifecycle';

const ALL: BookingStatus[] = [
  'draft',
  'held',
  'pending_payment',
  'pending_confirmation',
  'confirmed',
  'checked_in',
  'in_service',
  'completed',
  'settled',
  'cancelled',
  'no_show',
  'rescheduled',
  'expired',
  'skipped',
];

describe('blocking is the predicate everything else stands on', () => {
  it('seven states hold capacity', () => {
    expect(BLOCKING_STATES.size).toBe(7);
    expect(isBlocking('confirmed')).toBe(true);
    expect(isBlocking('checked_in')).toBe(true);
    expect(isBlocking('in_service')).toBe(true);
  });

  it('a completed visit still blocks, because it happened', () => {
    expect(isBlocking('completed')).toBe(true);
    expect(isBlocking('settled')).toBe(true);
  });

  it('four exits release capacity, and those are what wake the waitlist', () => {
    expect([...RELEASING_STATES].sort()).toEqual([
      'cancelled',
      'expired',
      'no_show',
      'skipped',
    ]);
    for (const s of RELEASING_STATES) expect(releasesCapacity(s)).toBe(true);
  });

  it('no state both blocks and releases', () => {
    for (const s of ALL) {
      expect(isBlocking(s) && releasesCapacity(s)).toBe(false);
    }
  });

  it('draft and held are neither: a draft reserves nothing, a hold is not a booking', () => {
    expect(isBlocking('draft')).toBe(false);
    expect(releasesCapacity('draft')).toBe(false);
    expect(isBlocking('held')).toBe(false);
  });
});

describe('only listed moves are legal', () => {
  it('the happy path walks all the way to settled', () => {
    const path: BookingStatus[] = [
      'draft',
      'held',
      'confirmed',
      'checked_in',
      'in_service',
      'completed',
      'settled',
    ];
    for (let i = 1; i < path.length; i++) {
      expect(canTransition(path[i - 1]!, path[i]!)).toBe(true);
    }
  });

  it('you cannot complete a visit that never started', () => {
    expect(canTransition('confirmed', 'completed')).toBe(false);
    expect(canTransition('confirmed', 'in_service')).toBe(false);
  });

  it('you cannot check in a cancelled visit', () => {
    expect(canTransition('cancelled', 'checked_in')).toBe(false);
  });

  it('nothing leaves a terminal state', () => {
    for (const s of ALL.filter(isTerminal)) {
      expect(nextStates(s)).toEqual([]);
    }
  });

  it('settled is the end of the road', () => {
    expect(isTerminal('settled')).toBe(true);
    expect(nextStates('settled')).toEqual([]);
  });

  it('a confirmed booking has exactly four ways out', () => {
    expect(nextStates('confirmed')).toEqual([
      'cancelled',
      'checked_in',
      'no_show',
      'rescheduled',
    ]);
  });

  it('every transition names its trigger', () => {
    for (const t of TRANSITIONS) {
      expect(t.trigger.length).toBeGreaterThan(0);
      expect(t.allowedActors.length).toBeGreaterThan(0);
    }
  });

  it('no duplicate from-to pairs', () => {
    const seen = new Set(TRANSITIONS.map((t) => `${t.from}->${t.to}`));
    expect(seen.size).toBe(TRANSITIONS.length);
  });
});

describe('the gate every lifecycle command runs', () => {
  it('lets a legal move through', () => {
    const v = checkTransition({
      from: 'confirmed',
      to: 'checked_in',
      actor: 'staff',
    });
    expect(v.kind).toBe('allowed');
  });

  it('refuses an impossible move before anything else', () => {
    const v = checkTransition({
      from: 'cancelled',
      to: 'checked_in',
      actor: 'customer',
      reason: null,
    });
    // Illegal beats forbidden beats needs-reason. Telling a receptionist to
    // supply a reason for a move that could never work is worse than useless.
    expect(v.kind).toBe('illegal');
    if (v.kind === 'illegal') expect(v.message).toContain('cannot become');
  });

  it('refuses an actor who may not do it', () => {
    const v = checkTransition({
      from: 'in_service',
      to: 'completed',
      actor: 'customer',
    });
    expect(v.kind).toBe('forbidden');
  });

  it('a cancellation without a reason is refused', () => {
    expect(
      checkTransition({ from: 'confirmed', to: 'cancelled', actor: 'staff' })
        .kind,
    ).toBe('needs_reason');
    expect(
      checkTransition({
        from: 'confirmed',
        to: 'cancelled',
        actor: 'staff',
        reason: '   ',
      }).kind,
    ).toBe('needs_reason');
  });

  it('and passes once a reason is given', () => {
    expect(
      checkTransition({
        from: 'confirmed',
        to: 'cancelled',
        actor: 'staff',
        reason: 'customer called',
      }).kind,
    ).toBe('allowed');
  });

  it('an automatic no-show is the system, not a person', () => {
    const t = findTransition('confirmed', 'no_show');
    expect(t?.allowedActors).toContain('system');
    expect(
      checkTransition({ from: 'confirmed', to: 'no_show', actor: 'system' })
        .kind,
    ).toBe('allowed');
  });
});

describe('the arrival window', () => {
  const START = 900;

  it('check-in opens 30 minutes before', () => {
    expect(arrivalWindow(START).opensAtMin).toBe(START - CHECK_IN_OPENS_MIN);
  });

  it('grace is 15 minutes, and 20 for a VIP', () => {
    expect(arrivalWindow(START).graceEndsAtMin).toBe(START + ARRIVAL_GRACE_MIN);
    expect(arrivalWindow(START, true).graceEndsAtMin).toBe(
      START + VIP_ARRIVAL_GRACE_MIN,
    );
  });

  it('the desk owns the decision until start plus 30', () => {
    expect(arrivalWindow(START).autoNoShowAtMin).toBe(START + AUTO_NO_SHOW_MIN);
  });

  it('there is always a window where the desk decides, never the system', () => {
    const w = arrivalWindow(START);
    expect(w.autoNoShowAtMin).toBeGreaterThan(w.graceEndsAtMin);
  });
});

describe('three gates guard check-in', () => {
  const green: CheckInGates = {
    consentAndPatchTest: true,
    paymentSettled: true,
    chairSelected: true,
  };

  it('all green inside the window is ready', () => {
    expect(canCheckIn({ gates: green, nowMin: 880, startMin: 900 })).toEqual({
      kind: 'ready',
    });
  });

  it('too early names the minute it opens', () => {
    const v = canCheckIn({ gates: green, nowMin: 860, startMin: 900 });
    expect(v).toEqual({ kind: 'too_early', opensAtMin: 870 });
  });

  it('a missing gate is named, not just refused', () => {
    const v = canCheckIn({
      gates: { ...green, paymentSettled: false },
      nowMin: 880,
      startMin: 900,
    });
    expect(v.kind).toBe('gates_amber');
    if (v.kind === 'gates_amber') expect(v.amber).toEqual(['payment']);
  });

  it('every amber gate is listed at once, so the desk fixes them together', () => {
    const v = canCheckIn({
      gates: {
        consentAndPatchTest: false,
        paymentSettled: false,
        chairSelected: false,
      },
      nowMin: 880,
      startMin: 900,
    });
    if (v.kind === 'gates_amber') expect(v.amber).toHaveLength(3);
  });

  it('a late arrival can still check in, because grace is not a wall', () => {
    expect(canCheckIn({ gates: green, nowMin: 910, startMin: 900 })).toEqual({
      kind: 'ready',
    });
  });
});

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const DEPOSIT = 24000;

describe('cancellation, the refund matrix', () => {
  function cancel(hoursAhead: number, over = {}) {
    return cancellationOutcome({
      nowMs: NOW,
      startAtMs: NOW + hoursAhead * HOUR,
      capturedFils: DEPOSIT,
      paidInFull: false,
      initiatedBy: 'customer',
      ...over,
    });
  }

  it('more than 24 hours ahead: refunded in full', () => {
    const o = cancel(48);
    expect(o.band).toBe('more_than_24h');
    expect(o.refundFils).toBe(DEPOSIT);
    expect(o.keptFils).toBe(0);
  });

  it('between 24 and 2 hours: the deposit is kept', () => {
    const o = cancel(6);
    expect(o.band).toBe('24h_to_2h');
    expect(o.keptFils).toBe(DEPOSIT);
    expect(o.lateCancel).toBe(false);
  });

  it('full payment in that band splits fifty-fifty', () => {
    const o = cancel(6, { capturedFils: 48000, paidInFull: true });
    expect(o.refundFils).toBe(24000);
    expect(o.keptFils).toBe(24000);
  });

  it('under 2 hours is a LATE CANCEL and weighs more', () => {
    const o = cancel(1);
    expect(o.band).toBe('under_2h');
    expect(o.keptFils).toBe(DEPOSIT);
    expect(o.lateCancel).toBe(true);
  });

  it('the boundaries land on the generous side of the customer', () => {
    expect(cancel(24.001).band).toBe('more_than_24h');
    expect(cancel(24).band).toBe('24h_to_2h');
    expect(cancel(2.001).band).toBe('24h_to_2h');
    expect(cancel(2).band).toBe('under_2h');
  });

  it('the salon cancelling refunds in full, whatever the timing', () => {
    const o = cancel(0.5, { initiatedBy: 'salon' });
    expect(o.band).toBe('salon_initiated');
    expect(o.refundFils).toBe(DEPOSIT);
    expect(o.lateCancel).toBe(false);
  });

  it('nothing captured means nothing to argue about', () => {
    const o = cancel(1, { capturedFils: 0 });
    expect(o.band).toBe('nothing_captured');
    expect(o.refundFils).toBe(0);
    expect(o.keptFils).toBe(0);
  });

  it('every outcome carries a sentence the desk can read aloud', () => {
    for (const h of [48, 6, 1, 0.5]) {
      expect(cancel(h).explanation.length).toBeGreaterThan(10);
    }
  });
});

describe('no-show', () => {
  it('the deposit is forfeited and the risk score moves', () => {
    const o = noShowOutcome({ capturedFils: DEPOSIT });
    expect(o.keptFils).toBe(DEPOSIT);
    expect(o.lateCancel).toBe(true);
  });

  it('a VIP standing reservation has the fee waived by rule', () => {
    const o = noShowOutcome({
      capturedFils: DEPOSIT,
      vipStandingReservation: true,
    });
    expect(o.refundFils).toBe(DEPOSIT);
    expect(o.keptFils).toBe(0);
  });

  it('no deposit means nothing is forfeited, and it says so', () => {
    const o = noShowOutcome({ capturedFils: 0 });
    expect(o.keptFils).toBe(0);
    expect(o.explanation).toContain('nothing is forfeited');
  });
});

describe('money is never invented or destroyed', () => {
  it('refund plus kept equals captured, across 500 random cases', () => {
    for (let t = 0; t < 500; t++) {
      const captured = Math.floor(Math.random() * 100000);
      const hoursAhead = Math.random() * 72;
      const o = cancellationOutcome({
        nowMs: NOW,
        startAtMs: NOW + hoursAhead * HOUR,
        capturedFils: captured,
        paidInFull: Math.random() < 0.5,
        initiatedBy: Math.random() < 0.5 ? 'customer' : 'salon',
      });
      expect(balances(o, captured)).toBe(true);
    }
  });

  it('and the same holds for no-shows', () => {
    for (let t = 0; t < 200; t++) {
      const captured = Math.floor(Math.random() * 100000);
      const o = noShowOutcome({
        capturedFils: captured,
        vipStandingReservation: Math.random() < 0.5,
      });
      expect(balances(o, captured)).toBe(true);
    }
  });

  it('a 50/50 split of an odd amount still balances', () => {
    const o = cancellationOutcome({
      nowMs: NOW,
      startAtMs: NOW + 6 * HOUR,
      capturedFils: 12345,
      paidInFull: true,
      initiatedBy: 'customer',
    });
    expect(balances(o, 12345)).toBe(true);
  });
});
