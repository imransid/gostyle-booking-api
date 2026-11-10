import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { DeskExtrasRepository } from './desk-extras.repository';

const BOOKING = '0190f0c1-2222-7000-8000-000000000002';
const NOW = Date.parse('2026-11-04T10:02:00Z');

/** A transaction that answers the undo's reads and records its writes. */
function setup(status = 'checked_in', checkedInAtMs = NOW - 60_000) {
  const tx = {
    $queryRaw: vi.fn(() =>
      Promise.resolve([
        {
          id: BOOKING,
          code: 'GS-1234',
          status,
          branch_id: '0190f0c1-3333-7000-8000-000000000003',
          trading_day: new Date('2026-11-04T00:00:00Z'),
          start_minute: 840,
          duration_min: 45,
        },
      ]),
    ),
    $executeRaw: vi.fn(() => Promise.resolve(1)),
    bookingStatusHistory: {
      findFirst: vi.fn(() =>
        Promise.resolve({ createdAt: new Date(checkedInAtMs) }),
      ),
      create: vi.fn(() => Promise.resolve({})),
    },
    bookingItem: {
      findFirst: vi.fn(() =>
        Promise.resolve({
          serviceId: '0190f0c1-8888-7000-8000-000000000008',
          staffId: '0190f0c1-9999-7000-8000-000000000009',
        }),
      ),
    },
    eventOutbox: { create: vi.fn(() => Promise.resolve({})) },
  };
  const prisma = {
    $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { repo: new DeskExtrasRepository(prisma as never), tx };
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('undoCheckIn writes booking.check_in_undone', () => {
  it('in the same transaction, in the lifecycle events’ shape', async () => {
    const { repo, tx } = setup();
    const out = await repo.undoCheckIn({
      bookingId: BOOKING,
      reason: 'Wrong customer',
      actor: 'staff',
      actorId: '0190f0c1-dddd-7000-8000-00000000000d',
      nowMs: NOW,
    });
    expect(out.kind).toBe('done');
    expect(tx.eventOutbox.create).toHaveBeenCalledWith({
      data: {
        aggregateType: 'booking',
        aggregateId: BOOKING,
        eventType: 'booking.check_in_undone',
        payload: {
          code: 'GS-1234',
          from: 'checked_in',
          to: 'confirmed',
          refundFils: 0,
          keptFils: 0,
          releasedCapacity: false,
          branchId: '0190f0c1-3333-7000-8000-000000000003',
          tradingDay: '2026-11-04',
          startMin: 840,
          durationMin: 45,
          serviceId: '0190f0c1-8888-7000-8000-000000000008',
          staffId: '0190f0c1-9999-7000-8000-000000000009',
          reason: 'Wrong customer',
          actorKind: 'staff',
          actorId: '0190f0c1-dddd-7000-8000-00000000000d',
        },
      },
    });
  });

  it('writes no event when the undo is refused', async () => {
    const { repo, tx } = setup('in_service');
    const out = await repo.undoCheckIn({
      bookingId: BOOKING,
      reason: 'x',
      actor: 'staff',
      actorId: null,
      nowMs: NOW,
    });
    expect(out.kind).toBe('illegal');
    expect(tx.eventOutbox.create).not.toHaveBeenCalled();
  });

  it('writes no event past the five-minute window', async () => {
    const { repo, tx } = setup('checked_in', NOW - 10 * 60_000);
    const out = await repo.undoCheckIn({
      bookingId: BOOKING,
      reason: 'x',
      actor: 'staff',
      actorId: null,
      nowMs: NOW,
    });
    expect(out.kind).toBe('illegal');
    expect(tx.eventOutbox.create).not.toHaveBeenCalled();
  });
});
