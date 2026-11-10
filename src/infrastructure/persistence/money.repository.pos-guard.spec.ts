import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { MoneyRepository } from './money.repository';

const BOOKING = '11111111-1111-4111-8111-111111111111';

/** The booking row act() locks, and a ledger that answers balance reads. */
function setup(status: string, posTicketNumber: string | null) {
  const tx = {
    $queryRaw: vi.fn((strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('FOR UPDATE')) {
        return Promise.resolve([
          {
            id: BOOKING,
            code: 'GS-1234',
            status,
            payment_status: 'deposit_paid',
            price_fils: 20000,
            deposit_fils: 5000,
            pos_ticket_number: posTicketNumber,
          },
        ]);
      }
      // balanceOf / forfeitedOf
      return Promise.resolve([
        { balance: 5000n, fils: 0n, entry_id: null, goodwill: 0n },
      ]);
    }),
    depositLedger: {
      findFirst: vi.fn(() => Promise.resolve(null)),
      create: vi.fn(() => Promise.resolve({ id: 'entry-1' })),
    },
    $executeRawUnsafe: vi.fn(() => Promise.resolve(1)),
    bookingStatusHistory: { create: vi.fn(() => Promise.resolve({})) },
  };
  const prisma = {
    $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { repo: new MoneyRepository(prisma as never), tx };
}

const refund = (repo: MoneyRepository) =>
  repo.refund({
    bookingId: BOOKING,
    actor: 'manager',
    actorId: '22222222-2222-4222-8222-222222222222',
    reason: 'Customer asked',
    idempotencyKey: 'k-1',
    mode: 'DEPOSIT',
    rail: 'card',
  });

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('a deposit held by a live POS ticket (B8)', () => {
  it('refuses a refund on a completed visit the till has not settled', async () => {
    const { repo, tx } = setup('completed', '#T-42');
    expect(await refund(repo)).toEqual({
      kind: 'held_by_pos',
      ticketNumber: '#T-42',
    });
    expect(tx.depositLedger.create).not.toHaveBeenCalled();
  });

  it('refuses goodwill the same way', async () => {
    const { repo, tx } = setup('checked_in', '#T-42');
    const out = await repo.goodwill({
      bookingId: BOOKING,
      actor: 'manager',
      actorId: '22222222-2222-4222-8222-222222222222',
      reason: 'Sorry',
      idempotencyKey: 'k-2',
      amountFils: 1000,
    });
    expect(out.kind).toBe('held_by_pos');
    expect(tx.depositLedger.create).not.toHaveBeenCalled();
  });

  it('lets a settled booking be refunded as before', async () => {
    const { repo } = setup('settled', '#T-42');
    expect((await refund(repo)).kind).not.toBe('held_by_pos');
  });

  it('lets a booking with no ticket through as before', async () => {
    const { repo } = setup('completed', null);
    expect((await refund(repo)).kind).not.toBe('held_by_pos');
  });
});
