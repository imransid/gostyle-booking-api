import { Injectable, Logger } from '@nestjs/common';
import {
  MobileSeriesReadHandler,
  type SeriesRowLoaded,
} from '@application/queries/mobile-series-read.handler';
import { MobileSeriesRepository } from '@infrastructure/persistence/mobile-series.repository';
import { LifecycleRepository } from '@infrastructure/persistence/lifecycle.repository';
import { branchToday } from '@infrastructure/persistence/hold.repository';
import { ROUTINE_COUNT_AUTO_NO_SHOWS } from '@interface/http/mobile-series.flag';
import {
  twoMissesInARow,
  type SessionFacts,
} from '@domain/booking/mobile-series';
import { movableSessions } from '@domain/booking/mobile-series-move';
import {
  MISSED_RELEASE_REASON,
  REMINDER_EVENT,
  allClosed,
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
 * misses in a row pause the routine. The far-off visits (8c) join it next.
 */
@Injectable()
export class MobileSeriesJobHandler {
  private static readonly log = new Logger(MobileSeriesJobHandler.name);

  constructor(
    private readonly repo: MobileSeriesRepository,
    private readonly reads: MobileSeriesReadHandler,
    private readonly lifecycle: LifecycleRepository,
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
}
