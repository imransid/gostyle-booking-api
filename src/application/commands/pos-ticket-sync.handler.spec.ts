import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { PosTicketSyncHandler } from './pos-ticket-sync.handler';
import { PosIntakeFailure } from '@application/ports/pos-ticket-intake.port';
import type { BookingPosContext } from '@infrastructure/persistence/pos-ticket-sync.repository';

const BOOKING = '0190f0c1-2222-7000-8000-000000000002';
const TICKET = '0190f0c1-0000-7000-8000-0000000000aa';
const STAFF = '0190f0c1-dddd-7000-8000-00000000000d';
const EVENT = '0190f0c1-eeee-7000-8000-00000000000e';

function ctx(status = 'checked_in'): BookingPosContext {
  return {
    booking: {
      id: BOOKING,
      code: 'GS-1234',
      tenantId: '0190f0c1-1111-7000-8000-000000000001',
      branchId: '0190f0c1-3333-7000-8000-000000000003',
      startAt: new Date('2026-11-04T10:00:00Z'),
      status,
      customerId: '0190f0c1-6666-7000-8000-000000000006',
      isGuest: false,
      items: [],
      products: [],
    },
    breakdown: { netFils: 20000, taxFils: 1000, discountFils: 0 },
    ledger: [{ entryType: 'captured', amountFils: 5000, vatFils: null }],
    actorByStatus: new Map([
      ['checked_in', STAFF],
      ['completed', STAFF],
    ]),
  };
}

const row = (kind: 'open' | 'status', bookingStatus: string, attempts = 0) => ({
  id: 'row-1',
  eventId: EVENT,
  bookingId: BOOKING,
  kind,
  bookingStatus,
  attempts,
});

function setup(opts: {
  due: ReturnType<typeof row>[];
  context?: BookingPosContext | null;
  open?: () => Promise<unknown>;
  update?: () => Promise<unknown>;
}) {
  const rows = {
    claimDue: vi.fn(() => Promise.resolve(opts.due)),
    bookingFor: vi.fn(() =>
      Promise.resolve(opts.context === undefined ? ctx() : opts.context),
    ),
    markDone: vi.fn(() => Promise.resolve()),
    markSkipped: vi.fn(() => Promise.resolve()),
    markRetry: vi.fn(
      (_id: string, _code: string | null, _e: string, _at: Date) =>
        Promise.resolve(),
    ),
    markParked: vi.fn(() => Promise.resolve()),
    setTicket: vi.fn(() => Promise.resolve()),
    clearTicket: vi.fn(() => Promise.resolve()),
    unsettledCompleted: vi.fn(() => Promise.resolve([])),
  };
  const ref = {
    ticketId: TICKET,
    number: '#T-42',
    state: 'OPEN',
    replayed: false,
  };
  const intake = {
    openTicketForBooking: vi.fn(opts.open ?? (() => Promise.resolve(ref))),
    updateBookingStatus: vi.fn(
      opts.update ?? (() => Promise.resolve({ ...ref, state: 'READY' })),
    ),
    getTicketForBooking: vi.fn(),
  };
  const contacts = {
    lookup: vi.fn(() =>
      Promise.resolve({
        kind: 'found',
        contact: {
          customerId: 'c',
          email: 'maya@example.com',
          emailVerified: true,
          fullName: 'Maya K',
        },
      }),
    ),
  };
  const paid = { settle: vi.fn() };
  const handler = new PosTicketSyncHandler(
    rows as never,
    intake as never,
    contacts as never,
    paid as never,
  );
  return { handler, rows, intake, contacts, paid };
}

