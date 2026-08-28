import { describe, it, expect } from 'vitest';
import {
  birthState,
  mayHoldStandingReservation,
  SCHEDULE_REMINDER_LEAD_HOURS,
  CONFIRMATION_REQUEST_LEAD_DAYS,
  CONFIRMATION_WINDOW_HOURS,
  type MaterialisationInput,
} from './auto-confirm';

const input = (
  over: Partial<MaterialisationInput> = {},
): MaterialisationInput => ({
  rule: 'auto_confirm_on_schedule',
  requirement: 'none',
  tier: 'none',
  ...over,
});

describe('auto-confirm on schedule', () => {
  it('is born confirmed when nothing is owed', () => {
    const got = birthState(input());
    expect(got.status).toBe('confirmed');
    expect(got.depositWaived).toBe(false);
  });

  it('sends a reminder 48 hours before', () => {
    const got = birthState(input());
    expect(got.notification).toEqual({
      leadHours: SCHEDULE_REMINDER_LEAD_HOURS,
      kind: 'reminder',
    });
  });

  it('waits on payment when a deposit is owed', () => {
    const got = birthState(input({ requirement: 'deposit' }));
    expect(got.status).toBe('pending_payment');
    expect(got.explanation).toMatch(/needs a deposit/);
  });

  it('waits on payment when the whole visit is owed', () => {
    const got = birthState(input({ requirement: 'full' }));
    expect(got.status).toBe('pending_payment');
    expect(got.explanation).toMatch(/in full/);
  });

  it('never opens a confirmation window: the cadence was pre-agreed', () => {
    expect(birthState(input()).confirmationWindowHours).toBeNull();
    expect(
      birthState(input({ requirement: 'deposit' })).confirmationWindowHours,
    ).toBeNull();
  });
});

describe('ask the customer each time', () => {
  it('is born pending confirmation', () => {
    expect(birthState(input({ rule: 'ask_each_time' })).status).toBe(
      'pending_confirmation',
    );
  });

  it('asks seven days ahead and runs a 48-hour window', () => {
    const got = birthState(input({ rule: 'ask_each_time' }));
    expect(got.notification).toEqual({
      leadHours: CONFIRMATION_REQUEST_LEAD_DAYS * 24,
      kind: 'confirmation_request',
    });
    expect(got.confirmationWindowHours).toBe(CONFIRMATION_WINDOW_HOURS);
  });

  it('outranks the payment requirement', () => {
    // There is no point charging for a visit the customer has not agreed to.
    const got = birthState(
      input({ rule: 'ask_each_time', requirement: 'full' }),
    );
    expect(got.status).toBe('pending_confirmation');
  });
});

describe('VIP standing reservation', () => {
  it('is Gold and Royal only', () => {
    expect(mayHoldStandingReservation('gold')).toBe(true);
    expect(mayHoldStandingReservation('royal')).toBe(true);
    expect(mayHoldStandingReservation('vip')).toBe(false);
    expect(mayHoldStandingReservation('silver')).toBe(false);
    expect(mayHoldStandingReservation('none')).toBe(false);
  });

  it('is born confirmed with the deposit waived', () => {
    const got = birthState(input({ rule: 'vip_standing', tier: 'gold' }));
    expect(got.status).toBe('confirmed');
    expect(got.depositWaived).toBe(true);
  });

  it('waives even a full-payment requirement', () => {
    // A standing reservation that has to be paid for is not standing.
    const got = birthState(
      input({ rule: 'vip_standing', tier: 'royal', requirement: 'full' }),
    );
    expect(got.status).toBe('confirmed');
    expect(got.depositWaived).toBe(true);
  });

  it('falls back to asking when the tier no longer qualifies', () => {
    // The rule was set while they were Gold; they have since been downgraded.
    const got = birthState(
      input({ rule: 'vip_standing', tier: 'silver', requirement: 'deposit' }),
    );
    expect(got.status).toBe('pending_confirmation');
    expect(got.depositWaived).toBe(false);
    expect(got.explanation).toMatch(/Gold or Royal/);
  });

  it('still reminds 48 hours before, like any confirmed occurrence', () => {
    const got = birthState(input({ rule: 'vip_standing', tier: 'gold' }));
    expect(got.notification?.kind).toBe('reminder');
    expect(got.notification?.leadHours).toBe(SCHEDULE_REMINDER_LEAD_HOURS);
  });
});

describe('every rule', () => {
  it('explains itself', () => {
    for (const rule of [
      'auto_confirm_on_schedule',
      'ask_each_time',
      'vip_standing',
    ] as const) {
      expect(
        birthState(input({ rule, tier: 'gold' })).explanation.length,
      ).toBeGreaterThan(20);
    }
  });

  it('only ever produces a state a new booking may legally hold', () => {
    const legal = new Set([
      'confirmed',
      'pending_payment',
      'pending_confirmation',
    ]);
    for (const rule of [
      'auto_confirm_on_schedule',
      'ask_each_time',
      'vip_standing',
    ] as const) {
      for (const requirement of ['none', 'deposit', 'full'] as const) {
        for (const tier of [
          'none',
          'silver',
          'gold',
          'vip',
          'royal',
        ] as const) {
          expect(
            legal.has(birthState({ rule, requirement, tier }).status),
          ).toBe(true);
        }
      }
    }
  });
});
