import { describe, it, expect } from 'vitest';
import {
  journalKey,
  planJournalEntry,
  vatShare,
  type JournalEntryRequest,
  type LedgerEntryType,
  type LedgerRail,
  type LedgerRowFacts,
} from './journal-entry-plan';

const TENANT = '0190f0c1-1111-7000-8000-000000000001';
const BOOKING = '0190f0c1-2222-7000-8000-000000000002';
const BRANCH = '0190f0c1-3333-7000-8000-000000000003';
const LEDGER = '0190f0c1-4444-7000-8000-000000000004';
const STAFF = '0190f0c1-5555-7000-8000-000000000005';

const NO_VAT = { netFils: null, taxFils: null, discountFils: null };
// AED 100.00 net + AED 5.00 VAT = AED 105.00.
const FIVE_PERCENT = { netFils: 10000, taxFils: 500, discountFils: 0 };

function row(over: Partial<LedgerRowFacts> = {}): LedgerRowFacts {
  return {
    ledgerId: LEDGER,
    entryType: 'captured',
    amountFils: 10500,
    rail: 'card',
    actorKind: 'system',
    actorId: null,
    entryDate: '2026-10-06',
    tenantId: TENANT,
    bookingId: BOOKING,
    bookingCode: 'GS-1010',
    branchId: BRANCH,
    breakdown: NO_VAT,
    ...over,
  };
}

function posted(over: Partial<LedgerRowFacts> = {}): JournalEntryRequest {
  const plan = planJournalEntry(row(over));
  if (plan.kind !== 'post') {
    throw new Error(`expected a posting, got ${plan.kind}`);
  }
  return plan.request;
}

/** [side, key, amount] per line, which is what the platform compares. */
function legs(r: JournalEntryRequest): [string, string, number][] {
  return r.lines.map((l) => [l.side, l.system_key, l.amount_minor]);
}

function totals(r: JournalEntryRequest): { debit: number; credit: number } {
  let debit = 0;
  let credit = 0;
  for (const l of r.lines) {
    if (l.side === 'DEBIT') debit += l.amount_minor;
    else credit += l.amount_minor;
  }
  return { debit, credit };
}

describe('the request around the lines', () => {
  it('keys the posting by the ledger row, never by the attempt', () => {
    const r = posted();
    expect(r.idempotency_key).toBe(`deposit-ledger:${LEDGER}`);
    expect(r.tenant_id).toBe(TENANT);
    expect(r.source_id).toBe(BOOKING);
    expect(r.entry_date).toBe('2026-10-06');
  });

  it('a correction takes a new key, because a voided key stays used up', () => {
    expect(journalKey(LEDGER)).toBe(`deposit-ledger:${LEDGER}`);
    expect(journalKey(LEDGER, 2)).toBe(`deposit-ledger:${LEDGER}:2`);
  });

  it('writes a memo a bookkeeper can read, naming the booking code', () => {
    expect(posted().memo).toBe('Deposit captured (card), booking GS-1010');
    expect(
      posted({ entryType: 'forfeited', amountFils: -5000, rail: 'internal' })
        .memo,
    ).toBe('Deposit forfeited, booking GS-1010');
  });

  it('stamps the branch on every line, and never a customer', () => {
    for (const l of posted({ breakdown: FIVE_PERCENT }).lines) {
      expect(l.branch_id).toBe(BRANCH);
      expect(l.customer_id).toBe('');
    }
  });

  it('names who posted it only when a staff member did', () => {
    expect(posted({ actorKind: 'staff', actorId: STAFF }).posted_by_id).toBe(
      STAFF,
    );
    expect(posted({ actorKind: 'manager', actorId: STAFF }).posted_by_id).toBe(
      STAFF,
    );
    // A customer id is a consumer id, not a platform user.
    expect(posted({ actorKind: 'customer', actorId: STAFF }).posted_by_id).toBe(
      '',
    );
    expect(posted({ actorKind: 'system', actorId: null }).posted_by_id).toBe(
      '',
    );
  });
});

