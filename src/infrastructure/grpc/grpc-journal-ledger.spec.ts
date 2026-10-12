import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import { Metadata, status } from '@grpc/grpc-js';
import { of, throwError, type Observable } from 'rxjs';

import { JournalRefused } from '@application/ports/journal-ledger.port';
import type { JournalEntryRequest } from '@domain/journal/journal-entry-plan';
import { GrpcJournalLedger, journalErrorCode } from './grpc-journal-ledger';

/**
 * ADAPTER SPEC — what goes on the wire, and which failures are a refusal
 * (park it, a person must look) versus no verdict (send it again later).
 */

const TENANT = '11111111-1111-4111-8111-111111111111';

const REQUEST: JournalEntryRequest = {
  tenant_id: TENANT,
  idempotency_key: 'deposit-ledger:abc',
  entry_date: '2026-10-06',
  source_id: '22222222-2222-4222-8222-222222222222',
  memo: 'Deposit captured (card), booking GS-1010',
  posted_by_id: '',
  lines: [
    {
      system_key: 'UNDEPOSITED_FUNDS',
      side: 'DEBIT',
      amount_minor: 10500,
      memo: '',
      branch_id: '33333333-3333-4333-8333-333333333333',
      customer_id: '',
    },
    {
      system_key: 'CUSTOMER_DEPOSITS',
      side: 'CREDIT',
      amount_minor: 10500,
      memo: '',
      branch_id: '33333333-3333-4333-8333-333333333333',
      customer_id: '',
    },
  ],
};

const ENTRY = {
  entry_id: '44444444-4444-4444-8444-444444444444',
  number: 'JE-1041',
  status: 'POSTED',
};

function grpc(code: number, errorCode?: string) {
  const metadata = new Metadata();
  if (errorCode !== undefined) metadata.set('error-code', errorCode);
  return Object.assign(new Error('wire'), {
    code,
    details: `${errorCode ?? 'X'}: refused`,
    metadata,
  });
}

function ledgerAnswering(answer: () => Observable<unknown>) {
  const createJournalEntry =
    vi.fn<(request: unknown) => Observable<unknown>>(answer);
  const listJournalEntries =
    vi.fn<(request: unknown) => Observable<unknown>>(answer);
  const client = {
    getService: vi.fn(() => ({ createJournalEntry, listJournalEntries })),
  } as unknown as ClientGrpc;
  const ledger = new GrpcJournalLedger(client);
  ledger.onModuleInit();
  return { ledger, createJournalEntry, listJournalEntries };
}

const failing = (code: number, errorCode?: string) =>
  ledgerAnswering(() => throwError(() => grpc(code, errorCode)));

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GrpcJournalLedger: the wire', () => {
  it('sends the frozen request exactly as stored', async () => {
    const { ledger, createJournalEntry } = ledgerAnswering(() =>
      of({ entry: ENTRY, replayed: false }),
    );

    const res = await ledger.createJournalEntry(REQUEST);

    expect(createJournalEntry).toHaveBeenCalledTimes(1);
    expect(createJournalEntry.mock.calls[0]?.[0]).toStrictEqual(REQUEST);
    expect(res).toEqual({ entry: ENTRY, replayed: false });
  });

  it('hands a replay back as the success it is', async () => {
    const { ledger } = ledgerAnswering(() =>
      of({ entry: ENTRY, replayed: true }),
    );
    await expect(ledger.createJournalEntry(REQUEST)).resolves.toMatchObject({
      replayed: true,
      entry: { number: 'JE-1041' },
    });
  });

  it('an empty page is no entries, passed through untouched', async () => {
    const page = { entries: [], total: 0, offset: 0, limit: 50 };
    const { ledger, listJournalEntries } = ledgerAnswering(() => of(page));

    await expect(
      ledger.listJournalEntries({ tenant_id: TENANT, source: 'BOOKING' }),
    ).resolves.toEqual(page);
    expect(listJournalEntries.mock.calls[0]?.[0]).toEqual({
      tenant_id: TENANT,
      source: 'BOOKING',
    });
  });
});

describe('GrpcJournalLedger: refused, nothing written', () => {
  it.each([
    [status.INVALID_ARGUMENT, 'JOURNAL_UNBALANCED'],
    [status.NOT_FOUND, 'ACCOUNT_NOT_FOUND'],
    [status.FAILED_PRECONDITION, 'ACCOUNT_ARCHIVED'],
    [status.PERMISSION_DENIED, 'JOURNAL_NOT_BOOKING_ENTRY'],
    [status.ALREADY_EXISTS, 'IDEMPOTENCY_KEY_REUSED'],
  ])(
    'status %i (%s) is a JournalRefused carrying the platform code',
    async (code, errorCode) => {
      const { ledger, createJournalEntry } = failing(code, errorCode);

      const err = await ledger
        .createJournalEntry(REQUEST)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(JournalRefused);
      expect((err as JournalRefused).errorCode).toBe(errorCode);
      expect((err as JournalRefused).code).toBe(errorCode);
      expect((err as JournalRefused).grpcStatus).toBe(status[code]);
      // A refusal is an answer: never sent twice.
      expect(createJournalEntry).toHaveBeenCalledTimes(1);
    },
  );

  it('falls back to the status name when the platform sent no code', async () => {
    const { ledger } = failing(status.INVALID_ARGUMENT);
    const err = await ledger
      .createJournalEntry(REQUEST)
      .catch((e: unknown) => e);
    expect((err as JournalRefused).code).toBe('INVALID_ARGUMENT');
  });
});

describe('GrpcJournalLedger: no verdict, rethrown for the queue to resend', () => {
  it('UNAVAILABLE is retried once in-process, then rethrown untouched', async () => {
    const { ledger, createJournalEntry } = failing(status.UNAVAILABLE);
    const err = await ledger
      .createJournalEntry(REQUEST)
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(JournalRefused);
    expect((err as { code: number }).code).toBe(status.UNAVAILABLE);
    expect(createJournalEntry).toHaveBeenCalledTimes(2);
  });

  it.each([
    status.DEADLINE_EXCEEDED,
    status.UNKNOWN,
    status.INTERNAL,
    status.UNIMPLEMENTED,
  ])('status %i is not retried here and is not a refusal', async (code) => {
    const { ledger, createJournalEntry } = failing(code);
    const err = await ledger
      .createJournalEntry(REQUEST)
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(JournalRefused);
    expect((err as { code: number }).code).toBe(code);
    expect(createJournalEntry).toHaveBeenCalledTimes(1);
  });
});

describe('journalErrorCode', () => {
  it('reads the error-code trailing metadata', () => {
    expect(journalErrorCode(grpc(status.NOT_FOUND, 'ACCOUNT_NOT_FOUND'))).toBe(
      'ACCOUNT_NOT_FOUND',
    );
  });

  it('is null when there is none, or no metadata at all', () => {
    expect(journalErrorCode(grpc(status.NOT_FOUND))).toBeNull();
    expect(journalErrorCode(new Error('x'))).toBeNull();
    expect(journalErrorCode(null)).toBeNull();
  });
});
