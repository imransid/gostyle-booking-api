import { Inject, Injectable } from '@nestjs/common';
import {
  JOURNAL_LEDGER,
  type JournalEntryView,
  type JournalLedger,
} from '@application/ports/journal-ledger.port';
import { bookingError } from '@application/contract/errors';
import {
  JournalSyncRepository,
  type LedgerSyncRow,
} from '@infrastructure/persistence/journal-sync.repository';
import { planJournalEntry } from '@domain/journal/journal-entry-plan';

export interface BookingJournalLineView {
  readonly accountCode: string;
  readonly accountName: string;
  readonly side: string;
  readonly amountMinor: number;
  readonly memo: string;
}

/** A journal entry as the platform's books hold it. */
export interface BookingJournalEntryView {
  readonly entryId: string;
  readonly number: string;
  readonly entryDate: string;
  /** POSTED | VOIDED */
  readonly status: string;
  readonly memo: string;
  readonly totalMinor: number;
  /** Set on an entry that reverses another. */
  readonly reversalOfId: string | null;
  readonly lines: readonly BookingJournalLineView[];
}

/** What a row not yet in the books will post, worked out now, never stored. */
export type PlannedPostingView =
  | {
      readonly kind: 'post';
      readonly entryDate: string;
      readonly memo: string;
      readonly lines: readonly {
        readonly account: string;
        readonly side: string;
        readonly amountMinor: number;
      }[];
    }
  | { readonly kind: 'skip'; readonly reason: string }
  | { readonly kind: 'park'; readonly code: string; readonly reason: string }
  | { readonly kind: 'waiting'; readonly reason: string };

export interface MoneyMovementView {
  readonly ledgerEntryId: string;
  readonly entryType: string;
  readonly amountFils: number;
  readonly rail: string | null;
  readonly recordedAt: string;
  readonly journal: {
    /** before_cutover: written before journal sync existed, never sent. */
    readonly status: string;
    /** The platform entry this row became, once posted. */
    readonly entryId: string | null;
    readonly attempts: number;
    readonly nextAttemptAt: string | null;
    readonly error: string | null;
    readonly errorCode: string | null;
  };
  /** Only for a row not yet in the books. */
  readonly plan: PlannedPostingView | null;
}

export interface BookingJournalView {
  readonly bookingId: string;
  /** Every money movement, oldest first, with how far it got. */
  readonly movements: readonly MoneyMovementView[];
  /** The booking's entries in the platform's general ledger, oldest first. */
  readonly entries: readonly BookingJournalEntryView[];
}

/**
 * What a booking's money did to the salon's books.
 *
 * THE ENTRIES COME FROM THE PLATFORM, which owns the books: booking-api
 * stores no entry, line or account. What it does hold is each money row's
 * delivery receipt, so a row the platform has not got yet -- pending, parked
 * with the reason, skipped -- is shown too, with the entry it WILL post
 * worked out by the same mapping the sender uses.
 */
@Injectable()
export class BookingJournalHandler {
  constructor(
    private readonly rows: JournalSyncRepository,
    @Inject(JOURNAL_LEDGER) private readonly ledger: JournalLedger,
  ) {}

  async execute(bookingId: string): Promise<BookingJournalView> {
    const booking = await this.rows.forBooking(bookingId);
    if (booking === null) {
      throw bookingError('BOOKING_NOT_FOUND', 'No such booking.', {
        bookingId,
      });
    }

    const anyPosted = booking.rows.some((r) => r.entryId !== null);
    const entries =
      booking.tenantId !== null && anyPosted
        ? await this.platformEntries(booking.tenantId, bookingId)
        : [];

    return {
      bookingId,
      movements: booking.rows.map(toMovement),
      entries,
    };
  }

  private async platformEntries(
    tenantId: string,
    bookingId: string,
  ): Promise<BookingJournalEntryView[]> {
    let found: readonly JournalEntryView[];
    try {
      const page = await this.ledger.listJournalEntries({
        tenant_id: tenantId,
        source: 'BOOKING',
        source_id: bookingId,
        limit: 200,
      });
      found = page.entries;
    } catch (e) {
      // Never an empty list: [] would say "this booking is not in the books",
      // which is a claim nobody checked.
      throw bookingError(
        'DEPENDENCY_UNAVAILABLE',
        'The general ledger on the platform could not be read.',
        {
          dependency: 'platform-api JournalLedger',
          reason: e instanceof Error ? e.message : String(e),
        },
      );
    }

    // The platform lists newest first; a booking reads oldest first.
    return [...found]
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((e) => ({
        entryId: e.entry_id,
        number: e.number,
        entryDate: e.entry_date,
        status: e.status,
        memo: e.memo,
        totalMinor: e.total_minor,
        reversalOfId: e.reversal_of_id === '' ? null : e.reversal_of_id,
        lines: e.lines.map((l) => ({
          accountCode: l.account_code,
          accountName: l.account_name,
          side: l.side,
          amountMinor: l.amount_minor,
          memo: l.memo,
        })),
      }));
  }
}

function toMovement(r: LedgerSyncRow): MoneyMovementView {
  const status = r.status ?? 'before_cutover';
  return {
    ledgerEntryId: r.ledgerEntryId,
    entryType: r.entryType,
    amountFils: r.amountFils,
    rail: r.rail,
    recordedAt: r.recordedAt.toISOString(),
    journal: {
      status,
      entryId: r.entryId,
      attempts: r.attempts,
      nextAttemptAt: r.nextAttemptAt?.toISOString() ?? null,
      error: r.error,
      errorCode: r.errorCode,
    },
    plan: status === 'pending' || status === 'parked' ? planOf(r) : null,
  };
}

function planOf(r: LedgerSyncRow): PlannedPostingView {
  if (r.facts === null) {
    return {
      kind: 'waiting',
      reason: 'The booking has no tenant yet; it is sent once it has one.',
    };
  }
  const plan = planJournalEntry(r.facts);
  switch (plan.kind) {
    case 'post':
      return {
        kind: 'post',
        entryDate: plan.request.entry_date,
        memo: plan.request.memo,
        lines: plan.request.lines.map((l) => ({
          account: l.system_key,
          side: l.side,
          amountMinor: l.amount_minor,
        })),
      };
    case 'skip':
      return { kind: 'skip', reason: plan.reason };
    case 'park':
      return { kind: 'park', code: plan.code, reason: plan.reason };
  }
}
