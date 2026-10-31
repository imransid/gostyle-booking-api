import { afterEach, describe, it, expect, vi } from 'vitest';
import type { DomainEvent } from '@application/ports/event-publisher.port';
import { HUB_DELIVER_WITHIN_MS, HubListener } from './hub-listener';

const BOOKING = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const START = new Date('2026-11-02T07:00:00Z');

const event = (eventType: string, id = 'ev-1'): DomainEvent => ({
  id,
  aggregateType: 'booking',
  aggregateId: BOOKING,
  eventType,
  payload: {},
  createdAt: new Date(),
  attempts: 0,
});

const setup = () => {
  const next = { publish: vi.fn(async (_e: DomainEvent) => {}) };
  const prisma = {
    booking: {
      findUnique: vi.fn((_a: unknown) =>
        Promise.resolve({ customerId: CUSTOMER, startAt: START } as {
          customerId: string;
          startAt: Date;
        } | null),
      ),
    },
  };
  const deliveries = {
    enqueue: vi.fn((_rows: unknown[]) => Promise.resolve(1)),
  };
  const listener = new HubListener(next, prisma as never, deliveries as never);
  return { listener, next, prisma, deliveries };
};

const saved = process.env.MOBILE_NOTIFY_HUB;
afterEach(() => {
  if (saved === undefined) delete process.env.MOBILE_NOTIFY_HUB;
  else process.env.MOBILE_NOTIFY_HUB = saved;
});

describe('HubListener', () => {
  it('off: writes nothing, passes the event on', async () => {
    delete process.env.MOBILE_NOTIFY_HUB;
    const { listener, next, deliveries, prisma } = setup();
    await listener.publish(event('booking.confirmed'));
    expect(prisma.booking.findUnique).not.toHaveBeenCalled();
    expect(deliveries.enqueue).not.toHaveBeenCalled();
    expect(next.publish).toHaveBeenCalledOnce();
  });

  it.each([
    'booking.confirmed',
    'booking.payment_recorded',
    'booking.rescheduled',
    'booking.cancelled',
  ])('on: %s becomes one hub row', async (type) => {
    process.env.MOBILE_NOTIFY_HUB = 'true';
    const { listener, next, deliveries } = setup();
    const before = Date.now();

    await listener.publish(event(type, 'ev-7'));

    expect(deliveries.enqueue).toHaveBeenCalledOnce();
    const [rows] = deliveries.enqueue.mock.calls[0]!;
    const row = (rows as Record<string, unknown>[])[0]!;
    expect(row).toMatchObject({
      sourceEventId: 'ev-7',
      channel: 'hub',
      eventType: type,
      bookingId: BOOKING,
      customerId: CUSTOMER,
      scheduledFor: START,
    });
    const expires = (row.expiresAt as Date).getTime();
    expect(expires).toBeGreaterThanOrEqual(before + HUB_DELIVER_WITHIN_MS);
    expect(next.publish).toHaveBeenCalledOnce();
  });

  it('on: other events are not its business', async () => {
    process.env.MOBILE_NOTIFY_HUB = 'true';
    const { listener, deliveries } = setup();
    for (const type of [
      'booking.no_show',
      'reminder.confirm_24h',
      'check_in_request.approved',
    ]) {
      await listener.publish(event(type));
    }
    expect(deliveries.enqueue).not.toHaveBeenCalled();
  });

  it('on: a booking that is gone writes nothing', async () => {
    process.env.MOBILE_NOTIFY_HUB = 'true';
    const { listener, deliveries, prisma } = setup();
    prisma.booking.findUnique.mockResolvedValueOnce(null);
    await listener.publish(event('booking.cancelled'));
    expect(deliveries.enqueue).not.toHaveBeenCalled();
  });

  it('on: a row it cannot write is thrown, so the relay delivers it again', async () => {
    process.env.MOBILE_NOTIFY_HUB = 'true';
    const { listener, next, deliveries } = setup();
    deliveries.enqueue.mockRejectedValueOnce(new Error('db down'));
    await expect(listener.publish(event('booking.cancelled'))).rejects.toThrow(
      'db down',
    );
    expect(next.publish).not.toHaveBeenCalled();
  });
});

describe('HubListener and the chosen reminder', () => {
  it('a reminder row is about the start it was claimed for, and ends there', async () => {
    process.env.MOBILE_NOTIFY_HUB = 'true';
    const { listener, deliveries } = setup();
    const claimedFor = '2026-11-02T06:00:00.000Z';
    await listener.publish({
      ...event('reminder.chosen', 'ev-8'),
      payload: { startAt: claimedFor },
    });
    const [rows] = deliveries.enqueue.mock.calls[0]!;
    const row = (rows as Record<string, unknown>[])[0]!;
    // Not the booking's start now (START): a move between the claim and
    // this row must read as moved when it is sent.
    expect(row.scheduledFor).toEqual(new Date(claimedFor));
    expect(row.expiresAt).toEqual(new Date(claimedFor));
    expect(row.eventType).toBe('reminder.chosen');
  });
});
