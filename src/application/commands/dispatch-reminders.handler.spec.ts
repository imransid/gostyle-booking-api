import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { DispatchRemindersHandler } from './dispatch-reminders.handler';
import {
  DISPATCH_LEASE_MS,
  planDeliveries,
  pushEventId,
  type ChannelOutcome,
  type Settlement,
} from '@domain/booking/reminder-delivery';
import type { Rung } from '@domain/booking/reminders';
import type {
  ClaimedDelivery,
  DeliveryBooking,
} from '@infrastructure/persistence/notification-delivery.repository';
import type { ContactLookup } from '@application/ports/customer-contact.port';
import type { PushRequest } from '@application/ports/push-sender.port';
import type { EmailMessage } from '@application/ports/email-sender.port';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Today October 6; the booking is October 11 at 10:00 in Dhaka (04:00 UTC).
const OCT_6 = Date.parse('2026-10-06T04:00:00Z');
const START = Date.parse('2026-10-11T04:00:00Z');
const AT_24H = START - DAY;
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const BOOKING = '11111111-1111-4111-8111-111111111111';

interface Row {
  id: string;
  sourceEventId: string;
  channel: 'push' | 'email';
  eventType: string;
  bookingId: string;
  customerId: string;
  scheduledForMs: number;
  expiresAtMs: number;
  status: 'pending' | 'sent' | 'failed' | 'skipped' | 'superseded';
  attempts: number;
  nextAttemptAtMs: number;
  lastError: string | null;
  skipReason: string | null;
  providerRef: string | null;
}

/**
 * notification_delivery in memory, with the same rules the SQL enforces:
 * a claim takes pending, due rows, counts an attempt and pushes them out by
 * the lease; a write lands only for the attempt that claimed it.
 */
class MemoryDeliveries {
  rows: Row[] = [];
  bookingRows = new Map<string, DeliveryBooking>();

  queue(
    rung: Rung,
    sourceEventId: string,
    nowMs: number,
    booking = this.bookingRows.get(BOOKING)!,
  ) {
    for (const d of planDeliveries({
      rung,
      startAtMs: booking.startAtMs,
      nowMs,
      manual: false,
      queuedUntilMs: null,
    })) {
      this.rows.push({
        id: `${sourceEventId}:${d.channel}`,
        sourceEventId,
        channel: d.channel,
        eventType: `reminder.${rung}`,
        bookingId: booking.id,
        customerId: booking.customerId,
        scheduledForMs: d.scheduledForMs,
        expiresAtMs: d.expiresAtMs,
        status: 'pending',
        attempts: 0,
        nextAttemptAtMs: d.notBeforeMs,
        lastError: null,
        skipReason: null,
        providerRef: null,
      });
    }
  }

  claimDue(nowMs: number, limit: number): Promise<ClaimedDelivery[]> {
    const due = this.rows
      .filter((r) => r.status === 'pending' && r.nextAttemptAtMs <= nowMs)
      .slice(0, limit);
    const claimed = due.map((r) => {
      r.attempts += 1;
      r.nextAttemptAtMs = nowMs + DISPATCH_LEASE_MS;
      return {
        id: r.id,
        sourceEventId: r.sourceEventId,
        channel: r.channel,
        eventType: r.eventType,
        bookingId: r.bookingId,
        customerId: r.customerId,
        scheduledForMs: r.scheduledForMs,
        expiresAtMs: r.expiresAtMs,
        attempt: r.attempts,
      };
    });
    return Promise.resolve(claimed);
  }

  bookings(ids: readonly string[]) {
    return Promise.resolve(
      new Map(
        ids.flatMap((id) => {
          const b = this.bookingRows.get(id);
          return b === undefined ? [] : [[id, b] as const];
        }),
      ),
    );
  }

  record(
    claim: { id: string; attempt: number },
    outcome: Settlement | { status: 'superseded' },
    _nowMs: number,
  ): Promise<boolean> {
    const r = this.rows.find((x) => x.id === claim.id);
    if (
      r === undefined ||
      r.status !== 'pending' ||
      r.attempts !== claim.attempt
    ) {
      return Promise.resolve(false);
    }
    if (outcome.status === 'pending') {
      r.nextAttemptAtMs = outcome.nextAttemptAtMs;
      r.lastError = outcome.error;
    } else {
      r.status = outcome.status;
      if (outcome.status === 'sent') r.providerRef = outcome.ref;
      if (outcome.status === 'failed') r.lastError = outcome.error;
      if (outcome.status === 'skipped') r.skipReason = outcome.reason;
    }
    return Promise.resolve(true);
  }

