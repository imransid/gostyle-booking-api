import { describe, it, expect } from 'vitest';
import {
  handleWebhook,
  type WebhookIntent,
  type BookingState,
} from './payment-webhook';

function intent(over: Partial<WebhookIntent> = {}): WebhookIntent {
  return {
    intentId: 'pi_abc123',
    kind: 'captured',
    amountFils: 24000,
    rail: 'card',
    ...over,
  };
}

function booking(over: Partial<BookingState> = {}): BookingState {
  return { status: 'pending_payment', alreadySeen: false, ...over };
}

describe('A DUPLICATE WEBHOOK CHARGES NOTHING TWICE', () => {
  it('is recognised before anything else is considered', () => {
    expect(handleWebhook(intent(), booking({ alreadySeen: true })).kind).toBe(
      'already_processed',
    );
  });

  it('even for a failure, a refund, or an expired booking', () => {
    for (const kind of [
      'captured',
      'capture_failed',
      'refunded',
      'refund_failed',
    ] as const) {
      for (const status of [
        'pending_payment',
        'expired',
        'cancelled',
        'settled',
      ]) {
        expect(
          handleWebhook(
            intent({ kind }),
            booking({ status, alreadySeen: true }),
          ).kind,
        ).toBe('already_processed');
      }
    }
  });
});

describe('the ordinary path', () => {
  it('an unpaid booking becomes confirmed', () => {
    const out = handleWebhook(intent(), booking());
    expect(out.kind).toBe('confirm');
    expect(out.kind === 'confirm' && out.explanation).toContain(
      'pass is issued',
    );
  });

  it('so does one awaiting confirmation', () => {
    expect(
      handleWebhook(intent(), booking({ status: 'pending_confirmation' })).kind,
    ).toBe('confirm');
  });

  it('a failed capture changes nothing', () => {
    const out = handleWebhook(intent({ kind: 'capture_failed' }), booking());
    expect(out.kind).toBe('capture_failed');
    expect(out.kind === 'capture_failed' && out.explanation).toContain(
      'still open',
    );
  });
});

describe('LATE MONEY, which is the case worth getting right', () => {
  it('the slot survived, so the booking comes back', () => {
    const out = handleWebhook(
      intent(),
      booking({ status: 'expired', slotStillFree: true }),
    );
    expect(out.kind).toBe('reinstate');
    expect(out.kind === 'reinstate' && out.explanation).toContain('still free');
  });

  it('the slot went, so the money goes back immediately', () => {
    const out = handleWebhook(
      intent(),
      booking({ status: 'expired', slotStillFree: false }),
    );
    expect(out.kind).toBe('auto_refund');
    expect(out.kind === 'auto_refund' && out.explanation).toContain(
      'rebook link',
    );
  });

  it('an unknown slot state is treated as gone, which is the safe direction', () => {
    // Reinstating a slot someone else has would double-book it. Refunding a
    // slot that was actually free costs a booking, which is recoverable.
    expect(handleWebhook(intent(), booking({ status: 'expired' })).kind).toBe(
      'auto_refund',
    );
  });

  it('THE CUSTOMER IS NEVER LEFT HOLDING A CHARGE AGAINST NOTHING', () => {
    for (const status of ['expired', 'cancelled', 'no_show', 'skipped']) {
      expect(handleWebhook(intent(), booking({ status })).kind).toBe(
        'auto_refund',
      );
    }
  });
});

describe('money against a booking that is already paid', () => {
  it('is recorded, not applied twice', () => {
    for (const status of [
      'confirmed',
      'checked_in',
      'in_service',
      'completed',
      'settled',
    ]) {
      expect(handleWebhook(intent(), booking({ status })).kind).toBe(
        'record_only',
      );
    }
  });
});

describe('NOTHING IS MARKED REFUNDED UNTIL MONEY ACTUALLY MOVES', () => {
  it('a refund that landed is recorded as settled', () => {
    expect(handleWebhook(intent({ kind: 'refunded' }), booking()).kind).toBe(
      'refund_settled',
    );
  });

  it('a refund that FAILED falls back to the wallet', () => {
    const out = handleWebhook(intent({ kind: 'refund_failed' }), booking());
    expect(out.kind).toBe('refund_to_wallet');
  });

  it('and says plainly that nothing was marked refunded', () => {
    const out = handleWebhook(intent({ kind: 'refund_failed' }), booking());
    expect(out.kind === 'refund_to_wallet' && out.explanation).toContain(
      'until money actually moves',
    );
  });

  it('a failed refund is never reported as a refund', () => {
    for (const status of ['confirmed', 'expired', 'cancelled', 'settled']) {
      const out = handleWebhook(
        intent({ kind: 'refund_failed' }),
        booking({ status }),
      );
      expect(out.kind).not.toBe('refund_settled');
    }
  });
});

describe('invariants', () => {
  const statuses = [
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
  const kinds = [
    'captured',
    'capture_failed',
    'refunded',
    'refund_failed',
  ] as const;

  it('every combination produces a decision, never a crash', () => {
    for (const status of statuses)
      for (const kind of kinds)
        for (const slotStillFree of [true, false, undefined]) {
          const out = handleWebhook(intent({ kind }), {
            status,
            alreadySeen: false,
            ...(slotStillFree !== undefined ? { slotStillFree } : {}),
          });
          expect(out.kind).toBeTruthy();
        }
  });

  it('a duplicate always wins, whatever the state', () => {
    for (const status of statuses)
      for (const kind of kinds) {
        expect(
          handleWebhook(intent({ kind }), { status, alreadySeen: true }).kind,
        ).toBe('already_processed');
      }
  });

  it('captured money is never silently kept against a dead booking', () => {
    for (const status of ['cancelled', 'no_show', 'expired', 'skipped']) {
      const out = handleWebhook(intent(), { status, alreadySeen: false });
      expect(['auto_refund', 'reinstate']).toContain(out.kind);
    }
  });

  it('every outcome explains itself, except a duplicate', () => {
    for (const status of statuses)
      for (const kind of kinds) {
        const out = handleWebhook(intent({ kind }), {
          status,
          alreadySeen: false,
        });
        if (out.kind === 'already_processed' || out.kind === 'ignored')
          continue;
        expect(out.explanation.length).toBeGreaterThan(20);
      }
  });
});
