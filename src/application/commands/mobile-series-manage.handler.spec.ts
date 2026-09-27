import { describe, it, expect, vi } from 'vitest';
import { MobileSeriesManageHandler } from './mobile-series-manage.handler';
import {
  RESCHEDULE_REASON,
  SKIP_REASON,
  manageClaimFrom,
} from '@domain/booking/mobile-series-manage';

const O1 = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'; // booked, 20 Oct
const O2 = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002'; // booked, starts in 2 hours
const O3 = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000003'; // booked, 27 Oct
const O4 = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000004'; // planned, not booked yet
const B1 = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001';
const B2 = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000002';
const B3 = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000003';
const CUSTOMER = 'cccccccc-cccc-4ccc-8ccc-000000000001';
const NOW = Date.parse('2026-10-01T09:00:00+06:00');

const fact = (
  id: string,
  index: number,
  day: string,
  startAtMs: number,
  booked = true,
) => ({
  id,
  index,
  day,
  startAtMs,
  state: booked ? ('materialised' as const) : ('planned' as const),
  bookingStatus: booked ? ('confirmed' as const) : null,
  noShowBy: null,
});

function build(status = 'active') {
  const series = {
    id: 'S',
    status,
    frequency: 'weekly',
    branchId: 'BR',
    serviceIds: ['svc'],
    preferredStaffId: 'pref',
    occurrences: [
      { id: O1, index: 0, bookingId: B1 },
      { id: O2, index: 1, bookingId: B2 },
      { id: O3, index: 2, bookingId: B3 },
      { id: O4, index: 3, bookingId: null },
    ],
  };
  const facts = [
    fact(O1, 0, '2026-10-20', Date.parse('2026-10-20T11:00:00+06:00')),
    fact(O2, 1, '2026-10-01', NOW + 2 * 3_600_000),
    fact(O3, 2, '2026-10-27', Date.parse('2026-10-27T11:00:00+06:00')),
    fact(O4, 3, '2026-11-30', Date.parse('2026-11-30T11:00:00+06:00'), false),
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
    booking: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ items: [{ staffId: 'staff-1' }] }),
    },
    bookingSeries: {
      findUnique: vi.fn().mockResolvedValue({
        anchorDay: new Date('2026-10-20T00:00:00Z'),
        startMin: 660,
      }),
    },
  };
  const holds = {
    execute: vi.fn().mockResolvedValue({ holdId: 'H1' }),
    release: vi.fn().mockResolvedValue(undefined),
  };
  const moves = { execute: vi.fn().mockResolvedValue({ code: 'GS-1' }) };
  const creates = { extend: vi.fn().mockResolvedValue(null) };
  const handler = new MobileSeriesManageHandler(
    prisma as never,
    lifecycle as never,
    reads as never,
    holds as never,
    moves as never,
    creates as never,
  );
  return { handler, reads, lifecycle, prisma, holds, moves, creates };
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

const skip = (ids: string[], extra: Record<string, unknown> = {}) =>
  manageClaimFrom({ action: 'SKIP', session_ids: ids, ...extra });

const move = (
  session: string,
  date: string,
  time: string,
  extra: Record<string, unknown> = {},
) =>
  manageClaimFrom({
    action: 'RESCHEDULE',
    session_id: session,
    date,
    time,
    ...extra,
  });