  get(channel: 'push' | 'email', sourceEventId = 'e24'): Row {
    return this.rows.find(
      (r) => r.channel === channel && r.sourceEventId === sourceEventId,
    )!;
  }
}

const found = (
  over: Partial<Extract<ContactLookup, { kind: 'found' }>['contact']> = {},
): ContactLookup => ({
  kind: 'found',
  contact: {
    customerId: CUSTOMER,
    email: 'sara@example.com',
    emailVerified: true,
    fullName: 'Sara Ahmed',
    appointmentReminder: true,
    pushEnabled: true,
    ...over,
  },
});

function setup() {
  const store = new MemoryDeliveries();
  store.bookingRows.set(BOOKING, {
    id: BOOKING,
    status: 'confirmed',
    startAtMs: START,
    code: 'GS-1050',
    customerId: CUSTOMER,
    paymentStatus: 'deposit_paid',
    durationMin: 105,
    services: ['Full colour'],
  });
  const contacts = {
    lookup: vi.fn((_id: string): Promise<ContactLookup> =>
      Promise.resolve(found()),
    ),
  };
  const push = {
    configured: vi.fn(() => true),
    send: vi.fn((_r: PushRequest): Promise<ChannelOutcome> =>
      Promise.resolve({ kind: 'sent', ref: 'devices=1' }),
    ),
  };
  const email = {
    configured: vi.fn(() => true),
    send: vi.fn((_m: EmailMessage): Promise<ChannelOutcome> =>
      Promise.resolve({ kind: 'sent', ref: '<m1@gostyle>' }),
    ),
  };
  const handler = new DispatchRemindersHandler(
    store as never,
    contacts,
    push,
    email,
  );
  return { store, contacts, push, email, handler };
}

const savedZone = process.env.BRANCH_TIMEZONE;
beforeEach(() => {
  process.env.BRANCH_TIMEZONE = 'Asia/Dhaka';
});
afterEach(() => {
  if (savedZone === undefined) delete process.env.BRANCH_TIMEZONE;
  else process.env.BRANCH_TIMEZONE = savedZone;
});

describe('a booking five days out: October 11 at 10:00, booked October 6', () => {
  it('nothing is due on October 6', async () => {
    const { handler, push, email } = setup();
    expect((await handler.run(OCT_6)).claimed).toBe(0);
    expect(push.send).not.toHaveBeenCalled();
    expect(email.send).not.toHaveBeenCalled();
  });

  it('October 10 at 10:00: the 24h reminder goes by push AND email', async () => {
    const { store, handler, push, email } = setup();
    store.queue('confirm_24h', 'e24', AT_24H);

    const report = await handler.run(AT_24H);

    expect(report).toMatchObject({ claimed: 2, sent: 2 });
    expect(store.get('push').status).toBe('sent');
    expect(store.get('email').status).toBe('sent');
    expect(push.send).toHaveBeenCalledWith({
      userId: CUSTOMER,
      eventId: pushEventId(BOOKING, 'confirm_24h', START),
      title: 'Your appointment is tomorrow',
      body: 'Full colour at 10:00 AM. Booking GS-1050.',
      data: {
        type: 'reminder.confirm_24h',
        bookingId: BOOKING,
        code: 'GS-1050',
        startAt: new Date(START).toISOString(),
      },
    });
    const sent = email.send.mock.calls[0]![0];
    expect(sent.to).toBe('sara@example.com');
    expect(sent.subject).toBe('Reminder: Your GoStyle appointment is tomorrow');
    expect(sent.text).toContain('Hi Sara,');
    expect(sent.text).toContain('Booking code: GS-1050');
  });

  it('3h before: push and email, "today at 10:00 AM"', async () => {
    const { store, handler, push, email } = setup();
    store.queue('day_of_3h', 'e3', START - 3 * HOUR);
    await handler.run(START - 3 * HOUR);
    expect(push.send.mock.calls[0]![0].title).toBe('See you today at 10:00 AM');
    expect(email.send.mock.calls[0]![0].subject).toBe(
      'Reminder: Your GoStyle appointment is today at 10:00 AM',
    );
  });

  it('15m before: a push only', async () => {
    const { store, handler, push, email } = setup();
    store.queue('running_late_15m', 'e15', START - 15 * MIN);
    const report = await handler.run(START - 15 * MIN);
    expect(report).toMatchObject({ claimed: 1, sent: 1 });
    expect(push.send.mock.calls[0]![0].title).toBe(
      'Your appointment starts at 10:00 AM',
    );
    expect(email.send).not.toHaveBeenCalled();
  });
});

