import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { LifecycleRepository } from './lifecycle.repository';

const BOOKING = '0190f0c1-2222-7000-8000-000000000002';
const TENANT = '0190f0c1-1111-7000-8000-000000000001';
const TICKET = '0190f0c1-0000-7000-8000-0000000000aa';
const CASHIER = '0190f0c1-0000-7000-8000-0000000000cc';

interface World {
  status: string;
  tenantId: string | null;
  posTicketId: string | null;
  /** deposit_ledger rows already on the booking. */
  ledger: { entryType: string; amountFils: number; vatFils: number | null }[];
  appliedForTicket?: boolean;
}

/**
 * A transaction over one booking: the POS lock, the transition's own lock,
 * and recorders for every write.
 */
function setup(w: World) {
  const tx = {
    $queryRaw: vi.fn((strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('pos_ticket_id')) {
        return Promise.resolve([
          {
            id: BOOKING,
            code: 'GS-1234',
            status: w.status,
            tenant_id: w.tenantId,
            pos_ticket_id: w.posTicketId,
            // AED 200 net + AED 10 VAT: the plan's worked example.
            net_fils: 20000,
            tax_fils: 1000,
            discount_fils: 0,
          },
        ]);
      }
      return Promise.resolve([
        {
          id: BOOKING,
          code: 'GS-1234',
          status: w.status,
          start_at: new Date('2026-11-04T10:00:00Z'),
          branch_id: '0190f0c1-3333-7000-8000-000000000003',
          trading_day: new Date('2026-11-04T00:00:00Z'),
          start_minute: 840,
          duration_min: 45,
        },
      ]);
    }),
    depositLedger: {
      findFirst: vi.fn(() =>
        Promise.resolve(w.appliedForTicket === true ? { id: 'x' } : null),
      ),
      findMany: vi.fn(() => Promise.resolve(w.ledger)),
      create: vi.fn((_a: { data: Record<string, unknown> }) =>
        Promise.resolve({}),
      ),
    },
    booking: { update: vi.fn((_a: unknown) => Promise.resolve({})) },
    bookingItem: { findMany: vi.fn(() => Promise.resolve([])) },
    staffReservation: { updateMany: vi.fn() },
    resourceReservation: { updateMany: vi.fn() },
    bookingStatusHistory: {
      create: vi.fn((_a: { data: Record<string, unknown> }) =>
        Promise.resolve({}),
      ),
    },
    eventOutbox: {
      create: vi.fn((_a: { data: Record<string, unknown> }) =>
        Promise.resolve({}),
      ),
    },
  };
  const prisma = {
    $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { repo: new LifecycleRepository(prisma as never), tx };
}

const settle = (
  repo: LifecycleRepository,
  applied: number,
  appliedVat: number,
) =>
  repo.settleFromPos({
    tenantId: TENANT,
    bookingId: BOOKING,
    ticketId: TICKET,
    ticketNumber: '#T-42',
    cashierId: CASHIER,
    depositAppliedFils: applied,
    depositAppliedVatFils: appliedVat,
    historyMetadata: {
      pos: { documents: [{ type: 'RECEIPT', number: 'R-1' }] },
    },
  });

const CAPTURED_50 = [
  { entryType: 'captured', amountFils: 5000, vatFils: null },
];

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('settleFromPos: the till took the balance', () => {
  it('draws the whole deposit down with the VAT the till reversed', async () => {
    const { repo, tx } = setup({
      status: 'completed',
      tenantId: TENANT,
      posTicketId: TICKET,
      ledger: CAPTURED_50,
    });
    expect(await settle(repo, 5000, 238)).toEqual({
      kind: 'settled',
      code: 'GS-1234',
      alreadySettled: false,
    });

    const rows = tx.depositLedger.create.mock.calls.map((c) => c[0].data);
    expect(rows).toEqual([
      expect.objectContaining({
        entryType: 'applied_at_pos',
        amountFils: -5000,
        vatFils: 238,
        rail: 'internal',
        posTransactionId: TICKET,
        actorKind: 'staff',
        actorId: CASHIER,
      }),
    ]);
    expect(tx.booking.update).toHaveBeenCalledWith({
      where: { id: BOOKING },
      data: {
        status: 'settled',
        posTicketId: TICKET,
        posTicketNumber: '#T-42',
      },
    });
    expect(tx.bookingStatusHistory.create.mock.calls[0]![0].data).toMatchObject(
      {
        fromStatus: 'completed',
        toStatus: 'settled',
        actorKind: 'staff',
        actorId: CASHIER,
        metadata: { pos: { documents: [{ type: 'RECEIPT', number: 'R-1' }] } },
      },
    );
    expect(tx.eventOutbox.create.mock.calls[0]![0].data).toMatchObject({
      eventType: 'booking.settled',
    });
  });

  it('credits the leftover with exactly the deposit VAT the till left', async () => {
    const { repo, tx } = setup({
      status: 'completed',
      tenantId: TENANT,
      posTicketId: TICKET,
      ledger: CAPTURED_50,
    });
    await settle(repo, 3000, 143);
    const rows = tx.depositLedger.create.mock.calls.map((c) => c[0].data);
    expect(rows).toEqual([
      expect.objectContaining({
        entryType: 'applied_at_pos',
        amountFils: -3000,
        vatFils: 143,
      }),
      expect.objectContaining({
        entryType: 'refunded',
        amountFils: -2000,
        // 238 declared at capture - 143 reversed by the till.
        vatFils: 95,
        rail: 'internal',
        posTransactionId: TICKET,
      }),
    ]);
  });

  it('answers a replay of the same ticket without writing', async () => {
    const { repo, tx } = setup({
      status: 'settled',
      tenantId: TENANT,
      posTicketId: TICKET,
      ledger: [],
    });
    expect(await settle(repo, 5000, 238)).toEqual({
      kind: 'settled',
      code: 'GS-1234',
      alreadySettled: true,
    });
    expect(tx.depositLedger.create).not.toHaveBeenCalled();
    expect(tx.booking.update).not.toHaveBeenCalled();
  });

  it('calls it a conflict when another ticket settled the booking', async () => {
    const { repo, tx } = setup({
      status: 'settled',
      tenantId: TENANT,
      posTicketId: '0190f0c1-0000-7000-8000-0000000000bb',
      ledger: [],
    });
    expect((await settle(repo, 5000, 238)).kind).toBe('settled_by_other');
    expect(tx.depositLedger.create).not.toHaveBeenCalled();
  });

  it('refuses a booking that is not completed', async () => {
    const { repo, tx } = setup({
      status: 'in_service',
      tenantId: TENANT,
      posTicketId: TICKET,
      ledger: CAPTURED_50,
    });
    expect(await settle(repo, 5000, 238)).toEqual({
      kind: 'not_completed',
      status: 'in_service',
    });
    expect(tx.depositLedger.create).not.toHaveBeenCalled();
  });

  it('treats another tenant’s booking as no booking', async () => {
    const { repo } = setup({
      status: 'completed',
      tenantId: 'someone-else',
      posTicketId: TICKET,
      ledger: CAPTURED_50,
    });
    expect((await settle(repo, 5000, 238)).kind).toBe('not_found');
  });

  it('refuses a draw-down larger than the deposit held', async () => {
    const { repo, tx } = setup({
      status: 'completed',
      tenantId: TENANT,
      posTicketId: TICKET,
      ledger: CAPTURED_50,
    });
    expect((await settle(repo, 6000, 286)).kind).toBe('refused');
    expect(tx.depositLedger.create).not.toHaveBeenCalled();
  });
});
