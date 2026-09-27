import { describe, it, expect, vi } from 'vitest';
import { MobileSeriesManageHandler } from './mobile-series-manage.handler';
import { manageClaimFrom } from '@domain/booking/mobile-series-manage';
import {
  PAUSE_MOVE_REASON,
  RESUME_MOVE_REASON,
} from '@domain/booking/mobile-series-move';

const O1 = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'; // booked, 20 Oct
const O2 = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002'; // booked, starts in 2 hours
const O3 = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000003'; // booked, 27 Oct
const O4 = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000004'; // planned, not booked yet
const B1 = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001';
const B2 = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000002';
const B3 = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000003';
const CUSTOMER = 'cccccccc-cccc-4ccc-8ccc-000000000001';
const NOW = Date.parse('2026-10-01T09:00:00+06:00');

/** What the manage handler hands to the create handler's move. */
interface MoveArg {
  readonly sessions: readonly Record<string, unknown>[];
  readonly otherDays: readonly string[];
  readonly from: string;
  readonly newFrequency: string | null;
  readonly startMin: number;
  readonly stylistId: string;
  readonly fromStatus: string;
  readonly after: Record<string, unknown>;
  readonly releaseReason: string;
  readonly field: string;
  readonly customerId: string;
  readonly dryRun: boolean;
}

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
  const occurrence = (
    id: string,
    index: number,
    day: string,
    bookingId: string | null,
  ) => ({
    id,
    index,
    plannedDay: new Date(`${day}T00:00:00Z`),
    plannedStartMin: 660,
    state: bookingId === null ? 'planned' : 'materialised',
    bookingId,
  });
  const series = {
    id: 'S',
    status,
    frequency: 'weekly',
    branchId: 'BR',
    serviceIds: ['svc'],
    preferredStaffId: 'pref',
    occurrences: [
      occurrence(O1, 0, '2026-10-20', B1),
      occurrence(O2, 1, '2026-10-01', B2),
      occurrence(O3, 2, '2026-10-27', B3),
      occurrence(O4, 3, '2026-11-30', null),
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
  const prisma = {
    bookingSeries: {
      findUnique: vi.fn().mockResolvedValue({
        anchorDay: new Date('2026-10-20T00:00:00Z'),
        startMin: 660,
      }),
    },
    booking: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: B1,
          tradingDay: new Date('2026-10-20T00:00:00Z'),
          startMinute: 660,
          items: [{ staffId: 'pref' }],
        },
        {
          id: B3,
          tradingDay: new Date('2026-10-28T00:00:00Z'),
          startMinute: 720,
          items: [{ staffId: 'other' }],
        },
      ]),
    },
  };
  const creates = {
    extend: vi.fn().mockResolvedValue(null),
    move: vi.fn().mockResolvedValue(null),
  };
  const handler = new MobileSeriesManageHandler(
    prisma as never,
    { transition: vi.fn() } as never,
    reads as never,
    { execute: vi.fn(), release: vi.fn() } as never,
    { execute: vi.fn() } as never,
    creates as never,
  );
  return { handler, reads, prisma, creates };
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

/** The one move the create handler was asked for. */
const moveOf = (creates: { move: { mock: { calls: unknown[][] } } }) =>
  (creates.move.mock.calls[0] as unknown as [MoveArg])[0];

