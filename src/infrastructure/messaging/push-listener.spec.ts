import { describe, it, expect, vi } from 'vitest';
import type { DomainEvent } from '@application/ports/event-publisher.port';
import { PushListener } from './push-listener';
import type { PushMessage } from './push-notification.client';

const BOOKING_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';

const event = (eventType: string, id = 'evt-1'): DomainEvent => ({
  id,
  aggregateType: 'booking',
  aggregateId: BOOKING_ID,
  eventType,
  payload: {},
  createdAt: new Date(),
  attempts: 0,
});

const setup = () => {
  const next = { publish: vi.fn(async (_e: DomainEvent) => {}) };
  const prisma = {
    booking: {
      findUnique: vi.fn((_args: unknown) =>
        Promise.resolve({ customerId: CUSTOMER_ID, code: 'GS-1050' }),
      ),
    },
  };
  const push = {
    send: vi.fn((_m: PushMessage) =>
      Promise.resolve({ kind: 'sent', ref: 'devices=1' } as const),
    ),
  };
  const listener = new PushListener(next, prisma as any, push as any);
  return { listener, next, prisma, push };
};

describe('PushListener', () => {
  it('pushes a confirmed booking to its customer, then passes the event on', async () => {
    const { listener, next, push } = setup();
    await listener.publish(event('booking.confirmed'));

    expect(push.send).toHaveBeenCalledWith({
      userId: CUSTOMER_ID,
      eventId: `booking:${BOOKING_ID}:confirmed`,
      title: 'Booking confirmed',
      body: 'Your booking GS-1050 is confirmed.',
      data: { type: 'booking.confirmed', bookingId: BOOKING_ID },
    });
    expect(next.publish).toHaveBeenCalledOnce();
  });

  it('gives every reschedule its own eventId', async () => {
    const { listener, push } = setup();
    await listener.publish(event('booking.rescheduled', 'evt-1'));
    await listener.publish(event('booking.rescheduled', 'evt-2'));

    const ids = push.send.mock.calls.map(([m]) => m.eventId);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('stays quiet for events the customer does not hear about', async () => {
    const { listener, next, push } = setup();
    await listener.publish(event('booking.no_show'));

    expect(push.send).not.toHaveBeenCalled();
    expect(next.publish).toHaveBeenCalledOnce();
  });

  it('never blocks the chain, even when the lookup fails', async () => {
    const { listener, next, prisma } = setup();
    prisma.booking.findUnique.mockRejectedValueOnce(new Error('db down'));

    await expect(
      listener.publish(event('booking.confirmed')),
    ).resolves.toBeUndefined();
    expect(next.publish).toHaveBeenCalledOnce();
  });
});
