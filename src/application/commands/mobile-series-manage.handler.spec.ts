import { describe, it, expect, vi } from 'vitest';
import { MobileSeriesManageHandler } from './mobile-series-manage.handler';
import {
  SKIP_REASON,
  manageClaimFrom,
} from '@domain/booking/mobile-series-manage';

const O1 = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'; // booked, far ahead
const O2 = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002'; // booked, starts in 2 hours
const B1 = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001';
const B2 = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000002';
const CUSTOMER = 'cccccccc-cccc-4ccc-8ccc-000000000001';
const NOW = Date.parse('2026-10-01T09:00:00+06:00');

const fact = (id: string, index: number, day: string, startAtMs: number) => ({
  id,
  index,
  day,
  startAtMs,
  state: 'materialised' as const,
  bookingStatus: 'confirmed' as const,
  noShowBy: null,
});

function build(status = 'active') {
  const series = {
    id: 'S',
    status,
    frequency: 'weekly',
    occurrences: [
      { id: O1, bookingId: B1 },
      { id: O2, bookingId: B2 },
    ],
  };
  const facts = [
    fact(O1, 0, '2026-10-20', Date.parse('2026-10-20T11:00:00+06:00')),
    fact(O2, 1, '2026-10-01', NOW + 2 * 3_600_000),
  ];
  const reads = {
    factsFor: vi.fn().mockResolvedValue({ series, facts }),
    read: vi.fn().mockResolvedValue({ id: 'S', hub: true }),
  };
  const lifecycle = {
    transition: vi.fn().mockResolvedValue({ kind: 'transitioned' }),
  };
  const prisma = {
    seriesOccurrence: { update: vi.fn().mockResolvedValue({}) },
  };
  const handler = new MobileSeriesManageHandler(
    prisma as never,
    lifecycle as never,
    reads as never,
  );
  return { handler, reads, lifecycle, prisma };
}

const customer = {
  actorId: CUSTOMER,
  actorKind: 'customer' as const,
  actorBranchId: null,
};

/** The error as text, or 'no error': enough to find its code in it. */
const failure = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'no error',
    (e: unknown) => JSON.stringify(e),
  );

describe('SKIP (step 6)', () => {
  it('cancels the booking as the customer, marks the session skipped, and answers the hub', async () => {
    const { handler, lifecycle, prisma } = build();
    const out = await handler.execute({
      seriesId: 'S',
      who: customer,
      claim: manageClaimFrom({ action: 'SKIP', session_ids: [O1] }),
      nowMs: NOW,
    });
    expect(lifecycle.transition).toHaveBeenCalledWith({
      bookingId: B1,
      to: 'cancelled',
      actor: 'customer',
      actorId: CUSTOMER,
      reason: SKIP_REASON,
      initiatedBy: 'customer',
    });
    expect(prisma.seriesOccurrence.update).toHaveBeenCalledWith({
      where: { id: O1 },
      data: { state: 'skipped', bookingId: null },
    });
    expect(out).toEqual({ id: 'S', hub: true });
  });

  it('changes nothing on a dry run', async () => {
    const { handler, lifecycle, prisma } = build();
    const out = await handler.execute({
      seriesId: 'S',
      who: customer,
      claim: manageClaimFrom({
        action: 'SKIP',
        session_ids: [O1],
        dry_run: true,
      }),
      nowMs: NOW,
    });
    expect(lifecycle.transition).not.toHaveBeenCalled();
    expect(prisma.seriesOccurrence.update).not.toHaveBeenCalled();
    expect(out).toEqual({ id: 'S', hub: true });
  });

  it('refuses a session inside the 24 hour lock, and changes nothing', async () => {
    const { handler, lifecycle } = build();
    const text = await failure(
      handler.execute({
        seriesId: 'S',
        who: customer,
        claim: manageClaimFrom({ action: 'SKIP', session_ids: [O2] }),
        nowMs: NOW,
      }),
    );
    expect(text).toContain('session_locked');
    expect(lifecycle.transition).not.toHaveBeenCalled();
  });

  it('refuses a routine that is not active', async () => {
    const { handler } = build('paused');
    const text = await failure(
      handler.execute({
        seriesId: 'S',
        who: customer,
        claim: manageClaimFrom({ action: 'SKIP', session_ids: [O1] }),
        nowMs: NOW,
      }),
    );
    expect(text).toContain('routine_not_active');
  });

  it('answers invalid_action for the changes not built yet', async () => {
    const { handler, lifecycle } = build();
    const text = await failure(
      handler.execute({
        seriesId: 'S',
        who: customer,
        claim: manageClaimFrom({ action: 'EXTEND', sessions: 1 }),
        nowMs: NOW,
      }),
    );
    expect(text).toContain('invalid_action');
    expect(lifecycle.transition).not.toHaveBeenCalled();
  });

  it('answers 404 for a routine the caller may not see', async () => {
    const { handler, reads } = build();
    reads.factsFor.mockResolvedValue(null);
    const text = await failure(
      handler.execute({
        seriesId: 'S',
        who: customer,
        claim: manageClaimFrom({ action: 'SKIP', session_ids: [O1] }),
        nowMs: NOW,
      }),
    );
    expect(text).toContain('not_found');
  });

  it("answers 404 to staff: the app changes are the customer's own", async () => {
    const { handler, reads } = build();
    const text = await failure(
      handler.execute({
        seriesId: 'S',
        who: { actorId: 'staff-1', actorKind: 'staff', actorBranchId: null },
        claim: manageClaimFrom({ action: 'SKIP', session_ids: [O1] }),
        nowMs: NOW,
      }),
    );
    expect(text).toContain('not_found');
    expect(reads.factsFor).not.toHaveBeenCalled();
  });
});
