import { Injectable, Logger } from '@nestjs/common';
import {
  MobileSeriesReadHandler,
  type SeriesRowLoaded,
} from '@application/queries/mobile-series-read.handler';
import { MobileSeriesRepository } from '@infrastructure/persistence/mobile-series.repository';
import { LifecycleRepository } from '@infrastructure/persistence/lifecycle.repository';
import { branchToday } from '@infrastructure/persistence/hold.repository';
import { TenantContext } from '@infrastructure/tenancy/tenant-context';
import { MobileSeriesHandler } from './mobile-series.handler';
import {
  ROUTINE_COUNT_AUTO_NO_SHOWS,
  seriesDepositPercent,
} from '@interface/http/mobile-series.flag';
import {
  twoMissesInARow,
  type SessionFacts,
} from '@domain/booking/mobile-series';
import { movableSessions } from '@domain/booking/mobile-series-move';
import {
  MISSED_RELEASE_REASON,
  NEEDS_ACTION_EVENT,
  REMINDER_EVENT,
  allClosed,
  horizonDue,
  needsActionEventId,
  reminderDue,
  reminderEventId,
  resumeDue,
} from '@domain/booking/mobile-series-job';

/** What one run did, for the logs and for the desk's "run now". */
export interface MobileSeriesJobReport {
  readonly routines: number;
  readonly deskKeptAway: number;
  readonly resumed: number;
  readonly completed: number;
  readonly pausedForMisses: number;
  readonly released: number;
  readonly booked: number;
  readonly needsAction: number;
  readonly reminded: number;
  readonly failed: number;
}

/**
 * The hourly job (step 8, plan E.4), app routines only (source 'mobile').
 *
 * TWO COPIES OF BOOKING-API RUN IT AT ONCE. Every write claims its own row
 * in a single update, or carries an id made from what it is about, so the
 * two never do the same work twice: the copy that loses a claim finds the
 * work done and moves on. One routine that fails is logged and counted, and
 * the others still run.
 *
 * 8a: the pause that ends on its date, the routine whose visits are all
 * closed, the 48 hour reminders, and the desk's job kept away. 8b: two
 * misses in a row pause the routine. 8c: the far-off visits the diary now
 * reaches are booked, at their own day, time and stylist, or marked "needs
 * action".
 */
@Injectable()
export class MobileSeriesJobHandler {
  private static readonly log = new Logger(MobileSeriesJobHandler.name);

  constructor(
    private readonly repo: MobileSeriesRepository,
    private readonly reads: MobileSeriesReadHandler,
    private readonly lifecycle: LifecycleRepository,
    private readonly creates: MobileSeriesHandler,
    private readonly tenants: TenantContext,
  ) {}

