import { describe, it, expect, vi } from 'vitest';
import { NotificationDeliveryRepository } from './notification-delivery.repository';
import { DISPATCH_LEASE_MS } from '@domain/booking/reminder-delivery';

const NOW = Date.parse('2026-10-10T04:00:00Z');

function build() {
  const prisma = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    notificationDelivery: {
      createMany: vi.fn().mockResolvedValue({ count: 2 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    booking: { findMany: vi.fn().mockResolvedValue([]) },
  };
  return { repo: new NotificationDeliveryRepository(prisma as never), prisma };
}

/** The SQL text of a tagged $queryRaw call, with its values. */
function taggedCall(mock: ReturnType<typeof vi.fn>) {
  const [strings, ...values] = mock.mock.calls[0]! as [
    TemplateStringsArray,
    ...unknown[],
  ];
  return { sql: strings.join('$'), values };
}

/** What the n-th updateMany was asked to write. */
const updateData = (prisma: ReturnType<typeof build>['prisma']): unknown =>
  (
    prisma.notificationDelivery.updateMany.mock.calls[0]![0] as {
      data: unknown;
    }
  ).data;

describe('enqueue', () => {
  it('skips duplicates, so the same reminder event relayed twice creates nothing new', async () => {
    const { repo, prisma } = build();
    await repo.enqueue([
      {
        sourceEventId: 'e1',
        channel: 'push',
        eventType: 'reminder.confirm_24h',
        bookingId: 'b1',
        customerId: 'c1',
        scheduledFor: new Date(NOW),
        expiresAt: new Date(NOW),
        nextAttemptAt: new Date(NOW),
      },
    ]);
    expect(prisma.notificationDelivery.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
  });

  it('nothing to write, no query', async () => {
    const { repo, prisma } = build();
    expect(await repo.enqueue([])).toBe(0);
    expect(prisma.notificationDelivery.createMany).not.toHaveBeenCalled();
  });
});

describe('claimDue', () => {
  it('claims pending, due rows with SKIP LOCKED and pushes them out by the lease', async () => {
    const { repo, prisma } = build();
    await repo.claimDue(NOW, 10);
    const { sql, values } = taggedCall(prisma.$queryRaw);
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain('attempts = attempts + 1');
    expect(values).toContainEqual(new Date(NOW + DISPATCH_LEASE_MS));
    expect(values).toContainEqual(new Date(NOW));
    expect(values).toContain(10);
  });

  it('hands back each row with its attempt number', async () => {
    const { repo, prisma } = build();
    prisma.$queryRaw.mockResolvedValue([
      {
        id: 'd1',
        source_event_id: 'e1',
        channel: 'email',
        event_type: 'reminder.confirm_24h',
        booking_id: 'b1',
        customer_id: 'c1',
        scheduled_for: new Date(NOW + 86_400_000),
        expires_at: new Date(NOW + 75_600_000),
        attempts: 3,
      },
    ]);
    const [got] = await repo.claimDue(NOW, 10);
    expect(got).toEqual({
      id: 'd1',
      sourceEventId: 'e1',
      channel: 'email',
      eventType: 'reminder.confirm_24h',
      bookingId: 'b1',
      customerId: 'c1',
      scheduledForMs: NOW + 86_400_000,
      expiresAtMs: NOW + 75_600_000,
      attempt: 3,
    });
  });
});

describe('record: only the current claimant writes', () => {
  it('is keyed on the attempt it was handed, and only while pending', async () => {
    const { repo, prisma } = build();
    await repo.record(
      { id: 'd1', attempt: 2 },
      { status: 'sent', ref: 'devices=1' },
      NOW,
    );
    expect(prisma.notificationDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: 'd1', status: 'pending', attempts: 2 },
      data: {
        status: 'sent',
        sentAt: new Date(NOW),
        providerRef: 'devices=1',
        lastError: null,
      },
    });
  });

  it('a worker whose lease ran out, writing late, changes nothing', async () => {
    const { repo, prisma } = build();
    prisma.notificationDelivery.updateMany.mockResolvedValue({ count: 0 });
    expect(
      await repo.record(
        { id: 'd1', attempt: 1 },
        { status: 'failed', error: 'late' },
        NOW,
      ),
    ).toBe(false);
  });

  it('a retry stays pending, due again later, with the error kept', async () => {
    const { repo, prisma } = build();
    await repo.record(
      { id: 'd1', attempt: 1 },
      { status: 'pending', nextAttemptAtMs: NOW + 60_000, error: 'HTTP 503' },
      NOW,
    );
    expect(updateData(prisma)).toEqual({
      nextAttemptAt: new Date(NOW + 60_000),
      lastError: 'HTTP 503',
    });
  });

  it.each([
    [
      { status: 'skipped', reason: 'no_email' } as const,
      { status: 'skipped', skipReason: 'no_email' },
    ],
    [{ status: 'superseded' } as const, { status: 'superseded' }],
    [
      { status: 'failed', error: 'HTTP 401' } as const,
      { status: 'failed', lastError: 'HTTP 401' },
    ],
  ])('%j is written as %j', async (outcome, data) => {
    const { repo, prisma } = build();
    await repo.record({ id: 'd1', attempt: 1 }, outcome, NOW);
    expect(updateData(prisma)).toEqual(data);
  });
});

describe('bookings', () => {
  it('reads the services in booking order', async () => {
    const { repo, prisma } = build();
    prisma.booking.findMany.mockResolvedValue([
      {
        id: 'b1',
        status: 'confirmed',
        startAt: new Date(NOW),
        code: 'GS-1050',
        customerId: 'c1',
        paymentStatus: 'deposit_paid',
        durationMin: 105,
        items: [{ serviceName: 'Full colour' }, { serviceName: 'Blow-dry' }],
      },
    ]);
    const got = await repo.bookings(['b1']);
    expect(got.get('b1')?.services).toEqual(['Full colour', 'Blow-dry']);
    expect(
      (
        prisma.booking.findMany.mock.calls[0]![0] as {
          select: { items: { orderBy: unknown } };
        }
      ).select.items.orderBy,
    ).toEqual({
      position: 'asc',
    });
  });
});
