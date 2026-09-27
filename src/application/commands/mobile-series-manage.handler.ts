import { Injectable, Logger } from '@nestjs/common';
import { MobileContractError } from './mobile-booking.error';
import {
  MobileSeriesHandler,
  refused,
  type MobileSeriesPreview,
} from './mobile-series.handler';
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
  pauseReasonColumn,
  type CheckedManage,
  type ManageClaim,
} from '@domain/booking/mobile-series-contract';
import {
  actionRefusal,
  checkPause,
  checkReschedule,
  checkSkip,
  frequencyFromColumn,
  type FrequencyColumn,
  type SessionFacts,
} from '@domain/booking/mobile-series';
import {
  RESCHEDULE_REASON,
  SKIP_REASON,
} from '@domain/booking/mobile-series-manage';
import {
  PAUSE_MOVE_REASON,
  RESUME_MOVE_REASON,
  movableSessions,
  pauseFrom,
  resumeFrom,
  stayingDays,
} from '@domain/booking/mobile-series-move';

type Reschedule = Extract<CheckedManage, { action: 'RESCHEDULE' }>;
type Pause = Extract<CheckedManage, { action: 'PAUSE' }>;
type Resume = Extract<CheckedManage, { action: 'RESUME' }>;

/** A movable session: where it is now, and which row it is. */
interface Movable {
  readonly occurrenceId: string;
  readonly index: number;
  readonly bookingId: string | null;
  readonly day: string;
  readonly startMin: number;
  readonly staffId: string | null;
}

/** MOBILE_SERIES_DEPOSIT_PERCENT's own default, when the caller sends none. */
const DEFAULT_DEPOSIT_PERCENT = 20;

/** A line for the log, from whatever was thrown. */
const reasonOf = (e: unknown): string =>
  e instanceof Error ? e.message : 'unknown error';

