import { Injectable, Logger } from '@nestjs/common';
import { MobileContractError } from './mobile-booking.error';
import { refused } from './mobile-series.handler';
import { PlaceHoldHandler } from './place-hold.handler';
import { RescheduleHandler } from './reschedule.handler';
import {
  MobileSeriesReadHandler,
  type MobileSeriesView,
  type SeriesReader,
  type SeriesRowLoaded,
} from '@application/queries/mobile-series-read.handler';
import { LifecycleRepository } from '@infrastructure/persistence/lifecycle.repository';
import { PrismaService } from '@infrastructure/persistence/prisma.service';
import {
  branchInstant,
  branchToday,
} from '@infrastructure/persistence/hold.repository';
import {
  checkManage,
  type CheckedManage,
  type ManageClaim,
} from '@domain/booking/mobile-series-contract';
import {
  actionRefusal,
  checkReschedule,
  checkSkip,
  frequencyFromColumn,
  type SessionFacts,
} from '@domain/booking/mobile-series';
import {
  RESCHEDULE_REASON,
  SKIP_REASON,
} from '@domain/booking/mobile-series-manage';

type Reschedule = Extract<CheckedManage, { action: 'RESCHEDULE' }>;

/** A line for the log, from whatever was thrown. */
const reasonOf = (e: unknown): string =>
  e instanceof Error ? e.message : 'unknown error';

/**
 * PATCH /v1/mobile-booking/series/:id (step 6): the changes the app asks
 * for. SKIP and RESCHEDULE are built. EXTEND, PAUSE and RESUME answer
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
    private readonly holds: PlaceHoldHandler,
    private readonly moves: RescheduleHandler,
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

    if (change.action !== 'SKIP' && change.action !== 'RESCHEDULE') {
      throw refused({
        field: 'action',
        code: 'invalid_action',
        message: `${change.action} is not available yet. Only SKIP and RESCHEDULE are.`,
      });
    }
    const notActive = actionRefusal(change.action, series.status);
    if (notActive !== null) throw refused(notActive);

    if (change.action === 'SKIP') {
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

    await this.reschedule(
      series,
      facts,
      change,
      input.who.actorId,
      input.claim.dryRun,
      nowMs,
    );
    return this.reads.read(
      input.seriesId,
      input.who,
      input.claim.dryRun ? nowMs : undefined,
    );
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

  /**
   * RESCHEDULE one session. The rules first (checkReschedule: still
   * changeable, the new time past the 24 hour lock and within 90 days, no
   * other session that day). Then the same two steps as any move: a HOLD on
   * the new time, placed as the app's own booking places it (it does the
   * racing: once placed, nobody else can take the slot), and the move onto
   * it (same booking, same code, new time). A dry run places the hold and
   * gives it straight back, so "free" is the truth and nothing moves.
   *
   * A session with no booking yet (planned past the horizon, or waiting for
   * a choice) cannot be moved here: it is booked first.
   */
  private async reschedule(
    series: SeriesRowLoaded,
    facts: readonly SessionFacts[],
    change: Reschedule,
    customerId: string,
    dryRun: boolean,
    nowMs: number,
  ): Promise<void> {
    const why = checkReschedule({
      sessions: facts,
      sessionId: change.sessionId,
      newDay: change.day,
      newStartAtMs: branchInstant(change.day, change.startMin).getTime(),
      today: branchToday(nowMs),
      nowMs,
    });
    if (why !== null) throw refused(why);

    const occurrence = series.occurrences.find(
      (o) => o.id === change.sessionId,
    )!;
    const bookingId = occurrence.bookingId;
    if (bookingId === null) {
      throw refused({
        field: 'session_id',
        code: 'session_not_changeable',
        message: 'This session is not booked yet, so it cannot be moved.',
      });
    }
    const current = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        items: { orderBy: { position: 'asc' }, select: { staffId: true } },
      },
    });

    const hold = await this.holds
      .execute({
        branchId: series.branchId,
        customerId,
        tradingDay: change.day,
        // Never null for an app routine (CHECK series_mobile_has_services).
        serviceIds: series.serviceIds ?? [],
        startMin: change.startMin,
        channel: 'online',
        preferredStaffId:
          change.stylistId ??
          current?.items[0]?.staffId ??
          series.preferredStaffId,
      })
      .catch((e: unknown) => {
        MobileSeriesManageHandler.log.warn(
          `reschedule: no hold on ${change.day} at ${change.startMin}: ${reasonOf(e)}`,
        );
        throw refused({
          field: 'time',
          code: 'session_not_free',
          message: 'That time is not free. Please pick another.',
        });
      });

    if (dryRun) {
      await this.holds.release(hold.holdId).catch(() => undefined);
      return;
    }

    try {
      await this.moves.execute({
        bookingId,
        holdId: hold.holdId,
        tradingDay: change.day,
        reason: RESCHEDULE_REASON,
        actor: 'customer',
        actorId: customerId,
      });
    } catch (e) {
      await this.holds.release(hold.holdId).catch(() => undefined);
      MobileSeriesManageHandler.log.warn(
        `reschedule: booking ${bookingId} was not moved: ${reasonOf(e)}`,
      );
      throw refused({
        field: 'session_id',
        code: 'session_not_changeable',
        message: 'This session could not be moved. Please try again.',
      });
    }

    await this.prisma.seriesOccurrence.update({
      where: { id: occurrence.id },
      data: {
        plannedDay: new Date(`${change.day}T00:00:00Z`),
        plannedStartMin: change.startMin,
      },
    });
  }
}