describe('SKIP (step 6)', () => {
  it('cancels the booking as the customer, marks the session skipped, and answers the hub', async () => {
    const { handler, lifecycle, prisma } = build();
    const out = await handler.execute({
      seriesId: 'S',
      who: customer,
      claim: skip([O1]),
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
    await handler.execute({
      seriesId: 'S',
      who: customer,
      claim: skip([O1], { dry_run: true }),
      nowMs: NOW,
    });
    expect(lifecycle.transition).not.toHaveBeenCalled();
    expect(prisma.seriesOccurrence.update).not.toHaveBeenCalled();
  });

  it('refuses a session inside the 24 hour lock, and changes nothing', async () => {
    const { handler, lifecycle } = build();
    const text = await failure(
      handler.execute({
        seriesId: 'S',
        who: customer,
        claim: skip([O2]),
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
        claim: skip([O1]),
        nowMs: NOW,
      }),
    );
    expect(text).toContain('routine_not_active');
  });

  it('answers invalid_action for an action the app does not have', async () => {
    const { handler, lifecycle } = build();
    const text = await failure(
      handler.execute({
        seriesId: 'S',
        who: customer,
        claim: manageClaimFrom({ action: 'FREEZE' }),
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
        claim: skip([O1]),
        nowMs: NOW,
      }),
    );
    expect(text).toContain('not_found');
  });

  it("answers 404 to staff: the app's changes are the customer's own", async () => {
    const { handler, reads } = build();
    const text = await failure(
      handler.execute({
        seriesId: 'S',
        who: { actorId: 'staff-1', actorKind: 'staff', actorBranchId: null },
        claim: skip([O1]),
        nowMs: NOW,
      }),
    );
    expect(text).toContain('not_found');
    expect(reads.factsFor).not.toHaveBeenCalled();
  });
});

describe('RESCHEDULE (step 6)', () => {
  it('moves the visit: a hold on the new time, then the move onto it', async () => {
    const { handler, holds, moves, prisma } = build();
    const out = await handler.execute({
      seriesId: 'S',
      who: customer,
      claim: move(O1, '2026-10-21', '12:00'),
      nowMs: NOW,
    });
    expect(holds.execute).toHaveBeenCalledWith({
      branchId: 'BR',
      customerId: CUSTOMER,
      tradingDay: '2026-10-21',
      serviceIds: ['svc'],
      startMin: 720,
      channel: 'online',
      preferredStaffId: 'staff-1',
    });
    expect(moves.execute).toHaveBeenCalledWith({
      bookingId: B1,
      holdId: 'H1',
      tradingDay: '2026-10-21',
      reason: RESCHEDULE_REASON,
      actor: 'customer',
      actorId: CUSTOMER,
    });
    expect(prisma.seriesOccurrence.update).toHaveBeenCalledWith({
      where: { id: O1 },
      data: {
        plannedDay: new Date('2026-10-21T00:00:00Z'),
        plannedStartMin: 720,
      },
    });
    expect(out).toEqual({ id: 'S', hub: true });
  });

  it('uses the stylist the customer picks', async () => {
    const { handler, holds } = build();
    await handler.execute({
      seriesId: 'S',
      who: customer,
      claim: move(O1, '2026-10-21', '12:00', { stylist_id: 'new-stylist' }),
      nowMs: NOW,
    });
    expect(holds.execute).toHaveBeenCalledWith(
      expect.objectContaining({ preferredStaffId: 'new-stylist' }),
    );
  });

  it('a dry run holds the new time and gives it straight back, and moves nothing', async () => {
    const { handler, holds, moves, prisma } = build();
    await handler.execute({
      seriesId: 'S',
      who: customer,
      claim: move(O1, '2026-10-21', '12:00', { dry_run: true }),
      nowMs: NOW,
    });
    expect(holds.release).toHaveBeenCalledWith('H1');
    expect(moves.execute).not.toHaveBeenCalled();
    expect(prisma.seriesOccurrence.update).not.toHaveBeenCalled();
  });

  it('refuses a time that is not free, and moves nothing', async () => {
    const { handler, holds, moves } = build();
    holds.execute.mockRejectedValue(new Error('taken'));
    const text = await failure(
      handler.execute({
        seriesId: 'S',
        who: customer,
        claim: move(O1, '2026-10-21', '12:00'),
        nowMs: NOW,
      }),
    );
    expect(text).toContain('session_not_free');
    expect(moves.execute).not.toHaveBeenCalled();
  });

  it('gives the hold back when the move itself fails', async () => {
    const { handler, holds, moves, prisma } = build();
    moves.execute.mockRejectedValue(new Error('illegal'));
    const text = await failure(
      handler.execute({
        seriesId: 'S',
        who: customer,
        claim: move(O1, '2026-10-21', '12:00'),
        nowMs: NOW,
      }),
    );
    expect(text).toContain('session_not_changeable');
    expect(holds.release).toHaveBeenCalledWith('H1');
    expect(prisma.seriesOccurrence.update).not.toHaveBeenCalled();
  });

  it('refuses a new time inside the 24 hour lock', async () => {
    const { handler, holds } = build();
    const text = await failure(
      handler.execute({
        seriesId: 'S',
        who: customer,
        claim: move(O1, '2026-10-01', '12:00'),
        nowMs: NOW,
      }),
    );
    expect(text).toContain('reschedule_out_of_range');
    expect(holds.execute).not.toHaveBeenCalled();
  });

  it('refuses a day another visit of the routine already has', async () => {
    const { handler, holds } = build();
    const text = await failure(
      handler.execute({
        seriesId: 'S',
        who: customer,
        claim: move(O1, '2026-10-27', '12:00'),
        nowMs: NOW,
      }),
    );
    expect(text).toContain('session_day_taken');
    expect(holds.execute).not.toHaveBeenCalled();
  });

  it('refuses a visit that is not booked yet', async () => {
    const { handler, holds } = build();
    const text = await failure(
      handler.execute({
        seriesId: 'S',
        who: customer,
        claim: move(O4, '2026-11-02', '12:00'),
        nowMs: NOW,
      }),
    );
    expect(text).toContain('session_not_changeable');
    expect(holds.execute).not.toHaveBeenCalled();
  });
});

describe('EXTEND (step 6)', () => {
  it('hands the routine to the create handler, numbered after its last session', async () => {
    const { handler, creates } = build();
    await handler.execute({
      seriesId: 'S',
      who: customer,
      claim: manageClaimFrom({ action: 'EXTEND', sessions: 2 }),
      nowMs: NOW,
      depositPercent: 20,
    });
    const [arg] = creates.extend.mock.calls[0] as unknown as [
      {
        routine: Record<string, unknown>;
        customerId: string;
        dryRun: boolean;
        depositPercent: number;
      },
    ];
    expect(arg.routine).toMatchObject({
      id: 'S',
      branchId: 'BR',
      serviceIds: ['svc'],
      stylistId: 'pref',
      startMin: 660,
      anchorDay: '2026-10-20',
      indexes: [0, 1, 2, 3],
    });
    expect(arg).toMatchObject({
      customerId: CUSTOMER,
      dryRun: false,
      depositPercent: 20,
    });
  });

  it('answers the new sessions on a dry run', async () => {
    const { handler, creates } = build();
    creates.extend.mockResolvedValue({ dry_run: true, sessions: [] });
    const out = await handler.execute({
      seriesId: 'S',
      who: customer,
      claim: manageClaimFrom({ action: 'EXTEND', sessions: 1, dry_run: true }),
      nowMs: NOW,
    });
    expect(out).toEqual({ dry_run: true, sessions: [] });
  });

  it('answers the hub after a real extend', async () => {
    const { handler } = build();
    const out = await handler.execute({
      seriesId: 'S',
      who: customer,
      claim: manageClaimFrom({ action: 'EXTEND', sessions: 1 }),
      nowMs: NOW,
    });
    expect(out).toEqual({ id: 'S', hub: true });
  });

  it('refuses a routine that is not active, and books nothing', async () => {
    const { handler, creates } = build('paused');
    const text = await failure(
      handler.execute({
        seriesId: 'S',
        who: customer,
        claim: manageClaimFrom({ action: 'EXTEND', sessions: 1 }),
        nowMs: NOW,
      }),
    );
    expect(text).toContain('routine_not_active');
    expect(creates.extend).not.toHaveBeenCalled();
  });
});