describe('the channels never wait on each other', () => {
  it('push fails, email still sent; the push retries in a minute', async () => {
    const { store, handler, push, email } = setup();
    push.send.mockResolvedValueOnce({
      kind: 'retry',
      error: 'push-app unreachable: HTTP 503',
    });
    store.queue('confirm_24h', 'e24', AT_24H);

    const report = await handler.run(AT_24H);

    expect(report).toMatchObject({ sent: 1, retrying: 1 });
    expect(store.get('email').status).toBe('sent');
    expect(store.get('push')).toMatchObject({
      status: 'pending',
      nextAttemptAtMs: AT_24H + MIN,
      lastError: 'push-app unreachable: HTTP 503',
    });
    expect(email.send).toHaveBeenCalledOnce();
  });

  it('email fails, push still sent; only the email retries', async () => {
    const { store, handler, push, email } = setup();
    email.send.mockResolvedValueOnce({
      kind: 'retry',
      error: 'SMTP ETIMEDOUT: timeout',
    });
    store.queue('confirm_24h', 'e24', AT_24H);

    await handler.run(AT_24H);
    expect(store.get('push').status).toBe('sent');
    expect(store.get('email').status).toBe('pending');

    // A minute later: only the email row is due. Push is never repeated.
    await handler.run(AT_24H + MIN);
    expect(store.get('email').status).toBe('sent');
    expect(push.send).toHaveBeenCalledOnce();
    expect(email.send).toHaveBeenCalledTimes(2);
  });

  it('both fail, both retry, both land -- with the same push id every time', async () => {
    const { store, handler, push, email } = setup();
    push.send
      .mockResolvedValueOnce({ kind: 'retry', error: 'HTTP 503' })
      .mockResolvedValueOnce({ kind: 'retry', error: 'HTTP 503' });
    email.send.mockResolvedValueOnce({
      kind: 'retry',
      error: 'SMTP 451: greylisted',
    });
    store.queue('confirm_24h', 'e24', AT_24H);

    await handler.run(AT_24H); // both fail
    await handler.run(AT_24H + MIN); // push fails again, email lands
    await handler.run(AT_24H + MIN + 5 * MIN); // push lands

    expect(store.get('push')).toMatchObject({ status: 'sent', attempts: 3 });
    expect(store.get('email')).toMatchObject({ status: 'sent', attempts: 2 });
    const ids = new Set(push.send.mock.calls.map(([r]) => r.eventId));
    expect(ids.size).toBe(1);
  });

  it('a permanent refusal is not retried', async () => {
    const { store, handler, push } = setup();
    push.send.mockResolvedValue({ kind: 'failed', error: 'HTTP 401' });
    store.queue('confirm_24h', 'e24', AT_24H);
    await handler.run(AT_24H);
    await handler.run(AT_24H + HOUR);
    expect(store.get('push')).toMatchObject({
      status: 'failed',
      lastError: 'HTTP 401',
    });
    expect(push.send).toHaveBeenCalledOnce();
  });

  it('retries stop when the window closes: no infinite loop', async () => {
    const { store, handler, push } = setup();
    push.send.mockResolvedValue({ kind: 'retry', error: 'HTTP 503' });
    store.queue('confirm_24h', 'e24', AT_24H);
    for (let t = AT_24H; t < START; t += 10 * MIN) await handler.run(t);
    expect(store.get('push').status).toBe('failed');
    expect(push.send.mock.calls.length).toBeLessThanOrEqual(6);
  });
});

