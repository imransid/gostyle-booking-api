import { describe, expect, it, vi } from 'vitest';
import type { DomainEvent } from '@application/ports/event-publisher.port';
import type { ContactLookup } from '@application/ports/customer-contact.port';
import { CheckInPushListener } from './check-in-push-listener';

const SARA = '11111111-1111-4111-8111-111111111111'; // the booker, or a single customer
const RANA = '22222222-2222-4222-8222-222222222222'; // a registered member
const GROUP = '33333333-3333-4333-8333-333333333333';

function event(eventType: string, aggregateId = 'req-1'): DomainEvent {
  return {
    id: 'evt-1',
    aggregateType: 'check_in_request',
    aggregateId,
    eventType,
    payload: {},
    createdAt: new Date(),
    attempts: 0,
  };
}

function found(
  over: { pushEnabled?: boolean; fullName?: string | null } = {},
): ContactLookup {
  return {
    kind: 'found',
    contact: {
      customerId: 'x',
      email: null,
      emailVerified: false,
      fullName: over.fullName ?? null,
      appointmentReminder: true,
      pushEnabled: over.pushEnabled ?? true,
      bookingConfirmation: true,
      bookingChanges: true,
      emailEnabled: true,
    },
  };
}

function harness(opts: {
  request?: Record<string, unknown> | null;
  participant?: { guestName: string | null; customerId: string | null } | null;
  contacts?: Record<string, ContactLookup>;
  configured?: boolean;
  sendThrows?: boolean;
}) {
  const request =
    opts.request === undefined
      ? {
          id: 'req-1',
          raisedByKind: 'customer',
          raisedById: SARA,
          booking: {
            id: 'bk-1',
            code: 'GS-1417',
            customerId: SARA,
            groupId: null,
          },
        }
      : opts.request;
  const prisma = {
    checkInRequest: { findUnique: vi.fn(() => Promise.resolve(request)) },
    groupParticipant: {
      findUnique: vi.fn(() => Promise.resolve(opts.participant ?? null)),
    },
  };
  const send = vi.fn(() =>
    opts.sendThrows
      ? Promise.reject(new Error('push-app down'))
      : Promise.resolve({ kind: 'sent' as const, ref: 'devices=1' }),
  );
  const push = { configured: () => opts.configured ?? true, send };
  const lookup = vi.fn((id: string) =>
    Promise.resolve(opts.contacts?.[id] ?? found()),
  );
  const next = { publish: vi.fn(() => Promise.resolve()) };
  const listener = new CheckInPushListener(next, prisma as never, push, {
    lookup,
  });
  return { listener, send, next, lookup, prisma };
}

