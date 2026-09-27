import { describe, it, expect, vi } from 'vitest';
import { MobileSeriesCancelHandler } from './mobile-series-cancel.handler';
import { cancelClaimFrom } from '@domain/booking/mobile-series-cancel';
import {
  cancelHistoryReason,
  cancelReasonFromHistory,
} from '@domain/booking/mobile-series-contract';

const O1 = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'; // booked, 20 Oct
const O2 = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002'; // booked, starts in 5 hours
const O3 = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000003'; // done
const O4 = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000004'; // far off, never booked
const B1 = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001';
const B2 = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000002';
const B3 = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000003';
const CUSTOMER = 'cccccccc-cccc-4ccc-8ccc-000000000001';
const NOW = Date.parse('2026-10-01T09:00:00+06:00');
const HOUR = 3_600_000;

const fact = (
  id: string,
  index: number,
  day: string,
  startAtMs: number,
  bookingStatus: string | null,
) => ({
  id,
  index,
  day,
  startAtMs,
  state: bookingStatus === null ? 'planned' : 'materialised',
  bookingStatus,
  noShowBy: null,
});

function build(status = 'active') {
  const series = {
    id: 'S',
    status,
    frequency: 'monthly',
    branchId: 'BR',
    serviceIds: ['svc'],
    preferredStaffId: 'pref',
    occurrences: [
      { id: O3, index: 0, bookingId: B3 },
      { id: O1, index: 1, bookingId: B1 },
      { id: O2, index: 2, bookingId: B2 },
      { id: O4, index: 3, bookingId: null },
    ],
  };
  const facts = [
    fact(
      O3,
      0,
      '2026-09-20',
      Date.parse('2026-09-20T11:00:00+06:00'),
      'completed',
    ),
    fact(
      O1,
      1,
      '2026-10-20',
      Date.parse('2026-10-20T11:00:00+06:00'),
      'confirmed',
    ),
    fact(O2, 2, '2026-10-01', NOW + 5 * HOUR, 'confirmed'),
    fact(O4, 3, '2027-02-20', Date.parse('2027-02-20T11:00:00+06:00'), null),
  ];
  const reads = {
    factsFor: vi.fn().mockResolvedValue({ series, facts }),
    read: vi.fn().mockResolvedValue({ id: 'S', hub: true }),
  };
  const lifecycle = {
    ticketFor: vi.fn().mockResolvedValue({
      serviceFils: 500,
      customerId: CUSTOMER,
      capturedFils: 0,
      status: 'confirmed',
    }),
    transition: vi.fn().mockResolvedValue({ kind: 'transitioned' }),
  };
  const repo = { endByCustomer: vi.fn().mockResolvedValue(true) };
  const handler = new MobileSeriesCancelHandler(
    lifecycle as never,
    reads as never,
    repo as never,
  );
  return { handler, reads, lifecycle, repo, series, facts };
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

describe('CANCEL a routine (step 7)', () => {
  it('a dry run answers the summary and the routine as it is, and changes nothing', async () => {
    const { handler, reads, lifecycle, repo } = build();
    const out = await handler.execute({
      seriesId: 'S',
      who: customer,
      claim: cancelClaimFrom({ dry_run: true }),
      nowMs: NOW,
    });
    expect(out).toMatchObject({
      dry_run: true,
      summary: {
        visits_cancelled: 3,
        late_visits: 1,
        paid: 0,
        refund: 0,
        kept: 0,
      },
      routine: { id: 'S', hub: true },
    });
    expect(reads.read).toHaveBeenCalledWith('S', customer, NOW);
    expect(lifecycle.transition).not.toHaveBeenCalled();
    expect(repo.endByCustomer).not.toHaveBeenCalled();
  });

  it('reads what was paid as the lifecycle does, for the booked sessions still to come only', async () => {
    const { handler, lifecycle } = build();
    lifecycle.ticketFor.mockImplementation((id: string) =>
      Promise.resolve({
        serviceFils: 500,
        customerId: CUSTOMER,
        capturedFils: id === B1 ? 2000 : 1000,
        status: 'confirmed',
      }),
    );
    const out = await handler.execute({
      seriesId: 'S',
      who: customer,
      claim: cancelClaimFrom({ dry_run: true }),
      nowMs: NOW,
    });
    expect(lifecycle.ticketFor).toHaveBeenCalledTimes(2);
    expect(lifecycle.ticketFor).toHaveBeenCalledWith(B1);
    expect(lifecycle.ticketFor).toHaveBeenCalledWith(B2);
    expect(lifecycle.ticketFor).not.toHaveBeenCalledWith(B3);
    expect(out).toMatchObject({ summary: { paid: 30, refund: 20, kept: 10 } });
  });

  it('cancels each booked session as the customer, with the reason in its history', async () => {
    const { handler, lifecycle } = build();
    await handler.execute({
      seriesId: 'S',
      who: customer,
      claim: cancelClaimFrom({ reason: 'TOO_EXPENSIVE' }),
      nowMs: NOW,
    });
    const reason = cancelHistoryReason('TOO_EXPENSIVE');
    expect(cancelReasonFromHistory(reason)).toBe('TOO_EXPENSIVE');
    expect(lifecycle.transition).toHaveBeenCalledTimes(2);
    for (const bookingId of [B1, B2]) {
      expect(lifecycle.transition).toHaveBeenCalledWith({
        bookingId,
        to: 'cancelled',
        actor: 'customer',
        actorId: CUSTOMER,
        reason,
        initiatedBy: 'customer',
      });
    }
  });

  it('then ends the routine, skips the never-booked session, and answers the hub', async () => {
    const { handler, repo } = build();
    const out = await handler.execute({
      seriesId: 'S',
      who: customer,
      claim: cancelClaimFrom({ reason: 'MOVING' }),
      nowMs: NOW,
    });
    expect(repo.endByCustomer).toHaveBeenCalledWith({
      seriesId: 'S',
      unbookedIds: [O4],
      reason: 'MOVING',
      cancelled: 2,
    });
    expect(out).toEqual({ id: 'S', hub: true });
  });

  it('with no reason, the history still says the app cancelled it', async () => {
    const { handler, lifecycle, repo } = build();
    await handler.execute({
      seriesId: 'S',
      who: customer,
      claim: cancelClaimFrom({}),
      nowMs: NOW,
    });
    expect(lifecycle.transition).toHaveBeenCalledWith(
      expect.objectContaining({ reason: cancelHistoryReason(null) }),
    );
    expect(repo.endByCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ reason: null }),
    );
  });

  it('one booking that changed in the meantime does not block the rest', async () => {
    const { handler, lifecycle, repo } = build();
    lifecycle.transition.mockResolvedValueOnce({
      kind: 'illegal',
      message: 'checked in',
    });
    const out = await handler.execute({
      seriesId: 'S',
      who: customer,
      claim: cancelClaimFrom({}),
      nowMs: NOW,
    });
    expect(lifecycle.transition).toHaveBeenCalledTimes(2);
    expect(repo.endByCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ cancelled: 1 }),
    );
    expect(out).toEqual({ id: 'S', hub: true });
  });

  it('a paused routine can be cancelled too', async () => {
    const { handler, repo } = build('paused');
    await handler.execute({
      seriesId: 'S',
      who: customer,
      claim: cancelClaimFrom({}),
      nowMs: NOW,
    });
    expect(repo.endByCustomer).toHaveBeenCalledTimes(1);
  });

  it('refuses a routine that has already ended, and changes nothing', async () => {
    const { handler, lifecycle, repo } = build('ended');
    const text = await failure(
      handler.execute({
        seriesId: 'S',
        who: customer,
        claim: cancelClaimFrom({}),
        nowMs: NOW,
      }),
    );
    expect(text).toContain('cannot_cancel');
    expect(lifecycle.transition).not.toHaveBeenCalled();
    expect(repo.endByCustomer).not.toHaveBeenCalled();
  });

  it('refuses a routine with no session left to come', async () => {
    const { handler, reads, repo, series, facts } = build();
    reads.factsFor.mockResolvedValue({
      series,
      facts: facts.filter((f) => f.id === O3),
    });
    const text = await failure(
      handler.execute({
        seriesId: 'S',
        who: customer,
        claim: cancelClaimFrom({}),
        nowMs: NOW,
      }),
    );
    expect(text).toContain('cannot_cancel');
    expect(repo.endByCustomer).not.toHaveBeenCalled();
  });

  it('refuses a reason the app does not offer, and changes nothing', async () => {
    const { handler, lifecycle } = build();
    const text = await failure(
      handler.execute({
        seriesId: 'S',
        who: customer,
        claim: cancelClaimFrom({ reason: 'BORED' }),
        nowMs: NOW,
      }),
    );
    expect(text).toContain('invalid_cancel_reason');
    expect(lifecycle.transition).not.toHaveBeenCalled();
  });

  it('answers 404 for a routine the caller may not see', async () => {
    const { handler, reads } = build();
    reads.factsFor.mockResolvedValue(null);
    const text = await failure(
      handler.execute({
        seriesId: 'S',
        who: customer,
        claim: cancelClaimFrom({}),
        nowMs: NOW,
      }),
    );
    expect(text).toContain('not_found');
  });

  it("answers 404 to staff: the app's cancel is the customer's own", async () => {
    const { handler, reads } = build();
    const text = await failure(
      handler.execute({
        seriesId: 'S',
        who: { actorId: 'staff-1', actorKind: 'staff', actorBranchId: null },
        claim: cancelClaimFrom({}),
        nowMs: NOW,
      }),
    );
    expect(text).toContain('not_found');
    expect(reads.factsFor).not.toHaveBeenCalled();
  });
});