describe('the side comes from the entry type, never the sign', () => {
  it('a capture debits the money and credits Deposits', () => {
    expect(legs(posted())).toEqual([
      ['DEBIT', 'UNDEPOSITED_FUNDS', 10500],
      ['CREDIT', 'CUSTOMER_DEPOSITS', 10500],
    ]);
  });

  it('a refund is the mirror: Deposits down, the money back out', () => {
    expect(legs(posted({ entryType: 'refunded', amountFils: -4000 }))).toEqual([
      ['DEBIT', 'CUSTOMER_DEPOSITS', 4000],
      ['CREDIT', 'UNDEPOSITED_FUNDS', 4000],
    ]);
  });

  it('a forfeit turns Deposits into fee income', () => {
    expect(
      legs(
        posted({ entryType: 'forfeited', amountFils: -5000, rail: 'internal' }),
      ),
    ).toEqual([
      ['DEBIT', 'CUSTOMER_DEPOSITS', 5000],
      ['CREDIT', 'CANCELLATION_FEE_INCOME', 5000],
    ]);
  });

  it('a revived no-show undoes exactly the account the forfeit credited', () => {
    expect(
      legs(
        posted({ entryType: 'reversed', amountFils: 5000, rail: 'internal' }),
      ),
    ).toEqual([
      ['DEBIT', 'CANCELLATION_FEE_INCOME', 5000],
      ['CREDIT', 'CUSTOMER_DEPOSITS', 5000],
    ]);
  });

  it('goodwill is the salon paying in: an expense, credited to Deposits', () => {
    expect(
      legs(posted({ entryType: 'goodwill', amountFils: 2000, rail: 'wallet' })),
    ).toEqual([
      ['DEBIT', 'CUSTOMER_GOODWILL', 2000],
      ['CREDIT', 'CUSTOMER_DEPOSITS', 2000],
    ]);
  });

  it('a course visit turns prepaid credit into service income', () => {
    expect(
      legs(
        posted({
          entryType: 'course_draw',
          amountFils: -12000,
          rail: 'internal',
        }),
      ),
    ).toEqual([
      ['DEBIT', 'CUSTOMER_DEPOSITS', 12000],
      ['CREDIT', 'SERVICE_INCOME', 12000],
    ]);
  });
});

describe('the money account, by rail', () => {
  it.each<[LedgerRail, string]>([
    ['card', 'UNDEPOSITED_FUNDS'],
    ['apple_pay', 'UNDEPOSITED_FUNDS'],
    ['google_pay', 'UNDEPOSITED_FUNDS'],
    ['link', 'UNDEPOSITED_FUNDS'],
    ['wallet', 'CUSTOMER_WALLET'],
    // Not CASH_ON_HAND: desk cash outside the till would wreck the count.
    ['cash', 'FRONT_DESK_CASH'],
    ['other', 'PAYMENTS_CLEARING'],
    ['internal', 'PAYMENTS_CLEARING'],
  ])('a capture on %s debits %s', (rail, account) => {
    expect(posted({ rail }).lines[0]).toMatchObject({
      side: 'DEBIT',
      system_key: account,
    });
  });

  it('an internal refund went to the wallet, as the cancel path says', () => {
    const r = posted({
      entryType: 'refunded',
      amountFils: -3000,
      rail: 'internal',
    });
    expect(r.lines.at(-1)).toMatchObject({
      side: 'CREDIT',
      system_key: 'CUSTOMER_WALLET',
    });
  });
});

describe('VAT', () => {
  it('splits a capture into the net share and the VAT owed on receipt', () => {
    expect(legs(posted({ breakdown: FIVE_PERCENT }))).toEqual([
      ['DEBIT', 'UNDEPOSITED_FUNDS', 10500],
      ['CREDIT', 'CUSTOMER_DEPOSITS', 10000],
      ['CREDIT', 'SALES_TAX_PAYABLE', 500],
    ]);
    expect(posted({ breakdown: FIVE_PERCENT }).lines[2]?.memo).toBe('VAT');
  });

  it('gives the VAT back on a refund', () => {
    expect(
      legs(
        posted({
          entryType: 'refunded',
          amountFils: -10500,
          breakdown: FIVE_PERCENT,
        }),
      ),
    ).toEqual([
      ['DEBIT', 'CUSTOMER_DEPOSITS', 10000],
      ['DEBIT', 'SALES_TAX_PAYABLE', 500],
      ['CREDIT', 'UNDEPOSITED_FUNDS', 10500],
    ]);
  });

  it('leaves the VAT where it is when a deposit is forfeited', () => {
    // Declared when the money arrived; a forfeit moves only the net share.
    expect(
      legs(
        posted({
          entryType: 'forfeited',
          amountFils: -10500,
          rail: 'internal',
          breakdown: FIVE_PERCENT,
        }),
      ),
    ).toEqual([
      ['DEBIT', 'CUSTOMER_DEPOSITS', 10000],
      ['CREDIT', 'CANCELLATION_FEE_INCOME', 10000],
    ]);
  });

  it('takes the share of a partial payment, rounded once', () => {
    // 50.00 of a 105.00 booking: 4762 net + 238 VAT (4761.9 / 238.09).
    expect(vatShare(5000, FIVE_PERCENT)).toEqual({ net: 4762, vat: 238 });
  });

  it('honours a discount: the share is of what the customer actually owes', () => {
    // 100.00 + 5.00 - 10.00 = 95.00, of which 5.00 is VAT.
    const b = { netFils: 10000, taxFils: 500, discountFils: 1000 };
    expect(vatShare(9500, b)).toEqual({ net: 9000, vat: 500 });
  });

  it('drops a VAT share that rounds to nothing rather than send a zero line', () => {
    const r = posted({ amountFils: 1, breakdown: FIVE_PERCENT });
    expect(legs(r)).toEqual([
      ['DEBIT', 'UNDEPOSITED_FUNDS', 1],
      ['CREDIT', 'CUSTOMER_DEPOSITS', 1],
    ]);
  });

  it('is no VAT at all when the booking carries no tax figure', () => {
    expect(vatShare(10500, NO_VAT)).toEqual({ net: 10500, vat: 0 });
    expect(
      vatShare(10500, { netFils: 10000, taxFils: 0, discountFils: null }),
    ).toEqual({ net: 10500, vat: 0 });
  });

  it('is no VAT when the breakdown makes no sense', () => {
    // A discount that swallows the net leaves tax >= total.
    const b = { netFils: 1000, taxFils: 500, discountFils: 1000 };
    expect(vatShare(500, b)).toEqual({ net: 500, vat: 0 });
  });
});

