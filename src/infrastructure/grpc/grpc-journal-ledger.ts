import { Inject, Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { Metadata, status } from '@grpc/grpc-js';
import { Observable } from 'rxjs';

import { callWithRetry, type GrpcCallOptions } from './call-with-retry';
import {
  describeGrpcFailure,
  grpcStatusName,
  grpcStatusOf,
} from './grpc-failure';
import { JOURNAL_LEDGER_CLIENT } from './journal-grpc.constants';
import {
  JournalRefused,
  type CreatedJournalEntry,
  type JournalEntryPage,
  type JournalEntryRequest,
  type JournalEntryView,
  type JournalLedger,
  type JournalReport,
  type JournalReportRequest,
  type ListJournalEntriesRequest,
  type VoidedJournalEntry,
  type VoidJournalEntryRequest,
} from '@application/ports/journal-ledger.port';

/**
 * The service as Nest's client proxy exposes it. The request and response
 * shapes are the port's: they are journal.proto verbatim, snake_case.
 */
interface JournalLedgerGrpc {
  createJournalEntry(
    data: JournalEntryRequest,
    metadata?: Metadata,
    options?: GrpcCallOptions,
  ): Observable<CreatedJournalEntry>;
  voidJournalEntry(
    data: VoidJournalEntryRequest,
    metadata?: Metadata,
    options?: GrpcCallOptions,
  ): Observable<VoidedJournalEntry>;
  getJournalEntry(
    data: { tenant_id: string; entry_id: string },
    metadata?: Metadata,
    options?: GrpcCallOptions,
  ): Observable<{ entry: JournalEntryView }>;
  listJournalEntries(
    data: ListJournalEntriesRequest,
    metadata?: Metadata,
    options?: GrpcCallOptions,
  ): Observable<JournalEntryPage>;
  getJournalReport(
    data: JournalReportRequest,
    metadata?: Metadata,
    options?: GrpcCallOptions,
  ): Observable<JournalReport>;
}

/** Milliseconds, per attempt. gRPC sets no default deadline. */
const CALL_TIMEOUT_MS = 5_000;

/**
 * The statuses that mean the platform READ the request and refused it.
 * Nothing was written, so resending the same request gets the same answer:
 * it needs a person (a missing account, a mapping bug), not a retry.
 *
 * Everything else -- UNAVAILABLE, DEADLINE_EXCEEDED, UNKNOWN, INTERNAL, an
 * rxjs timeout, UNIMPLEMENTED from a platform not yet deployed -- is NO
 * VERDICT, and is safe to send again: the idempotency key stops a second
 * posting.
 */
const REFUSED: ReadonlySet<number> = new Set<number>([
  status.INVALID_ARGUMENT,
  status.NOT_FOUND,
  status.FAILED_PRECONDITION,
  status.PERMISSION_DENIED,
  status.ALREADY_EXISTS,
]);

/**
 * Two levels of retry, deliberately split:
 *
 *  - here, callWithRetry retries UNAVAILABLE once, waiting for the channel.
 *    That is booking-api's rule for every platform call and it stays.
 *  - DEADLINE_EXCEEDED and UNKNOWN are NOT retried in-process. They are safe
 *    to resend, but the resend belongs to the posting queue, which retries
 *    over minutes rather than milliseconds.
 *
 * AND NO FAILURE BECOMES AN EMPTY RESULT. The directory adapters do that for
 * reads with a fallback; here an empty list means "no entries", and a
 * swallowed write is a posting that never happened.
 */
@Injectable()
export class GrpcJournalLedger implements JournalLedger, OnModuleInit {
  private readonly logger = new Logger(GrpcJournalLedger.name);
  private svc!: JournalLedgerGrpc;

  constructor(
    @Inject(JOURNAL_LEDGER_CLIENT) private readonly client: ClientGrpc,
  ) {}

  onModuleInit(): void {
    this.svc = this.client.getService<JournalLedgerGrpc>('JournalLedger');
  }

  createJournalEntry(
    request: JournalEntryRequest,
  ): Promise<CreatedJournalEntry> {
    return this.call(
      `createJournalEntry key=${request.idempotency_key}`,
      (md, opts) => this.svc.createJournalEntry(request, md, opts),
    );
  }

  voidJournalEntry(
    request: VoidJournalEntryRequest,
  ): Promise<VoidedJournalEntry> {
    return this.call(`voidJournalEntry entry=${request.entry_id}`, (md, opts) =>
      this.svc.voidJournalEntry(request, md, opts),
    );
  }

  async getJournalEntry(
    tenantId: string,
    entryId: string,
  ): Promise<JournalEntryView> {
    const res = await this.call(
      `getJournalEntry entry=${entryId}`,
      (md, opts) =>
        this.svc.getJournalEntry(
          { tenant_id: tenantId, entry_id: entryId },
          md,
          opts,
        ),
    );
    return res.entry;
  }

  listJournalEntries(
    request: ListJournalEntriesRequest,
  ): Promise<JournalEntryPage> {
    return this.call(
      `listJournalEntries tenant=${request.tenant_id}`,
      (md, opts) => this.svc.listJournalEntries(request, md, opts),
    );
  }

  getJournalReport(request: JournalReportRequest): Promise<JournalReport> {
    return this.call(
      `getJournalReport tenant=${request.tenant_id}`,
      (md, opts) => this.svc.getJournalReport(request, md, opts),
    );
  }

  private async call<T>(
    label: string,
    issue: (metadata: Metadata, options: GrpcCallOptions) => Observable<T>,
  ): Promise<T> {
    try {
      return await callWithRetry(this.logger, label, CALL_TIMEOUT_MS, issue);
    } catch (err) {
      const code = grpcStatusOf(err);
      if (code !== null && REFUSED.has(code)) {
        throw new JournalRefused(
          grpcStatusName(err) ?? `code ${code}`,
          journalErrorCode(err),
          describeGrpcFailure(err),
        );
      }
      throw err;
    }
  }
}

/**
 * The platform's own refusal code (ACCOUNT_NOT_FOUND, JOURNAL_UNBALANCED,
 * ...) from the `error-code` trailing metadata, or null when it sent none.
 * Nest hands the raw grpc-js error through, so the metadata is there.
 */
export function journalErrorCode(e: unknown): string | null {
  if (typeof e !== 'object' || e === null) return null;
  // Duck-typed, not `instanceof Metadata`: the error is built by whichever
  // copy of grpc-js Nest loaded, which need not be the one imported here.
  const metadata = (e as { metadata?: { get?: unknown } }).metadata;
  if (typeof metadata?.get !== 'function') return null;
  const value = (metadata as Metadata).get('error-code')[0];
  return typeof value === 'string' && value !== '' ? value : null;
}