describe('cancelled or moved before the send', () => {
  it('cancelled after the claim: both rows skipped, nothing sent', async () => {
    const { store, handler, push, email } = setup();
    store.queue('confirm_24h', 'e24', AT_24H);
    (store.bookingRows.get(BOOKING) as { status: string }).status = 'cancelled';

    const report = await handler.run(AT_24H);

    expect(report).toMatchObject({ skipped: 2, sent: 0 });
    expect(store.get('push').skipReason).toBe('booking_cancelled');
    expect(store.get('email').skipReason).toBe('booking_cancelled');
    expect(push.send).not.toHaveBeenCalled();
    expect(email.send).not.toHaveBeenCalled();
  });

  it('rescheduled Oct 11 -> Oct 15: the old reminder is superseded and never sent', async () => {
    const { store, handler, push, email } = setup();
    store.queue('confirm_24h', 'e24', AT_24H);
    (store.bookingRows.get(BOOKING) as { startAtMs: number }).startAtMs =
      START + 4 * DAY;

    const report = await handler.run(AT_24H);

    expect(report.superseded).toBe(2);
    expect(push.send).not.toHaveBeenCalled();
    expect(email.send).not.toHaveBeenCalled();
  });

  it('the new time gets its own reminder, with a new push id', async () => {
    const { store, handler, push } = setup();
    const moved = START + 4 * DAY;
    (store.bookingRows.get(BOOKING) as { startAtMs: number }).startAtMs = moved;
    // The move reset the ladder; the 24h rung is claimed again for Oct 15.
    store.queue('confirm_24h', 'e24-moved', moved - DAY);

    await handler.run(moved - DAY);

    expect(store.get('push', 'e24-moved').status).toBe('sent');
    expect(push.send.mock.calls[0]![0].eventId).toBe(
      pushEventId(BOOKING, 'confirm_24h', moved),
    );
    expect(push.send.mock.calls[0]![0].eventId).not.toBe(
      pushEventId(BOOKING, 'confirm_24h', START),
    );
  });
});

describe('who the customer is decides the email, not the push', () => {
  it('no email on file: push sent, email skipped', async () => {
    const { store, handler, contacts, push, email } = setup();
    contacts.lookup.mockResolvedValue(found({ email: null }));
    store.queue('confirm_24h', 'e24', AT_24H);
    await handler.run(AT_24H);
    expect(store.get('push').status).toBe('sent');
    expect(store.get('email')).toMatchObject({
      status: 'skipped',
      skipReason: 'no_email',
    });
    expect(push.send).toHaveBeenCalledOnce();
    expect(email.send).not.toHaveBeenCalled();
  });

  it('an unverified address is not written to', async () => {
    const { store, handler, contacts, email } = setup();
    contacts.lookup.mockResolvedValue(found({ emailVerified: false }));
    store.queue('confirm_24h', 'e24', AT_24H);
    await handler.run(AT_24H);
    expect(store.get('email').skipReason).toBe('email_unverified');
    expect(email.send).not.toHaveBeenCalled();
  });

  it('customer-api down: email retries, push goes at default preferences', async () => {
    const { store, handler, contacts, email } = setup();
    contacts.lookup.mockResolvedValueOnce({
      kind: 'unavailable',
      error: 'customer-api UNAVAILABLE: connection refused',
    });
    store.queue('confirm_24h', 'e24', AT_24H);

    await handler.run(AT_24H);
    expect(store.get('push').status).toBe('sent');
    expect(store.get('email')).toMatchObject({
      status: 'pending',
      lastError: 'customer-api UNAVAILABLE: connection refused',
    });
    expect(email.send).not.toHaveBeenCalled();

    // customer-api is back a minute later.
    await handler.run(AT_24H + MIN);
    expect(store.get('email').status).toBe('sent');
  });

  it('reminders turned off in the app: neither channel sends', async () => {
    const { store, handler, contacts, push, email } = setup();
    contacts.lookup.mockResolvedValue(found({ appointmentReminder: false }));
    store.queue('confirm_24h', 'e24', AT_24H);
    await handler.run(AT_24H);
    expect(store.get('push').skipReason).toBe('opted_out');
    expect(store.get('email').skipReason).toBe('opted_out');
    expect(push.send).not.toHaveBeenCalled();
    expect(email.send).not.toHaveBeenCalled();
  });

  it('push turned off: push skipped, email still sent', async () => {
    const { store, handler, contacts, email } = setup();
    contacts.lookup.mockResolvedValue(found({ pushEnabled: false }));
    store.queue('confirm_24h', 'e24', AT_24H);
    await handler.run(AT_24H);
    expect(store.get('push').skipReason).toBe('opted_out');
    expect(email.send).toHaveBeenCalledOnce();
  });

  it('a guest lane with no account: push to nobody, email skipped', async () => {
    const { store, handler, contacts } = setup();
    contacts.lookup.mockResolvedValue({ kind: 'not_found' });
    store.queue('confirm_24h', 'e24', AT_24H);
    await handler.run(AT_24H);
    expect(store.get('email').skipReason).toBe('customer_not_found');
  });

  it('asks customer-api once per customer per batch, not once per row', async () => {
    const { store, handler, contacts } = setup();
    store.queue('confirm_24h', 'e24', AT_24H);
    await handler.run(AT_24H);
    expect(contacts.lookup).toHaveBeenCalledOnce();
  });
});

