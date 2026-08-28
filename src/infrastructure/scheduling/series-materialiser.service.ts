import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SeriesRepository } from '../persistence/series.repository';
import { MaterialiseSeriesHandler } from '@application/commands/materialise-series.handler';

/**
 * The nightly occurrence horizon job: 02:00 branch time.
 *
 * An open-ended series always has about ten weeks of concrete,
 * conflict-checked bookings on the calendar and never an infinite tail. This
 * is what keeps that true.
 *
 * 02:00 because the salon is shut and the diary is quiet. Materialising into
 * a trading day means competing with the desk for the same slots, and losing
 * that race writes a needs-attention item for a clash that would not have
 * existed an hour earlier.
 */
export const MATERIALISE_CRON = '0 2 * * *';

/** Asia/Dubai is UTC+4 all year, matching the rest of the service. */
const BRANCH_TIMEZONE = 'Asia/Dubai';

/**
 * How many series one run will touch.
 *
 * A cap rather than everything, because a run that takes an hour is a run
 * that overlaps the salon opening. The index is ordered by how stale the
 * calendar is, so the ones left behind are the freshest and are picked up
 * first tomorrow.
 */
export const MATERIALISE_BATCH = 200;

@Injectable()
export class SeriesMaterialiser {
  private static readonly log = new Logger(SeriesMaterialiser.name);
  private running = false;

  constructor(
    private readonly repo: SeriesRepository,
    private readonly handler: MaterialiseSeriesHandler,
  ) {}

  @Cron(MATERIALISE_CRON, {
    name: 'series-materialise',
    timeZone: BRANCH_TIMEZONE,
  })
  async nightly(): Promise<void> {
    await this.run();
  }

  /** Exposed so the endpoint and the tests can drive one pass by hand. */
  async run(
    todayOverride?: string,
  ): Promise<{ series: number; materialised: number }> {
    if (this.running) return { series: 0, materialised: 0 };
    this.running = true;

    const today = todayOverride ?? this.branchToday();
    let series = 0;
    let materialised = 0;

    try {
      const due = await this.repo.dueForTopUp(today, MATERIALISE_BATCH);

      for (const id of due) {
        try {
          const result = await this.handler.run(id, today);
          series += 1;
          materialised += result.materialised;

          if (result.needsAttention > 0) {
            SeriesMaterialiser.log.warn(
              `Series ${id}: ${result.needsAttention} occurrence(s) need attention`,
            );
          }
        } catch (e) {
          // ONE BAD SERIES MUST NOT STOP THE NIGHT. The others still need
          // their calendars, and a run that aborts halfway leaves a
          // fortnight of holes nobody notices until the phone rings.
          SeriesMaterialiser.log.error(
            `Series ${id} failed to materialise: ` +
              `${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      if (series > 0) {
        SeriesMaterialiser.log.log(
          `Materialised ${materialised} occurrence(s) across ${series} series`,
        );
      }
    } catch (e) {
      SeriesMaterialiser.log.error(
        `Materialiser run failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      this.running = false;
    }

    return { series, materialised };
  }

  private branchToday(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: BRANCH_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }
}
