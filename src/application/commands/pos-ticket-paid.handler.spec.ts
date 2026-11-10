import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import {
  PosTicketPaidHandler,
  type PosTicketPaid,
} from './pos-ticket-paid.handler';
import { isBookingError } from '@application/contract/errors';

const PAID: PosTicketPaid = {
  tenantId: '0190f0c1-1111-7000-8000-000000000001',
  bookingId: '0190f0c1-2222-7000-8000-000000000002',
  ticketId: '0190f0c1-0000-7000-8000-0000000000aa',
  ticketNumber: '#T-42',
  paidAt: '2026-11-04T11:00:00.000Z',
  cashierId: '0190f0c1-0000-7000-8000-0000000000cc',
  totalMinor: 21000,
  depositAppliedMinor: 5000,
  depositAppliedVatMinor: 238,
  documents: [
    { type: 'RECEIPT', number: 'R-118' },
    { type: 'INVOICE', number: 'INV-2026-0042' },
  ],
};

function setup(outcome: unknown) {
  const lifecycle = { settleFromPos: vi.fn(() => Promise.resolve(outcome)) };
  return {
    handler: new PosTicketPaidHandler(lifecycle as never),
    lifecycle,
  };
}

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return isBookingError(e) ? `${e.status} ${e.code}` : String(e);
  }
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('PosTicketPaidHandler', () => {
  it('settles with the cashier and records the documents in history', async () => {
    const { handler, lifecycle } = setup({
      kind: 'settled',
      code: 'GS-1234',
      alreadySettled: false,
    });
    expect(await handler.settle(PAID)).toEqual({
      bookingId: PAID.bookingId,
      code: 'GS-1234',
      status: 'settled',
      alreadySettled: false,
    });
    expect(lifecycle.settleFromPos).toHaveBeenCalledWith({
      tenantId: PAID.tenantId,
      bookingId: PAID.bookingId,
      ticketId: PAID.ticketId,
      ticketNumber: '#T-42',
      cashierId: PAID.cashierId,
      depositAppliedFils: 5000,
      depositAppliedVatFils: 238,
      historyMetadata: {
        pos: {
          ticketId: PAID.ticketId,
          ticketNumber: '#T-42',
          paidAt: PAID.paidAt,
          totalMinor: 21000,
          depositAppliedMinor: 5000,
          depositAppliedVatMinor: 238,
          documents: PAID.documents,
        },
      },
    });
  });

  it('answers a replay of the same ticket as already settled, not an error', async () => {
    const { handler } = setup({
      kind: 'settled',
      code: 'GS-1234',
      alreadySettled: true,
    });
    expect((await handler.settle(PAID)).alreadySettled).toBe(true);
  });

  it.each([
    [{ kind: 'not_found' }, '404 BOOKING_NOT_FOUND'],
    [{ kind: 'settled_by_other', code: 'GS-1' }, '409 ALREADY_SETTLED'],
    [
      { kind: 'not_completed', status: 'in_service' },
      '409 BOOKING_STATE_INVALID',
    ],
    [
      { kind: 'refused', code: 'DEPOSIT_EXCEEDS_BALANCE', reason: 'too much' },
      '409 BOOKING_STATE_INVALID',
    ],
    [{ kind: 'forbidden', message: 'no' }, '409 BOOKING_STATE_INVALID'],
  ])('maps %o to %s', async (outcome, expected) => {
    const { handler } = setup(outcome);
    expect(await codeOf(handler.settle(PAID))).toBe(expected);
  });

  it('refuses a malformed booking id before touching the database', async () => {
    const { handler, lifecycle } = setup({ kind: 'not_found' });
    expect(await codeOf(handler.settle({ ...PAID, bookingId: 'GS-1' }))).toBe(
      '404 BOOKING_NOT_FOUND',
    );
    expect(lifecycle.settleFromPos).not.toHaveBeenCalled();
  });
});