describe('a channel that is not set up', () => {
  it('no SMTP: email skipped at once, without asking customer-api for an address', async () => {
    const { store, handler, contacts, email } = setup();
    email.configured.mockReturnValue(false);
    contacts.lookup.mockResolvedValue({ kind: 'unavailable', error: 'down' });
    store.queue('confirm_24h', 'e24', AT_24H);

    await handler.run(AT_24H);

    expect(store.get('email')).toMatchObject({
      status: 'skipped',
      skipReason: 'email_not_configured',
    });
    expect(email.send).not.toHaveBeenCalled();
  });

  it('no PUSH_API_KEY: push skipped at once, email unaffected', async () => {
    const { store, handler, push, email } = setup();
    push.configured.mockReturnValue(false);
    store.queue('confirm_24h', 'e24', AT_24H);

    await handler.run(AT_24H);

    expect(store.get('push')).toMatchObject({
      status: 'skipped',
      skipReason: 'push_not_configured',
    });
    expect(push.send).not.toHaveBeenCalled();
    expect(email.send).toHaveBeenCalledOnce();
  });
});

describe('a worker killed mid-dispatch', () => {
  it('leaves its rows claimed; they come due again when the lease runs out', async () => {
    const { store, handler, push } = setup();
    store.queue('confirm_24h', 'e24', AT_24H);

    // Worker A claims and dies (kill -9) before sending or recording.
    const abandoned = await store.claimDue(AT_24H, 10);
    expect(abandoned).toHaveLength(2);

    // Inside the lease nobody touches them.
    expect((await handler.run(AT_24H + MIN)).claimed).toBe(0);

    // After it, the next worker picks them up as attempt 2 and sends.
    await handler.run(AT_24H + DISPATCH_LEASE_MS);
    expect(store.get('push')).toMatchObject({ status: 'sent', attempts: 2 });
    expect(store.get('email')).toMatchObject({ status: 'sent', attempts: 2 });
    expect(push.send).toHaveBeenCalledOnce();
  });

  it("a slow worker's late result cannot overwrite the newer one", async () => {
    const { store, handler } = setup();
    store.queue('running_late_15m', 'e15', START - 15 * MIN);
    const [stale] = await store.claimDue(START - 15 * MIN, 10);

    // The lease runs out; another worker claims attempt 2 and sends it.
    await handler.run(START - 15 * MIN + DISPATCH_LEASE_MS);
    expect(store.get('push', 'e15').status).toBe('sent');

    // Worker A wakes up and tries to record a failure for attempt 1.
    expect(
      await store.record(stale!, { status: 'failed', error: 'late' }, 0),
    ).toBe(false);
    expect(store.get('push', 'e15').status).toBe('sent');
  });

  it('an unexpected error leaves the row for the lease, not stuck', async () => {
    const { store, handler, push } = setup();
    push.send.mockRejectedValueOnce(new Error('bug'));
    store.queue('running_late_15m', 'e15', START - 15 * MIN);

    expect((await handler.run(START - 15 * MIN)).lost).toBe(1);
    expect(store.get('push', 'e15').status).toBe('pending');

    // Window for the 15m nudge is the start; the lease (5 min) is inside it.
    await handler.run(START - 15 * MIN + DISPATCH_LEASE_MS);
    expect(store.get('push', 'e15').status).toBe('sent');
  });
});

describe('every time shown is branch time', () => {
  it('the same booking reads 10:00 AM in a Dhaka branch', async () => {
    const { store, handler, push } = setup();
    store.queue('confirm_24h', 'e24', AT_24H);
    await handler.run(AT_24H);
    expect(push.send.mock.calls[0]![0].body).toContain('10:00 AM');
  });

  it('and 8:00 AM when BRANCH_TIMEZONE says Dubai', async () => {
    process.env.BRANCH_TIMEZONE = 'Asia/Dubai';
    const { store, handler, push } = setup();
    store.queue('confirm_24h', 'e24', AT_24H);
    await handler.run(AT_24H);
    expect(push.send.mock.calls[0]![0].body).toContain('8:00 AM');
  });
});