describe('PAUSE (step 7)', () => {
  it("moves the sessions past the lock to the resume date onwards, on the routine's time and stylist", async () => {
    const { handler, creates } = build();
    const out = await handler.execute({
      seriesId: 'S',
      who: customer,
      claim: manageClaimFrom({
        action: 'PAUSE',
        until: '2026-11-10',
        reason: 'TRAVEL',
        note: 'Away for work',
      }),
      nowMs: NOW,
      depositPercent: 20,
    });
    const arg = moveOf(creates);
    // The session starting in 2 hours stays: it is inside the lock.
    expect(arg.sessions).toEqual([
      {
        occurrenceId: O1,
        index: 0,
        bookingId: B1,
        day: '2026-10-20',
        startMin: 660,
        staffId: 'pref',
      },
      // Where its booking really is (moved at the desk), not where it was planned.
      {
        occurrenceId: O3,
        index: 2,
        bookingId: B3,
        day: '2026-10-28',
        startMin: 720,
        staffId: 'other',
      },
      {
        occurrenceId: O4,
        index: 3,
        bookingId: null,
        day: '2026-11-30',
        startMin: 660,
        staffId: null,
      },
    ]);
    expect(arg).toMatchObject({
      from: '2026-11-10',
      otherDays: ['2026-10-01'],
      newFrequency: null,
      startMin: 660,
      stylistId: 'pref',
      fromStatus: 'active',
      releaseReason: PAUSE_MOVE_REASON,
      field: 'until',
      customerId: CUSTOMER,
      dryRun: false,
    });
    expect(arg.after).toEqual({
      status: 'paused',
      pausedUntil: '2026-11-10',
      pauseReason: 'travel',
      pauseNote: 'Away for work',
    });
    expect(out).toEqual({ id: 'S', hub: true });
  });

  it('never brings a visit closer: a resume date before the first session keeps it', async () => {
    const { handler, creates } = build();
    await handler.execute({
      seriesId: 'S',
      who: customer,
      claim: manageClaimFrom({ action: 'PAUSE', until: '2026-10-05' }),
      nowMs: NOW,
    });
    expect(moveOf(creates).from).toBe('2026-10-20');
  });

  it('answers the preview of the moved sessions on a dry run', async () => {
    const { handler, creates } = build();
    creates.move.mockResolvedValue({ dry_run: true, sessions: [] });
    const out = await handler.execute({
      seriesId: 'S',
      who: customer,
      claim: manageClaimFrom({
        action: 'PAUSE',
        until: '2026-11-10',
        dry_run: true,
      }),
      nowMs: NOW,
    });
    expect(moveOf(creates).dryRun).toBe(true);
    expect(out).toEqual({ dry_run: true, sessions: [] });
  });

  it('refuses a pause of more than 60 days, and moves nothing', async () => {
    const { handler, creates } = build();
    const text = await failure(
      handler.execute({
        seriesId: 'S',
        who: customer,
        claim: manageClaimFrom({ action: 'PAUSE', until: '2026-12-15' }),
        nowMs: NOW,
      }),
    );
    expect(text).toContain('pause_too_long');
    expect(creates.move).not.toHaveBeenCalled();
  });

  it('refuses a routine that is not active', async () => {
    const { handler, creates } = build('paused');
    const text = await failure(
      handler.execute({
        seriesId: 'S',
        who: customer,
        claim: manageClaimFrom({ action: 'PAUSE', until: '2026-11-10' }),
        nowMs: NOW,
      }),
    );
    expect(text).toContain('routine_not_active');
    expect(creates.move).not.toHaveBeenCalled();
  });
});

describe('RESUME (step 7)', () => {
  it('moves the sessions back to tomorrow onwards, and makes the routine active', async () => {
    const { handler, creates } = build('paused');
    const out = await handler.execute({
      seriesId: 'S',
      who: customer,
      claim: manageClaimFrom({ action: 'RESUME' }),
      nowMs: NOW,
    });
    const arg = moveOf(creates);
    // Tomorrow, 2 Oct. The session starting in 2 hours stays where it is.
    expect(arg).toMatchObject({
      from: '2026-10-02',
      newFrequency: null,
      startMin: 660,
      stylistId: 'pref',
      fromStatus: 'paused',
      releaseReason: RESUME_MOVE_REASON,
      field: 'frequency',
    });
    expect(arg.after).toEqual({
      status: 'active',
      pausedUntil: null,
      pauseReason: null,
      pauseNote: null,
    });
    expect(out).toEqual({ id: 'S', hub: true });
  });

  it('"Customize first": the new frequency, time and stylist go to the move and to the routine', async () => {
    const { handler, creates } = build('paused');
    await handler.execute({
      seriesId: 'S',
      who: customer,
      claim: manageClaimFrom({
        action: 'RESUME',
        frequency: 'EVERY_2_WEEKS',
        time: '15:00',
        stylist_id: 'maya',
      }),
      nowMs: NOW,
    });
    const arg = moveOf(creates);
    expect(arg).toMatchObject({
      newFrequency: 'EVERY_2_WEEKS',
      startMin: 900,
      stylistId: 'maya',
    });
    expect(arg.after).toEqual({
      status: 'active',
      pausedUntil: null,
      pauseReason: null,
      pauseNote: null,
      startMin: 900,
      preferredStaffId: 'maya',
      frequency: 'every_2_weeks',
    });
  });

  it('refuses an active routine: only a paused one resumes', async () => {
    const { handler, creates } = build('active');
    const text = await failure(
      handler.execute({
        seriesId: 'S',
        who: customer,
        claim: manageClaimFrom({ action: 'RESUME' }),
        nowMs: NOW,
      }),
    );
    expect(text).toContain('routine_not_active');
    expect(creates.move).not.toHaveBeenCalled();
  });

  it('refuses CUSTOM as a new frequency', async () => {
    const { handler, creates } = build('paused');
    const text = await failure(
      handler.execute({
        seriesId: 'S',
        who: customer,
        claim: manageClaimFrom({ action: 'RESUME', frequency: 'CUSTOM' }),
        nowMs: NOW,
      }),
    );
    expect(text).toContain('invalid_frequency');
    expect(creates.move).not.toHaveBeenCalled();
  });
});
