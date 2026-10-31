import { afterEach, describe, it, expect, vi } from 'vitest';
import type { DomainEvent } from '@application/ports/event-publisher.port';
import type {
  ContactLookup,
  CustomerContact,
} from '@application/ports/customer-contact.port';
import { PUSH_PREFS_LOOKUP_MS, PushListener } from './push-listener';
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
  const contacts = {
    lookup: vi.fn((_id: string, _o?: unknown): Promise<ContactLookup> =>
      Promise.resolve(found()),
    ),
  };
  const listener = new PushListener(next, prisma as any, push as any, contacts);
  return { listener, next, prisma, push, contacts };
};

const found = (over: Partial<CustomerContact> = {}): ContactLookup => ({
  kind: 'found',
  contact: {
    customerId: CUSTOMER_ID,
    email: null,
    emailVerified: false,
    fullName: null,
    appointmentReminder: true,
    pushEnabled: true,
    bookingConfirmation: true,
    bookingChanges: true,
    emailEnabled: true,
    ...over,
  },
});

const savedFlag = process.env.MOBILE_PUSH_PREFS;
afterEach(() => {
  if (savedFlag === undefined) delete process.env.MOBILE_PUSH_PREFS;
  else process.env.MOBILE_PUSH_PREFS = savedFlag;
});

describe('PushListener with MOBILE_PUSH_PREFS off', () => {
  it('asks nobody and pushes as before, whatever the customer chose', async () => {
    delete process.env.MOBILE_PUSH_PREFS;
    const { listener, push, contacts } = setup();
    contacts.lookup.mockResolvedValue(found({ pushEnabled: false }));

    await listener.publish(event('booking.confirmed'));

    expect(contacts.lookup).not.toHaveBeenCalled();
    expect(push.send).toHaveBeenCalledOnce();
  });
});

describe('PushListener with MOBILE_PUSH_PREFS on', () => {
  const on = () => {
    process.env.MOBILE_PUSH_PREFS = 'true';
  };

  it('asks quickly, once, for the booking customer', async () => {
    on();
    const { listener, push, contacts } = setup();
    await listener.publish(event('booking.confirmed'));

    expect(contacts.lookup).toHaveBeenCalledWith(CUSTOMER_ID, {
      quickMs: PUSH_PREFS_LOOKUP_MS,
    });
    expect(push.send).toHaveBeenCalledOnce();
  });

  it.each([
    ['booking.confirmed', { bookingConfirmation: false }],
    ['booking.cancelled', { bookingChanges: false }],
    ['booking.rescheduled', { bookingChanges: false }],
    ['booking.confirmed', { pushEnabled: false }],
    ['booking.cancelled', { pushEnabled: false }],
  ] as const)('%s stays quiet with %o', async (type, off) => {
    on();
    const { listener, next, push, contacts } = setup();
    contacts.lookup.mockResolvedValue(found(off));

    await listener.publish(event(type));

    expect(push.send).not.toHaveBeenCalled();
    expect(next.publish).toHaveBeenCalledOnce();
  });

  it.each([
    ['booking.confirmed', { bookingChanges: false }],
    ['booking.cancelled', { bookingConfirmation: false }],
  ] as const)(
    '%s still goes when only the other switch is off',
    async (type, off) => {
      on();
      const { listener, push, contacts } = setup();
      contacts.lookup.mockResolvedValue(found(off));

      await listener.publish(event(type));

      expect(push.send).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ['not found (a desk customer)', { kind: 'not_found' } as const],
    [
      'no answer in time',
      { kind: 'unavailable', error: 'customer-api DEADLINE_EXCEEDED' } as const,
    ],
  ])('pushes as before when %s', async (_name, answer) => {
    on();
    const { listener, push, contacts } = setup();
    contacts.lookup.mockResolvedValue(answer);

    await listener.publish(event('booking.cancelled'));

    expect(push.send).toHaveBeenCalledOnce();
  });

  it('never blocks the chain when the lookup throws', async () => {
    on();
    const { listener, next, push, contacts } = setup();
    contacts.lookup.mockRejectedValue(new Error('boom'));

    await expect(
      listener.publish(event('booking.confirmed')),
    ).resolves.toBeUndefined();
    expect(push.send).not.toHaveBeenCalled();
    expect(next.publish).toHaveBeenCalledOnce();
  });

  it('asks nothing for events the customer does not hear about', async () => {
    on();
    const { listener, contacts } = setup();
    await listener.publish(event('booking.no_show'));
    expect(contacts.lookup).not.toHaveBeenCalled();
  });
});

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