const saved = {
  enabled: process.env.POS_TICKET_SYNC_ENABLED,
  tenants: process.env.POS_TICKET_SYNC_TENANTS,
};
beforeEach(() => {
  process.env.POS_TICKET_SYNC_ENABLED = 'true';
  delete process.env.POS_TICKET_SYNC_TENANTS;
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation(() => {});
  }
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

describe('PosTicketSyncHandler.run', () => {
  it('claims nothing while the switch is off', async () => {
    process.env.POS_TICKET_SYNC_ENABLED = 'false';
    const { handler, rows } = setup({ due: [row('open', 'checked_in')] });
    expect((await handler.run()).sendingEnabled).toBe(false);
    expect(rows.claimDue).not.toHaveBeenCalled();
  });

  it('opens the ticket with the deposit and who checked them in, then stores it', async () => {
    const { handler, rows, intake } = setup({
      due: [row('open', 'checked_in')],
    });
    expect(await handler.run()).toMatchObject({ done: 1 });
    expect(intake.openTicketForBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        booking_id: BOOKING,
        opened_by_user_id: STAFF,
        deposit_available_minor: 5000,
        deposit_vat_minor: 238,
        customer: {
          consumer_id: '0190f0c1-6666-7000-8000-000000000006',
          email: 'maya@example.com',
          full_name: 'Maya K',
        },
        idempotency_key: `booking:${BOOKING}:open:${EVENT}`,
      }),
    );
    expect(rows.setTicket).toHaveBeenCalledWith(BOOKING, TICKET, '#T-42');
    expect(rows.markDone).toHaveBeenCalledWith('row-1', TICKET);
  });

  it('skips an open whose visit was undone before its turn came', async () => {
    const { handler, intake } = setup({
      due: [row('open', 'checked_in')],
      context: ctx('confirmed'),
    });
    expect(await handler.run()).toMatchObject({ skipped: 1 });
    expect(intake.openTicketForBooking).not.toHaveBeenCalled();
  });

  it('sends a completion with the deposit, and clears the ticket on a void', async () => {
    const done = setup({ due: [row('status', 'completed')] });
    await done.handler.run();
    expect(done.intake.updateBookingStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'COMPLETED',
        deposit_available_minor: 5000,
        deposit_vat_minor: 238,
        actor_user_id: STAFF,
      }),
    );
    expect(done.rows.clearTicket).not.toHaveBeenCalled();

    const voided = setup({ due: [row('status', 'cancelled')] });
    await voided.handler.run();
    expect(voided.rows.clearTicket).toHaveBeenCalledWith(BOOKING, TICKET);
  });

  it('retries with backoff when the platform is unreachable', async () => {
    const { handler, rows } = setup({
      due: [row('open', 'checked_in')],
      open: () =>
        Promise.reject(new PosIntakeFailure('UNAVAILABLE', null, 'down')),
    });
    const before = Date.now();
    expect(await handler.run()).toMatchObject({ retried: 1 });
    const at = rows.markRetry.mock.calls[0]![3];
    expect(at.getTime() - before).toBeGreaterThanOrEqual(10_000);
    expect(rows.markParked).not.toHaveBeenCalled();
  });

  it('parks a refusal with the platform code', async () => {
    const { handler, rows } = setup({
      due: [row('open', 'checked_in')],
      open: () =>
        Promise.reject(
          new PosIntakeFailure('FAILED_PRECONDITION', 'POS_LINE_CATALOG', 'no'),
        ),
    });
    expect(await handler.run()).toMatchObject({ parked: 1 });
    expect(rows.markParked).toHaveBeenCalledWith(
      'row-1',
      'POS_LINE_CATALOG',
      'no',
    );
  });

  it('waits for the next trading day when the Z is signed', async () => {
    const { handler, rows } = setup({
      due: [row('open', 'checked_in')],
      open: () =>
        Promise.reject(
          new PosIntakeFailure('FAILED_PRECONDITION', 'POS_Z_IMMUTABLE', 'z'),
        ),
    });
    await handler.run();
    const at = rows.markRetry.mock.calls[0]![3];
    expect(at.getTime()).toBeGreaterThan(Date.now());
    expect(at.getTime() - Date.now()).toBeLessThanOrEqual(25 * 3_600_000);
  });

  it('is done with a void the till has no ticket for', async () => {
    const { handler, rows } = setup({
      due: [row('status', 'check_in_undone')],
      update: () =>
        Promise.reject(
          new PosIntakeFailure(
            'NOT_FOUND',
            'POS_BOOKING_TICKET_NOT_FOUND',
            'none',
          ),
        ),
    });
    expect(await handler.run()).toMatchObject({ skipped: 1 });
    expect(rows.markSkipped).toHaveBeenCalled();
  });
});

describe('PosTicketSyncHandler.sweepUnsettled (the safety net)', () => {
  it('settles a completed visit whose ticket was paid', async () => {
    const { handler, rows, intake, paid } = setup({ due: [] });
    rows.unsettledCompleted.mockResolvedValue([
      { bookingId: BOOKING, tenantId: 't', posTicketId: TICKET },
    ] as never);
    intake.getTicketForBooking.mockResolvedValue({
      found: true,
      ticketId: TICKET,
      number: '#T-42',
      state: 'PAID',
      paidAt: '2026-11-04T11:00:00.000Z',
      cashierId: STAFF,
      totalMinor: 21000,
      depositAppliedMinor: 5000,
      depositAppliedVatMinor: 238,
      documents: [{ type: 'RECEIPT', number: 'R-1' }],
    });
    paid.settle.mockResolvedValue({ code: 'GS-1234' });

    expect(await handler.sweepUnsettled()).toEqual({
      checked: 1,
      settled: 1,
      failed: 0,
    });
    expect(paid.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: BOOKING,
        ticketId: TICKET,
        cashierId: STAFF,
        depositAppliedMinor: 5000,
        depositAppliedVatMinor: 238,
      }),
    );
  });

  it('leaves a ticket that is not paid yet alone', async () => {
    const { handler, rows, intake, paid } = setup({ due: [] });
    rows.unsettledCompleted.mockResolvedValue([
      { bookingId: BOOKING, tenantId: 't', posTicketId: TICKET },
    ] as never);
    intake.getTicketForBooking.mockResolvedValue({
      found: true,
      ticketId: TICKET,
      number: '#T-42',
      state: 'READY',
      paidAt: null,
      cashierId: null,
      totalMinor: 0,
      depositAppliedMinor: 0,
      depositAppliedVatMinor: 0,
      documents: [],
    });
    expect(await handler.sweepUnsettled()).toEqual({
      checked: 1,
      settled: 0,
      failed: 0,
    });
    expect(paid.settle).not.toHaveBeenCalled();
  });
});
