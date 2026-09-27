import { Injectable, Logger } from '@nestjs/common';
import { MobileSeriesReadHandler } from '@application/queries/mobile-series-read.handler';
import { MobileSeriesRepository } from '@infrastructure/persistence/mobile-series.repository';
import { branchToday } from '@infrastructure/persistence/hold.repository';
import {
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
 * Built in parts. 8a: the pause that ends on its date, the routine whose
 * visits are all closed, the 48 hour reminders, and the desk's job kept
 * away. The two misses (8b) and the far-off visits (8c) join it next.
 */
@Injectable()
export class MobileSeriesJobHandler {
  private static readonly log = new Logger(MobileSeriesJobHandler.name);

  constructor(
    private readonly repo: MobileSeriesRepository,
    private readonly reads: MobileSeriesReadHandler,
  ) {}

  async run(nowMs = Date.now()): Promise<MobileSeriesJobReport> {
    const today = branchToday(nowMs);
    const report = {
      routines: 0,
      deskKeptAway: await this.repo.keepDeskAway(),
      resumed: 0,
      completed: 0,
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
}
