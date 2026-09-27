import { Injectable, Logger } from '@nestjs/common';
import { MobileContractError } from './mobile-booking.error';
import { refused } from './mobile-series.handler';
import {
  MobileSeriesReadHandler,
  type MobileSeriesView,
  type SeriesReader,
} from '@application/queries/mobile-series-read.handler';
import { LifecycleRepository } from '@infrastructure/persistence/lifecycle.repository';
import { MobileSeriesRepository } from '@infrastructure/persistence/mobile-series.repository';
import {
  cancelHistoryReason,
  checkCancel,
  type CancelClaim,
} from '@domain/booking/mobile-series-contract';
import {
  cancelSummary,
  routineCan,
  sessionBucket,
} from '@domain/booking/mobile-series';
import {
  cancelSummaryView,
  type CancelSummaryView,
} from '@domain/booking/mobile-series-cancel';

/** A cancel's dry run: what cancelling would do, and the routine as it is. */
export interface MobileSeriesCancelPreview {
  readonly dry_run: true;
  readonly summary: CancelSummaryView;
  /**
   * The hub, unchanged. customer-api gives each summary line its date and
   * time from here (by id), already on the salon's clock, so times are
   * converted in one place only.
   */
  readonly routine: MobileSeriesView;
}

/**
 * POST /v1/mobile-booking/series/:id/cancel (step 7): the customer ends
 * their routine.
 *
 * Every session still to come is cancelled as the single booking is: through
 * the lifecycle, as the customer's own cancel, under its refund bands (inside
 * the 24 hour lock that is a late cancel, plan R18), with the app's reason in
 * its history (cancelHistoryReason). A session never booked (past the 90 day
 * horizon, or waiting for a choice) has nothing to cancel and is marked
 * skipped. Then the routine ends, and its own event carries the reason.
 * Never the desk's cancelOccurrences (plan K8: no refund, history or event).
 *
 * Allowed exactly when the hub shows the Cancel button (routineCan): active
 * or paused, with a session still to come.
 *
 * The dry run is cancelSummary over the same facts, with the paid money read
 * as the lifecycle reads it (ticketFor: the ledger), so what the preview
 * promises is what the cancel does. It changes nothing.
 */
@Injectable()
export class MobileSeriesCancelHandler {
  private static readonly log = new Logger(MobileSeriesCancelHandler.name);

  constructor(
    private readonly lifecycle: LifecycleRepository,
    private readonly reads: MobileSeriesReadHandler,
    private readonly repo: MobileSeriesRepository,
  ) {}

  async execute(input: {
    readonly seriesId: string;
    readonly who: SeriesReader;
    readonly claim: CancelClaim;
    readonly nowMs?: number;
  }): Promise<MobileSeriesView | MobileSeriesCancelPreview> {
    // The app's cancel is the customer's own. Staff end a routine at the
    // desk, with the desk's tools; here they get the hub's 404.
    if (input.who.actorKind !== 'customer') {
      throw MobileContractError.notFoundBooking();
    }
    const nowMs = input.nowMs ?? Date.now();
    const loaded = await this.reads.factsFor(input.seriesId, input.who);
    if (loaded === null) throw MobileContractError.notFoundBooking();
    const { series, facts } = loaded;

    const checked = checkCancel(input.claim);
    if (checked.kind === 'refused') throw refused(checked.refusal);

    if (!routineCan(series.status, facts, nowMs).cancel) {
      const over = series.status === 'ended' || series.status === 'completed';
      throw refused({
        field: 'id',
        code: 'cannot_cancel',
        message: over
          ? 'This routine has already ended.'
          : 'This routine has no session left to cancel.',
      });
    }

    const bookingOf = new Map(
      series.occurrences.map((o) => [o.id, o.bookingId] as const),
    );
    // What was paid for each booked session still to come: the ledger, read
    // exactly as the lifecycle reads it when it cancels.
    const paid = new Map<string, number>();
    for (const f of facts) {
      const bookingId = bookingOf.get(f.id) ?? null;
      if (bookingId === null) continue;
      if (sessionBucket(f) !== 'remaining' || f.startAtMs <= nowMs) continue;
      const ticket = await this.lifecycle.ticketFor(bookingId);
      paid.set(f.id, ticket?.capturedFils ?? 0);
    }
    const summary = cancelSummary(
      facts.map((f) => ({ ...f, capturedFils: paid.get(f.id) ?? 0 })),
      nowMs,
    );

    if (input.claim.dryRun) {
      return {
        dry_run: true,
        summary: cancelSummaryView(summary),
        routine: await this.reads.read(input.seriesId, input.who, nowMs),
      };
    }

    const reason = cancelHistoryReason(checked.value.reason);
    const unbooked: string[] = [];
    let cancelled = 0;
    for (const line of summary.sessions) {
      const bookingId = bookingOf.get(line.id) ?? null;
      if (bookingId === null) {
        unbooked.push(line.id);
        continue;
      }
      const out = await this.lifecycle.transition({
        bookingId,
        to: 'cancelled',
        actor: 'customer',
        actorId: input.who.actorId,
        reason,
        initiatedBy: 'customer',
      });
      if (out.kind === 'transitioned') {
        cancelled += 1;
      } else {
        // It changed a moment before (checked in, or cancelled at the
        // desk). The customer asked to stop the routine, so one session
        // never blocks the rest; the hub shows it as it now is.
        MobileSeriesCancelHandler.log.warn(
          `cancel: booking ${bookingId} was not cancelled (${out.kind})`,
        );
      }
    }

    const ended = await this.repo.endByCustomer({
      seriesId: series.id,
      unbookedIds: unbooked,
      reason: checked.value.reason,
      cancelled,
    });
    if (!ended) {
      MobileSeriesCancelHandler.log.warn(
        `cancel: routine ${series.id} was not active or paused any more`,
      );
    }
    return this.reads.read(input.seriesId, input.who);
  }
}
