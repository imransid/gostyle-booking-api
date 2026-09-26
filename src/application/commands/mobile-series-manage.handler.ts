import { Injectable, Logger } from '@nestjs/common';
import { MobileContractError } from './mobile-booking.error';
import { refused } from './mobile-series.handler';
import {
  MobileSeriesReadHandler,
  type MobileSeriesView,
  type SeriesReader,
} from '@application/queries/mobile-series-read.handler';
import { LifecycleRepository } from '@infrastructure/persistence/lifecycle.repository';
import { PrismaService } from '@infrastructure/persistence/prisma.service';
import { branchToday } from '@infrastructure/persistence/hold.repository';
import {
  checkManage,
  type ManageClaim,
} from '@domain/booking/mobile-series-contract';
import {
  actionRefusal,
  checkSkip,
  frequencyFromColumn,
} from '@domain/booking/mobile-series';
import { SKIP_REASON } from '@domain/booking/mobile-series-manage';

/**
 * PATCH /v1/mobile-booking/series/:id (step 6): the changes the app asks
 * for. SKIP is built. RESCHEDULE, EXTEND, PAUSE and RESUME answer
 * invalid_action until they are.
 *
 * Every check runs on the facts the hub shows (MobileSeriesReadHandler
 * .factsFor), so what the app is offered and what it is allowed always
 * agree. The answer is always the whole routine, as the hub reads it.
 */
@Injectable()
export class MobileSeriesManageHandler {
  private static readonly log = new Logger(MobileSeriesManageHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: LifecycleRepository,
    private readonly reads: MobileSeriesReadHandler,
  ) {}

  async execute(input: {
    readonly seriesId: string;
    readonly who: SeriesReader;
    readonly claim: ManageClaim;
    readonly nowMs?: number;
  }): Promise<MobileSeriesView> {
    // The app's changes are the customer's own. Staff change a routine at
    // the desk, with the desk's tools; here they get the hub's 404.
    if (input.who.actorKind !== 'customer') {
      throw MobileContractError.notFoundBooking();
    }
    const nowMs = input.nowMs ?? Date.now();
    const loaded = await this.reads.factsFor(input.seriesId, input.who);
    if (loaded === null) throw MobileContractError.notFoundBooking();
    const { series, facts } = loaded;

    const checked = checkManage(
      input.claim,
      frequencyFromColumn(series.frequency) ?? 'CUSTOM',
      branchToday(nowMs),
    );
    if (checked.kind === 'refused') throw refused(checked.refusal);
    const change = checked.value;

    if (change.action !== 'SKIP') {
      throw refused({
        field: 'action',
        code: 'invalid_action',
        message: `${change.action} is not available yet. Only SKIP is.`,
      });
    }

    const notActive = actionRefusal('SKIP', series.status);
    if (notActive !== null) throw refused(notActive);
    const why = checkSkip(facts, change.sessionIds, nowMs);
    if (why !== null) throw refused(why);

    // A preview changes nothing. Every check passed, so the skip is allowed.
    if (input.claim.dryRun) {
      return this.reads.read(input.seriesId, input.who, nowMs);
    }

    for (const id of change.sessionIds) {
      const occurrence = series.occurrences.find((o) => o.id === id)!;
      await this.skipOne(occurrence, input.who.actorId);
    }
    return this.reads.read(input.seriesId, input.who);
  }

  /**
   * One session skipped. Its booking (when it has one) is cancelled through
   * the lifecycle as the customer's own choice, so the history, the events
   * and the released chair are those of any cancel. Then the session is
   * marked `skipped`, which the hub shows as SKIPPED, and its link to the
   * booking is cleared, as the desk's skip does.
   */
  private async skipOne(
    occurrence: { readonly id: string; readonly bookingId: string | null },
    customerId: string,
  ): Promise<void> {
    if (occurrence.bookingId !== null) {
      const out = await this.lifecycle.transition({
        bookingId: occurrence.bookingId,
        to: 'cancelled',
        actor: 'customer',
        actorId: customerId,
        reason: SKIP_REASON,
        initiatedBy: 'customer',
      });
      if (out.kind !== 'transitioned') {
        MobileSeriesManageHandler.log.warn(
          `skip: booking ${occurrence.bookingId} was not cancelled (${out.kind})`,
        );
        throw refused({
          field: 'session_ids',
          code: 'session_not_changeable',
          message: 'This session changed in the meantime. Please try again.',
        });
      }
    }
    await this.prisma.seriesOccurrence.update({
      where: { id: occurrence.id },
      data: { state: 'skipped', bookingId: null },
    });
  }
}
