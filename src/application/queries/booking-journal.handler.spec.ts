import { describe, expect, it, vi } from 'vitest';

import type { JournalLedger } from '@application/ports/journal-ledger.port';
import { BookingError } from '@application/contract/errors';
import type {
  BookingLedgerSync,
  JournalSyncRepository,
  LedgerSyncRow,
} from '@infrastructure/persistence/journal-sync.repository';
import { BookingJournalHandler } from './booking-journal.handler';

const TENANT = '0190f0c1-1111-7000-8000-000000000001';
const BOOKING = '0190f0c1-2222-7000-8000-000000000002';

function row(over: Partial<LedgerSyncRow> = {}): LedgerSyncRow {
  return {
    ledgerEntryId: '0190f0c1-4444-7000-8000-000000000004',
    entryType: 'captured',
    amountFils: 10500,
    rail: 'card',
    recordedAt: new Date('2026-10-06T08:00:00Z'),
    status: 'pending',
    entryId: null,
    attempts: 0,
    nextAttemptAt: new Date('2026-10-06T08:00:00Z'),
    error: null,
    errorCode: null,
    facts: {
      ledgerId: '0190f0c1-4444-7000-8000-000000000004',
      entryType: 'captured',
      amountFils: 10500,
      rail: 'card',
      actorKind: 'system',
      actorId: null,
      entryDate: '2026-10-06',
      tenantId: TENANT,
      bookingId: BOOKING,
      bookingCode: 'GS-1010',
      branchId: '0190f0c1-3333-7000-8000-000000000003',
      breakdown: { netFils: 10000, taxFils: 500, discountFils: 0 },
    },
    ...over,
  };
}

const ENTRY = {
  entry_id: '0190f0c1-6666-7000-8000-000000000006',
  number: 'JE-1041',
  entry_date: '2026-10-06',
  status: 'POSTED',
  source: 'BOOKING',
  source_id: BOOKING,
  memo: 'Deposit captured (card), booking GS-1010',
  total_minor: 10500,
  posted_at: '2026-10-06T08:00:01Z',
  reversal_of_id: '',
  created_at: '2026-10-06T08:00:01Z',
  lines: [
    {
      account_code: '1050',
      account_name: 'Undeposited Funds',
      side: 'DEBIT',
      amount_minor: 10500,
      memo: '',
    },
  ],
};

function harness(
  booking: BookingLedgerSync | null,
  list: () => Promise<unknown> = () =>
    Promise.resolve({ entries: [ENTRY], total: 1, offset: 0, limit: 200 }),
) {
  const rows = { forBooking: vi.fn(() => Promise.resolve(booking)) };
  const ledger = { listJournalEntries: vi.fn(list) };
  const handler = new BookingJournalHandler(
    rows as unknown as JournalSyncRepository,
    ledger as unknown as JournalLedger,
  );
  return { handler, ledger };
}

describe('BookingJournalHandler', () => {
  it('is a 404 for a booking that does not exist', async () => {
    const { handler } = harness(null);
    await expect(handler.execute(BOOKING)).rejects.toBeInstanceOf(BookingError);
  });

  it('shows what a pending movement will post, and asks the platform for nothing', async () => {
    const { handler, ledger } = harness({ tenantId: TENANT, rows: [row()] });

    const view = await handler.execute(BOOKING);

    expect(ledger.listJournalEntries).not.toHaveBeenCalled();
    expect(view.entries).toEqual([]);
    expect(view.movements[0]?.journal.status).toBe('pending');
    expect(view.movements[0]?.plan).toEqual({
      kind: 'post',
      entryDate: '2026-10-06',
      memo: 'Deposit captured (card), booking GS-1010',
      lines: [
        { account: 'UNDEPOSITED_FUNDS', side: 'DEBIT', amountMinor: 10500 },
        { account: 'CUSTOMER_DEPOSITS', side: 'CREDIT', amountMinor: 10000 },
        { account: 'SALES_TAX_PAYABLE', side: 'CREDIT', amountMinor: 500 },
      ],
    });
  });

  it('reads posted entries from the platform, which owns the books', async () => {
    const { handler, ledger } = harness({
      tenantId: TENANT,
      rows: [
        row({ status: 'posted', entryId: ENTRY.entry_id, nextAttemptAt: null }),
      ],
    });

    const view = await handler.execute(BOOKING);

    expect(ledger.listJournalEntries).toHaveBeenCalledWith({
      tenant_id: TENANT,
      source: 'BOOKING',
      source_id: BOOKING,
      limit: 200,
    });
    expect(view.movements[0]?.plan).toBeNull();
    expect(view.entries).toEqual([
      {
        entryId: ENTRY.entry_id,
        number: 'JE-1041',
        entryDate: '2026-10-06',
        status: 'POSTED',
        memo: ENTRY.memo,
        totalMinor: 10500,
        reversalOfId: null,
        lines: [
          {
            accountCode: '1050',
            accountName: 'Undeposited Funds',
            side: 'DEBIT',
            amountMinor: 10500,
            memo: '',
          },
        ],
      },
    ]);
  });

  it('a platform it cannot reach is a 503, never an empty journal', async () => {
    const { handler } = harness(
      {
        tenantId: TENANT,
        rows: [row({ status: 'posted', entryId: ENTRY.entry_id })],
      },
      () => Promise.reject(new Error('14 UNAVAILABLE')),
    );

    const err = await handler.execute(BOOKING).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BookingError);
    expect((err as BookingError).code).toBe('DEPENDENCY_UNAVAILABLE');
  });

  it('says a movement waits for its tenant, and a pre-cutover one was never sent', async () => {
    const { handler } = harness({
      tenantId: null,
      rows: [
        row({ facts: null }),
        row({ status: null, nextAttemptAt: null, facts: null }),
      ],
    });

    const view = await handler.execute(BOOKING);

    expect(view.movements[0]?.plan).toMatchObject({ kind: 'waiting' });
    expect(view.movements[1]?.journal.status).toBe('before_cutover');
    expect(view.movements[1]?.plan).toBeNull();
  });
});