  async run(nowMs = Date.now()): Promise<MobileSeriesJobReport> {
    const today = branchToday(nowMs);
    const countAutoNoShows = ROUTINE_COUNT_AUTO_NO_SHOWS();
    const report = {
      routines: 0,
      deskKeptAway: await this.repo.keepDeskAway(),
      resumed: 0,
      completed: 0,
      pausedForMisses: 0,
      released: 0,
      booked: 0,
      needsAction: 0,
      reminded: 0,
      failed: 0,
    };
    if (report.deskKeptAway > 0) {
      MobileSeriesJobHandler.log.warn(
        `${report.deskKeptAway} app routine(s) were opened to the desk's job, and closed again`,
      );
    }

    for (const routine of await this.repo.openRoutines()) {
      report.routines += 1;
      try {
        if (
          routine.status === 'paused' &&
          resumeDue(routine.pausedUntil, today) &&
          (await this.repo.resumeByJob(routine.id, today))
        ) {
          report.resumed += 1;
        }

        const loaded = await this.reads.factsForJob(routine.id);
        if (loaded === null) continue;
        const { series, facts } = loaded;

        if (allClosed(facts)) {
          if (await this.repo.completeByJob(routine.id)) report.completed += 1;
          continue;
        }

        if (series.status === 'active') {
          const released = await this.missedTwice(
            routine,
            series,
            facts,
            nowMs,
            countAutoNoShows,
          );
          if (released !== null) {
            report.pausedForMisses += 1;
            report.released += released;
          } else {
            const far = await this.bookFarVisits(
              routine.id,
              series,
              facts,
              nowMs,
              today,
            );
            report.booked += far.booked;
            report.needsAction += far.needsAction;
          }
        }

        const bookingOf = new Map(
          series.occurrences.map((o) => [o.id, o.bookingId] as const),
        );
        report.reminded += await this.repo.writeEvents(
          routine.id,
          facts
            .filter((f) => reminderDue(f, nowMs))
            .map((f) => ({
              id: reminderEventId(f.id, f.startAtMs),
              eventType: REMINDER_EVENT,
              payload: {
                source: 'mobile',
                occurrenceId: f.id,
                index: f.index,
                bookingId: bookingOf.get(f.id) ?? '',
                customerId: routine.customerId,
                startAt: new Date(f.startAtMs).toISOString(),
              },
            })),
        );
      } catch (e) {
        report.failed += 1;
        MobileSeriesJobHandler.log.error(
          `routine ${routine.id}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return report;
  }

  /**
   * Plan E.4 step 2 (D5, D9, R11): the last two visits that count were both
   * missed. The routine pauses with no end date (reason missed_twice) and
   * remembers the second miss's day, so the same two misses never pause it
   * again after a resume. Then every visit more than 24 hours away is
   * released: its booking is cancelled for the customer as the salon's call
   * (nothing is kept), and the visit waits, planned, for the resume to book
   * it again (D6). A visit inside the 24 hour lock stays booked.
   *
   * The pause is claimed first, so only one copy of the job releases. A
   * visit whose booking could not be cancelled stays linked and booked, so
   * the hub still shows the truth. Returns how many visits were released, or
   * null when the routine did not pause.
   */
  private async missedTwice(
    routine: { readonly id: string; readonly customerId: string },
    series: SeriesRowLoaded,
    facts: readonly SessionFacts[],
    nowMs: number,
    countAutoNoShows: boolean,
  ): Promise<number | null> {
    const after = await this.repo.missStreakAfter(routine.id);
    const verdict = twoMissesInARow(facts, { countAutoNoShows, after });
    if (!verdict.pause || verdict.lastMissDay === null) return null;
    if (!(await this.repo.pauseForMisses(routine.id, verdict.lastMissDay))) {
      return null;
    }

    const bookingOf = new Map(
      series.occurrences.map((o) => [o.id, o.bookingId] as const),
    );
    let released = 0;
    for (const f of movableSessions(facts, nowMs)) {
      const bookingId = bookingOf.get(f.id) ?? null;
      if (bookingId === null) continue;
      const out = await this.lifecycle
        .transition({
          bookingId,
          to: 'cancelled',
          actor: 'customer',
          actorId: routine.customerId,
          reason: MISSED_RELEASE_REASON,
          initiatedBy: 'salon',
        })
        .catch(() => null);
      if (out !== null && out.kind === 'transitioned') {
        await this.repo.unlinkReleased(routine.id, f.id);
        released += 1;
      } else {
        MobileSeriesJobHandler.log.warn(
          `misses: booking ${bookingId} was not released (${out === null ? 'error' : out.kind})`,
        );
      }
    }
    return released;
  }

  /**
   * Plan E.4 step 3 (R8): each far-off visit the diary now reaches is booked
   * STRICTLY, at its own day, time and stylist, as the create books (in the
   * routine's own tenant: no request brings one to the job). It is claimed
   * first, so the two copies of the job never book it twice. When its time
   * is not free any more, it stays "needs action", with an event for the
   * sending team, and the customer picks another time (RESCHEDULE books a
   * visit that has nothing booked). Never moved silently (D4).
   */
  private async bookFarVisits(
    seriesId: string,
    series: SeriesRowLoaded,
    facts: readonly SessionFacts[],
    nowMs: number,
    today: string,
  ): Promise<{ booked: number; needsAction: number }> {
    const rows = new Map(series.occurrences.map((o) => [o.id, o] as const));
    let booked = 0;
    let needsAction = 0;
    for (const f of facts) {
      if (!horizonDue(f, nowMs, today)) continue;
      const row = rows.get(f.id);
      if (row === undefined) continue;
      if (!(await this.repo.claimPlanned(seriesId, f.id))) continue;

      const result = await this.tenants
        .run(series.tenantId, () =>
          this.creates.bookSession({
            routine: {
              id: series.id,
              branchId: series.branchId,
              frequency: series.frequency,
              // Never null for an app routine (CHECK series_mobile_has_services).
              serviceIds: series.serviceIds ?? [],
            },
            occurrenceId: f.id,
            day: f.day,
            startMin: row.plannedStartMin,
            stylistId: series.preferredStaffId ?? '',
            customerId: series.customerId,
            dryRun: false,
            depositPercent: seriesDepositPercent(),
            nowMs,
          }),
        )
        .catch((e: unknown) => {
          MobileSeriesJobHandler.log.warn(
            `far visit ${f.id}: not booked: ${e instanceof Error ? e.message : String(e)}`,
          );
          return 'not_free' as const;
        });

      if (result === 'booked') {
        booked += 1;
      } else if (result !== 'changed') {
        needsAction += 1;
        await this.repo.writeEvents(seriesId, [
          {
            id: needsActionEventId(f.id, f.day),
            eventType: NEEDS_ACTION_EVENT,
            payload: {
              source: 'mobile',
              occurrenceId: f.id,
              index: f.index,
              day: f.day,
              customerId: series.customerId,
            },
          },
        ]);
      }
    }
    return { booked, needsAction };
  }
}
