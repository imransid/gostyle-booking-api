import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../persistence/prisma.service';
import {
  branchTimeZone,
  branchUtcOffsetMin,
} from '../persistence/hold.repository';
import { offsetLabel } from '@domain/shared/time-zone';
import { REMINDER_LIVE_STATUSES } from '@domain/booking/reminders';

/** One offset upcoming bookings were written at, and how many. */
interface RecordedOffset {
  readonly offset_min: number;
  readonly bookings: number;
}

export type BranchClockVerdict =
  | { readonly kind: 'agrees'; readonly bookings: number }
  | { readonly kind: 'no_upcoming_bookings' }
  | {
      readonly kind: 'disagrees';
      readonly recorded: readonly RecordedOffset[];
    };

/**
 * Says, at boot, which clock the engine runs on -- and whether the bookings
 * already in the database were written on the same one.
 *
 * EVERY BOOKING RECORDS ITS OWN OFFSET. A row carries both its branch-local
 * trading_day + start_minute and the absolute start_at, and start_at was
 * computed from the other two with the offset in force at the time. So the
 * difference between them IS the offset it was written at, and the database
 * can be asked.
 *
 * WHY IT MATTERS. Changing BRANCH_TIMEZONE changes how every stored
 * (trading_day, start_minute) is read back, but not the stored start_at --
 * and start_at is what the reminder ladder and the no-show sweeper count
 * down to. Bookings written at +06:00 and read at +04:00 show two hours off
 * in every view while their reminders still fire on the old instant. That is
 * a decision to make deliberately, with a migration, not a side effect of a
 * deploy that happened to carry a stale variable.
 *
 * LOGGED, NOT FATAL. Refusing to boot over existing data would turn a
 * misconfiguration into an outage on a stop-first rolling update; an ERROR on
 * the first line of the log is where CLAUDE.md 9 says to look. An unknown
 * zone or one with daylight saving IS fatal: nothing correct can run on it.
 */
@Injectable()
export class BranchClockCheck implements OnApplicationBootstrap {
  private static readonly log = new Logger(BranchClockCheck.name);

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    // Throws for a bad zone, and the process stops here with that sentence.
    const offset = branchUtcOffsetMin();
    const zone = branchTimeZone();

    let verdict: BranchClockVerdict;
    try {
      verdict = await this.check();
    } catch (e) {
      BranchClockCheck.log.warn(
        `Branch clock: ${zone}, ${offsetLabel(offset)}; could not compare ` +
          `with stored bookings: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }

    if (verdict.kind === 'disagrees') {
      const written = verdict.recorded
        .map((r) => `${r.bookings} at ${offsetLabel(r.offset_min)}`)
        .join(', ');
      BranchClockCheck.log.error(
        `BRANCH_TIMEZONE=${zone} is ${offsetLabel(offset)}, but upcoming ` +
          `bookings were written ${written}. Their times read wrong in every ` +
          'view while their reminders still count down to the stored instant. ' +
          'Set BRANCH_TIMEZONE to the zone they were written in, or migrate ' +
          'them deliberately.',
      );
      return;
    }

    BranchClockCheck.log.log(
      `Branch clock: ${zone}, ${offsetLabel(offset)}` +
        (verdict.kind === 'agrees'
          ? `; ${verdict.bookings} upcoming booking(s) agree`
          : '; no upcoming bookings to compare'),
    );
  }

  /** Exposed so the comparison can be driven directly in a test. */
  async check(): Promise<BranchClockVerdict> {
    const configured = branchUtcOffsetMin();
    const recorded = await this.prisma.$queryRawUnsafe<RecordedOffset[]>(
      `
      SELECT round(extract(epoch FROM
               (trading_day + make_interval(mins => start_minute))
               - (start_at AT TIME ZONE 'UTC')) / 60)::int AS offset_min,
             count(*)::int AS bookings
        FROM booking
       WHERE start_at > now()
         AND status = ANY($1::booking_status[])
       GROUP BY 1
       ORDER BY 2 DESC`,
      [...REMINDER_LIVE_STATUSES],
    );

    if (recorded.length === 0) return { kind: 'no_upcoming_bookings' };
    if (recorded.every((r) => r.offset_min === configured)) {
      return {
        kind: 'agrees',
        bookings: recorded.reduce((n, r) => n + r.bookings, 0),
      };
    }
    return { kind: 'disagrees', recorded };
  }
}
