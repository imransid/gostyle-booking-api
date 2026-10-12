import type { JournalEntryRequest } from '@domain/journal/journal-entry-plan';

/**
 * The platform's general ledger, as booking-api reads and posts to it.
 *
 * SPELLED AS journal.proto SPELLS IT, snake_case, unlike the directory ports.
 * A posting is built once, stored as JSON and sent exactly as stored on every
 * retry (the platform compares a replayed key against what it first saw), so
 * the request IS the wire shape; a camelCase twin would be a second copy to
 * keep in step. The responses follow suit so one file reads like the proto.
 *
 * proto3 has no null: a field with no value arrives as '' or 0.
 */

export type { JournalEntryRequest };

export interface JournalLineView {
  readonly line_id: string;
  readonly account_id: string;
  readonly account_code: string;
  readonly account_name: string;
  /** ASSET | LIABILITY | EQUITY | INCOME | EXPENSE */
  readonly account_kind: string;
  /** DEBIT | CREDIT */
  readonly side: string;
  readonly amount_minor: number;
  readonly memo: string;
  readonly position: number;
  readonly branch_id: string;
  readonly supplier_id: string;
  readonly customer_id: string;
}

export interface JournalEntryView {
  readonly entry_id: string;
  /** "JE-1041". */
  readonly number: string;
  readonly entry_date: string;
  /** DRAFT | POSTED | VOIDED */
  readonly status: string;
  readonly source: string;
  readonly source_id: string;
  readonly memo: string;
  readonly total_minor: number;
  readonly posted_at: string;
  readonly reversal_of_id: string;
  readonly created_at: string;
  readonly lines: readonly JournalLineView[];
}

export interface CreatedJournalEntry {
  readonly entry: JournalEntryView;
  /** True: this key had already posted, and `entry` is that entry. A success. */
  readonly replayed: boolean;
}

export interface VoidJournalEntryRequest {
  readonly tenant_id: string;
  /** The ORIGINAL entry. Sending a reversal's id is refused. */
  readonly entry_id: string;
  readonly reason: string;
  readonly voided_by_id: string;
}

export interface VoidedJournalEntry {
  /** The NEW opposing entry, not the original. */
  readonly reversal: JournalEntryView;
  /** True: it was already voided, and `reversal` is the existing one. A success. */
  readonly already_voided: boolean;
}

export interface ListJournalEntriesRequest {
  readonly tenant_id: string;
  readonly status?: string;
  readonly source?: string;
  readonly source_id?: string;
  readonly from?: string;
  readonly to?: string;
  readonly offset?: number;
  readonly limit?: number;
}

export interface JournalEntryPage {
  readonly entries: readonly JournalEntryView[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
}

export interface JournalReportRequest {
  readonly tenant_id: string;
  readonly from?: string;
  readonly to?: string;
  readonly source?: string;
  readonly status?: string;
}

export interface JournalReportLineView {
  readonly account_id: string;
  readonly account_code: string;
  readonly account_name: string;
  readonly account_kind: string;
  readonly debit_minor: number;
  readonly credit_minor: number;
  readonly memo: string;
}

export interface JournalReportEntryView {
  readonly entry_id: string;
  readonly number: string;
  readonly entry_date: string;
  readonly status: string;
  readonly source: string;
  readonly transaction_type: string;
  readonly name: string;
  readonly memo: string;
  readonly lines: readonly JournalReportLineView[];
  readonly total_debit_minor: number;
  readonly total_credit_minor: number;
}

export interface JournalReport {
  readonly from: string;
  readonly to: string;
  readonly currency: string;
  readonly entries: readonly JournalReportEntryView[];
  readonly entry_count: number;
  readonly total_debit_minor: number;
  readonly total_credit_minor: number;
  readonly balanced: boolean;
  readonly truncated: boolean;
}

/**
 * The platform looked at the request and said no. NOTHING WAS WRITTEN, so the
 * key is still unused: fix the cause and send again.
 *
 * Distinct from every other failure, which means the platform never gave a
 * verdict (down, timed out, broke while answering) and the same request
 * should simply be sent again later.
 */
export class JournalRefused extends Error {
  constructor(
    /** The gRPC status by name: INVALID_ARGUMENT, NOT_FOUND, ... */
    readonly grpcStatus: string,
    /** The platform's own code (ACCOUNT_NOT_FOUND, ...), or null if none. */
    readonly errorCode: string | null,
    detail: string,
  ) {
    super(detail);
    this.name = 'JournalRefused';
  }

  /** What is stored and shown: the most specific code there is. */
  get code(): string {
    return this.errorCode ?? this.grpcStatus;
  }
}

export interface JournalLedger {
  /**
   * Post one balanced entry, once per idempotency key.
   *
   * THROWS on failure, never answers with nothing: a swallowed error on a
   * write is a posting that never happened. JournalRefused when the platform
   * said no; anything else when it gave no verdict.
   */
  createJournalEntry(
    request: JournalEntryRequest,
  ): Promise<CreatedJournalEntry>;

  /** Reverse an entry booking-api posted. Safe to retry. */
  voidJournalEntry(
    request: VoidJournalEntryRequest,
  ): Promise<VoidedJournalEntry>;

  getJournalEntry(tenantId: string, entryId: string): Promise<JournalEntryView>;

  /** Newest first. An empty page means no entries, never "could not ask". */
  listJournalEntries(
    request: ListJournalEntriesRequest,
  ): Promise<JournalEntryPage>;

  /** Oldest first, with totals. The console's journal report. */
  getJournalReport(request: JournalReportRequest): Promise<JournalReport>;
}

/** Nest injection token. An interface has no runtime identity, so this does. */
export const JOURNAL_LEDGER = Symbol('JOURNAL_LEDGER');
