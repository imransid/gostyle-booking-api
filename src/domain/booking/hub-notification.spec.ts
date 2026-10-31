import { describe, it, expect } from 'vitest';
import { HUB_EVENTS, hubPlan, type HubBooking } from './hub-notification';

const BOOKING: HubBooking = {
  id: '11111111-1111-4111-8111-111111111111',
  code: 'GS-1481',
  status: 'confirmed',
  startAtMs: Date.parse('2026-11-02T07:00:00Z'),
  branchId: '33333333-3333-4333-8333-333333333333',
};
const EXPIRES = Date.parse('2026-11-01T08:00:00Z');

const plan = (eventType: string, booking: HubBooking | null = BOOKING) =>
  hubPlan({
    eventType,
    sourceEventId: 'ev-9',
    customerId: 'c-1',
    booking,
    scheduledForMs: BOOKING.startAtMs,
    expiresAtMs: EXPIRES,
  });

describe('hubPlan', () => {
  it('hands over facts, never words', () => {
    const p = plan('booking.confirmed');
    expect(p).toEqual({
      kind: 'send',
      request: {
        consumerId: 'c-1',
        type: 'booking.confirmed',
        dedupeKey: `booking.confirmed:${BOOKING.id}`,
        params: {
          booking_id: BOOKING.id,
          booking_code: 'GS-1481',
          branch_id: BOOKING.branchId,
          start_at: '2026-11-02T07:00:00.000Z',
        },
        targetType: 'booking',
        targetId: BOOKING.id,
        deliverBy: '2026-11-01T08:00:00.000Z',
      },
    });
  });

  it.each(['draft', 'held', 'pending_payment'])(
    'confirmed while %s waits for the payment',
    (status) => {
      expect(plan('booking.confirmed', { ...BOOKING, status })).toEqual({
        kind: 'skip',
        reason: 'awaiting_payment',
      });
    },
  );

  it.each(['confirmed', 'checked_in', 'in_service', 'completed', 'settled'])(
    'confirmed is still true to say at %s',
    (status) => {
      expect(
        plan('booking.payment_recorded', { ...BOOKING, status }).kind,
      ).toBe('send');
    },
  );

  it.each(['cancelled', 'no_show', 'expired'])(
    'confirmed is not said once it is %s',
    (status) => {
      expect(plan('booking.confirmed', { ...BOOKING, status })).toEqual({
        kind: 'skip',
        reason: `booking_${status}`,
      });
    },
  );

  it('the create and the payment share one key: told once', () => {
    const a = plan('booking.confirmed');
    const b = plan('booking.payment_recorded');
    expect(a.kind === 'send' && b.kind === 'send').toBe(true);
    if (a.kind === 'send' && b.kind === 'send') {
      expect(a.request.dedupeKey).toBe(b.request.dedupeKey);
      expect(b.request.type).toBe('booking.confirmed');
    }
  });

  it('a move is keyed on its own event, a cancel on the booking', () => {
    const moved = plan('booking.rescheduled');
    const cancelled = plan('booking.cancelled', {
      ...BOOKING,
      status: 'cancelled',
    });
    expect(moved.kind === 'send' && moved.request.dedupeKey).toBe(
      'booking.rescheduled:ev-9',
    );
    expect(cancelled.kind === 'send' && cancelled.request.dedupeKey).toBe(
      `booking.cancelled:${BOOKING.id}`,
    );
  });

  it('no booking, or another event, is nothing to hand over', () => {
    expect(plan('booking.cancelled', null)).toEqual({
      kind: 'skip',
      reason: 'booking_gone',
    });
    expect(plan('booking.no_show')).toEqual({
      kind: 'skip',
      reason: 'not_a_hub_event',
    });
  });

  it('HUB_EVENTS is what the plan knows', () => {
    for (const type of HUB_EVENTS) {
      expect(plan(type).kind).toBe('send');
    }
  });
});

describe('hubPlan for the chosen reminder', () => {
  const reminder = (booking: HubBooking, scheduledForMs = BOOKING.startAtMs) =>
    hubPlan({
      eventType: 'reminder.chosen',
      sourceEventId: 'ev-9',
      customerId: 'c-1',
      booking,
      scheduledForMs,
      expiresAtMs: BOOKING.startAtMs,
    });

  it('is an appointment reminder, keyed on the booking and its start', () => {
    const p = reminder(BOOKING);
    expect(p.kind === 'send' && p.request.type).toBe('booking.reminder');
    expect(p.kind === 'send' && p.request.dedupeKey).toBe(
      `booking.reminder:${BOOKING.id}:${BOOKING.startAtMs}`,
    );
  });

  it('a moved booking has its own reminder; this one is dropped', () => {
    expect(reminder(BOOKING, BOOKING.startAtMs - 60_000)).toEqual({
      kind: 'skip',
      reason: 'moved',
    });
  });

  it.each(['cancelled', 'checked_in', 'no_show'])(
    'a visit that is %s is not reminded of',
    (status) => {
      expect(reminder({ ...BOOKING, status })).toEqual({
        kind: 'skip',
        reason: `booking_${status}`,
      });
    },
  );

  it('an unpaid booking is still reminded of, as the fixed rungs do', () => {
    expect(reminder({ ...BOOKING, status: 'pending_payment' }).kind).toBe(
      'send',
    );
  });
});
