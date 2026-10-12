import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { DomainEvent } from '@application/ports/event-publisher.port';
import { ReminderDeliveryListener } from './reminder-delivery-listener';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-10-10T04:00:00Z');
const START = NOW + 24 * HOUR;
const BOOKING = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';

const event = (
  eventType: string,
  payload: Record<string, unknown> = {
    startAt: new Date(START).toISOString(),
    customerId: CUSTOMER,
  },
  id = '0192aaaa-0000-7000-8000-000000000001',
): DomainEvent => ({
  id,
  aggregateType: 'booking',
  aggregateId: BOOKING,
  eventType,
  payload,
  createdAt: new Date(NOW),
  attempts: 0,
});

/**
 * An in-memory notification_delivery with the real unique key, so "relayed
 * twice" is tested against the rule that actually prevents duplicates.
 */
function setup() {
  const rows = new Map<string, Record<string, unknown>>();
  const deliveries = {
    enqueue: vi.fn((batch: readonly Record<string, unknown>[]) => {
      let created = 0;
      for (const r of batch) {
        const key = `${String(r.sourceEventId)}:${String(r.channel)}`;
        if (!rows.has(key)) {
          rows.set(key, r);
          created += 1;
        }
      }
      return Promise.resolve(created);
    }),
  };
  const next = { publish: vi.fn(async (_e: DomainEvent) => {}) };
  const listener = new ReminderDeliveryListener(
    next,
    deliveries as never,
    () => NOW,
  );
  return { listener, next, deliveries, rows };
}

const saved = process.env.REMINDER_DELIVERY;
beforeEach(() => {
  process.env.REMINDER_DELIVERY = 'true';
});
afterEach(() => {
  if (saved === undefined) delete process.env.REMINDER_DELIVERY;
  else process.env.REMINDER_DELIVERY = saved;
});

describe('a reminder event becomes one delivery per channel', () => {
  it('24h: a push and an email, for the start it was claimed for', async () => {
    const { listener, rows } = setup();
    await listener.publish(event('reminder.confirm_24h'));

    expect([...rows.values()]).toEqual([
      expect.objectContaining({
        channel: 'push',
        eventType: 'reminder.confirm_24h',
        bookingId: BOOKING,
        customerId: CUSTOMER,
        scheduledFor: new Date(START),
        expiresAt: new Date(START - 3 * HOUR),
        nextAttemptAt: new Date(NOW),
      }),
      expect.objectContaining({ channel: 'email' }),
    ]);
  });

  it('3h: a push and an email', async () => {
    const { listener, rows } = setup();
    await listener.publish(event('reminder.day_of_3h'));
    expect([...rows.values()].map((r) => r.channel)).toEqual(['push', 'email']);
  });

  it('15m: a push only', async () => {
    const { listener, rows } = setup();
    await listener.publish(event('reminder.running_late_15m'));
    expect([...rows.values()].map((r) => r.channel)).toEqual(['push']);
  });

  it('THE SAME EVENT RELAYED TWICE creates no second delivery on any channel', async () => {
    const { listener, rows, deliveries } = setup();
    await listener.publish(event('reminder.confirm_24h'));
    await listener.publish(event('reminder.confirm_24h'));
    expect(rows.size).toBe(2);
    expect(await deliveries.enqueue.mock.results[1]!.value).toBe(0);
  });

  it("the desk's quiet-hours time is when it goes, and a manual send lives until the start", async () => {
    const { listener, rows } = setup();
    const nine = NOW + 5 * HOUR;
    await listener.publish(
      event('reminder.confirm_24h', {
        startAt: new Date(START).toISOString(),
        customerId: CUSTOMER,
        manual: true,
        queuedUntil: new Date(nine).toISOString(),
      }),
    );
    for (const r of rows.values()) {
      expect(r.nextAttemptAt).toEqual(new Date(nine));
      expect(r.expiresAt).toEqual(new Date(START));
    }
  });
});

describe('everything else passes straight through', () => {
  it.each([
    'booking.confirmed',
    'reminder.payment_link',
    'series.session_reminder_48h',
  ])(
    '%s creates no delivery and still reaches the next link',
    async (eventType) => {
      const { listener, next, deliveries } = setup();
      await listener.publish(event(eventType));
      expect(deliveries.enqueue).not.toHaveBeenCalled();
      expect(next.publish).toHaveBeenCalledOnce();
    },
  );

  it('with REMINDER_DELIVERY off, a reminder is passed on and nothing is queued', async () => {
    process.env.REMINDER_DELIVERY = '';
    const { listener, next, deliveries } = setup();
    await listener.publish(event('reminder.confirm_24h'));
    expect(deliveries.enqueue).not.toHaveBeenCalled();
    expect(next.publish).toHaveBeenCalledOnce();
  });

  it('an event without the fields a delivery needs is logged, not retried forever', async () => {
    const { listener, next, deliveries } = setup();
    await expect(
      listener.publish(event('reminder.confirm_24h', { code: 'GS-1050' })),
    ).resolves.toBeUndefined();
    expect(deliveries.enqueue).not.toHaveBeenCalled();
    expect(next.publish).toHaveBeenCalledOnce();
  });
});

describe('a failed insert is retried by the relay, not lost', () => {
  it('throws, so the relay counts the attempt and delivers the event again', async () => {
    const { listener, deliveries, next } = setup();
    deliveries.enqueue.mockRejectedValueOnce(new Error('connection refused'));
    await expect(
      listener.publish(event('reminder.confirm_24h')),
    ).rejects.toThrow('connection refused');
    expect(next.publish).not.toHaveBeenCalled();
  });
});
