import { describe, it, expect } from 'vitest';
import { depositPosition, type DepositRow } from './deposit-position';
import {
  planJournalEntry,
  type LedgerEntryType,
  type LedgerRail,
  type LedgerRowFacts,
} from './journal-entry-plan';
import { Account } from './accounts';

const TENANT = '0190f0c1-1111-7000-8000-000000000001';
const NO_VAT = { netFils: null, taxFils: null, discountFils: null };
// AED 200.00 net + AED 10.00 VAT = AED 210.00 (the plan's worked example).
const FIVE_PERCENT = { netFils: 20000, taxFils: 1000, discountFils: 0 };
// A ratio that does not divide evenly, so rounding has something to do.
const AWKWARD = { netFils: 33333, taxFils: 1667, discountFils: 0 };

const RAIL: Partial<Record<LedgerEntryType, LedgerRail>> = {
  captured: 'card',
  refunded: 'internal',
};

/**
 * How far a set of rows moved CUSTOMER_DEPOSITS, as the journal posts them.
 * Credits raise the liability, debits lower it.
 */
function depositsMovement(
  rows: readonly DepositRow[],
  breakdown: LedgerRowFacts['breakdown'],
): number {
  let net = 0;
  rows.forEach((r, i) => {
    const plan = planJournalEntry({
      ledgerId: `0190f0c1-4444-7000-8000-${String(i).padStart(12, '0')}`,
      entryType: r.entryType,
      amountFils: r.amountFils,
      rail: RAIL[r.entryType] ?? null,
      actorKind: 'system',
      actorId: null,
      entryDate: '2026-11-04',
      tenantId: TENANT,
      bookingId: '0190f0c1-2222-7000-8000-000000000002',
      bookingCode: 'GS-1',
      branchId: '0190f0c1-3333-7000-8000-000000000003',
      breakdown,
      vatFils: r.vatFils ?? null,
    });
    if (plan.kind !== 'post') return;
    for (const l of plan.request.lines) {
      if (l.system_key !== Account.CUSTOMER_DEPOSITS) continue;
      net += l.side === 'CREDIT' ? l.amount_minor : -l.amount_minor;
    }
  });
  return net;
}

describe('depositPosition', () => {
  it('is empty for a booking that never took a deposit', () => {
    expect(depositPosition([], FIVE_PERCENT)).toEqual({
      balanceFils: 0,
      vatFils: 0,
    });
  });

  it('splits one card capture exactly as the journal posted it', () => {
    // 5000 x 1000/21000 = 238.1 -> 238, the plan's §4.2 figure.
    const rows: DepositRow[] = [{ entryType: 'captured', amountFils: 5000 }];
    expect(depositPosition(rows, FIVE_PERCENT)).toEqual({
      balanceFils: 5000,
      vatFils: 238,
    });
  });

  it('carries no VAT for a booking stored without a tax figure', () => {
    const rows: DepositRow[] = [{ entryType: 'captured', amountFils: 5000 }];
    expect(depositPosition(rows, NO_VAT)).toEqual({
      balanceFils: 5000,
      vatFils: 0,
    });
  });

  it('removes the VAT share of a forfeit, which was consumed as income', () => {
    const rows: DepositRow[] = [
      { entryType: 'captured', amountFils: 10500 },
      { entryType: 'forfeited', amountFils: -5250 },
    ];
    const p = depositPosition(rows, FIVE_PERCENT);
    expect(p.balanceFils).toBe(5250);
    expect(p.vatFils).toBe(500 - 250);
  });

  it('honours a row the till split itself', () => {
    const rows: DepositRow[] = [
      { entryType: 'captured', amountFils: 5000 },
      { entryType: 'applied_at_pos', amountFils: -3000, vatFils: 143 },
    ];
    expect(depositPosition(rows, FIVE_PERCENT)).toEqual({
      balanceFils: 2000,
      vatFils: 238 - 143,
    });
  });

  it('never reports VAT on a balance that is gone', () => {
    const rows: DepositRow[] = [
      { entryType: 'captured', amountFils: 5000 },
      { entryType: 'refunded', amountFils: -5000 },
    ];
    expect(depositPosition(rows, FIVE_PERCENT)).toEqual({
      balanceFils: 0,
      vatFils: 0,
    });
  });

  /**
   * THE RECONCILIATION THE TILL DEPENDS ON. Whatever the history, the VAT
   * the till is told to reverse is the balance minus what the journal put
   * into CUSTOMER_DEPOSITS -- so applying the whole balance with that VAT
   * empties CUSTOMER_DEPOSITS for the booking, to the fil.
   */
  it.each([
    ['one capture', FIVE_PERCENT, [['captured', 5000]]],
    [
      'two captures, a partial refund and goodwill',
      AWKWARD,
      [
        ['captured', 3333],
        ['captured', 7777],
        ['refunded', -1111],
        ['goodwill', 999],
      ],
    ],
    [
      'a forfeit revived',
      AWKWARD,
      [
        ['captured', 9999],
        ['forfeited', -9999],
        ['reversed', 9999],
      ],
    ],
    [
      'a course draw',
      FIVE_PERCENT,
      [
        ['captured', 21000],
        ['course_draw', -10500],
      ],
    ],
  ] as const)('balance - VAT = CUSTOMER_DEPOSITS after %s', (_n, b, list) => {
    const rows: DepositRow[] = list.map(([entryType, amountFils]) => ({
      entryType,
      amountFils,
    }));
    const p = depositPosition(rows, b);
    expect(p.balanceFils - p.vatFils).toBe(depositsMovement(rows, b));
  });
});
