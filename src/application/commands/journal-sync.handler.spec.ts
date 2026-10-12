import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';

import {
  JournalRefused,
  type JournalLedger,
} from '@application/ports/journal-ledger.port';
import type {
  DueLedgerRow,
  JournalSyncRepository,
} from '@infrastructure/persistence/journal-sync.repository';
import type { LedgerRowFacts } from '@domain/journal/journal-entry-plan';
import { JournalSyncHandler } from './journal-sync.handler';

const LEDGER_ID = '0190f0c1-4444-7000-8000-000000000004';
const ENTRY = {
  entry_id: '0190f0c1-6666-7000-8000-000000000006',
  number: 'JE-1041',
};

function due(over: Partial<LedgerRowFacts> = {}, attempts = 0): DueLedgerRow {
  return {
    attempts,
    facts: {
      ledgerId: LEDGER_ID,
      entryType: 'captured',
      amountFils: 10500,
      rail: 'card',
      actorKind: 'system',
      actorId: null,
      entryDate: '2026-10-06',
      tenantId: '0190f0c1-1111-7000-8000-000000000001',
      bookingId: '0190f0c1-2222-7000-8000-000000000002',
      bookingCode: 'GS-1010',
      branchId: '0190f0c1-3333-7000-8000-000000000003',
      breakdown: { netFils: null, taxFils: null, discountFils: null },
      ...over,
    },
  };
}

function harness(opts: {
  due?: DueLedgerRow[];
  create?: () => Promise<unknown>;
}) {
  const rows = {
    claimDue: vi.fn(() => Promise.resolve(opts.due ?? [])),
    markPosted: vi.fn(() => Promise.resolve()),
    markSkipped: vi.fn(() => Promise.resolve()),
    markParked: vi.fn(() => Promise.resolve()),
    markRetry: vi.fn(() => Promise.resolve()),
  };
  const ledger = {
    createJournalEntry: vi.fn(
      opts.create ?? (() => Promise.resolve({ entry: ENTRY, replayed: false })),
    ),
  };
  const handler = new JournalSyncHandler(
    rows as unknown as JournalSyncRepository,
    ledger as unknown as JournalLedger,
  );
  return { handler, rows, ledger };
}

const saved = { ...process.env };
let logError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  process.env.JOURNAL_POSTING_ENABLED = 'true';
  delete process.env.JOURNAL_POSTING_TENANTS;
  logError = vi
    .spyOn(Logger.prototype, 'error')
    .mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});

describe('JournalSyncHandler: the switches', () => {
  it('sends nothing and touches nothing while sending is off', async () => {
    process.env.JOURNAL_POSTING_ENABLED = 'false';
    const { handler, rows, ledger } = harness({ due: [due()] });

    const report = await handler.run();

    expect(rows.claimDue).not.toHaveBeenCalled();
    expect(ledger.createJournalEntry).not.toHaveBeenCalled();
    expect(report).toMatchObject({ sendingEnabled: false, posted: 0 });
  });

  it('claims only the allow-listed tenants', async () => {
    process.env.JOURNAL_POSTING_TENANTS = 't-1, t-2';
    const { handler, rows } = harness({});

    await handler.run();

    expect(rows.claimDue.mock.calls[0]).toEqual([
      expect.any(Number),
      ['t-1', 't-2'],
      expect.any(Number),
    ]);
  });
});

