import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  JOURNAL_LEDGER,
  JournalRefused,
  type JournalLedger,
} from '@application/ports/journal-ledger.port';
import {
  JournalSyncRepository,
  type DueLedgerRow,
} from '@infrastructure/persistence/journal-sync.repository';
import { planJournalEntry } from '@domain/journal/journal-entry-plan';
import { postingBackoffMs } from '@domain/journal/posting-backoff';
import {
  journalPostingEnabled,
  journalPostingTenants,
} from './journal-sync.flag';

/**
 * Rows sent per tick, one after another.
 *
 * Small, because the LEASE must outlast the whole batch: a send is at most
 * two 5s attempts (callWithRetry), so 20 is under four minutes against a
 * five-minute lease even if every call times out. A lease that expired
 * mid-batch would let a second replica send the same row -- harmless, the
 * key replays it, but pointless.
 */
const BATCH = 20;
const LEASE_MS = 5 * 60_000;

export interface JournalSyncRunReport {
  readonly sendingEnabled: boolean;
  readonly posted: number;
  /** Never posted from here (applied_at_pos). */
  readonly skipped: number;
  /** Parked before sending: no mapping, or a tenant the platform cannot accept. */
  readonly unmapped: number;
  /** Parked by the platform's refusal. */
  readonly refused: number;
  readonly retried: number;
}

/**
 * Sends each deposit_ledger row to the platform's general ledger, once.
 *
 * OWNS THE JOURNAL_LEDGER PORT (CLAUDE.md 7). The repository only reads and
 * writes the row's journal_* columns; this decides what each one becomes:
 *
 *   the mapping says skip        -> skipped (the till posts applied_at_pos)
 *   the mapping has no answer    -> parked NO_MAPPING / TENANT_NOT_UUID
 *   an entry, replayed or not    -> posted, with the platform's entry id.
 *                                   `replayed` is an earlier attempt that
 *                                   landed after we stopped waiting.
 *   JournalRefused               -> parked, logged at ERROR. Nothing was
 *                                   written; a person fixes the cause and
 *                                   requeues it.
 *   anything else                -> no verdict. Stay pending and send again
 *                                   after a backoff, with no attempt limit:
 *                                   a capture that gave up is money in the
 *                                   bank and not in the books.
 *
 * THE REQUEST IS REBUILT FROM THE ROW ON EVERY SEND, never stored. It is the
 * same every time -- the date comes from the row's own created_at, the
 * amounts from the row and its booking -- which is what lets the platform
 * replay a key. It would differ only if the booking's tax breakdown changed
 * between a send that landed unseen and its retry; the platform then answers
 * IDEMPOTENCY_KEY_REUSED and the row parks for a person, rather than posting
 * twice.
 */
@Injectable()
export class JournalSyncHandler {
  private static readonly log = new Logger(JournalSyncHandler.name);

  constructor(
    private readonly rows: JournalSyncRepository,
    @Inject(JOURNAL_LEDGER) private readonly ledger: JournalLedger,
  ) {}

  async run(): Promise<JournalSyncRunReport> {
    const report = {
      sendingEnabled: journalPostingEnabled(),
      posted: 0,
      skipped: 0,
      unmapped: 0,
      refused: 0,
      retried: 0,
    };
    // Off: nothing is claimed, so nothing changes. New rows wait as pending,
    // with their own dates, until sending is turned on.
    if (!report.sendingEnabled) return report;

    const due = await this.rows.claimDue(
      BATCH,
      journalPostingTenants(),
      LEASE_MS,
    );
    for (const row of due) {
      const outcome = await this.sync(row);
      report[outcome] += 1;
    }
    return report;
  }

  private async sync(
    row: DueLedgerRow,
  ): Promise<'posted' | 'skipped' | 'unmapped' | 'refused' | 'retried'> {
    const id = row.facts.ledgerId;
    const plan = planJournalEntry(row.facts);

    if (plan.kind === 'skip') {
      await this.rows.markSkipped(id);
      return 'skipped';
    }
    if (plan.kind === 'park') {
      JournalSyncHandler.log.error(
        `deposit-ledger:${id}: not sent (${plan.code}): ${plan.reason} -- ` +
          'parked. Fix the mapping or the booking, then requeue it.',
      );
      await this.rows.markParked(id, plan.code, plan.reason, false);
      return 'unmapped';
    }

    const key = plan.request.idempotency_key;
    try {
      const res = await this.ledger.createJournalEntry(plan.request);
      if (!res.entry?.entry_id) {
        // An answer with no entry is not a posting we can void or show.
        throw new Error('the platform answered without an entry');
      }
      await this.rows.markPosted(id, res.entry.entry_id);
      if (row.attempts > 0 || res.replayed) {
        JournalSyncHandler.log.log(
          `${key}: posted as ${res.entry.number}` +
            (res.replayed ? ' (replayed: an earlier attempt had landed)' : '') +
            (row.attempts > 0 ? ` after ${row.attempts} failure(s)` : ''),
        );
      }
      return 'posted';
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);

      if (e instanceof JournalRefused) {
        // At ERROR, every time: each one is money that will not reach the
        // books until somebody acts.
        JournalSyncHandler.log.error(
          `${key}: REFUSED by the platform (${e.code}): ${message} -- ` +
            'parked. Fix the cause, then requeue it.',
        );
        await this.rows.markParked(id, e.code, message, true);
        return 'refused';
      }

      const attempts = row.attempts + 1;
      const delayMs = postingBackoffMs(attempts);
      // At ERROR from the first attempt (CLAUDE.md 9), then every thirtieth,
      // so a long outage is visible without burying the log.
      if (attempts === 1 || attempts % 30 === 0) {
        JournalSyncHandler.log.error(
          `${key}: no verdict from the platform (attempt ${attempts}): ` +
            `${message} -- will send again in ${Math.round(delayMs / 1000)}s`,
        );
      }
      await this.rows.markRetry(id, message, new Date(Date.now() + delayMs));
      return 'retried';
    }
  }
}