describe('every posting balances', () => {
  const types: [LedgerEntryType, number][] = [
    ['captured', 1],
    ['refunded', -1],
    ['forfeited', -1],
    ['reversed', 1],
    ['goodwill', 1],
    ['course_draw', -1],
  ];
  const rails: LedgerRail[] = [
    'card',
    'apple_pay',
    'google_pay',
    'link',
    'wallet',
    'cash',
    'internal',
    'other',
  ];
  const amounts = [1, 99, 5000, 10500, 33333, 2_000_000];
  const breakdowns = [
    NO_VAT,
    FIVE_PERCENT,
    { netFils: 33333, taxFils: 1667, discountFils: 777 },
  ];

  it('debits equal credits for every type, rail, amount and VAT', () => {
    for (const [entryType, sign] of types) {
      for (const rail of rails) {
        for (const amount of amounts) {
          for (const breakdown of breakdowns) {
            const r = posted({
              entryType,
              rail,
              amountFils: sign * amount,
              breakdown,
            });
            const { debit, credit } = totals(r);
            expect(debit).toBe(credit);
            expect(r.lines.length).toBeGreaterThanOrEqual(2);
            for (const l of r.lines) expect(l.amount_minor).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('the net and VAT shares always sum back to the whole', () => {
    for (const amount of amounts) {
      const { net, vat } = vatShare(amount, FIVE_PERCENT);
      expect(net + vat).toBe(amount);
    }
  });
});

describe('what is not posted', () => {
  it('skips a deposit applied at the till: the POS tender owns it', () => {
    expect(
      planJournalEntry(
        row({
          entryType: 'applied_at_pos',
          amountFils: -5000,
          rail: 'internal',
        }),
      ).kind,
    ).toBe('skip');
  });

  it('parks a capture or refund with no rail: nobody knows where the money is', () => {
    for (const entryType of ['captured', 'refunded'] as const) {
      const plan = planJournalEntry(
        row({
          entryType,
          amountFils: entryType === 'captured' ? 1 : -1,
          rail: null,
        }),
      );
      expect(plan).toMatchObject({ kind: 'park', code: 'NO_MAPPING' });
    }
  });

  it('parks partially_refunded, which nothing is meant to write', () => {
    expect(
      planJournalEntry(
        row({ entryType: 'partially_refunded', amountFils: -100 }),
      ),
    ).toMatchObject({ kind: 'park', code: 'NO_MAPPING' });
  });

  it('parks a negative reversal: it undoes something nobody mapped', () => {
    expect(
      planJournalEntry(row({ entryType: 'reversed', amountFils: -100 })),
    ).toMatchObject({ kind: 'park', code: 'NO_MAPPING' });
  });

  it('parks a tenant the platform could never accept', () => {
    // booking.tenant_id is TEXT; the platform requires a UUID.
    expect(planJournalEntry(row({ tenantId: 'salon-one' }))).toMatchObject({
      kind: 'park',
      code: 'TENANT_NOT_UUID',
    });
  });
});

describe('vatFils: a split the till decided', () => {
  it('replaces the booking proportion on a refund the till sized', () => {
    // A leftover credited after the till applied part of the deposit: the
    // VAT left on it is whatever the till did not reverse, not 5/105 of it.
    const r = posted({
      entryType: 'refunded',
      amountFils: -2000,
      rail: 'internal',
      breakdown: FIVE_PERCENT,
      vatFils: 95,
    });
    expect(legs(r)).toEqual([
      ['DEBIT', 'CUSTOMER_DEPOSITS', 1905],
      ['DEBIT', 'SALES_TAX_PAYABLE', 95],
      ['CREDIT', 'CUSTOMER_WALLET', 2000],
    ]);
  });

  it('cannot move more VAT than the row moves', () => {
    const r = posted({
      entryType: 'refunded',
      amountFils: -100,
      rail: 'internal',
      breakdown: FIVE_PERCENT,
      vatFils: 999,
    });
    expect(legs(r)).toEqual([
      ['DEBIT', 'SALES_TAX_PAYABLE', 100],
      ['CREDIT', 'CUSTOMER_WALLET', 100],
    ]);
  });

  it('leaves every row without one exactly as before', () => {
    const a = posted({ entryType: 'captured', breakdown: FIVE_PERCENT });
    const b = posted({
      entryType: 'captured',
      breakdown: FIVE_PERCENT,
      vatFils: null,
    });
    expect(b).toEqual(a);
  });
});
