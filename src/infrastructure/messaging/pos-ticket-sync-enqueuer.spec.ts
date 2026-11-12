import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { DomainEvent } from '@application/ports/event-publisher.port';
import { PosTicketSyncEnqueuer } from './pos-ticket-sync-enqueuer';

const BOOKING = '11111111-1111-4111-8111-111111111111';
const AT = new Date('2026-11-04T10:00:00Z');

const event = (
  eventType: string,
  payload: Record<string, unknown> = {},
  id = '0192aaaa-0000-7000-8000-000000000001',
): DomainEvent => ({
  id,
  aggregateType: 'booking',
  aggregateId: BOOKING,
  eventType,
  payload,
  createdAt: AT,
  attempts: 0,
});

/** An in-memory queue with the real unique key on event_id. */
function setup(fail = false) {
  const queued = new Map<string, Record<string, unknown>>();
  const rows = {
    enqueue: vi.fn(
      (row: Record<string, unknown>, _tenants: readonly string[]) => {
        if (fail) return Promise.reject(new Error('db down'));
        const key = String(row.eventId);
        if (queued.has(key)) return Promise.resolve(false);
        queued.set(key, row);
        return Promise.resolve(true);
      },
    ),
  };
  const next = { publish: vi.fn(async (_e: DomainEvent) => {}) };
  const link = new PosTicketSyncEnqueuer(next, rows as never);
  return { link, next, rows, queued };
}

const saved = {
  enabled: process.env.POS_TICKET_SYNC_ENABLED,
  tenants: process.env.POS_TICKET_SYNC_TENANTS,
};
beforeEach(() => {
  process.env.POS_TICKET_SYNC_ENABLED = 'true';
  process.env.POS_TICKET_SYNC_TENANTS = 't-pilot';
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of [
    ['POS_TICKET_SYNC_ENABLED', saved.enabled],
    ['POS_TICKET_SYNC_TENANTS', saved.tenants],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('PosTicketSyncEnqueuer', () => {
  it('queues a check-in as an open, with the event time and allow-list', async () => {
    const { link, rows, next } = setup();
    await link.publish(event('booking.checked_in'));
    expect(rows.enqueue).toHaveBeenCalledWith(
      {
        eventId: '0192aaaa-0000-7000-8000-000000000001',
        eventAt: AT,
        bookingId: BOOKING,
        kind: 'open',
        bookingStatus: 'checked_in',
      },
      ['t-pilot'],
    );
    expect(next.publish).toHaveBeenCalledTimes(1);
  });

  it('queues a completion as a status', async () => {
    const { link, queued } = setup();
    await link.publish(event('booking.completed'));
    expect([...queued.values()][0]).toMatchObject({
      kind: 'status',
      bookingStatus: 'completed',
    });
  });

  it('writes nothing twice for a re-delivered event', async () => {
    const { link, queued, next } = setup();
    await link.publish(event('booking.checked_in'));
    await link.publish(event('booking.checked_in'));
    expect(queued.size).toBe(1);
    expect(next.publish).toHaveBeenCalledTimes(2);
  });

  it('ignores events the till does not care about', async () => {
    const { link, rows, next } = setup();
    await link.publish(event('booking.confirmed'));
    await link.publish(event('booking.cancelled', { from: 'confirmed' }));
    await link.publish(event('reminder.24h'));
    expect(rows.enqueue).not.toHaveBeenCalled();
    expect(next.publish).toHaveBeenCalledTimes(3);
  });

  it('touches nothing at all while the switch is off', async () => {
    process.env.POS_TICKET_SYNC_ENABLED = '';
    const { link, rows, next } = setup();
    await link.publish(event('booking.checked_in'));
    expect(rows.enqueue).not.toHaveBeenCalled();
    expect(next.publish).toHaveBeenCalledTimes(1);
  });

  it('ignores another aggregate entirely', async () => {
    const { link, rows } = setup();
    await link.publish({
      ...event('booking.checked_in'),
      aggregateType: 'check_in_request',
    });
    expect(rows.enqueue).not.toHaveBeenCalled();
  });

  it('throws when the row cannot be written, so the relay retries', async () => {
    const { link, next } = setup(true);
    await expect(link.publish(event('booking.checked_in'))).rejects.toThrow(
      'db down',
    );
    expect(next.publish).not.toHaveBeenCalled();
  });
});