describe('CheckInPushListener', () => {
  it("tells a customer their own approval, with the booking in the push's data", async () => {
    const h = harness({});
    await h.listener.publish(event('check_in_request.approved'));
    expect(h.send).toHaveBeenCalledWith({
      userId: SARA,
      eventId: 'check-in:req-1:approved',
      title: 'You are checked in',
      body: 'Welcome! Booking GS-1417.',
      data: {
        type: 'check_in_request.approved',
        bookingId: 'bk-1',
        code: 'GS-1417',
        requestId: 'req-1',
      },
    });
    expect(h.next.publish).toHaveBeenCalledTimes(1);
  });

  it("tells the booker a guest's answer, by the guest's name, with the party in the data", async () => {
    const h = harness({
      request: {
        id: 'req-2',
        raisedByKind: 'customer',
        raisedById: SARA,
        booking: {
          id: 'bk-2',
          code: 'GS-1418',
          customerId: GROUP,
          groupId: GROUP,
        },
      },
      participant: { guestName: 'Mina', customerId: null },
    });
    await h.listener.publish(event('check_in_request.rejected', 'req-2'));
    expect(h.send).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: SARA,
        eventId: 'check-in:req-2:rejected',
        title: 'Please speak to the desk',
        body: "The salon could not confirm Mina's arrival. Booking GS-1418.",
        data: {
          type: 'check_in_request.rejected',
          bookingId: 'bk-2',
          code: 'GS-1418',
          requestId: 'req-2',
          groupId: GROUP,
        },
      }),
    );
  });

  it("tells the booker a registered member's answer, by the name customer-api holds", async () => {
    const h = harness({
      request: {
        id: 'req-3',
        raisedByKind: 'customer',
        raisedById: SARA,
        booking: {
          id: 'bk-3',
          code: 'GS-1419',
          customerId: RANA,
          groupId: GROUP,
        },
      },
      participant: { guestName: null, customerId: RANA },
      contacts: { [RANA]: found({ fullName: 'Rana Saleh' }) },
    });
    await h.listener.publish(event('check_in_request.approved', 'req-3'));
    expect(h.send).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: SARA,
        title: 'Rana Saleh is checked in',
      }),
    );
  });

  it('tells a member who tapped for themselves about themselves', async () => {
    const h = harness({
      request: {
        id: 'req-4',
        raisedByKind: 'customer',
        raisedById: RANA,
        booking: {
          id: 'bk-4',
          code: 'GS-1420',
          customerId: RANA,
          groupId: GROUP,
        },
      },
    });
    await h.listener.publish(event('check_in_request.expired', 'req-4'));
    expect(h.send).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: RANA,
        body: 'The salon did not answer your check-in in time. Booking GS-1420.',
      }),
    );
    expect(h.prisma.groupParticipant.findUnique).not.toHaveBeenCalled();
  });

  it('a name customer-api cannot give: "A member of your party"', async () => {
    const h = harness({
      request: {
        id: 'req-5',
        raisedByKind: 'customer',
        raisedById: SARA,
        booking: {
          id: 'bk-5',
          code: 'GS-1421',
          customerId: RANA,
          groupId: GROUP,
        },
      },
      participant: { guestName: null, customerId: RANA },
      contacts: { [RANA]: { kind: 'unavailable', error: 'timeout' } },
    });
    await h.listener.publish(event('check_in_request.approved', 'req-5'));
    expect(h.send).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'A member of your party is checked in',
      }),
    );
  });

  it('sends nothing to a customer who turned push off', async () => {
    const h = harness({ contacts: { [SARA]: found({ pushEnabled: false }) } });
    await h.listener.publish(event('check_in_request.approved'));
    expect(h.send).not.toHaveBeenCalled();
    expect(h.next.publish).toHaveBeenCalledTimes(1);
  });

  it('still sends when customer-api cannot be asked, as reminders do', async () => {
    const h = harness({
      contacts: { [SARA]: { kind: 'unavailable', error: 'down' } },
    });
    await h.listener.publish(event('check_in_request.approved'));
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('sends nothing without push-app configured, a request that is gone, or one no customer raised', async () => {
    for (const opts of [
      { configured: false },
      { request: null },
      {
        request: {
          id: 'req-1',
          raisedByKind: 'staff',
          raisedById: SARA,
          booking: {
            id: 'bk-1',
            code: 'GS-1417',
            customerId: SARA,
            groupId: null,
          },
        },
      },
    ]) {
      const h = harness(opts);
      await h.listener.publish(event('check_in_request.approved'));
      expect(h.send).not.toHaveBeenCalled();
      expect(h.next.publish).toHaveBeenCalledTimes(1);
    }
  });

  it('never throws, and the event still goes down the chain, when push-app fails', async () => {
    const h = harness({ sendThrows: true });
    await expect(
      h.listener.publish(event('check_in_request.approved')),
    ).resolves.toBeUndefined();
    expect(h.next.publish).toHaveBeenCalledTimes(1);
  });

  it('passes every other event through untouched, reading nothing', async () => {
    const h = harness({});
    const other = event('booking.checked_in');
    await h.listener.publish(other);
    expect(h.prisma.checkInRequest.findUnique).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.next.publish).toHaveBeenCalledWith(other);
  });
});