/**
 * PATCH /v1/mobile-booking/series/:id (steps 6 and 7): the changes the app
 * asks for: SKIP, RESCHEDULE, EXTEND, PAUSE and RESUME.
 *
 * Every check runs on the facts the hub shows (MobileSeriesReadHandler
 * .factsFor), so what the app is offered and what it is allowed always
 * agree. The answer is the whole routine, as the hub reads it. The dry runs
 * of EXTEND, PAUSE and RESUME answer the new sessions instead, as the
 * create's preview does.
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
    private readonly creates: MobileSeriesHandler,
  ) {}

  async execute(input: {
    readonly seriesId: string;
    readonly who: SeriesReader;
    readonly claim: ManageClaim;
    readonly nowMs?: number;
    readonly depositPercent?: number;
  }): Promise<MobileSeriesView | MobileSeriesPreview> {
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

    if (change.action === 'EXTEND') {
      const row = await this.prisma.bookingSeries.findUnique({
        where: { id: series.id },
        select: { anchorDay: true, startMin: true },
      });
      if (row === null) throw MobileContractError.notFoundBooking();
      const preview = await this.creates.extend({
        routine: {
          id: series.id,
          branchId: series.branchId,
          frequency: series.frequency,
          // Never null for an app routine (CHECK series_mobile_has_services).
          serviceIds: series.serviceIds ?? [],
          stylistId: series.preferredStaffId ?? '',
          startMin: row.startMin,
          anchorDay: row.anchorDay.toISOString().slice(0, 10),
          indexes: series.occurrences.map((o) => o.index),
        },
        facts,
        change,
        customerId: input.who.actorId,
        dryRun: input.claim.dryRun,
        depositPercent: input.depositPercent ?? DEFAULT_DEPOSIT_PERCENT,
        nowMs,
      });
      return preview ?? this.reads.read(input.seriesId, input.who);
    }

    if (change.action === 'PAUSE' || change.action === 'RESUME') {
      return this.pauseOrResume(series, facts, change, {
        seriesId: input.seriesId,
        who: input.who,
        dryRun: input.claim.dryRun,
        depositPercent: input.depositPercent ?? DEFAULT_DEPOSIT_PERCENT,
        nowMs,
      });
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
   * PAUSE and RESUME (step 7). Both move the routine's movable sessions
   * (still to come, past the 24 hour lock; one inside it stays), the count
   * kept (D6), through the create's own planning, checks and booking
   * (MobileSeriesHandler.move).
   *
   * PAUSE, at most 60 days (checkPause): the sessions move to the resume
   * date onwards, on the routine's own cadence, time and stylist, and are
   * booked there right away (plan E.3). A session already after the resume
   * date stays on its day. The routine is `paused` until then.
   *
   * RESUME ("Resume now"): the sessions move back to tomorrow onwards, with
   * the optional new frequency, time or stylist ("Customize first", R17),
   * and the routine is active again.
   */
  private async pauseOrResume(
    series: SeriesRowLoaded,
    facts: readonly SessionFacts[],
    change: Pause | Resume,
    input: {
      readonly seriesId: string;
      readonly who: SeriesReader;
      readonly dryRun: boolean;
      readonly depositPercent: number;
      readonly nowMs: number;
    },
  ): Promise<MobileSeriesView | MobileSeriesPreview> {
    const { nowMs } = input;
    const today = branchToday(nowMs);
    if (change.action === 'PAUSE') {
      const why = checkPause(change.until, today);
      if (why !== null) throw refused(why);
    }
    const row = await this.prisma.bookingSeries.findUnique({
      where: { id: series.id },
      select: { anchorDay: true, startMin: true },
    });
    if (row === null) throw MobileContractError.notFoundBooking();

    const movable = movableSessions(facts, nowMs);
    const staying = stayingDays(facts, new Set(movable.map((f) => f.id)));
    const sessions = await this.whereNow(series, movable);
    const stylistId = series.preferredStaffId ?? '';
    const common = {
      routine: {
        id: series.id,
        branchId: series.branchId,
        frequency: series.frequency,
        // Never null for an app routine (CHECK series_mobile_has_services).
        serviceIds: series.serviceIds ?? [],
        anchorDay: row.anchorDay.toISOString().slice(0, 10),
      },
      sessions,
      otherDays: staying,
      picks: change.picks,
      customerId: input.who.actorId,
      dryRun: input.dryRun,
      depositPercent: input.depositPercent,
      nowMs,
    };

    const preview =
      change.action === 'PAUSE'
        ? await this.creates.move({
            ...common,
            from: pauseFrom(change.until, sessions[0]?.day ?? null, staying),
            newFrequency: null,
            startMin: row.startMin,
            stylistId,
            fromStatus: 'active',
            after: {
              status: 'paused',
              pausedUntil: change.until,
              pauseReason:
                change.reason === null
                  ? null
                  : pauseReasonColumn(change.reason),
              pauseNote: change.note,
            },
            releaseReason: PAUSE_MOVE_REASON,
            field: 'until',
          })
        : await this.creates.move({
            ...common,
            from: resumeFrom(today, staying),
            newFrequency: change.frequency,
            startMin: change.startMin ?? row.startMin,
            stylistId: change.stylistId ?? stylistId,
            fromStatus: 'paused',
            after: {
              status: 'active',
              pausedUntil: null,
              pauseReason: null,
              pauseNote: null,
              ...(change.startMin === null
                ? {}
                : { startMin: change.startMin }),
              ...(change.stylistId === null
                ? {}
                : { preferredStaffId: change.stylistId }),
              ...(change.frequency === null
                ? {}
                : {
                    frequency:
                      change.frequency.toLowerCase() as FrequencyColumn,
                  }),
            },
            releaseReason: RESUME_MOVE_REASON,
            field: 'frequency',
          });
    return preview ?? this.reads.read(input.seriesId, input.who);
  }

  /**
   * Where each movable session is now: its booking's day, minute and
   * stylist (a desk move or a RESCHEDULE may have changed them), else its
   * planned day and minute, with no stylist yet.
   */
  private async whereNow(
    series: SeriesRowLoaded,
    movable: readonly SessionFacts[],
  ): Promise<Movable[]> {
    const rows = new Map(series.occurrences.map((o) => [o.id, o] as const));
    const ids = movable
      .map((f) => rows.get(f.id)?.bookingId ?? null)
      .filter((id): id is string => id !== null);
    const bookings =
      ids.length === 0
        ? []
        : await this.prisma.booking.findMany({
            where: { id: { in: ids } },
            select: {
              id: true,
              tradingDay: true,
              startMinute: true,
              items: {
                orderBy: { position: 'asc' },
                select: { staffId: true },
              },
            },
          });
    const byId = new Map(bookings.map((b) => [b.id, b] as const));
    return movable.map((f): Movable => {
      const o = rows.get(f.id)!;
      const b = o.bookingId === null ? undefined : byId.get(o.bookingId);
      return {
        occurrenceId: o.id,
        index: o.index,
        bookingId: o.bookingId,
        day: b === undefined ? f.day : b.tradingDay.toISOString().slice(0, 10),
        startMin: b === undefined ? o.plannedStartMin : b.startMinute,
        staffId: b?.items[0]?.staffId ?? null,
      };
    });
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