describe('JournalSyncHandler: before sending', () => {
  it('builds the entry from the row and sends it under the row key', async () => {
    const { handler, ledger } = harness({ due: [due()] });

    await handler.run();

    expect(ledger.createJournalEntry).toHaveBeenCalledTimes(1);
    expect(ledger.createJournalEntry.mock.calls[0]).toEqual([
      expect.objectContaining({
        idempotency_key: `deposit-ledger:${LEDGER_ID}`,
        entry_date: '2026-10-06',
        lines: [
          expect.objectContaining({
            side: 'DEBIT',
            system_key: 'UNDEPOSITED_FUNDS',
            amount_minor: 10500,
          }),
          expect.objectContaining({
            side: 'CREDIT',
            system_key: 'CUSTOMER_DEPOSITS',
            amount_minor: 10500,
          }),
        ],
      }),
    ]);
  });

  it('marks a deposit used at the till skipped, without sending it', async () => {
    const { handler, rows, ledger } = harness({
      due: [
        due({
          entryType: 'applied_at_pos',
          amountFils: -2000,
          rail: 'internal',
        }),
      ],
    });

    expect((await handler.run()).skipped).toBe(1);
    expect(rows.markSkipped).toHaveBeenCalledWith(LEDGER_ID);
    expect(ledger.createJournalEntry).not.toHaveBeenCalled();
  });

  it('parks a row nobody has mapped, without sending it, and alerts', async () => {
    const { handler, rows, ledger } = harness({
      due: [due({ rail: null })],
    });

    expect((await handler.run()).unmapped).toBe(1);
    expect(rows.markParked).toHaveBeenCalledWith(
      LEDGER_ID,
      'NO_MAPPING',
      expect.any(String),
      false,
    );
    expect(ledger.createJournalEntry).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalled();
  });
});

describe('JournalSyncHandler: what an answer means', () => {
  it('stores the entry id the platform handed back', async () => {
    const { handler, rows } = harness({ due: [due()] });

    expect((await handler.run()).posted).toBe(1);
    expect(rows.markPosted).toHaveBeenCalledWith(LEDGER_ID, ENTRY.entry_id);
  });

  it('a replay is an ordinary success: an earlier attempt landed', async () => {
    const { handler, rows } = harness({
      due: [due({}, 3)],
      create: () => Promise.resolve({ entry: ENTRY, replayed: true }),
    });

    expect((await handler.run()).posted).toBe(1);
    expect(rows.markRetry).not.toHaveBeenCalled();
  });

  it('a refusal parks the row with the platform code, and alerts', async () => {
    const { handler, rows } = harness({
      due: [due()],
      create: () =>
        Promise.reject(
          new JournalRefused(
            'NOT_FOUND',
            'ACCOUNT_NOT_FOUND',
            'NOT_FOUND: ACCOUNT_NOT_FOUND: no CUSTOMER_DEPOSITS',
          ),
        ),
    });

    expect((await handler.run()).refused).toBe(1);
    expect(rows.markParked).toHaveBeenCalledWith(
      LEDGER_ID,
      'ACCOUNT_NOT_FOUND',
      expect.stringContaining('CUSTOMER_DEPOSITS'),
      true,
    );
    expect(rows.markRetry).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalled();
  });

  it('no verdict stays pending and comes back after the backoff', async () => {
    const { handler, rows } = harness({
      due: [due({}, 2)],
      create: () =>
        Promise.reject(
          Object.assign(new Error('14 UNAVAILABLE: no connection'), {
            code: 14,
          }),
        ),
    });
    const before = Date.now();

    expect((await handler.run()).retried).toBe(1);
    expect(rows.markParked).not.toHaveBeenCalled();
    const [id, message, next] = rows.markRetry.mock.calls[0] as unknown as [
      string,
      string,
      Date,
    ];
    expect(id).toBe(LEDGER_ID);
    expect(message).toContain('UNAVAILABLE');
    // The third failure waits 40s.
    expect(next.getTime() - before).toBeGreaterThanOrEqual(40_000);
    expect(next.getTime() - before).toBeLessThan(41_000);
  });

  it('an answer without an entry is not a posting: send it again', async () => {
    const { handler, rows } = harness({
      due: [due()],
      create: () => Promise.resolve({ entry: null, replayed: false }),
    });

    expect((await handler.run()).retried).toBe(1);
    expect(rows.markPosted).not.toHaveBeenCalled();
  });

  it('one failing row does not stop the rest of the batch', async () => {
    let n = 0;
    const { handler } = harness({
      due: [due(), due({ ledgerId: '0190f0c1-4444-7000-8000-000000000009' })],
      create: () => {
        n += 1;
        return n === 1
          ? Promise.reject(new Error('DEADLINE_EXCEEDED'))
          : Promise.resolve({ entry: ENTRY, replayed: false });
      },
    });

    expect(await handler.run()).toMatchObject({ retried: 1, posted: 1 });
  });
});
